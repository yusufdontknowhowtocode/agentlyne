/*!
 * OpenAI Realtime (WebRTC) client for Agentlyne
 * - STUN + keepalive pings
 * - Disable Opus DTX (prevents NAT idle timeouts)
 * - Auto-reconnect on disconnect/failed
 * - Parses <<BOOK>>{...} from assistant output and POSTs /api/book
 * - Still forwards assistant text to window.AGENT_BOOKING.onAssistantText(finalText)
 */
(function () {
  let current = null;
  let lastOpts = null;
  let reconnectTimer = null;
  let pingTimer = null;

  // prevent duplicate posts if a response is retried
  const postedResponseIds = new Set();

  function scheduleReconnect(reason, delay = 800) {
    if (reconnectTimer) return;
    console.warn('[webrtc] reconnect scheduled:', reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      try { stop(); } catch {}
      if (lastOpts) start(lastOpts).catch(e => console.error('reconnect failed:', e));
    }, delay);
  }

  // ---- booking parsing + POST ----
  function tryParseBookingLine(finalText) {
    // Be forgiving: find any line that starts with <<BOOK>>
    const line = (finalText || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .find(s => s.startsWith('<<BOOK>>'));
    if (!line) return null;

    const raw = line.slice('<<BOOK>>'.length).trim();
    try {
      const obj = JSON.parse(raw);
      // minimal validation
      const need = ['fullName', 'email', 'date', 'time', 'timeZone'];
      const missing = need.filter(k => !obj?.[k] || String(obj[k]).trim() === '');
      if (missing.length) {
        console.warn('[book] missing fields from agent:', missing, obj);
        return null;
      }
      if (!obj.duration) obj.duration = 60;
      if (!obj.source) obj.source = 'voice-agent';
      return obj;
    } catch (e) {
      console.warn('[book] bad JSON from agent:', raw, e);
      return null;
    }
  }

  function postBooking(payload) {
    console.log('[book] posting:', payload);
    return fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(r => r.json())
    .then(j => {
      console.log('[book] server response:', j);
      if (!j?.ok) console.warn('[book] NOT OK:', j);
      return j;
    })
    .catch(e => {
      console.error('[book] post failed:', e);
      throw e;
    });
  }

  async function start({ voice = 'verse', instructions } = {}) {
    lastOpts = { voice, instructions };
    if (current?.pc) stop();

    // 1) Ask our server for an ephemeral client key (server injects booking protocol)
    const sessionRes = await fetch('/api/openai/realtime-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice, instructions })
    });
    if (!sessionRes.ok) throw new Error('Failed to create realtime session');
    const session = await sessionRes.json();
    const EPHEMERAL = session?.client_secret?.value || session?.client_secret || session?.clientSecret;
    if (!EPHEMERAL) throw new Error('No client secret returned');

    // 2) WebRTC peer connection with STUN
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
      ],
      bundlePolicy: 'balanced',
      iceTransportPolicy: 'all'
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      console.log('[webrtc] ice:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch {}
        scheduleReconnect('ice failed', 500);
      } else if (pc.iceConnectionState === 'disconnected') {
        scheduleReconnect('ice disconnected', 1500);
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      console.log('[webrtc] conn:', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        scheduleReconnect('conn state ' + pc.connectionState, 800);
      }
    });

    // remote audio sink
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    // 3) mic upstream (enable common processing)
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    mic.getTracks().forEach(t => {
      const sender = pc.addTrack(t, mic);
      // Disable Opus DTX to avoid "no packets during silence"
      try {
        const p = sender.getParameters();
        p.encodings = p.encodings || [{}];
        p.encodings[0].dtx = false; // keep packets flowing
        sender.setParameters(p);
      } catch {}
    });

    // 4) keepalive data channel we control
    const dcKeep = pc.createDataChannel('client-keepalive');
    dcKeep.onopen = () => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (dcKeep.readyState === 'open') {
          dcKeep.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }
      }, 8000);
    };
    dcKeep.onclose = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

    // 5) Handle ANY incoming datachannel; parse events and also raw text
    let eventsDc = null;
    const buffers = Object.create(null); // responseId -> aggregated text

    function getResponseId(m) {
      return m?.response_id || m?.response?.id || m?.id || m?.response?.response_id || null;
    }
    function handleEventMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.type) {
        case 'response.created': {
          const id = getResponseId(msg) || msg?.response?.id;
          if (id && !(id in buffers)) buffers[id] = '';
          break;
        }
        case 'response.output_text.delta': {
          const id = msg?.response_id || getResponseId(msg);
          const delta = typeof msg.delta === 'string' ? msg.delta : (msg?.delta?.toString?.() || '');
          if (id && delta != null) buffers[id] = (buffers[id] || '') + delta;
          break;
        }
        case 'response.completed': {
          const id = getResponseId(msg);
          const finalText = (id && buffers[id] != null) ? buffers[id] : '';
          // Forward to optional hook
          if (finalText && window.AGENT_BOOKING?.onAssistantText) {
            try { window.AGENT_BOOKING.onAssistantText(finalText); } catch {}
          }
          // Booking capture
          if (finalText && id && !postedResponseIds.has(id)) {
            const payload = tryParseBookingLine(finalText);
            if (payload) {
              postedResponseIds.add(id);
              postBooking(payload).catch(()=>{});
            }
          }
          if (id) delete buffers[id];
          break;
        }
        case 'response.error':
        case 'response.cancelled': {
          const id = getResponseId(msg);
          if (id && buffers[id] != null) delete buffers[id];
          break;
        }
      }
    }

    pc.ondatachannel = (e) => {
      const ch = e.channel;
      console.log('[webrtc] datachannel:', ch.label);
      // If OpenAI emits "oai-events", parse the structured events.
      if (ch.label === 'oai-events') {
        eventsDc = ch;
        ch.onmessage = (ev) => { if (typeof ev.data === 'string') handleEventMessage(ev.data); };
      } else {
        // Fallback: if any plain text comes through, scan for booking line.
        ch.onmessage = (ev) => {
          const s = (typeof ev.data === 'string') ? ev.data : '';
          if (!s) return;
          // Try immediate parse (some models might push the whole text here)
          const payload = tryParseBookingLine(s);
          if (payload) postBooking(payload).catch(()=>{});
          // Also forward raw text to hook
          if (window.AGENT_BOOKING?.onAssistantText) {
            try { window.AGENT_BOOKING.onAssistantText(s); } catch {}
          }
        };
      }
      ch.onclose = () => console.log('[dc] closed:', ch.label);
      ch.onerror = (err) => console.warn('[dc] error', ch.label, err);
      window.oaiRTCPeer = { pc, dc: eventsDc || ch }; // expose for other scripts
    };

    // 6) offer/answer via HTTPS SDP
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    const url = 'https://api.openai.com/v1/realtime?model='
      + encodeURIComponent('gpt-4o-realtime-preview')
      + '&voice=' + encodeURIComponent(voice);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${EPHEMERAL}`,
        'Content-Type': 'application/sdp'
      },
      body: offer.sdp
    });
    const answerSdp = await resp.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    current = { pc, mic, audioEl, eventsDc, dcKeep };
    window.oaiRTCPeer = { pc, dc: eventsDc };
    console.log('[webrtc] connected');
    return current;
  }

  function stop() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    try { current?.dcKeep?.close?.(); } catch {}
    try { current?.eventsDc?.close?.(); } catch {}
    try {
      current?.pc?.getSenders()?.forEach(s => { try { s.track && s.track.stop(); } catch {} });
      current?.pc?.close?.();
    } catch {}
    current = null;
    try { delete window.oaiRTCPeer; } catch {}
  }

  window.OpenAIRealtime = { start, stop };
})();
