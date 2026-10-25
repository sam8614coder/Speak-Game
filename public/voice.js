/* SPEAK ONLINE - voice calls (WebRTC mesh, signalling relayed by the game server).
   Rules of the phones:
     * "open table": everyone on voice with line === 'all' hears each other
     * private line: only players sharing the same line id hear each other
   Each peer connection has one audio transceiver; the outgoing track is attached
   (replaceTrack) only for peers we are allowed to talk to, and incoming audio is
   muted for peers on another line. */
(function (root) {
  'use strict';
  const S = { send: null, ice: [], onUpdate: function () {}, stream: null, track: null, muted: false, on: false,
    peers: {}, me: null, players: [], levels: {}, ctx: null, raf: 0, audioEls: {}, error: '' };

  function notify() { try { S.onUpdate(); } catch (e) { /* ignore */ } }
  function myPlayer() { return S.players.find(function (p) { return p.id === S.me; }); }
  function canTalk(q) { const me = myPlayer(); return !!(me && q && me.voice && q.voice && me.line === q.line); }

  function meter(id, stream) {
    try {
      const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return;
      if (!S.ctx) S.ctx = new AC();
      const src = S.ctx.createMediaStreamSource(stream); const an = S.ctx.createAnalyser(); an.fftSize = 512;
      src.connect(an); S.levels[id] = { an: an, buf: new Uint8Array(an.fftSize), v: 0, src: src };
      if (!S.raf) loop();
    } catch (e) { /* meters are cosmetic */ }
  }
  function loop() {
    let changed = false;
    Object.keys(S.levels).forEach(function (id) {
      const l = S.levels[id]; l.an.getByteTimeDomainData(l.buf);
      let m = 0; for (let i = 0; i < l.buf.length; i++) { const d = Math.abs(l.buf[i] - 128); if (d > m) m = d; }
      const v = m > 9 ? 1 : 0; if (v !== l.v) { l.v = v; changed = true; }
    });
    if (changed) notify();
    S.raf = Object.keys(S.levels).length ? root.requestAnimationFrame(loop) : 0;
  }
  function dropMeter(id) { const l = S.levels[id]; if (l) { try { l.src.disconnect(); } catch (e) { /* ignore */ } delete S.levels[id]; } }

  /* The side with the lower id makes the offer and owns a pre-made transceiver;
     the answering side adopts the transceiver created from the offer (see handleSignal). */
  function makePeer(id, offerer) {
    const pc = new RTCPeerConnection({ iceServers: S.ice });
    const peer = { id: id, pc: pc, tr: offerer ? pc.addTransceiver('audio', { direction: 'sendrecv' }) : null, pending: [], remoteSet: false, state: 'new', sending: false };
    S.peers[id] = peer;
    pc.onicecandidate = function (e) { if (e.candidate) S.send({ t: 'rtc', to: id, data: { c: e.candidate } }); };
    pc.ontrack = function (e) {
      const stream = e.streams[0] || new MediaStream([e.track]);
      let el = S.audioEls[id];
      if (!el) { el = new Audio(); el.autoplay = true; el.playsInline = true; S.audioEls[id] = el; }
      el.srcObject = stream; const pr = el.play(); if (pr && pr.catch) pr.catch(function () { /* needs gesture, retried on next click */ });
      dropMeter(id); meter(id, stream); applyGate();
    };
    pc.onconnectionstatechange = function () {
      peer.state = pc.connectionState; notify();
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch (e) { /* ignore */ } if (S.me < id) offer(peer, true); }
    };
    return peer;
  }
  async function offer(peer, iceRestart) {
    try {
      const o = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await peer.pc.setLocalDescription(o);
      S.send({ t: 'rtc', to: peer.id, data: { d: peer.pc.localDescription } });
    } catch (e) { /* will retry on next sync */ }
  }
  function closePeer(id) {
    const p = S.peers[id]; if (!p) return;
    try { p.pc.close(); } catch (e) { /* ignore */ }
    delete S.peers[id]; dropMeter(id);
    const el = S.audioEls[id]; if (el) { el.srcObject = null; delete S.audioEls[id]; }
  }

  function applyGate() {
    const me = myPlayer();
    Object.keys(S.peers).forEach(function (id) {
      const peer = S.peers[id]; const q = S.players.find(function (x) { return x.id === id; });
      const allow = canTalk(q);
      const want = allow && S.track && !S.muted ? S.track : null;
      if (peer.tr && peer.sending !== !!want) { peer.sending = !!want; try { peer.tr.sender.replaceTrack(want); } catch (e) { /* ignore */ } }
      const el = S.audioEls[id]; if (el) el.muted = !allow;
    });
    if (me && S.track) S.track.enabled = !S.muted;
  }

  const Voice = {
    supported: function () { return !!(root.RTCPeerConnection && root.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },
    init: function (o) { S.send = o.send; S.ice = o.iceServers || S.ice; S.onUpdate = o.onUpdate || S.onUpdate; },
    setIce: function (l) { S.ice = l; },
    isOn: function () { return S.on; },
    isMuted: function () { return S.muted; },
    error: function () { return S.error; },
    level: function (id) { const l = S.levels[id]; return !!(l && l.v) && (id !== S.me || !S.muted); },
    peerState: function (id) { const p = S.peers[id]; return p ? p.state : 'none'; },
    join: async function () {
      if (S.on) return true;
      S.error = '';
      if (!Voice.supported()) { S.error = 'Voice needs a modern browser and a secure (https) connection.'; notify(); return false; }
      try {
        S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      } catch (e) {
        S.error = (e && e.name === 'NotAllowedError') ? 'Microphone blocked. Allow it in the browser address bar, then try again.' : 'Could not open a microphone.';
        notify(); return false;
      }
      S.track = S.stream.getAudioTracks()[0]; S.on = true; S.muted = false;
      meter(S.me, S.stream);
      S.send({ t: 'voice', on: true }); notify(); return true;
    },
    leave: function () {
      if (!S.on) return;
      S.on = false;
      Object.keys(S.peers).forEach(closePeer);
      if (S.stream) S.stream.getTracks().forEach(function (t) { t.stop(); });
      S.stream = null; S.track = null; dropMeter(S.me);
      S.send({ t: 'voice', on: false }); notify();
    },
    setMuted: function (m) { S.muted = !!m; applyGate(); notify(); },
    /* called on every server snapshot */
    sync: function (players, myId) {
      S.players = players; S.me = myId;
      if (!S.on) return;
      const live = {};
      players.forEach(function (q) {
        if (q.id === myId || !q.voice || !q.connected) return;
        live[q.id] = 1;
        if (!S.peers[q.id]) { const off = myId < q.id; const peer = makePeer(q.id, off); if (off) offer(peer); }
      });
      Object.keys(S.peers).forEach(function (id) { if (!live[id]) closePeer(id); });
      applyGate(); notify();
    },
    handleSignal: async function (from, data) {
      if (!S.on || !data) return;
      let peer = S.peers[from];
      if (!peer) { const q = S.players.find(function (x) { return x.id === from; }); if (!q) return; peer = makePeer(from, false); }
      const pc = peer.pc;
      try {
        if (data.d) {
          if (data.d.type === 'offer') {
            if (pc.signalingState !== 'stable') { if (S.me < from) return; await pc.setLocalDescription({ type: 'rollback' }); }
            await pc.setRemoteDescription(data.d); peer.remoteSet = true;
            if (!peer.tr) {
              peer.tr = pc.getTransceivers().find(function (t) { return t.receiver && t.receiver.track && t.receiver.track.kind === 'audio'; }) || null;
              if (peer.tr) peer.tr.direction = 'sendrecv';
              applyGate();
            }
            await pc.setLocalDescription(await pc.createAnswer());
            S.send({ t: 'rtc', to: from, data: { d: pc.localDescription } });
          } else if (data.d.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription(data.d); peer.remoteSet = true; }
          }
          while (peer.pending.length && peer.remoteSet) { await pc.addIceCandidate(peer.pending.shift()); }
        } else if (data.c) {
          if (peer.remoteSet) await pc.addIceCandidate(data.c); else peer.pending.push(data.c);
        }
      } catch (e) { /* stale signalling is harmless */ }
    },
    /* retry blocked autoplay after a user gesture */
    resume: function () { if (S.ctx && S.ctx.state === 'suspended') S.ctx.resume(); Object.keys(S.audioEls).forEach(function (k) { const p = S.audioEls[k].play(); if (p && p.catch) p.catch(function () {}); }); },
    _state: S,
  };
  root.SpeakVoice = Voice;
})(typeof window !== 'undefined' ? window : globalThis);
