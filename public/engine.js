/* ==========================================================================
   SPEAK - rules engine
   --------------------------------------------------------------------------
   Pure game logic: no DOM, no timers, no randomness. Every function takes a
   plain-JSON game state and returns a new plain-JSON state, so the same engine
   can later run on a server for online play (clients send orders, the server
   calls resolveRound and broadcasts the result).

   The rules (modelled on the "Speak" diplomacy game):
     1. PLANNING   every gang secretly gives each of its units an order:
                     hold                     - stay put and defend
                     move  {to}               - push into an adjacent district
                     support {from, into?}    - back the unit standing in `from`:
                                                 into == null  -> help it hold (you must be next to it)
                                                 into == D     -> help it move into D (you must be next to D)
     2. REVEAL     all orders are resolved at once. Strength = 1 + supports.
                   The strongest move into a district wins; ties bounce.
                   A move needs MORE strength than whoever holds the district.
                   A unit that is attacked has its support cut (unless the
                   attacker comes from the district it was supporting against).
                   A unit that is pushed out is knocked out.
     3. REINFORCE  you may field exactly as many units as you hold hideouts:
                   extra hideouts spawn units, lost hideouts disband the units
                   farthest from home.
     Win: capture a majority of the hideouts (9 of 17), be the last gang
     standing, or lead when the round limit is reached.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpeakEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Which of the six home pairs on the map each seat gets, by player count.
  const SEAT_HOMES = {
    2: [0, 3],
    3: [0, 2, 4],
    4: [0, 2, 3, 5],
    5: [0, 1, 2, 3, 4],
    6: [0, 1, 2, 3, 4, 5],
  };

  function makeRules(map) {
    const count = map.districts.length;
    const adj = map.districts.map((d) => new Set(d.adj));
    const hideoutSet = new Set(map.hideouts);
    const isAdj = (a, b) => a !== b && !!adj[a] && adj[a].has(b);
    const name = (id) => map.districts[id].name;
    const winTargetFor = () => Math.floor(map.hideouts.length / 2) + 1;

    /** Multi-source BFS distance over the district graph. */
    function distances(sources) {
      const dist = new Array(count).fill(Infinity);
      const queue = [];
      sources.forEach((s) => { dist[s] = 0; queue.push(s); });
      for (let i = 0; i < queue.length; i++) {
        const u = queue[i];
        adj[u].forEach((v) => {
          if (dist[v] === Infinity) { dist[v] = dist[u] + 1; queue.push(v); }
        });
      }
      return dist;
    }

    /* ---------------------------------------------------------------- setup */
    function newGame(config) {
      const names = (config.players || []).map((p) => p.name);
      const n = names.length;
      if (n < 2 || n > 6) throw new Error('Speak needs 2 to 6 players');
      const seats = config.seats || (map.seats && map.seats[n]) || SEAT_HOMES[n];
      const state = {
        version: 1,
        round: 1,
        maxRounds: config.maxRounds == null ? 15 : config.maxRounds, // 0 = unlimited
        winTarget: winTargetFor(),
        over: false,
        winners: [],
        endReason: null,
        players: names.map((nm, i) => ({
          id: i, name: nm, color: i, alive: true,
          stats: { captures: 0, knockouts: 0, assists: 0, lost: 0 },
        })),
        units: [],
        nextUnitId: 1,
        hideouts: {},
        orders: {},
        locked: {},
        history: [],
      };
      map.hideouts.forEach((h) => { state.hideouts[h] = null; });
      seats.forEach((homeIdx, seat) => {
        map.homes[homeIdx].forEach((d) => {
          state.hideouts[d] = seat;
          state.units.push({ id: state.nextUnitId++, owner: seat, at: d });
        });
      });
      refreshLocks(state);
      return state;
    }

    /* ----------------------------------------------------------- queries */
    const unitsOf = (state, pid) => state.units.filter((u) => u.owner === pid);
    const unitAt = (state, d) => state.units.find((u) => u.at === d) || null;
    const hideoutCount = (state, pid) =>
      Object.values(state.hideouts).filter((o) => o === pid).length;

    function scoreboard(state) {
      return state.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, alive: p.alive,
        hideouts: hideoutCount(state, p.id),
        units: unitsOf(state, p.id).length,
      }));
    }

    /** A player needs to enter orders if they are alive and own at least one unit. */
    const needsOrders = (state, pid) =>
      !state.over && state.players[pid].alive && unitsOf(state, pid).length > 0;

    function refreshLocks(state) {
      state.players.forEach((p) => {
        // players with nothing to command are locked automatically
        state.locked[p.id] = !needsOrders(state, p.id);
      });
    }

    const allLocked = (state) => state.players.every((p) => state.locked[p.id]);
    const lockedCount = (state) => state.players.filter((p) => needsOrders(state, p.id) && state.locked[p.id]).length;
    const pendingCount = (state) => state.players.filter((p) => needsOrders(state, p.id)).length;

    /**
     * Everything the order UI needs to know about one unit:
     *   moves:    districts it can push into
     *   supports: for each neighbouring district D it could help with
     *             { district, defend: {unitId, owner} | null,   // a unit standing in D (help it hold)
     *               backs: [{from, unitId, owner}] }             // units next to D that could move into D
     */
    function legalOrders(state, unitId) {
      const u = state.units.find((x) => x.id === unitId);
      if (!u) return { moves: [], supports: [] };
      const moves = [...adj[u.at]];
      const supports = [];
      adj[u.at].forEach((d) => {
        const occ = unitAt(state, d);
        const defend = occ && occ.id !== u.id ? { unitId: occ.id, owner: occ.owner } : null;
        const backs = [];
        adj[d].forEach((x) => {
          if (x === u.at) return;
          const other = unitAt(state, x);
          if (other && other.id !== u.id) backs.push({ from: x, unitId: other.id, owner: other.owner });
        });
        if (defend || backs.length) supports.push({ district: d, defend, backs });
      });
      return { moves, supports };
    }

    /* ----------------------------------------------------------- orders */
    function validateOrder(state, unit, order) {
      if (!order || order.type === 'hold') return { type: 'hold' };
      if (order.type === 'move') {
        return isAdj(unit.at, order.to) ? { type: 'move', to: order.to } : null;
      }
      if (order.type === 'support') {
        const target = unitAt(state, order.from);
        if (!target || target.id === unit.id) return null;
        if (order.into != null) {
          // backing a move: the supporter only has to be next to the district being entered
          if (order.into === unit.at || order.into === order.from) return null;
          if (!isAdj(unit.at, order.into) || !isAdj(order.from, order.into)) return null;
          return { type: 'support', from: order.from, into: order.into };
        }
        // backing a defender: the supporter has to be next to that unit
        if (!isAdj(unit.at, order.from)) return null;
        return { type: 'support', from: order.from, into: null };
      }
      return null;
    }

    /**
     * Lock in one player's orders. `orders` maps unitId -> order.
     * Invalid or missing orders become "hold". Returns a new state.
     */
    function submitOrders(state, pid, orders) {
      if (state.over) return state;
      const next = clone(state);
      if (!next.players[pid] || !next.players[pid].alive) return next;
      unitsOf(next, pid).forEach((u) => {
        const o = validateOrder(next, u, orders && orders[u.id]);
        next.orders[u.id] = o || { type: 'hold' };
      });
      next.locked[pid] = true;
      return next;
    }

    /** Reopen a player's planning (used by "restart round"). */
    function clearOrders(state) {
      const next = clone(state);
      next.orders = {};
      refreshLocks(next);
      return next;
    }

    /* ------------------------------------------------------- adjudication */
    function adjudicate(state) {
      const units = state.units;
      const byId = {};
      const at = {};
      units.forEach((u) => { byId[u.id] = u; at[u.at] = u; });

      // normalise orders (anything illegal is a hold)
      const ord = {};
      units.forEach((u) => {
        ord[u.id] = validateOrder(state, u, state.orders[u.id]) || { type: 'hold' };
      });

      // which supports line up with what the supported unit really does?
      const supportMatches = {}; // unitId -> true/false (only for support orders)
      units.forEach((u) => {
        const o = ord[u.id];
        if (o.type !== 'support') return;
        const v = at[o.from];
        if (!v) { supportMatches[u.id] = false; return; }
        const vo = ord[v.id];
        supportMatches[u.id] = o.into != null
          ? (vo.type === 'move' && vo.to === o.into)
          : (vo.type !== 'move');
      });

      const moves = units.filter((u) => ord[u.id].type === 'move');

      // support cutting
      const cutBy = {}; // supporter id -> attacker unit
      units.forEach((u) => {
        const o = ord[u.id];
        if (o.type !== 'support' || !supportMatches[u.id]) return;
        const attacker = moves.find((m) =>
          ord[m.id].to === u.at && m.owner !== u.owner && (o.into == null || m.at !== o.into));
        if (attacker) cutBy[u.id] = attacker;
      });

      const supporters = (unit, kind) => units.filter((s) => {
        const o = ord[s.id];
        if (o.type !== 'support' || !supportMatches[s.id] || cutBy[s.id]) return false;
        if (kind === 'move') return o.from === unit.at && o.into === ord[unit.id].to;
        return o.from === unit.at && o.into == null;
      });

      const moveStr = {};
      const holdStr = {};
      const backers = {};
      units.forEach((u) => {
        if (ord[u.id].type === 'move') {
          const s = supporters(u, 'move'); backers[u.id] = s; moveStr[u.id] = 1 + s.length;
        } else {
          const s = supporters(u, 'hold'); backers[u.id] = s; holdStr[u.id] = 1 + s.length;
        }
      });

      const reverseOf = (m) => moves.find((x) => ord[x.id].to === m.at && x.at === ord[m.id].to) || null;
      const lostHeadOn = (m) => {
        const r = reverseOf(m);
        return !!r && moveStr[r.id] > moveStr[m.id];
      };

      // optimistic fixed point: start by assuming every move succeeds, then
      // strip the ones that fail until nothing changes
      const success = new Set(moves.map((m) => m.id));
      const why = {};
      let changed = true;
      while (changed) {
        changed = false;
        for (const m of moves) {
          if (!success.has(m.id)) continue;
          const to = ord[m.id].to;
          const str = moveStr[m.id];
          let fail = null;

          // rival moves into the same district
          for (const r of moves) {
            if (r.id === m.id || ord[r.id].to !== to) continue;
            if (lostHeadOn(r)) continue;
            if (moveStr[r.id] >= str) { fail = { reason: 'standoff', with: r.id }; break; }
          }
          // whoever is standing in the district
          if (!fail) {
            const occ = at[to];
            if (occ) {
              const occOrd = ord[occ.id];
              const leaves = occOrd.type === 'move' && success.has(occ.id) && occOrd.to !== m.at;
              if (!leaves) {
                if (occ.owner === m.owner) fail = { reason: 'own', with: occ.id };
                else if (occOrd.type === 'move' && occOrd.to === m.at) {
                  if (moveStr[occ.id] >= str) fail = { reason: 'headon', with: occ.id };
                } else {
                  const res = occOrd.type === 'move' ? 1 : holdStr[occ.id];
                  if (res >= str) fail = { reason: 'defended', with: occ.id };
                }
              }
            }
          }
          if (fail) { success.delete(m.id); why[m.id] = fail; changed = true; }
        }
      }

      // dislodged units
      const dislodged = {}; // unitId -> attacker unit
      moves.forEach((m) => {
        if (!success.has(m.id)) return;
        const occ = at[ord[m.id].to];
        if (occ && !success.has(occ.id)) dislodged[occ.id] = m;
      });

      return { ord, moves, success, why, moveStr, holdStr, backers, supportMatches, cutBy, dislodged, byId, at };
    }

    /* ----------------------------------------------------- reinforcements */
    function reinforce(next, report) {
      next.players.forEach((p) => {
        if (!p.alive) return;
        const owned = Object.keys(next.hideouts).map(Number).filter((d) => next.hideouts[d] === p.id);
        const mine = unitsOf(next, p.id);
        if (mine.length < owned.length) {
          let need = owned.length - mine.length;
          const homePriority = new Set(map.homes.flat());
          const free = owned
            .filter((d) => !unitAt(next, d))
            .sort((a, b) => (homePriority.has(b) - homePriority.has(a)) || a - b);
          while (need > 0 && free.length) {
            const d = free.shift();
            const unit = { id: next.nextUnitId++, owner: p.id, at: d };
            next.units.push(unit);
            report.spawns.push({ unitId: unit.id, owner: p.id, at: d });
            need--;
          }
        } else if (mine.length > owned.length) {
          const dist = distances(owned);
          const victims = mine
            .map((u) => ({ u, d: dist[u.at] }))
            .sort((a, b) => (b.d - a.d) || (b.u.id - a.u.id))
            .slice(0, mine.length - owned.length);
          victims.forEach(({ u }) => {
            next.units = next.units.filter((x) => x.id !== u.id);
            report.disbands.push({ unitId: u.id, owner: p.id, at: u.at });
          });
        }
        if (owned.length === 0 && unitsOf(next, p.id).length === 0) {
          p.alive = false;
          report.eliminated.push(p.id);
        }
      });
    }

    /* -------------------------------------------------------- resolve round */
    /**
     * Resolve the whole round. Returns { state, report }.
     * `report` describes everything that happened, for the reveal animation.
     * opts.skipReinforce is for tests that only want to look at movement.
     */
    function resolveRound(state, opts) {
      opts = opts || {};
      const next = clone(state);
      const adjud = adjudicate(next);
      const { ord, moves, success, why, moveStr, holdStr, backers, supportMatches, cutBy, dislodged, byId } = adjud;

      const report = {
        round: state.round,
        orders: [], results: [], knockouts: [], captures: [],
        spawns: [], disbands: [], eliminated: [],
        winners: [], over: false, endReason: null,
      };

      next.units.forEach((u) => {
        const o = ord[u.id];
        const r = { unitId: u.id, owner: u.owner, at: u.at, order: o, outcome: 'held', strength: 1 };
        if (o.type === 'move') {
          r.strength = moveStr[u.id];
          r.backers = backers[u.id].map((s) => s.id);
          if (success.has(u.id)) { r.outcome = 'moved'; r.to = o.to; }
          else { r.outcome = 'bounced'; r.reason = why[u.id] ? why[u.id].reason : 'standoff'; r.with = why[u.id] ? why[u.id].with : null; }
        } else if (o.type === 'support') {
          r.strength = 1;
          if (!supportMatches[u.id]) r.outcome = 'support-void';
          else if (cutBy[u.id]) { r.outcome = 'support-cut'; r.cutBy = cutBy[u.id].id; }
          else r.outcome = 'support-ok';
        } else {
          r.strength = holdStr[u.id];
          r.backers = backers[u.id].map((s) => s.id);
        }
        if (dislodged[u.id]) { r.dislodgedBy = dislodged[u.id].id; }
        report.orders.push({ unitId: u.id, owner: u.owner, at: u.at, order: o });
        report.results.push(r);
      });

      // stats: assists
      report.results.forEach((r) => {
        if (r.outcome !== 'support-ok') return;
        const target = adjud.at[r.order.from];
        if (target && target.owner !== r.owner) next.players[r.owner].stats.assists++;
      });

      // apply knock-outs and movement
      const gone = new Set();
      Object.keys(dislodged).forEach((id) => {
        const victim = byId[id]; const attacker = dislodged[id];
        gone.add(Number(id));
        next.players[attacker.owner].stats.knockouts++;
        next.players[victim.owner].stats.lost++;
        report.knockouts.push({ unitId: victim.id, owner: victim.owner, at: victim.at, byUnitId: attacker.id, byOwner: attacker.owner });
      });
      next.units = next.units.filter((u) => !gone.has(u.id));
      next.units.forEach((u) => { if (success.has(u.id)) u.at = ord[u.id].to; });

      // hideout control: standing in a hideout takes it
      Object.keys(next.hideouts).map(Number).forEach((d) => {
        const occ = unitAt(next, d);
        if (occ && next.hideouts[d] !== occ.owner) {
          report.captures.push({ district: d, from: next.hideouts[d], to: occ.owner });
          next.hideouts[d] = occ.owner;
          next.players[occ.owner].stats.captures++;
        }
      });

      if (!opts.skipReinforce) reinforce(next, report);

      // end of game?
      const board = scoreboard(next);
      const leader = board.slice().sort((a, b) => b.hideouts - a.hideouts || b.units - a.units)[0];
      const alive = next.players.filter((p) => p.alive);
      if (leader.hideouts >= next.winTarget) {
        report.over = true; report.winners = [leader.id]; report.endReason = 'majority';
      } else if (alive.length === 1) {
        report.over = true; report.winners = [alive[0].id]; report.endReason = 'last-standing';
      } else if (next.maxRounds > 0 && state.round >= next.maxRounds) {
        const top = board.filter((b) => b.hideouts === leader.hideouts && b.units === leader.units);
        report.over = true; report.winners = top.map((b) => b.id); report.endReason = 'round-limit';
      }

      next.history.push({ round: state.round, captures: report.captures.length, knockouts: report.knockouts.length });
      if (report.over) {
        next.over = true; next.winners = report.winners; next.endReason = report.endReason;
      } else {
        next.round = state.round + 1;
      }
      next.orders = {};
      refreshLocks(next);
      return { state: next, report };
    }

    return {
      map, count, isAdj, name, hideoutSet,
      newGame, scoreboard, unitsOf, unitAt, hideoutCount, needsOrders, allLocked, lockedCount, pendingCount,
      legalOrders, validateOrder, submitOrders, clearOrders, resolveRound, adjudicate, distances,
    };
  }

  return { makeRules, SEAT_HOMES, clone };
});
