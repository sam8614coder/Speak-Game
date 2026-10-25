/* ==========================================================================
   SPEAK - board renderer
   Draws the city (SVG), the thugs, hideout markers and the order arrows, and
   owns the pan / zoom camera. It knows nothing about turns or rules: the UI
   hands it a game state and a list of orders to draw.
   ========================================================================== */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ theme */
  const COLORS = [
    { name: 'Crimson', hex: '#e5483b', dark: '#7d1c16', light: '#ff9a8f' },
    { name: 'Teal', hex: '#2fb5b0', dark: '#145a57', light: '#8ff0ea' },
    { name: 'Green', hex: '#4aa84f', dark: '#1d5421', light: '#a2eaa6' },
    { name: 'Magenta', hex: '#d93fb7', dark: '#6d1a5a', light: '#ff9be6' },
    { name: 'Yellow', hex: '#e7d24a', dark: '#6e6112', light: '#fff2a0' },
    { name: 'Orange', hex: '#f08a2b', dark: '#753a07', light: '#ffc58a' },
  ];

  function starPath(r1, r2) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? r2 : r1;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      d += (i ? 'L' : 'M') + (Math.cos(a) * r).toFixed(2) + ' ' + (Math.sin(a) * r).toFixed(2);
    }
    return d + 'Z';
  }
  /* shapes make gangs distinguishable without relying on colour alone */
  const GLYPHS = [
    'M-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0Z',
    'M-3.4-3.4h6.8v6.8h-6.8Z',
    'M0-4.6L4.4 3.2H-4.4Z',
    'M0-4.8L4.2 0L0 4.8L-4.2 0Z',
    starPath(4.9, 2.1),
    'M-1.6-4.6h3.2v3h3v3.2h-3v3h-3.2v-3h-3v-3.2h3Z',
  ];

  /* ------------------------------------------------------------------ utils */
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function hash(n) { let x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  function woodTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      const streak = (Math.sin(y * 0.35) + Math.sin(y * 0.11 + 2)) * 0.5;
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const n = Math.random();
        const dark = n < 0.5 + streak * 0.18;
        img.data[i] = dark ? 0 : 255; img.data[i + 1] = dark ? 0 : 245; img.data[i + 2] = dark ? 0 : 230;
        img.data[i + 3] = Math.round((dark ? 34 : 14) * Math.random());
      }
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  /* ----------------------------------------------------------------- camera */
  function Camera(svg, bounds) {
    const cam = this;
    cam.svg = svg; cam.b = bounds;
    cam.scale = 1; cam.cx = bounds.x + bounds.w / 2; cam.cy = bounds.y + bounds.h / 2;
    cam.cw = 800; cam.ch = 500; cam.min = 0.5; cam.max = 3;
    cam.anim = null;
    cam.ready = false;

    cam.resize = function () {
      const r = svg.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      const wasFit = !cam.ready || Math.abs(cam.scale - cam.min) < 1e-6;
      const oldMin = cam.min;
      cam.cw = r.width; cam.ch = r.height;
      cam.min = Math.min(cam.cw / cam.b.w, cam.ch / cam.b.h);
      cam.max = cam.min * 4.2;
      if (wasFit) { cam.scale = cam.min; cam.cx = cam.b.x + cam.b.w / 2; cam.cy = cam.b.y + cam.b.h / 2; }
      else cam.scale = clamp(cam.scale * (cam.min / oldMin), cam.min, cam.max);
      cam.ready = true;
      cam.apply();
    };
    cam.clampCenter = function () {
      const w = cam.cw / cam.scale, h = cam.ch / cam.scale, b = cam.b;
      cam.cx = w >= b.w ? b.x + b.w / 2 : clamp(cam.cx, b.x + w / 2, b.x + b.w - w / 2);
      cam.cy = h >= b.h ? b.y + b.h / 2 : clamp(cam.cy, b.y + h / 2, b.y + b.h - h / 2);
    };
    cam.apply = function () {
      cam.scale = clamp(cam.scale, cam.min, cam.max);
      cam.clampCenter();
      const w = cam.cw / cam.scale, h = cam.ch / cam.scale;
      svg.setAttribute('viewBox', [cam.cx - w / 2, cam.cy - h / 2, w, h].map((n) => n.toFixed(2)).join(' '));
      svg.dataset.zoom = (cam.scale / cam.min).toFixed(2);
    };
    cam.toWorld = function (px, py) {
      const r = svg.getBoundingClientRect();
      const w = cam.cw / cam.scale, h = cam.ch / cam.scale;
      return { x: cam.cx - w / 2 + ((px - r.left) / r.width) * w, y: cam.cy - h / 2 + ((py - r.top) / r.height) * h };
    };
    cam.zoomAt = function (factor, px, py) {
      const before = cam.toWorld(px, py);
      cam.scale = clamp(cam.scale * factor, cam.min, cam.max);
      const after = cam.toWorld(px, py);
      cam.cx += before.x - after.x; cam.cy += before.y - after.y;
      cam.apply();
    };
    cam.zoomCenter = function (factor) {
      const r = svg.getBoundingClientRect();
      cam.stop(); cam.zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
    };
    cam.panBy = function (dxPx, dyPx) { cam.cx -= dxPx / cam.scale; cam.cy -= dyPx / cam.scale; cam.apply(); };
    cam.stop = function () { if (cam.anim) { cancelAnimationFrame(cam.anim); cam.anim = null; } };
    cam.animateTo = function (cx, cy, scale, ms) {
      cam.stop();
      if (!ms) { cam.cx = cx; cam.cy = cy; cam.scale = scale; cam.apply(); return; }
      const s0 = { cx: cam.cx, cy: cam.cy, sc: cam.scale }; const t0 = performance.now();
      (function step(t) {
        const k = clamp((t - t0) / ms, 0, 1); const e = 1 - Math.pow(1 - k, 3);
        cam.cx = s0.cx + (cx - s0.cx) * e; cam.cy = s0.cy + (cy - s0.cy) * e;
        cam.scale = s0.sc * Math.pow(scale / s0.sc, e);
        cam.apply();
        cam.anim = k < 1 ? requestAnimationFrame(step) : null;
      })(t0);
    };
    cam.fit = function (ms) { cam.animateTo(cam.b.x + cam.b.w / 2, cam.b.y + cam.b.h / 2, cam.min, ms == null ? 350 : ms); };
    /** Zoom in on a point if we are zoomed out (used on small screens). */
    cam.focus = function (x, y, minZoom, ms) {
      const target = Math.max(cam.scale, cam.min * (minZoom || 1.6));
      cam.animateTo(x, y, target, ms == null ? 380 : ms);
    };
  }

  /* ----------------------------------------------------------------- board */
  function create(svg, MAP, handlers) {
    handlers = handlers || {};
    const W = MAP.width, H = MAP.height;
    const bounds = { x: -46, y: -46, w: W + 92, h: H + 92 };
    svg.innerHTML = '';
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const cam = new Camera(svg, bounds);
    const hasHideout = new Set(MAP.hideouts);
    const D = MAP.districts;
    const unitPos = (d) => ({ x: D[d].cx, y: D[d].cy - 8 });
    const flagPos = (d) => ({ x: D[d].cx + 27, y: D[d].cy + 4 });

    /* ---- defs ---- */
    const defs = el('defs', null, svg);
    const tex = el('pattern', { id: 'wood', width: 256, height: 256, patternUnits: 'userSpaceOnUse' }, defs);
    el('image', { href: woodTexture(), width: 256, height: 256 }, tex);
    const vg = el('radialGradient', { id: 'vignette', cx: '50%', cy: '50%', r: '75%' }, defs);
    el('stop', { offset: '55%', 'stop-color': '#000', 'stop-opacity': 0 }, vg);
    el('stop', { offset: '100%', 'stop-color': '#000', 'stop-opacity': 0.55 }, vg);
    const lakeG = el('radialGradient', { id: 'lakeGrad', cx: '50%', cy: '45%', r: '70%' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#16293a' }, lakeG);
    el('stop', { offset: '100%', 'stop-color': '#080f17' }, lakeG);
    COLORS.forEach((c, i) => {
      const m = el('marker', { id: 'arrow-' + i, viewBox: '0 0 10 10', refX: 6.5, refY: 5, markerWidth: 3.6, markerHeight: 3.6, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' }, defs);
      el('path', { d: 'M0 0L10 5L0 10Z', fill: c.hex, stroke: '#0a0808', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, m);
    });
    const mk = el('marker', { id: 'arrow-x', viewBox: '0 0 10 10', refX: 6.5, refY: 5, markerWidth: 3.6, markerHeight: 3.6, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' }, defs);
    el('path', { d: 'M0 0L10 5L0 10Z', fill: '#bbb' }, mk);

    /* ---- layers ---- */
    const L = {};
    ['table', 'districts', 'tints', 'water', 'bridges', 'marks', 'labels', 'shade', 'hit', 'hl', 'orders', 'units', 'fx'].forEach((n) => {
      L[n] = el('g', { class: 'layer-' + n }, svg);
    });
    L.shade.style.pointerEvents = 'none'; L.labels.style.pointerEvents = 'none';
    L.marks.style.pointerEvents = 'none'; L.tints.style.pointerEvents = 'none';
    L.water.style.pointerEvents = 'none'; L.bridges.style.pointerEvents = 'none';
    L.orders.style.pointerEvents = 'none'; L.units.style.pointerEvents = 'none';
    L.fx.style.pointerEvents = 'none'; L.hl.style.pointerEvents = 'none';

    /* table + board rim */
    el('rect', { x: -2400, y: -2400, width: 5800, height: 5400, fill: '#0b0908' }, L.table);
    el('rect', { x: -2400, y: -2400, width: 5800, height: 5400, fill: 'url(#wood)', opacity: 0.35 }, L.table);
    el('rect', { x: -30, y: -30, width: W + 60, height: H + 60, rx: 18, fill: '#1b1612', stroke: '#050403', 'stroke-width': 6 }, L.table);
    el('rect', { x: -22, y: -22, width: W + 44, height: H + 44, rx: 12, fill: 'none', stroke: '#3a2f25', 'stroke-width': 2 }, L.table);

    /* districts */
    const dEls = [], tintEls = [], hitEls = [], labelEls = [], flagEls = [];
    D.forEach((d) => {
      const h = 26 + hash(d.id + 1) * 10, l = 27 + hash(d.id + 9) * 9, sat = 7 + hash(d.id + 17) * 9;
      const p = el('path', { d: d.d, class: 'district', fill: `hsl(${h} ${sat}% ${l}%)`, stroke: '#0a0807', 'stroke-width': 3.4, 'stroke-linejoin': 'round' }, L.districts);
      el('path', { d: d.d, fill: 'url(#wood)', opacity: 0.9, 'pointer-events': 'none' }, L.districts);
      dEls[d.id] = p;
      const t = el('path', { d: d.d, class: 'tint', fill: 'none', 'pointer-events': 'none' }, L.tints);
      tintEls[d.id] = t;
      const hit = el('path', { d: d.d, class: 'hit', 'data-district': d.id, fill: 'transparent' }, L.hit);
      hitEls[d.id] = hit;
    });

    /* river + lake + bridges */
    el('path', { d: MAP.lake.d, fill: 'url(#lakeGrad)', stroke: '#04080c', 'stroke-width': 5, 'stroke-linejoin': 'round' }, L.water);
    el('path', { d: MAP.river, fill: 'none', stroke: '#04080c', 'stroke-width': 17, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, L.water);
    el('path', { d: MAP.river, fill: 'none', stroke: '#13222f', 'stroke-width': 11, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, L.water);
    el('path', { d: MAP.river, class: 'river-flow', fill: 'none', stroke: 'rgba(120,170,210,.22)', 'stroke-width': 3, 'stroke-dasharray': '3 12', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, L.water);
    MAP.bridges.forEach((b) => {
      const g = el('g', { transform: `translate(${b.x} ${b.y}) rotate(${b.angle})` }, L.bridges);
      el('rect', { x: -b.len / 2 - 2, y: -8, width: b.len + 4, height: 16, rx: 2, fill: '#0a0705' }, g);
      el('rect', { x: -b.len / 2, y: -6, width: b.len, height: 12, rx: 1.5, fill: '#8a6b43', stroke: '#2d2112', 'stroke-width': 1 }, g);
      for (let i = -b.len / 2 + 5; i < b.len / 2 - 2; i += 6) el('line', { x1: i, y1: -6, x2: i, y2: 6, stroke: '#2d2112', 'stroke-width': 1 }, g);
    });

    /* labels + hideout markers */
    D.forEach((d) => {
      const t = el('text', { x: d.cx, y: d.cy + 27, class: 'dlabel', 'text-anchor': 'middle', 'font-size': Math.min(14.5, d.fs) }, L.labels);
      t.textContent = d.name;
      labelEls[d.id] = t;
      if (hasHideout.has(d.id)) {
        const f = flagPos(d.id);
        const g = el('g', { class: 'flag', transform: `translate(${f.x} ${f.y})`, 'data-flag': d.id }, L.marks);
        el('ellipse', { cx: 0, cy: 1, rx: 11, ry: 3.5, fill: 'rgba(0,0,0,.45)' }, g);
        const body = el('path', { class: 'flag-body', d: 'M-8 0V-19H-2.6V-5.4H8.6V0Z', fill: '#cfc9bb', stroke: '#0a0807', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, g);
        flagEls[d.id] = { g, body };
      }
    });
    el('rect', { x: -2, y: -2, width: W + 4, height: H + 4, fill: 'url(#vignette)', 'pointer-events': 'none' }, L.shade);

    /* ---------------------------------------------------------------- units */
    const unitEls = new Map();
    function makeUnit(u) {
      const c = COLORS[u.owner];
      const g = el('g', { class: 'unit', 'data-unit': u.id });
      const p = unitPos(u.at);
      g.style.transform = `translate(${p.x}px, ${p.y}px)`;
      const body = el('g', { class: 'unit-body' }, g);
      el('ellipse', { cx: 0, cy: 11.5, rx: 12.5, ry: 4.4, fill: 'rgba(0,0,0,.55)' }, body);
      el('path', { class: 'u-body', d: 'M-10.5 11.5C-11.5 -1.5 -6.5 -7 0 -7C6.5 -7 11.5 -1.5 10.5 11.5Z', fill: c.hex, stroke: '#0a0807', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, body);
      el('path', { d: 'M-4.2 -6.4L0 -1.6L4.2 -6.4', fill: 'none', stroke: 'rgba(255,255,255,.55)', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }, body);
      el('circle', { cx: 0, cy: -12.5, r: 6.3, fill: '#ecd0aa', stroke: '#0a0807', 'stroke-width': 2.1 }, body);
      el('rect', { x: -4.7, y: -14.2, width: 9.4, height: 2.6, rx: 1, fill: '#0e0b0a' }, body);
      el('path', { d: 'M-10.5 -15.2Q0 -18 10.5 -15.2L8.6 -17.2Q0 -26.5 -8.6 -17.2Z', fill: '#17110e', stroke: '#0a0807', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }, body);
      el('path', { d: 'M-7.4 -17.9Q0 -21 7.4 -17.9L7 -16.4Q0 -18.9 -7 -16.4Z', fill: c.hex }, body);
      const gl = el('path', { d: GLYPHS[u.owner], transform: 'translate(0 3.2) scale(.62)', fill: '#fff', stroke: '#0a0807', 'stroke-width': 1.7, 'paint-order': 'stroke' }, body);
      gl.setAttribute('class', 'u-glyph');
      return g;
    }
    function syncUnits(state) {
      const live = new Set(state.units.map((u) => u.id));
      unitEls.forEach((g, id) => { if (!live.has(id)) { g.remove(); unitEls.delete(id); } });
      state.units.forEach((u) => {
        let g = unitEls.get(u.id);
        if (!g) { g = makeUnit(u); L.units.appendChild(g); unitEls.set(u.id, g); }
        const p = unitPos(u.at);
        g.style.transform = `translate(${p.x}px, ${p.y}px)`;
        g.dataset.at = u.at;
      });
    }

    /* ------------------------------------------------------------ state sync */
    function paintOwners(state) {
      MAP.hideouts.forEach((d) => {
        const o = state.hideouts[d];
        const f = flagEls[d];
        if (f) f.body.setAttribute('fill', o == null ? '#cfc9bb' : COLORS[o].hex);
        tintEls[d].setAttribute('fill', o == null ? 'none' : COLORS[o].hex);
        tintEls[d].setAttribute('fill-opacity', o == null ? 0 : 0.2);
        dEls[d].classList.toggle('is-hideout', true);
      });
    }
    function setState(state) {
      paintOwners(state);
      syncUnits(state);
    }
    function reset() { unitEls.forEach((g) => g.remove()); unitEls.clear(); clearOrders(); clearHighlight(); setSelected(null); L.fx.innerHTML = ''; }

    /* ---------------------------------------------------------- highlights */
    function clearHighlight() {
      L.hl.innerHTML = '';
      hitEls.forEach((h) => h.classList.remove('target', 'target-support', 'target-picked'));
    }
    /** items: [{d, kind: 'move'|'support'|'picked'}] */
    function highlight(items) {
      clearHighlight();
      items.forEach((it) => {
        const h = hitEls[it.d];
        h.classList.add(it.kind === 'support' ? 'target-support' : it.kind === 'picked' ? 'target-picked' : 'target');
        const ring = el('path', { d: D[it.d].d, class: 'hl hl-' + it.kind, fill: 'none' }, L.hl);
        ring.setAttribute('stroke-linejoin', 'round');
      });
    }
    let selRing = null;
    function setSelected(unitId) {
      if (selRing) { selRing.remove(); selRing = null; }
      unitEls.forEach((g) => g.classList.remove('selected'));
      if (unitId == null) return;
      const g = unitEls.get(unitId);
      if (!g) return;
      g.classList.add('selected');
    }

    /* -------------------------------------------------------------- orders */
    function clearOrders() { L.orders.innerHTML = ''; }
    function arrowPath(a, b, bend) {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const s = { x: a.x + ux * 15, y: a.y + uy * 15 };
      const e = { x: b.x - ux * 21, y: b.y - uy * 21 };
      const nx = -uy, ny = ux, k = Math.min(18, len * 0.14) * (bend || 1);
      const c = { x: (s.x + e.x) / 2 + nx * k, y: (s.y + e.y) / 2 + ny * k };
      return { d: `M${s.x.toFixed(1)} ${s.y.toFixed(1)} Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${e.x.toFixed(1)} ${e.y.toFixed(1)}`, mid: { x: (s.x + 2 * c.x + e.x) / 4, y: (s.y + 2 * c.y + e.y) / 4 } };
    }
    function bubble(parent, x, y, text, color) {
      const g = el('g', { class: 'bubble', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, parent);
      el('circle', { r: 9.5, fill: '#120e0b', stroke: color, 'stroke-width': 2.4 }, g);
      const t = el('text', { y: 4.4, 'text-anchor': 'middle', class: 'bubble-text' }, g);
      t.textContent = text;
      return g;
    }
    /**
     * items: [{unitId, owner, at, order}]; opts: {selectedUnit, dim}
     * Draws moves as arrows, supports as dashed links, holds as little shields.
     */
    function drawOrders(items, opts) {
      opts = opts || {};
      clearOrders();
      const byDistrict = {};
      (opts.units || []).forEach((u) => { byDistrict[u.at] = u; });
      items.forEach((it) => {
        const c = COLORS[it.owner]; const o = it.order; if (!o) return;
        const sel = opts.selectedUnit === it.unitId;
        const g = el('g', { class: 'ord' + (sel ? ' sel' : '') + (it.dim ? ' dim' : ''), 'data-order-unit': it.unitId }, L.orders);
        const a = unitPos(it.at);
        if (o.type === 'move') {
          const p = arrowPath(a, unitPos(o.to));
          el('path', { d: p.d, class: 'arrow-bg', fill: 'none', stroke: '#050303', 'stroke-width': sel ? 9.5 : 8, 'stroke-linecap': 'round', opacity: 0.7 }, g);
          el('path', { d: p.d, class: 'arrow', fill: 'none', stroke: c.hex, 'stroke-width': sel ? 5.2 : 4, 'stroke-linecap': 'round', 'marker-end': `url(#arrow-${it.owner})` }, g);
        } else if (o.type === 'support') {
          const from = unitPos(o.from);
          const anchor = o.into == null ? from : { x: (from.x + unitPos(o.into).x) / 2, y: (from.y + unitPos(o.into).y) / 2 };
          const p = arrowPath(a, anchor, 0.6);
          el('path', { d: p.d, fill: 'none', stroke: '#050303', 'stroke-width': 6.5, 'stroke-linecap': 'round', opacity: 0.6 }, g);
          el('path', { d: p.d, class: 'support-line', fill: 'none', stroke: c.hex, 'stroke-width': 3.4, 'stroke-dasharray': '1 7', 'stroke-linecap': 'round' }, g);
          // little +1 on the supporter's side
          bubble(g, a.x + 16, a.y - 16, '+1', c.hex).classList.add('plus');
          if (o.into != null) {
            // show where the helped unit is meant to go
            const q = arrowPath(from, unitPos(o.into), -0.5);
            el('path', { d: q.d, fill: 'none', stroke: c.hex, 'stroke-width': 1.8, 'stroke-dasharray': '2 6', opacity: 0.8, 'stroke-linecap': 'round', 'marker-end': `url(#arrow-${it.owner})` }, g);
          }
        } else {
          const sh = el('g', { transform: `translate(${(a.x + 15).toFixed(1)} ${(a.y - 13).toFixed(1)})` }, g);
          el('path', { d: 'M0-9L8-5.5V1C8 6 4.5 9 0 11C-4.5 9-8 6-8 1V-5.5Z', fill: '#17110e', stroke: c.hex, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, sh);
          el('path', { d: 'M-3 0L-.8 2.6L3.4 -2.6', fill: 'none', stroke: c.hex, 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sh);
        }
      });
    }
    /** After the orders are revealed: strength bubbles for moves and supported holds. */
    function showStrengths(results) {
      const g = el('g', { class: 'strengths' }, L.orders);
      results.forEach((r) => {
        const c = COLORS[r.owner];
        if (r.order.type === 'move') {
          const p = arrowPath(unitPos(r.at), unitPos(r.order.to));
          bubble(g, p.mid.x, p.mid.y, String(r.strength), c.hex).classList.add('pop');
        } else if (r.order.type === 'hold' && r.strength > 1) {
          const a = unitPos(r.at);
          bubble(g, a.x - 17, a.y - 13, String(r.strength), c.hex).classList.add('pop');
        }
      });
    }

    /* ------------------------------------------------------------------ fx */
    function floatText(x, y, text, color, cls) {
      const t = el('text', { x, y, 'text-anchor': 'middle', class: 'fx-float ' + (cls || ''), fill: color || '#fff' }, L.fx);
      t.textContent = text;
      setTimeout(() => t.remove(), 1800);
    }
    function stars(x, y) {
      const g = el('g', { transform: `translate(${x} ${y})`, class: 'fx-stars' }, L.fx);
      for (let i = 0; i < 5; i++) {
        const s = el('path', { d: starPath(6, 2.6), fill: i % 2 ? '#ffe27a' : '#fff', stroke: '#0a0807', 'stroke-width': 1.2, class: 'fx-star', style: `--a:${i * 72 - 90}deg` }, g);
        s.style.animationDelay = (i * 25) + 'ms';
      }
      setTimeout(() => g.remove(), 1400);
    }
    function pulseDistrict(d, color) {
      const p = el('path', { d: D[d].d, fill: color, stroke: color, 'stroke-width': 4, class: 'fx-district' }, L.fx);
      setTimeout(() => p.remove(), 1200);
    }

    /* ---------------------------------------------------------- interaction */
    const pointers = new Map();
    let down = null, pinch = null;
    const TAP_PX = 9;

    svg.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cam.stop();
      if (pointers.size === 1) {
        down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, target: e.target, lastX: e.clientX, lastY: e.clientY };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        if (down) down.moved = true;
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.dist > 0) cam.zoomAt(dist / pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch.dist = dist;
        return;
      }
      if (down && pointers.size === 1) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (!down.moved && Math.hypot(dx, dy) > TAP_PX) down.moved = true;
        if (down.moved) {
          cam.panBy(e.clientX - down.lastX, e.clientY - down.lastY);
          svg.classList.add('panning');
        }
        down.lastX = e.clientX; down.lastY = e.clientY;
      }
    });
    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      svg.classList.remove('panning');
      if (down && pointers.size === 0) {
        const d = down; down = null;
        if (!d.moved && e.type === 'pointerup' && performance.now() - d.t < 700) {
          const t = d.target && d.target.closest ? d.target.closest('[data-district]') : null;
          if (t && handlers.onDistrict) handlers.onDistrict(Number(t.getAttribute('data-district')));
          else if (handlers.onBackground) handlers.onBackground();
        }
      }
    }
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') endPointer(e); });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      cam.stop();
      cam.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY);
    }, { passive: false });

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => cam.resize()) : null;
    if (ro) ro.observe(svg); else window.addEventListener('resize', cam.resize);
    cam.resize();

    return {
      svg, camera: cam, L, MAP,
      setState, reset, highlight, clearHighlight, setSelected,
      drawOrders, clearOrders, showStrengths,
      unitEl: (id) => unitEls.get(id),
      unitPos, flagPos,
      flagEl: (d) => flagEls[d],
      floatText, stars, pulseDistrict,
      makeUnit, addUnitEl(u) { let g = unitEls.get(u.id); if (!g) { g = makeUnit(u); L.units.appendChild(g); unitEls.set(u.id, g); } return g; },
      removeUnitEl(id) { const g = unitEls.get(id); if (g) { g.remove(); unitEls.delete(id); } },
      paintOwners, syncUnits,
      destroy() { if (ro) ro.disconnect(); },
    };
  }

  function glyphSVG(owner, size) {
    const c = COLORS[owner];
    const sz = size || 18;
    return `<svg class="glyph" width="${sz}" height="${sz}" viewBox="-6 -6 12 12" aria-hidden="true"><path d="${GLYPHS[owner]}" fill="${c.hex}" stroke="#0a0807" stroke-width=".9" stroke-linejoin="round"/></svg>`;
  }
  function flagSVG(color, size) {
    const sz = size || 16;
    return `<svg class="lflag" width="${sz}" height="${sz}" viewBox="-10 -21 20 23" aria-hidden="true"><path d="M-8 0V-19H-2.6V-5.4H8.6V0Z" fill="${color}" stroke="#0a0807" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }

  root.SpeakTheme = { COLORS, GLYPHS, glyphSVG, flagSVG };
  root.SpeakBoard = { create };
})(typeof self !== 'undefined' ? self : this);
