// /public/agent-booking.js
(function () {
  const tzLocal = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function parseSignal(text) {
    const tag = '<<BOOK>>';
    const i = text.indexOf(tag);
    if (i === -1) return null;
    const j = text.indexOf('{', i);
    if (j === -1) return null;
    // try to grab the last } in the chunk
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
    const sig = parseSignal(text);
    if (!sig) return;

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
    if (!payload.fullName || !payload.email || !payload.date || !payload.time) return;

    try {
      await postBooking(payload);

      // Tell the model it worked (so she speaks it)
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

  // Expose a single hook the SDK can call whenever assistant text arrives
  window.AGENT_BOOKING = { onAssistantText };
})();

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
  const audio = new Audio(url);
  audio.play().catch(console.warn);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
}

// Hook up the hero button
document.getElementById('demo-tts')?.addEventListener('click', () => {
  playTTS("Hi! I'm your Agentlyne voice agent. Ask me anything or book a call—I'll handle it.");
});
