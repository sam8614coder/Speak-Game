/* ==========================================================================
   SPEAK ONLINE - client
   The server is the single source of truth (rules, timers, secret orders).
   This file: connection, menu, lobby, game screen driven by server snapshots,
   planning UI, reveal animation, voice "phones" panel.
   ========================================================================== */
(function () {
  'use strict';
  const MAP = SPEAK_MAP;
  const rules = SpeakEngine.makeRules(MAP);
  const Sound = SpeakSound, Voice = SpeakVoice;
  const { COLORS, glyphSVG, flagSVG } = SpeakTheme;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, a, b) => (n === 1 ? a : b || a + 's');
  const dn = (d) => MAP.districts[d].name;
  const ICONS = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>', menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.1.9-1.1 1.8M12 17v.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    soundOn: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
    soundOff: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  };
  const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  const Store = {
    get(k, d) { try { const v = localStorage.getItem('speak.online.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('speak.online.' + k, JSON.stringify(v)); } catch (e) { /* blocked */ } },
  };
  const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const settings = Object.assign({ sound: true, volume: 0.7, speed: reduceMotion ? 'instant' : 'normal' }, Store.get('settings', {}));
  const saveSettings = () => Store.set('settings', settings);
  Sound.setEnabled(settings.sound); Sound.setVolume(settings.volume);

  const TIPS = [
    'Two thugs pushing into the same empty spot just bounce. Coordinate or lose the tempo.',
    'A push needs MORE strength than the defender. Equal strength means nothing moves.',
    'Support can be given to anyone. Back a rival to buy their trust, or their downfall.',
    'Attack a supporting thug from a different district and its help is cut.',
    'You may only field as many thugs as you hold hideouts.',
    'Promises are free. Orders are secret. That is where the fun is.',
    'Need to scheme? Call one player privately: only they hear you.',
    'Look for hideouts nobody owns yet. Early grabs snowball.',
  ];

  /* ------------------------------------------------------------ connection */
  let cid = Store.get('cid', null);
  if (!cid) { cid = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join(''); Store.set('cid', cid); }
  let ws = null, wsReady = false, retry = 0, retryTimer = null, pingTimer = null, wantOpen = true;
  let pendingAfterHello = null;
  let snap = null, clockOff = 0;
  const net = {
    send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); },
  };
  function setConn(msg) { const c = $('#conn'); if (!msg) { c.hidden = true; return; } c.textContent = msg; c.hidden = false; }
  function connect() {
    clearTimeout(retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch (e) { scheduleRetry(); return; }
    ws.onopen = () => {
      retry = 0; wsReady = true;
      net.send({ t: 'hello', cid, name: myName() });
      clearInterval(pingTimer); pingTimer = setInterval(() => net.send({ t: 'ping' }), 20000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMessage(m); };
    ws.onclose = () => {
      wsReady = false; clearInterval(pingTimer);
      if (Voice.isOn()) { Voice.leave(); }
      if (wantOpen) { setConn(snap ? 'Connection lost. Reconnecting...' : 'Connecting to the server...'); scheduleRetry(); }
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  function scheduleRetry() { retry++; retryTimer = setTimeout(connect, Math.min(5000, 400 * retry)); }

  function onMessage(m) {
    switch (m.t) {
      case 'hello-ok':
        setConn('');
        if (!m.rejoined && snap) { snap = null; showScreen('menu'); toast('That room is gone.'); }
        if (pendingAfterHello) { const f = pendingAfterHello; pendingAfterHello = null; f(); }
        break;
      case 'snap': onSnap(m); break;
      case 'error': menuMsg(m.msg); toast(m.msg); Sound.play('error'); if (m.code === 'no-room' && !snap) showScreen('menu'); break;
      case 'notice': toast(m.msg); if (calling && /declined|isn't|pick up/.test(m.msg)) { calling = null; renderPhones(); } break;
      case 'left': snap = null; resetGameUI(); showScreen('menu'); break;
      case 'rtc': Voice.handleSignal(m.from, m.data); break;
      case 'ring': onRing(m); break;
      case 'ring-cancel': if (incoming && incoming.from === m.from) clearRing(); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------------ misc */
  let toastTimer = null;
  function toast(msg) { const t = $('#toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
  function menuMsg(t) { $('#menuMsg').textContent = t || ''; }
  const myName = () => (($('#nameInput').value || '').trim().slice(0, 16)) || Store.get('name', '') || '';
  const me = () => snap && snap.players.find((p) => p.id === snap.you);
  const bySeat = (seat) => snap && snap.players.find((p) => p.seat === seat);
  const nowS = () => Date.now() + clockOff;
  const left = () => (snap && snap.deadline ? Math.max(0, Math.ceil((snap.deadline - nowS()) / 1000)) : 0);
  const fmt = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const pcolor = (i) => COLORS[i % COLORS.length].hex;
  const pname = (i) => (snap && snap.state && snap.state.players[i] ? snap.state.players[i].name : '?');
  const pspan = (i) => `<b style="color:${pcolor(i)}">${esc(pname(i))}</b>`;
  const isHost = () => snap && snap.host === snap.you;

  function phoneSVG() {
    let holes = '';
    for (let i = 0; i < 10; i++) {
      const a = ((50 + i * 30) * Math.PI) / 180, x = 50 + 31 * Math.sin(a), y = 50 - 31 * Math.cos(a);
      holes += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6.4" fill="#12100e" stroke="#e8d9c4" stroke-width="1.3"/><text x="${x.toFixed(1)}" y="${(y + 2.2).toFixed(1)}" text-anchor="middle" font-size="6.4" font-family="Oswald,Arial,sans-serif" fill="#e8d9c4" font-weight="700">${(i + 1) % 10}</text>`;
    }
    return `<svg viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id="phg" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#ff5a4a"/><stop offset=".6" stop-color="#c3281d"/><stop offset="1" stop-color="#6e120c"/></radialGradient></defs><circle cx="50" cy="50" r="48" fill="url(#phg)" stroke="#120302" stroke-width="3"/><g class="dial"><circle cx="50" cy="50" r="40" fill="#1b0706" stroke="#000" stroke-width="2"/>${holes}</g><circle cx="50" cy="50" r="13" fill="#e6dac0" stroke="#000" stroke-width="2"/><text x="50" y="52.4" text-anchor="middle" font-size="6.2" font-family="Oswald,Arial,sans-serif" font-weight="700" fill="#2a1d14" letter-spacing=".5">SPEAK</text></svg>`;
  }

  /* ---------------------------------------------------------------- screens */
  let screen = 'menu';
  function showScreen(name) {
    screen = name;
    ['menu', 'lobby', 'game', 'end'].forEach((s) => { $('#' + s).hidden = s !== name; });
    if (name !== 'end') stopConfetti();
    if (name === 'menu' || name === 'end') closePhonePanel();
  }

  /* ----------------------------------------------------------- game ui state */
  const ui = {
    plan: null, planKey: '', rv: null, rvKey: '', animTimers: [], disp: null, animating: false, lastReport: null, endShown: -1,
  };
  let board = null;
  function resetGameUI() {
    clearAnim(); ui.plan = null; ui.planKey = ''; ui.rv = null; ui.rvKey = ''; ui.disp = null; ui.animating = false; ui.lastReport = null; ui.endShown = -1;
    if (board) { board.reset(); board.clearOrders(); board.clearHighlight(); }
    closePhonePanel();
  }

  /* --------------------------------------------------------------- snapshots */
  function onSnap(s) {
    const prev = snap;
    clockOff = s.now - Date.now();
    snap = s;
    Voice.sync(s.players, s.you);
    if (calling) { const mm = s.players.find((p) => p.id === s.you), tt = s.players.find((p) => p.id === calling.id); if (!mm || mm.line === 'all' || (tt && tt.line === mm.line)) calling = null; }
    if (!prev || prev.code !== s.code) { menuMsg(''); resetGameUI(); try { history.replaceState(null, '', location.pathname + '?room=' + s.code); } catch (e) { /* ignore */ } }
    if (prev && prev.gameNo !== s.gameNo) resetGameUI();

    if (s.phase === 'lobby') {
      if (prev && prev.phase !== 'lobby') resetGameUI();
      showScreen('lobby'); renderLobby(); return;
    }
    // game phases
    if (screen === 'menu' || screen === 'lobby') enterGame();
    if (s.phase === 'over' && ui.endShown !== s.gameNo) {
      // let a running animation finish first
      if (ui.animating) { finishReveal(); }
      else if (!ui.rv) syncBoard();
      ui.endShown = s.gameNo; showEnd(); return;
    }
    if (s.phase === 'over') { renderEnd(); return; }
    if (screen === 'end') { showScreen('game'); }

    if (s.phase === 'reveal') handleReveal();
    else {
      if (ui.animating) finishReveal();
      if (s.phase === 'talk') { ui.rv = null; ui.plan = null; ui.planKey = ''; }
      if (s.phase === 'plan') ensurePlan();
      syncBoard();
    }
    renderAll();
  }

  function enterGame() {
    showScreen('game');
    if (!board) board = SpeakBoard.create($('#board'), MAP, { onDistrict: onMapTap });
    board.reset(); ui.disp = null;
    board.camera.resize(); board.camera.fit(0);
    syncBoard(true);
  }
  function syncBoard(force) {
    if (!board || !snap || !snap.state) return;
    if (ui.animating) return;
    const key = snap.gameNo + ':' + snap.state.round + ':' + (snap.phase === 'reveal' ? 'r' : 'p');
    if (!force && ui.disp === key) return;
    if (snap.phase === 'reveal' && ui.rv && !ui.rv.done) return;
    board.clearOrders(); board.setState(snap.state); ui.disp = key;
    if (snap.phase === 'talk' || snap.phase === 'plan') ui.dispRound = snap.state.round;
  }

  /* ----------------------------------------------------------------- lobby */
  function shareLink() { return location.origin + location.pathname + '?room=' + snap.code; }
  function renderLobby() {
    const s = snap, host = isHost(), mine = me();
    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
    const dis = host ? '' : 'disabled';
    $('#lobbyInner').innerHTML = `
      <section class="panel lobby-code">
        <small>Room code</small>
        <div class="code-big">${esc(s.code)}</div>
        <div class="share-row">
          <button class="btn btn-ghost" type="button" data-action="copy-link">Copy invite link</button>
          ${navigator.share ? '<button class="btn btn-ghost" type="button" data-action="share-link">Share...</button>' : ''}
        </div>
        <p class="phones-note">Friends open this page and type the code, or tap your link.</p>
      </section>
      <section class="panel">
        <h2 class="panel-title">Gangs <span class="muted">(${s.players.length}/6)</span></h2>
        <ul class="roster">${s.players.map((p, i) => `<li class="${p.id === s.you ? 'me' : ''} ${p.connected ? '' : 'off'}" style="--pc:${pcolor(i)}"><span class="pbadge">${glyphSVG(i, 22)}</span><span class="nm">${esc(p.name)}${p.id === s.you ? ' (you)' : ''}</span>${p.id === s.host ? '<span class="tagx">host</span>' : ''}${p.connected ? '' : '<span class="tagx">away</span>'}<span class="mic ${p.voice ? (Voice.level(p.id) ? 'talk' : 'on') : ''}" title="${p.voice ? 'On the phones' : 'Not on voice'}"></span></li>`).join('')}</ul>
        <div class="opts lobby-opts">
          <label class="opt">Round limit<select data-set="rounds" ${dis}>${opt(8, s.settings.rounds, '8 rounds (quick)')}${opt(12, s.settings.rounds, '12 rounds')}${opt(16, s.settings.rounds, '16 rounds')}${opt(0, s.settings.rounds, 'No limit')}</select></label>
          <label class="opt">Talking time<select data-set="talk" ${dis}>${opt(0, s.settings.talk, 'No limit (players vote to move on)')}${opt(60, s.settings.talk, '1 minute')}${opt(120, s.settings.talk, '2 minutes')}${opt(180, s.settings.talk, '3 minutes')}${opt(300, s.settings.talk, '5 minutes')}</select></label>
          <label class="opt">Planning time<select data-set="plan" ${dis}>${opt(0, s.settings.plan, 'No limit')}${opt(45, s.settings.plan, '45 seconds')}${opt(90, s.settings.plan, '90 seconds')}${opt(120, s.settings.plan, '2 minutes')}${opt(180, s.settings.plan, '3 minutes')}</select></label>
        </div>
        ${host ? `<button class="btn btn-primary btn-xl" type="button" data-action="start" ${s.players.filter((p) => p.connected).length < 2 ? 'disabled' : ''}>${s.players.filter((p) => p.connected).length < 2 ? 'Waiting for friends...' : 'Start game'}</button>` : '<p class="lobby-wait">Waiting for the host to start the game...</p>'}
      </section>
      <section class="panel" id="lobbyPhones">${phonesHTML(true)}</section>
      <div class="menu-links"><button class="link" data-action="how" type="button">How to play</button><span aria-hidden="true">&middot;</span><button class="link" data-action="settings" type="button">Settings</button><span aria-hidden="true">&middot;</span><button class="link" data-action="leave" type="button">Leave room</button></div>`;
  }

  /* ----------------------------------------------------------------- phones */
  let calling = null, incoming = null, ringTimer = null;
  function lineMembers(line) { return snap ? snap.players.filter((p) => p.voice && p.line === line) : []; }
  function phonesHTML(inline) {
    if (!snap) return '';
    const m = me(), mine = m ? m.line : 'all', onPrivate = mine !== 'all', on = Voice.isOn();
    const title = `<h3>Phones${inline ? '' : '<button class="icon-btn" type="button" data-action="close-phones" aria-label="Close">' + icon('close') + '</button>'}</h3>`;
    const err = Voice.error() ? `<p class="phones-err">${esc(Voice.error())}</p>` : '';
    const others = snap.players.filter((p) => p.id !== snap.you);
    const rows = others.map((p) => {
      const same = onPrivate && p.line === mine;
      const st = !p.connected ? 'away' : same ? (p.voice ? 'on your line' : 'joining your line...') : p.voice ? (p.line === 'all' ? 'on the open table' : 'on a private line') : 'not on voice yet';
      let btn = '';
      if (p.connected && !same) {
        btn = calling && calling.id === p.id
          ? `<button class="btn btn-ghost btn-sm" type="button" data-action="cancel-call" data-id="${p.id}">Ringing... cancel</button>`
          : `<button class="btn btn-primary btn-sm" type="button" data-action="call" data-id="${p.id}">Call privately</button>`;
      }
      return `<li class="${same ? 'same' : ''}"><span class="mic ${p.voice && p.connected ? (Voice.level(p.id) ? 'talk' : 'on') : ''}"></span><span class="nm"><span style="color:${pcolor(p.seat)}">${esc(p.name)}</span><small>${st}</small></span>${btn}</li>`;
    }).join('');
    const members = lineMembers(mine).filter((p) => p.id !== snap.you);
    let where;
    if (onPrivate) where = calling || !members.length
      ? '<span class="line-badge">PRIVATE LINE</span> Ringing... waiting for them to pick up. Nobody else can hear this line.'
      : `<span class="line-badge">PRIVATE LINE</span> Only ${members.map((p) => esc(p.name)).join(', ')} can hear you. You cannot hear the open table.`;
    else if (on) where = '<span class="line-badge">OPEN TABLE</span> Everyone on the open table can hear you.';
    else where = 'Tap <b>Call privately</b> next to a player to ring them. Their phone rings and they answer straight onto a private line. No need to join the open table first.';
    const you = on ? `<li class="${Voice.level(snap.you) ? 'same' : ''}"><span class="mic ${Voice.isMuted() ? '' : (Voice.level(snap.you) ? 'talk' : 'on')}"></span><span class="nm">You<small>${Voice.isMuted() ? 'muted' : 'mic on'}</small></span></li>` : '';
    const actions = on
      ? `<div class="phone-row"><button class="btn ${Voice.isMuted() ? 'btn-danger' : 'btn-ghost'}" type="button" data-action="mute">${Voice.isMuted() ? 'Unmute' : 'Mute'}</button>${onPrivate ? '<button class="btn btn-ghost" type="button" data-action="hangup">Back to open table</button>' : ''}<button class="btn btn-ghost" type="button" data-action="voice-leave">Hang up</button></div>`
      : `<div class="phone-row"><button class="btn btn-ghost" type="button" data-action="voice-join">Join the open table</button></div><p class="phones-note">The open table is the group call everyone can hear. Your browser will ask for the microphone. Use headphones.</p>`;
    return `${title}<p class="phones-note">${where}</p>${err}<ul class="line-list">${you}${rows || '<li><span class="nm">Nobody else is here yet<small>Share the room code</small></span></li>'}</ul>${actions}`;
  }
  function renderPhones() {
    if (!snap) return;
    const lp = $('#lobbyPhones'); if (lp && screen === 'lobby') lp.innerHTML = phonesHTML(true);
    const pp = $('#phonePanel'); if (!pp.hidden) pp.innerHTML = phonesHTML(false);
    const b = $('#phoneBtn'); const m = me();
    if (b) {
      const talking = snap.players.some((p) => p.id !== snap.you && p.voice && Voice.level(p.id));
      b.innerHTML = icon('phone') + (Voice.isOn() ? `<span class="dotbadge ${talking ? 'talk' : ''}"></span>` : '');
      b.classList.toggle('private', !!(m && Voice.isOn() && m.line !== 'all'));
      b.classList.toggle('ringing', !!incoming);
      b.title = Voice.isOn() ? (m && m.line !== 'all' ? 'On a private line' : 'On the open table') : 'Phones: join voice call';
    }
  }
  function openPhonePanel() { const pp = $('#phonePanel'); pp.hidden = false; pp.innerHTML = phonesHTML(false); }
  function closePhonePanel() { const pp = $('#phonePanel'); if (pp) { pp.hidden = true; pp.innerHTML = ''; } }
  function onRing(m) {
    incoming = { from: m.from, name: m.name };
    Sound.play('ring');
    const r = $('#ring');
    r.innerHTML = `<b>${esc(m.name)} is calling you privately...</b><button class="btn btn-sm" type="button" data-action="answer" data-id="${m.from}">Answer</button><button class="btn btn-ghost btn-sm" type="button" data-action="decline" data-id="${m.from}">Decline</button>`;
    r.hidden = false; renderPhones();
    clearTimeout(ringTimer); ringTimer = setTimeout(clearRing, 30000);
    const ringer = setInterval(() => { if (!incoming) clearInterval(ringer); else Sound.play('ring'); }, 2200);
  }
  function clearRing() { incoming = null; $('#ring').hidden = true; clearTimeout(ringTimer); renderPhones(); }
  Voice.init({ send: (o) => net.send(o), iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], onUpdate: () => { renderPhones(); if (snap && snap.phase !== 'lobby') renderScoreboard(); else if (snap && screen === 'lobby') updateRosterMics(); } });
  function updateRosterMics() {
    document.querySelectorAll('.roster li').forEach((li, i) => { const p = snap.players[i]; const m = li.querySelector('.mic'); if (p && m) m.className = 'mic ' + (p.voice ? (Voice.level(p.id) ? 'talk' : 'on') : ''); });
  }
  fetch('/config').then((r) => r.json()).then((c) => { if (c && c.iceServers) Voice.setIce(c.iceServers); }).catch(() => {});

  /* --------------------------------------------------------------- game render */
  function renderAll() { renderTop(); renderScoreboard(); renderDock(); renderPhones(); updateSoundUI(); }
  function lockedInfo() {
    const need = snap.players.filter((p) => p.connected && p.seat != null && rules.needsOrders(snap.state, p.seat));
    return { done: need.filter((p) => p.locked).length, total: need.length };
  }
  function renderTop() {
    const s = snap; if (!s || !s.state) return;
    const rep = s.phase === 'reveal' ? s.report : null;
    $('#roundNum').textContent = rep ? rep.round : s.state.round;
    const li = lockedInfo(); const t = s.deadline ? ` (${fmt(left())})` : '';
    const rvTitle = ui.rv && !ui.rv.done ? (ui.animating ? 'Resolving...' : 'Orders revealed') : `Round ${rep ? rep.round : s.state.round} results`;
    const map = {
      talk: ['Phones are open', 'Talk, deal, scheme. Nothing is binding.' + t],
      plan: ['Plan your moves', `${li.done}/${li.total} gangs ready${t}`],
      reveal: [rvTitle, ui.rv && !ui.rv.done ? 'Read them out loud!' : 'Next round starts when everyone is ready'],
    };
    const [a, b] = map[s.phase] || ['SPEAK', ''];
    $('#phaseTitle').textContent = a; $('#phaseSub').textContent = b;
  }
  function renderScoreboard() {
    const s = snap && snap.state; if (!s) return;
    const sb = rules.scoreboard(s);
    $('#scoreboard').innerHTML = `<div class="sb-head">${flagSVG('#e9e2cf', 22)}<span>Capture ${s.winTarget}</span><small>to win</small></div>` +
      sb.map((p) => {
        const pl = bySeat(p.id); const talk = pl && pl.voice && Voice.level(pl.id);
        return `<div class="sb-row ${p.alive ? '' : 'dead'} ${pl && !pl.connected ? 'away' : ''}" style="--pc:${pcolor(p.id)}">${glyphSVG(p.id, 18)}<span class="sb-name">${esc(p.name)}</span>${pl && pl.id === snap.you ? '<span class="you">YOU</span>' : ''}${pl && pl.voice ? `<span class="mic ${talk ? 'talk' : 'on'}"></span>` : ''}<span class="sb-num" title="Hideouts">${p.hideouts}</span><div class="sb-bar"><i style="width:${Math.min(100, (p.hideouts / s.winTarget) * 100)}%"></i></div><span class="sb-units">${p.units} ${plural(p.units, 'thug')}</span></div>`;
      }).join('');
  }
  function updateSoundUI() {
    const on = Sound.isEnabled();
    const b = $('#soundBtn'); if (b) { b.innerHTML = icon(on ? 'soundOn' : 'soundOff'); b.title = on ? 'Sound on' : 'Sound off'; }
    const m = $('#menuSoundBtn'); if (m) m.textContent = 'Sound: ' + (on ? 'on' : 'off');
  }
  function orderLabel(o) {
    if (!o) return 'Hold (default)';
    if (o.type === 'hold') return 'Hold';
    if (o.type === 'move') return `Move to ${dn(o.to)}`;
    return o.into == null ? `Defend ${dn(o.from)}` : `Back ${dn(o.from)} to ${dn(o.into)}`;
  }
  function votesLine() {
    const live = snap.players.filter((p) => p.connected);
    const v = live.filter((p) => p.voted).length;
    return `${v}/${live.length} ready`;
  }
  function renderDock() {
    const dock = $('#dock'); if (!snap || !snap.state) return;
    const s = snap, st = s.state, m = me(); let h = '';
    if (s.phase === 'talk') {
      const dl = s.deadline ? `<div class="big-timer ${left() <= 10 ? 'low' : ''}" id="tmText">${fmt(left())}</div>` : '<div class="big-timer" id="tmText">--</div>';
      const voiceBtn = Voice.isOn() ? '' : '<button class="btn btn-primary" type="button" data-action="open-phones">Pick up the phone</button>';
      h = `<div class="dock-inner">
        <button class="phone-btn ${Voice.isOn() ? 'ringing' : ''}" data-action="open-phones" type="button" aria-label="Open phones">${phoneSVG()}</button>
        <div class="dock-text"><h3>Round ${st.round}: talk it out</h3><p>${Voice.isOn() ? 'You are on the phones. Make deals, lie a little, call someone privately to plot.' : 'Join the voice call to talk with your friends.'}</p><p style="color:var(--muted);font-size:.8rem">Tip: ${esc(TIPS[(st.round - 1) % TIPS.length])}</p></div>
        ${dl}
        <div class="phone-mini">${voiceBtn}<button class="btn ${m && m.voted ? 'btn-ghost' : 'btn-primary'} btn-xl" type="button" data-action="planvote" ${m && m.voted ? 'disabled' : ''}>${m && m.voted ? 'Waiting for others...' : "I'm ready to plan &rarr;"}</button></div>
        <div class="votes">${votesLine()}${isHost() ? ' &middot; <button class="link" data-action="skip" type="button">Skip talking</button>' : ''}</div>
      </div>`;
    } else if (s.phase === 'plan') {
      h = ordersDock();
    } else if (s.phase === 'reveal') {
      const rep = s.report;
      if (ui.rv && !ui.rv.done) {
        h = ui.animating
          ? `<div class="dock-inner"><div class="dock-text"><h3>Resolving...</h3><p>More support wins. Ties bounce.</p></div><button class="btn btn-ghost" data-action="skip-anim" type="button">Skip animation</button></div>`
          : `<div class="dock-inner"><div class="dock-text" style="flex-basis:100%"><h3>Orders revealed</h3><p>Everyone's secret plans are on the map. Gasp, accuse, forgive.</p></div><ul class="log">${rep.orders.map((o) => `<li><i style="color:${pcolor(o.owner)}">${o.order.type === 'move' ? '&rarr;' : o.order.type === 'support' ? '+' : '&#9632;'}</i><span>${pspan(o.owner)} at ${esc(dn(o.at))}: ${esc(orderLabel(o.order))}</span></li>`).join('')}</ul></div>`;
      } else {
        const lines = logLines(rep).map((l) => `<li class="${l[2] || ''}"><i>${l[0]}</i><span>${l[1]}</span></li>`).join('') || '<li><i>-</i><span>A quiet round. Nobody budged.</span></li>';
        h = `<div class="dock-inner"><div class="dock-text" style="flex-basis:100%"><h3>Round ${rep.round} results</h3></div><ul class="log">${lines}</ul>
          <button class="btn ${m && m.voted ? 'btn-ghost' : 'btn-primary'} btn-xl" type="button" data-action="ready" ${m && m.voted ? 'disabled' : ''}>${m && m.voted ? 'Waiting for others...' : (st.over ? 'See results &rarr;' : 'Next round &rarr;')}</button>
          <div class="votes">${votesLine()}${s.deadline ? ' &middot; auto-continues in <span id="tmText">' + fmt(left()) + '</span>' : ''}${isHost() ? ' &middot; <button class="link" data-action="skip" type="button">Continue now</button>' : ''}</div></div>`;
      }
    }
    dock.innerHTML = h;
  }
  setInterval(() => {
    if (!snap || screen !== 'game') return;
    const t = $('#tmText'); if (t && snap.deadline) { const l = left(); t.textContent = fmt(l); t.classList.toggle('low', snap.phase === 'talk' && l <= 10); }
    if (snap.phase === 'plan' || snap.phase === 'talk') renderTop();
  }, 500);

  function logLines(rep) {
    const out = [];
    rep.knockouts.forEach((k) => out.push(['&#9733;', `${pspan(k.owner)}'s thug in ${esc(dn(k.at))} was knocked out by ${pspan(k.byOwner)}!`, 'big']));
    rep.captures.forEach((c) => out.push(['&#9873;', `${pspan(c.to)} captured ${esc(dn(c.district))}${c.from != null ? ' from ' + pspan(c.from) : ''}!`, 'big']));
    rep.results.forEach((r) => {
      const from = esc(dn(r.at));
      if (r.outcome === 'moved') out.push(['&rarr;', `${pspan(r.owner)} pushed ${from} &rarr; ${esc(dn(r.to))}${r.strength > 1 ? ` (strength ${r.strength})` : ''}`]);
      else if (r.outcome === 'bounced') {
        const why = { standoff: 'bounced off a rival push', defended: 'was held off by the defenders', headon: 'collided head-on', own: 'was blocked by their own crew' }[r.reason] || 'was stopped';
        out.push(['&times;', `${pspan(r.owner)}'s push ${from} &rarr; ${esc(dn(r.order.to))} ${why}`]);
      } else if (r.outcome === 'support-cut') out.push(['&#9986;', `${pspan(r.owner)}'s support from ${from} was cut!`]);
      else if (r.outcome === 'support-void') out.push(['?', `${pspan(r.owner)}'s support from ${from} matched nothing`]);
    });
    rep.spawns.forEach((x) => out.push(['+', `${pspan(x.owner)} recruits a new thug at ${esc(dn(x.at))}`]));
    rep.disbands.forEach((x) => out.push(['&minus;', `${pspan(x.owner)} loses a thug at ${esc(dn(x.at))} (not enough hideouts)`]));
    rep.eliminated.forEach((p) => out.push(['&#10006;', `${pspan(p)} is out of the game!`, 'big']));
    return out;
  }

  /* ================================================================ PLANNING */
  function mySeat() { const m = me(); return m && m.seat != null ? m.seat : -1; }
  function iNeedOrders() { return snap && snap.state && mySeat() >= 0 && rules.needsOrders(snap.state, mySeat()); }
  function ensurePlan() {
    const key = snap.gameNo + ':' + snap.state.round;
    if (ui.planKey === key) return;
    ui.planKey = key; ui.plan = null;
    if (!iNeedOrders()) return;
    const mine = rules.unitsOf(snap.state, mySeat());
    ui.plan = { pid: mySeat(), orders: {}, sel: mine[0] ? mine[0].id : null, mode: null, sd: null };
    if (board) { board.clearOrders(); board.setState(snap.state); ui.disp = snap.gameNo + ':' + snap.state.round + ':p'; focusUnit(mine[0]); }
    Sound.play('round');
    toast('Time to plan your moves');
    refreshPlan(true);
  }
  function focusUnit(u) { if (!u || !board) return; if (window.innerWidth < 720) { const p = board.unitPos(u.at); board.camera.focus(p.x, p.y, 1.8); } }
  const planUnit = () => (ui.plan ? snap.state.units.find((u) => u.id === ui.plan.sel) : null);
  const locked = () => { const m = me(); return !!(m && m.locked); };
  function refreshPlan(quiet) {
    const pl = ui.plan; if (!pl || snap.phase !== 'plan') return;
    const s = snap.state, mine = rules.unitsOf(s, pl.pid);
    board.drawOrders(mine.map((u) => ({ unitId: u.id, owner: u.owner, at: u.at, order: pl.orders[u.id] || { type: 'hold' }, dim: !pl.orders[u.id] })), { selectedUnit: pl.sel });
    board.setSelected(pl.sel);
    const hl = []; const u = planUnit();
    if (u && !locked()) {
      const lo = rules.legalOrders(s, u.id);
      if (pl.mode === 'move') lo.moves.forEach((d) => hl.push({ d, kind: 'move' }));
      if (pl.mode === 'support') lo.supports.forEach((x) => hl.push({ d: x.district, kind: pl.sd === x.district ? 'picked' : 'support' }));
    }
    board.highlight(hl);
    if (!quiet) renderAll();
  }
  function selectUnit(id) { const pl = ui.plan; if (!pl || locked()) return; const u = snap.state.units.find((x) => x.id === id && x.owner === pl.pid); if (!u) return; pl.sel = id; pl.mode = null; pl.sd = null; Sound.play('select'); focusUnit(u); refreshPlan(); }
  function setMode(m) { const pl = ui.plan; if (!pl || locked() || !pl.sel) return; if (m === 'hold') { applyOrder({ type: 'hold' }); return; } pl.mode = pl.mode === m ? null : m; pl.sd = null; Sound.play('tap'); refreshPlan(); }
  function applyOrder(order) {
    const pl = ui.plan, u = planUnit(); if (!pl || !u || locked()) return;
    const v = rules.validateOrder(snap.state, u, order);
    if (!v) { Sound.play('error'); toast("That order isn't possible."); return; }
    pl.orders[u.id] = v; pl.mode = null; pl.sd = null; Sound.play('order');
    const next = rules.unitsOf(snap.state, pl.pid).find((x) => !pl.orders[x.id]);
    if (next) { pl.sel = next.id; focusUnit(next); }
    refreshPlan();
  }
  function pickSupportDistrict(d) { const pl = ui.plan, u = planUnit(); if (!pl || !u) return; if (!rules.legalOrders(snap.state, u.id).supports.some((x) => x.district === d)) return; pl.sd = d; Sound.play('select'); refreshPlan(); }
  function resetOrders() { const pl = ui.plan; if (!pl || locked()) return; pl.orders = {}; pl.mode = null; pl.sd = null; const mine = rules.unitsOf(snap.state, pl.pid); pl.sel = mine[0] ? mine[0].id : null; Sound.play('tap'); refreshPlan(); }
  function lockOrders() {
    const pl = ui.plan; if (!pl || locked() || snap.phase !== 'plan') return;
    const orders = {}; rules.unitsOf(snap.state, pl.pid).forEach((u) => { orders[u.id] = pl.orders[u.id] || { type: 'hold' }; });
    net.send({ t: 'orders', orders }); Sound.play('lock');
    board.clearHighlight(); board.setSelected(null);
  }
  function infoToast(d) {
    const occ = rules.unitAt(snap.state, d), ho = snap.state.hideouts[d];
    toast(`${dn(d)}${ho !== undefined ? (ho == null ? ' (free hideout)' : ` (${pname(ho)}'s hideout)`) : ''}${occ ? `: ${pname(occ.owner)}'s thug` : ''}`);
  }
  function onMapTap(d) {
    if (screen !== 'game' || !snap || !snap.state) return;
    if (snap.phase !== 'plan' || !ui.plan || locked()) { infoToast(d); return; }
    const pl = ui.plan, s = snap.state, u = planUnit();
    const lo = u ? rules.legalOrders(s, u.id) : { moves: [], supports: [] };
    if (pl.mode === 'move' && lo.moves.includes(d)) { applyOrder({ type: 'move', to: d }); return; }
    if (pl.mode === 'support' && lo.supports.some((x) => x.district === d)) { pickSupportDistrict(d); return; }
    const occ = rules.unitAt(s, d);
    if (occ && occ.owner === pl.pid) { if (occ.id === pl.sel) { pl.mode = null; pl.sd = null; refreshPlan(); } else selectUnit(occ.id); return; }
    infoToast(d);
  }
  function ordersDock() {
    const s = snap.state, m = me();
    const wait = snap.players.filter((p) => p.connected && p.seat != null && rules.needsOrders(s, p.seat) && !p.locked);
    if (!iNeedOrders()) {
      return `<div class="dock-inner"><div class="dock-text"><h3>Watching this round</h3><p>You have no thugs to command. Waiting for: ${wait.map((p) => esc(p.name)).join(', ') || 'the reveal'}.</p></div></div>`;
    }
    if (m && m.locked) {
      return `<div class="dock-inner"><div class="dock-text"><h3>Orders locked in &#10003;</h3><p>${wait.length ? 'Waiting for: ' + wait.map((p) => esc(p.name)).join(', ') : 'Revealing...'}</p></div>
        <div class="lockrow">${snap.players.filter((p) => p.seat != null && rules.needsOrders(s, p.seat)).map((p) => `<span class="${p.locked ? 'ok' : 'wait'}">${p.locked ? '&#10003;' : '&hellip;'} ${esc(p.name)}</span>`).join('')}</div>
        <div class="actions"><button class="btn btn-ghost" type="button" data-action="unlock">Change my orders</button>${isHost() ? '<button class="btn btn-ghost" type="button" data-action="skip">Don\'t wait: reveal now</button>' : ''}</div></div>`;
    }
    const pl = ui.plan; if (!pl) return '';
    const mine = rules.unitsOf(s, pl.pid), u = planUnit(), cur = u ? pl.orders[u.id] : null;
    const chips = mine.map((x) => `<button class="chip ${x.id === pl.sel ? 'sel' : ''} ${pl.orders[x.id] ? 'set' : ''}" type="button" data-action="select-unit" data-id="${x.id}">${glyphSVG(pl.pid, 16)}<span>${esc(dn(x.at))}</span><small>${esc(orderLabel(pl.orders[x.id]))}</small></button>`).join('');
    let hint = 'Choose an order for the selected thug: Hold, Move, or Support.', extra = '';
    if (u) {
      const lo = rules.legalOrders(s, u.id);
      const occTag = (d) => { const o = rules.unitAt(s, d); const ho = s.hideouts[d]; return `${o ? `<span class="tag" style="--tc:${pcolor(o.owner)}"></span>` : ''}${esc(dn(d))}${ho !== undefined ? ' <small>' + (ho == null ? 'free hideout' : esc(pname(ho)) + "'s hideout") + '</small>' : ''}`; };
      if (pl.mode === 'move') {
        hint = 'Tap a glowing district on the map, or pick one here.';
        extra = `<div class="chips">${lo.moves.map((d) => `<button class="chip pick" type="button" data-action="pick-move" data-d="${d}">${occTag(d)}</button>`).join('')}</div>`;
      } else if (pl.mode === 'support' && pl.sd == null) {
        hint = 'Which neighbouring district do you want to help in? Tap it on the map or below.';
        extra = lo.supports.length ? `<div class="chips">${lo.supports.map((x) => `<button class="chip pick" type="button" data-action="pick-sd" data-d="${x.district}">${occTag(x.district)}</button>`).join('')}</div>` : '<p class="hint">Nobody nearby to support. Try Hold or Move.</p>';
      } else if (pl.mode === 'support') {
        const x = lo.supports.find((q) => q.district === pl.sd);
        hint = `Help in ${dn(pl.sd)}: who are you backing?`;
        const opts = [];
        if (x && x.defend) opts.push(`<button class="chip pick" type="button" data-action="pick-support" data-from="${pl.sd}" data-into="">Help ${pspan(x.defend.owner)}'s thug <b>hold</b> ${esc(dn(pl.sd))}</button>`);
        if (x) x.backs.forEach((b) => opts.push(`<button class="chip pick" type="button" data-action="pick-support" data-from="${b.from}" data-into="${pl.sd}">Help ${pspan(b.owner)}'s thug <b>${esc(dn(b.from))} &rarr; ${esc(dn(pl.sd))}</b></button>`));
        extra = `<div class="chips">${opts.join('') || '<span class="hint">Nothing to back here.</span>'}</div>`;
      } else if (cur) hint = `Order set: ${orderLabel(cur)}. Tap another thug or lock in.`;
    }
    const unset = mine.filter((x) => !pl.orders[x.id]).length;
    return `<div class="dock-inner" style="--pc:${pcolor(pl.pid)}">
      <div class="who"><span class="dot"></span>${esc(pname(pl.pid))}: plan your moves ${s.round ? '' : ''}</div>
      <div class="chips">${chips}</div>
      ${u ? `<div class="seg" role="group" aria-label="Order type"><button type="button" data-action="mode" data-mode="hold" class="${cur && cur.type === 'hold' ? 'on' : ''}">Hold</button><button type="button" data-action="mode" data-mode="move" class="${pl.mode === 'move' || (cur && cur.type === 'move' && !pl.mode) ? 'on' : ''}">Move</button><button type="button" data-action="mode" data-mode="support" class="${pl.mode === 'support' || (cur && cur.type === 'support' && !pl.mode) ? 'on' : ''}">Support</button></div>` : ''}
      <p class="hint">${hint}</p>${extra}
      <div class="actions"><button class="btn btn-ghost" type="button" data-action="reset-orders">Reset</button><button class="btn btn-primary" type="button" data-action="lock">Lock in orders &#10003;${unset ? ` <small style="opacity:.8;text-transform:none;letter-spacing:0">(${unset} will hold)</small>` : ''}</button></div>
    </div>`;
  }

  /* ================================================================= REVEAL */
  function clearAnim() { ui.animTimers.forEach(clearTimeout); ui.animTimers = []; }
  function handleReveal() {
    const rep = snap.report; if (!rep) { syncBoard(); return; }
    const key = snap.gameNo + ':' + rep.round;
    if (ui.rvKey === key) return;      // same reveal, just a vote update
    ui.rvKey = key; ui.plan = null; ui.planKey = '';
    const canAnimate = ui.dispRound === rep.round && ui.disp && ui.disp.indexOf(snap.gameNo + ':') === 0 && settings.speed !== 'instant';
    ui.rv = { key, done: false, state: snap.state, report: rep };
    ui.lastReport = rep;
    if (!canAnimate) { finishReveal(true); return; }
    board.camera.fit(300);
    board.drawOrders(rep.orders.map((o) => ({ unitId: o.unitId, owner: o.owner, at: o.at, order: o.order })), {});
    Sound.play('reveal');
    ui.animating = false;
    ui.animTimers.push(setTimeout(() => { if (ui.rv && ui.rv.key === key && !ui.rv.done) { ui.animating = true; renderAll(); animateReport(ui.rv, () => finishReveal()); } }, 4500));
  }
  function finishReveal(silent) {
    if (!ui.rv || ui.rv.done) { ui.animating = false; return; }
    clearAnim(); ui.animating = false; ui.rv.done = true;
    board.clearOrders(); board.setState(ui.rv.state);
    ui.disp = snap.gameNo + ':' + ui.rv.state.round + ':r';
    ui.dispRound = ui.rv.state.round;
    if (!silent) { if (ui.rv.report.over) Sound.play('win'); else Sound.play('round'); }
    renderAll();
  }
  function animateReport(res, done) {
    const rep = res.report;
    const speed = settings.speed === 'fast' ? 0.5 : 1;
    clearAnim();
    const at = (ms, fn) => ui.animTimers.push(setTimeout(fn, ms * speed));
    document.documentElement.style.setProperty('--move-ms', (0.7 * speed).toFixed(2) + 's');
    board.showStrengths(rep.results);
    at(1000, () => {
      board.clearOrders();
      rep.results.forEach((r) => {
        const g = board.unitEl(r.unitId); if (!g) return;
        if (r.outcome === 'moved') { const p = board.unitPos(r.to); g.style.transform = `translate(${p.x}px, ${p.y}px)`; Sound.play('move'); }
        else if (r.outcome === 'bounced') {
          const a = board.unitPos(r.at), b = board.unitPos(r.order.to);
          g.style.transform = `translate(${a.x + (b.x - a.x) * 0.38}px, ${a.y + (b.y - a.y) * 0.38}px)`;
          ui.animTimers.push(setTimeout(() => { g.style.transform = `translate(${a.x}px, ${a.y}px)`; }, 340 * speed));
          board.floatText(a.x + (b.x - a.x) * 0.5, a.y + (b.y - a.y) * 0.5 - 6, 'BOUNCE', '#ffd27a'); Sound.play('bounce');
        } else if (r.outcome === 'support-cut') { const a = board.unitPos(r.at); board.floatText(a.x, a.y - 26, 'CUT!', '#9ad7ff'); }
      });
    });
    at(1900, () => {
      rep.knockouts.forEach((k) => { const g = board.unitEl(k.unitId); const p = board.unitPos(k.at); if (g) g.classList.add('ko'); board.stars(p.x, p.y - 8); board.floatText(p.x, p.y - 28, 'KO!', '#ff7a6b'); });
      if (rep.knockouts.length) Sound.play('knock');
    });
    at(2700, () => {
      board.paintOwners(res.state);
      rep.captures.forEach((c) => {
        const f = board.flagEl(c.district); if (f) { f.g.classList.remove('flip'); void f.g.getBoundingClientRect(); f.g.classList.add('flip'); }
        board.pulseDistrict(c.district, pcolor(c.to));
        const p = board.unitPos(c.district); board.floatText(p.x, p.y - 30, 'CAPTURED', pcolor(c.to));
      });
      if (rep.captures.length) Sound.play('capture');
    });
    at(3500, () => {
      rep.spawns.forEach((x) => { const g = board.addUnitEl({ id: x.unitId, owner: x.owner, at: x.at }); g.classList.add('pop'); });
      rep.disbands.forEach((x) => { const g = board.unitEl(x.unitId); if (g) g.classList.add('fade'); });
      if (rep.spawns.length) Sound.play('spawn');
      if (rep.disbands.length) Sound.play('disband');
    });
    at(4300, done);
  }

  /* ==================================================================== END */
  function showEnd() { showScreen('end'); closePhonePanel(); renderEnd(); startConfetti(); Sound.play('win'); }
  function renderEnd() {
    const s = snap.state; if (!s || screen !== 'end') return;
    const win = s.winners.slice();
    const names = win.map((i) => esc(pname(i))).join(' &amp; ');
    const col = win.length === 1 ? pcolor(win[0]) : '#efe6d2';
    const rows = rules.scoreboard(s).slice().sort((a, b) => b.hideouts - a.hideouts || b.units - a.units).map((p) => {
      const st = s.players[p.id].stats;
      return `<tr class="${win.includes(p.id) ? 'win' : ''}"><td>${win.includes(p.id) ? '&#9819;' : ''}</td><td><span class="nm">${glyphSVG(p.id, 18)} <b style="color:${pcolor(p.id)}">${esc(p.name)}</b></span></td><td>${p.hideouts}</td><td>${p.units}</td><td>${st.captures}</td><td>${st.knockouts}</td></tr>`;
    }).join('');
    const why = { majority: `Captured ${s.winTarget} of ${MAP.hideouts.length} hideouts in ${s.round} ${plural(s.round, 'round')}. The city is theirs.`, 'last-standing': 'Last gang standing.', 'round-limit': `Most hideouts after ${s.maxRounds} rounds.${win.length > 1 ? ' An exact tie: the city is shared.' : ''}` }[s.endReason] || '';
    const awardDefs = [['Turf Boss', 'captures', 'Most hideouts captured'], ['Muscle', 'knockouts', 'Most thugs knocked out'], ['Best Wingman', 'assists', "Helped others' plans the most"], ['Punching Bag', 'lost', 'Lost the most thugs']];
    const awards = awardDefs.map(([title, key, desc]) => {
      const max = Math.max(...s.players.map((p) => p.stats[key])); if (max <= 0) return '';
      return `<div class="award"><b>${title}</b><span>${s.players.filter((p) => p.stats[key] === max).map((p) => pspan(p.id)).join(' &amp; ')} (${max})</span><br><small style="color:var(--muted)">${desc}</small></div>`;
    }).join('');
    const host = isHost();
    $('#endInner').style.setProperty('--pc', col);
    $('#endInner').innerHTML = `<p class="end-kicker">${win.length > 1 ? "It's a tie" : 'Winner'}</p><h1 class="end-win">${names}</h1><p class="end-why">${why}</p>
      <table class="stand"><thead><tr><th></th><th>Gang</th><th>Hideouts</th><th>Thugs</th><th>Captures</th><th>KOs</th></tr></thead><tbody>${rows}</tbody></table>
      ${awards ? `<div class="awards">${awards}</div>` : ''}
      <div class="end-actions">${host ? '<button class="btn btn-primary btn-xl" type="button" data-action="rematch">Play again (same room)</button>' : '<span class="lobby-wait">Waiting for the host to start a rematch...</span>'}<button class="btn btn-ghost" type="button" data-action="phones-open">Phones</button><button class="btn btn-ghost" type="button" data-action="leave">Leave room</button></div>`;
  }
  let confettiRaf = null;
  function stopConfetti() { if (confettiRaf) { cancelAnimationFrame(confettiRaf); confettiRaf = null; } const c = $('#confetti'); if (c) { const g = c.getContext('2d'); g && g.clearRect(0, 0, c.width, c.height); } }
  function startConfetti() {
    stopConfetti(); if (settings.speed === 'instant') return;
    const c = $('#confetti'), g = c.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    const cols = ['#e5483b', '#2fb5b0', '#4aa84f', '#d93fb7', '#e7d24a', '#f08a2b', '#efe6d2'];
    const ps = Array.from({ length: 130 }, () => ({ x: Math.random() * c.width, y: -Math.random() * c.height * 0.6, vx: (Math.random() - 0.5) * 2.2 * dpr, vy: (2 + Math.random() * 3.5) * dpr, w: (6 + Math.random() * 8) * dpr, h: (4 + Math.random() * 6) * dpr, a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.3, c: cols[(Math.random() * cols.length) | 0] }));
    const t0 = performance.now();
    (function frame(t) {
      g.clearRect(0, 0, c.width, c.height);
      const alive = t - t0 < 6500;
      ps.forEach((p) => { p.x += p.vx; p.y += p.vy; p.a += p.va; if (p.y > c.height && alive) { p.y = -20; p.x = Math.random() * c.width; } g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore(); });
      confettiRaf = t - t0 < 9000 ? requestAnimationFrame(frame) : null;
      if (!confettiRaf) g.clearRect(0, 0, c.width, c.height);
    })(t0);
  }

  /* ================================================================= MODALS */
  let modalOnClose = null;
  function openModal(html, onClose) { const m = $('#modal'); m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; modalOnClose = onClose || null; }
  function closeModal() { const m = $('#modal'); if (m.hidden) return; m.hidden = true; m.innerHTML = ''; const cb = modalOnClose; modalOnClose = null; if (cb) cb(); }
  function confirmDialog({ title, text, yes, danger }) {
    return new Promise((resolve) => {
      openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btns"><button class="btn btn-ghost" type="button" data-modal="no">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-modal="yes">${esc(yes || 'Yes')}</button></div>`);
      const m = $('#modal');
      const onClick = (e) => { const b = e.target.closest('[data-modal]'); if (!b) return; m.removeEventListener('click', onClick); modalOnClose = null; closeModal(); resolve(b.dataset.modal === 'yes'); };
      m.addEventListener('click', onClick);
      modalOnClose = () => { m.removeEventListener('click', onClick); resolve(false); };
    });
  }
  function howToModal() {
    openModal(`<h2>How to play</h2>
      <p>Be the first gang to hold <b>${Math.floor(MAP.hideouts.length / 2) + 1} of ${MAP.hideouts.length} hideouts</b> (the little L-shaped flags).</p>
      <ol class="howto">
        <li><b>Talk.</b> Pick up the phone. Everyone on the open table hears you. <b>Call</b> a player to scheme on a private line.</li>
        <li><b>Plan in secret.</b> Everyone gives each thug an order on their own screen: <b>Hold</b>, <b>Move</b>, or <b>Support</b>. Nobody sees yours.</li>
        <li><b>Reveal.</b> All orders show at once. More strength wins the district. Ties bounce. A pushed-out thug is knocked out.</li>
        <li><b>Reinforce.</b> You field as many thugs as you hold hideouts.</li>
      </ol>
      <ul class="rules"><li>Strength = 1 + the thugs supporting you.</li><li>Support can help <i>anyone</i>, so allies (and traitors) matter.</li><li>Being attacked from another district <b>cuts</b> your support.</li><li>Rivers block movement except at bridges. The lake is impassable.</li></ul>
      <div class="btns"><button class="btn btn-primary" type="button" data-modal="close">Got it</button></div>`);
  }
  function settingsModal() {
    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
    openModal(`<h2>Settings</h2>
      <div class="set-row"><label for="sSound">Sound effects</label><button class="toggle" id="sSound" type="button" data-setting="sound" aria-pressed="${Sound.isEnabled()}" aria-label="Sound effects"></button></div>
      <div class="set-row"><label for="sVol">Volume</label><input id="sVol" type="range" min="0" max="1" step="0.05" value="${settings.volume}" data-setting="volume"></div>
      <div class="set-row"><label for="sSpeed">Reveal animation</label><select id="sSpeed" data-setting="speed">${opt('normal', settings.speed, 'Normal')}${opt('fast', settings.speed, 'Fast')}${opt('instant', settings.speed, 'Instant')}</select></div>
      <div class="btns"><button class="btn btn-primary" type="button" data-modal="close">Done</button></div>`);
  }
  function gameMenuModal() {
    openModal(`<h2>Game menu</h2><div class="stack"><button class="btn btn-primary" type="button" data-modal="close">Resume</button>
      <button class="btn" type="button" data-action="how">How to play</button><button class="btn" type="button" data-action="settings">Settings</button>
      <button class="btn" type="button" data-action="copy-link">Copy invite link <small>room ${esc(snap ? snap.code : '')}</small></button>
      <button class="btn btn-danger" type="button" data-action="leave">Leave game</button></div>`);
  }

  /* ================================================================= EVENTS */
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) {
      try { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (x) { return false; }
    }
  }
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-modal="close"]')) { closeModal(); return; }
    if (e.target === $('#modal')) { closeModal(); return; }
    const sw = e.target.closest('[data-setting="sound"]');
    if (sw) { const on = !Sound.isEnabled(); Sound.setEnabled(on); settings.sound = on; saveSettings(); sw.setAttribute('aria-pressed', String(on)); updateSoundUI(); if (on) { Sound.unlock(); Sound.play('click'); } return; }
    const a = e.target.closest('[data-action]'); if (!a) return;
    Voice.resume();
    const act = a.dataset.action, id = a.dataset.id;
    switch (act) {
      case 'copy-link': toast((await copyText(shareLink())) ? 'Invite link copied!' : 'Could not copy. Share the code: ' + snap.code); break;
      case 'share-link': try { await navigator.share({ title: 'SPEAK', text: `Join my SPEAK game! Room ${snap.code}`, url: shareLink() }); } catch (x) { /* cancelled */ } break;
      case 'start': Sound.unlock(); net.send({ t: 'start' }); break;
      case 'leave': {
        const inGame = snap && snap.phase !== 'lobby' && snap.phase !== 'over';
        const ok = inGame ? await confirmDialog({ title: 'Leave the game?', text: 'You will drop out of this game. Your gang will simply hold its ground.', yes: 'Leave', danger: true }) : true;
        if (ok) { closeModal(); Voice.leave(); net.send({ t: 'leave' }); try { history.replaceState(null, '', location.pathname); } catch (x) { /* ignore */ } }
        break;
      }
      case 'rematch': net.send({ t: 'rematch' }); break;
      case 'planvote': net.send({ t: 'planvote' }); break;
      case 'ready': net.send({ t: 'ready' }); break;
      case 'skip': net.send({ t: 'skip' }); break;
      case 'skip-anim': finishReveal(); break;
      case 'unlock': net.send({ t: 'unlock' }); break;
      case 'select-unit': selectUnit(Number(id)); break;
      case 'mode': setMode(a.dataset.mode); break;
      case 'pick-move': applyOrder({ type: 'move', to: Number(a.dataset.d) }); break;
      case 'pick-sd': pickSupportDistrict(Number(a.dataset.d)); break;
      case 'pick-support': applyOrder({ type: 'support', from: Number(a.dataset.from), into: a.dataset.into === '' ? null : Number(a.dataset.into) }); break;
      case 'reset-orders': resetOrders(); break;
      case 'lock': lockOrders(); break;
      case 'how': howToModal(); break;
      case 'settings': settingsModal(); break;
      case 'open-phones': case 'phones-open': openPhonePanel(); break;
      case 'close-phones': closePhonePanel(); break;
      case 'voice-join': Sound.unlock(); await Voice.join(); renderPhones(); break;
      case 'voice-leave': Voice.leave(); calling = null; renderPhones(); break;
      case 'mute': Voice.setMuted(!Voice.isMuted()); break;
      case 'call': {
        calling = { id }; net.send({ t: 'call', to: id }); Sound.unlock(); renderPhones();
        setTimeout(() => { if (calling && calling.id === id) { calling = null; renderPhones(); } }, 31000);
        if (!Voice.isOn()) { const ok = await Voice.join(); if (!ok) { net.send({ t: 'cancel', to: id }); calling = null; renderPhones(); } }
        break;
      }
      case 'cancel-call': net.send({ t: 'cancel', to: id }); calling = null; renderPhones(); break;
      case 'answer': {
        net.send({ t: 'answer', to: id, accept: true }); clearRing(); Sound.unlock();
        if (!Voice.isOn()) { const ok = await Voice.join(); if (!ok) { net.send({ t: 'hangup' }); toast('Could not open your microphone.'); } }
        break;
      }
      case 'decline': net.send({ t: 'answer', to: id, accept: false }); clearRing(); break;
      case 'hangup': net.send({ t: 'hangup' }); break;
      default: break;
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset) return;
    if (t.dataset.set && snap) { const o = Object.assign({}, snap.settings); o[t.dataset.set] = Number(t.value); net.send(Object.assign({ t: 'settings' }, o)); }
    if (t.dataset.setting === 'speed') { settings.speed = t.value; saveSettings(); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.setting === 'volume') { settings.volume = Number(t.value); Sound.setVolume(settings.volume); saveSettings(); Sound.play('click'); }
    if (t.id === 'codeInput') t.value = t.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else closePhonePanel(); }
    if (e.key === 'Enter' && e.target.id === 'codeInput') $('#joinBtn').click();
    if (e.key === 'Enter' && e.target.id === 'nameInput') e.target.blur();
  });
  function whenReady(f) { if (wsReady) f(); else { pendingAfterHello = f; menuMsg('Connecting...'); } }
  $('#createBtn').addEventListener('click', () => { Sound.unlock(); const n = myName(); Store.set('name', n); whenReady(() => net.send({ t: 'create', name: n })); });
  $('#joinBtn').addEventListener('click', () => {
    Sound.unlock(); const code = $('#codeInput').value.trim();
    if (code.length !== 4) { menuMsg('Room codes have 4 letters.'); Sound.play('error'); return; }
    const n = myName(); Store.set('name', n); whenReady(() => net.send({ t: 'join', code, name: n }));
  });
  $('#howBtn').addEventListener('click', howToModal);
  $('#settingsBtn').addEventListener('click', settingsModal);
  $('#helpBtn').addEventListener('click', howToModal);
  $('#menuBtn').addEventListener('click', gameMenuModal);
  $('#phoneBtn').addEventListener('click', () => { Voice.resume(); if ($('#phonePanel').hidden) openPhonePanel(); else closePhonePanel(); });
  const toggleSound = () => { const on = !Sound.isEnabled(); Sound.setEnabled(on); settings.sound = on; saveSettings(); updateSoundUI(); if (on) { Sound.unlock(); Sound.play('click'); } };
  $('#soundBtn').addEventListener('click', toggleSound); $('#menuSoundBtn').addEventListener('click', toggleSound);
  $('#zoomIn').innerHTML = icon('plus'); $('#zoomOut').innerHTML = icon('minus'); $('#zoomFit').innerHTML = icon('fit');
  $('#helpBtn').innerHTML = icon('help'); $('#menuBtn').innerHTML = icon('menu'); $('#phoneBtn').innerHTML = icon('phone');
  $('#zoomIn').addEventListener('click', () => board && board.camera.zoomCenter(1.4));
  $('#zoomOut').addEventListener('click', () => board && board.camera.zoomCenter(1 / 1.4));
  $('#zoomFit').addEventListener('click', () => board && board.camera.fit());
  $('#heroPhone').innerHTML = phoneSVG();
  $('#nameInput').value = Store.get('name', '');
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (urlRoom) { $('#codeInput').value = urlRoom; menuMsg(`Invited to room ${urlRoom}. Enter your name and press Join.`); }
  /* Android back button (called by the APK wrapper): close things first, else open the game menu */
  window.SPEAKBack = function () {
    if (!$('#modal').hidden) { closeModal(); return; }
    if (!$('#phonePanel').hidden) { closePhonePanel(); return; }
    if (screen === 'game') { gameMenuModal(); return; }
    toast('Press back again to leave');
  };
  window.addEventListener('error', (e) => console.error('SPEAK error:', e.message));
  window.SPEAKOnline = { get snap() { return snap; }, ui, rules, Voice, net, get board() { return board; } };
  updateSoundUI();
  connect();
})();
