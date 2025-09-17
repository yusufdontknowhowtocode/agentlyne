/*!
 * OpenAI Realtime (WebRTC) client for Agentlyne — with booking signal hook
 * - Injects instructions via /api/openai/realtime-session
 * - Listens to assistant responses over the "oai-events" data channel
 * - Buffers text and, on completion, forwards it to window.AGENT_BOOKING.onAssistantText
 * - Exposes window.oaiRTCPeer = { pc, dc } so other scripts can send control msgs
 */
(function () {
  let current = null;

  async function start({ voice = 'verse', instructions } = {}) {
    if (current?.pc) stop();

    // 1) Ask our server for an ephemeral client key (it also injects booking protocol)
    const sessionRes = await fetch('/api/openai/realtime-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice, instructions })
    });
    if (!sessionRes.ok) throw new Error('Failed to create realtime session');
    const session = await sessionRes.json();
    const EPHEMERAL = session?.client_secret?.value || session?.client_secret || session?.clientSecret;
    if (!EPHEMERAL) throw new Error('No client secret returned');

    // 2) WebRTC peer connection
    const pc = new RTCPeerConnection();

    // remote audio sink
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    // 3) mic upstream
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.getTracks().forEach(t => pc.addTrack(t, mic));

    // 4) receive OpenAI data channel with response events
    let dc = null;
    const buffers = Object.create(null); // responseId -> aggregated text

    function getResponseId(m) {
      return m?.response_id || m?.response?.id || m?.id || m?.response?.response_id || null;
    }

    function handleEventMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Collect assistant text until completion, then forward to booking hook.
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
          if (finalText && window.AGENT_BOOKING?.onAssistantText) {
            try { window.AGENT_BOOKING.onAssistantText(finalText); } catch {}
          }
          if (id) delete buffers[id];
          break;
        }
        // (optional) clear buffers if cancelled/errored
        case 'response.error':
        case 'response.cancelled': {
          const id = getResponseId(msg);
          if (id && buffers[id] != null) delete buffers[id];
          break;
        }
        default:
          // ignore other event types
          break;
      }
    }

    pc.ondatachannel = (e) => {
      // OpenAI sends a channel named "oai-events"
      dc = e.channel;
      window.oaiRTCPeer = { pc, dc }; // expose so other scripts can send messages
      dc.onopen = () => console.log('[oai-events] open');
      dc.onclose = () => console.log('[oai-events] closed');
      dc.onerror = (err) => console.warn('[oai-events] error', err);
      dc.onmessage = (ev) => {
        // Messages can be JSON (events) or raw text; we only care about JSON events
        if (typeof ev.data === 'string') handleEventMessage(ev.data);
      };
    };

    // 5) offer/answer via HTTPS SDP
    const offer = await pc.createOffer();
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

    current = { pc, mic, audioEl, dc };
    window.oaiRTCPeer = { pc, dc }; // ensure global reference exists even if dc arrives slightly later
    return current;
  }

  function stop() {
    try {
      if (current?.dc) { try { current.dc.close(); } catch {} }
      if (current?.pc) {
        current.pc.getSenders()?.forEach(s => { try { s.track && s.track.stop(); } catch {} });
        current.pc.close?.();
      }
    } catch {}
    current = null;
    try { delete window.oaiRTCPeer; } catch {}
  }

  window.OpenAIRealtime = { start, stop };
})();
