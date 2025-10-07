// /public/agent-booking.js
// Booking signal handler + ElevenLabs TTS helper (with a tiny queue)
(function () {
  const tzLocal = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  /* ---------------------------- BOOKING SIGNAL ---------------------------- */
  function parseSignal(text) {
    const tag = '<<BOOK>>';
    const i = text.indexOf(tag);
    if (i === -1) return null;
    const j = text.indexOf('{', i);
    if (j === -1) return null;
    const k = text.lastIndexOf('}');
    if (k === -1 || k < j) return null;
    try { return JSON.parse(text.slice(j, k + 1)); } catch { return null; }
  }

  async function postBooking(payload) {
    const r = await fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  }

  async function onAssistantText(text) {
    // 1) watch for booking signal
    const sig = parseSignal(text);
    if (sig) {
      const payload = {
        fullName: sig.fullName || sig.name,
        email: sig.email,
        phone: sig.phone || '',
        company: sig.company || '',
        date: sig.date,          // YYYY-MM-DD
        time: sig.time,          // HH:mm (24h)
        timeZone: sig.timeZone || tzLocal,
        duration: sig.duration || 60,
        source: 'voice-agent'
      };
      if (payload.fullName && payload.email && payload.date && payload.time) {
        try {
          await postBooking(payload);
          // Tell the model it worked so it can respond (we’ll TTS that too)
          window.oaiRTCPeer?.dc?.send(JSON.stringify({
            type: 'response.create',
            response: {
              instructions:
                `Perfect — I’ve booked ${payload.fullName} for ${payload.date} ${payload.time} ${payload.timeZone}. ` +
                `I emailed a calendar invite and we’ll reply shortly with call details.`
            }
          }));
        } catch (e) {
          console.error('voice booking error:', e);
          window.oaiRTCPeer?.dc?.send(JSON.stringify({
            type: 'response.create',
            response: {
              instructions:
                `I hit a booking error. We can try again now, or you can use the form on the site.`
            }
          }));
        }
      }
    }

    // 2) speak whatever the assistant said (using ElevenLabs)
    if (text && text.trim()) TTSQueue.enqueue(text.trim());
  }

  /* ---------------------------- ELEVENLABS TTS --------------------------- */
  async function playTTS(text, opts = {}) {
    const r = await fetch('/api/elevenlabs/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voiceId: opts.voiceId,   // optional override
        modelId: opts.modelId    // optional override
      })
    });
    if (!r.ok) {
      console.error('TTS failed', await r.text().catch(() => r.statusText));
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    try {
      await new Audio(url).play();
    } catch (err) {
      console.warn('Audio play error:', err);
    } finally {
      // release object URL after a short delay
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  // Simple FIFO queue so clips don’t overlap
  const TTSQueue = (() => {
    let chain = Promise.resolve();
    function enqueue(text, opts) {
      chain = chain.then(() => playTTS(text, opts)).catch(() => {});
      return chain;
    }
    return { enqueue };
  })();

  // Export hooks for the realtime SDK
  window.AGENT_BOOKING = {
    onAssistantText,     // call this for every assistant message
    speak: (text, opts) => TTSQueue.enqueue(text, opts) // optional direct TTS
  };

  // Also expose a global helper (handy for a greeting button)
  window.playTTS = (text, opts) => TTSQueue.enqueue(text, opts);
})();
