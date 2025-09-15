/*!
 * OpenAI Realtime (WebRTC) minimal client for the Agentlyne live demo
 */
(function () {
  let current = null;

  async function start({ voice = 'verse', instructions } = {}) {
    if (current?.pc) stop();

    // 1) Ask our server for an ephemeral client key
    const sessionRes = await fetch('/api/openai/realtime-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice, instructions })
    });
    if (!sessionRes.ok) throw new Error('Failed to create realtime session');
    const session = await sessionRes.json();
    const EPHEMERAL = session.client_secret?.value;
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

    // 4) optional data channel
    pc.createDataChannel('oai-events');

    // 5) offer/answer via HTTPS SDP
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const url = 'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&voice=' + encodeURIComponent(voice);
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

    current = { pc, mic, audioEl };
    return current;
  }

  function stop() {
    try {
      current?.pc?.getSenders()?.forEach(s => s.track && s.track.stop());
      current?.pc?.close?.();
    } catch {}
    current = null;
  }

  window.OpenAIRealtime = { start, stop };
})();
