// Loads .env locally (on Render, env vars are injected)
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';
import { promises as dnsPromises } from 'dns';
import fs from 'fs/promises';

// Prefer IPv4 on platforms without IPv6 (avoids ENETUNREACH)
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Force HTTPS behind a proxy (Render/Cloudflare/etc.)
app.enable('trust proxy');
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
  return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* fetch fallback (lazy, no top-level await)                           */
/* ------------------------------------------------------------------ */
let cachedNodeFetch = null;
async function getFetch() {
  if (globalThis.fetch) return globalThis.fetch;
  if (!cachedNodeFetch) {
    const mod = await import('node-fetch');
    cachedNodeFetch = mod.default || mod;
  }
  return cachedNodeFetch;
}

/* ------------------------------------------------------------------ */
/* Dynamic runtime config (used by book/index pages)                   */
/* ------------------------------------------------------------------ */
app.get('/config.js', (_req, res) => {
  const cfg = {
    API_BASE: (process.env.API_BASE ?? ''),
    SUPPORT_EMAIL: (process.env.SUPPORT_EMAIL ?? 'info@agentlyne.com'),
    BRAND_NAME: (process.env.BRAND_NAME ?? 'Agentlyne'),
    CALENDLY_URL: (process.env.CALENDLY_URL ?? ''),
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify(cfg, null, 2)};`);
});

/* ------------------------------------------------------------------ */
/* Static site                                                         */
/* ------------------------------------------------------------------ */
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext && ext !== '.html') res.setHeader('Cache-Control', 'public, max-age=300');
  }
}));

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Serve old /favicon.ico path by redirecting to our PNG (or SVG)
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon-48.png'));


// Debug helper for static assets
app.get('/api/static-check', async (req, res) => {
  try {
    const p = String(req.query.path || '');
    const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(PUBLIC_DIR, safe);
    if (!abs.startsWith(PUBLIC_DIR)) return res.status(400).json({ ok:false, error:'bad path' });
    let exists = false; try { await fs.access(abs); exists = true; } catch {}
    res.json({ ok:true, exists, rel:safe, abs });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

/* ------------------------------------------------------------------ */
/* Utils                                                              */
/* ------------------------------------------------------------------ */
const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
function pick(obj, keys, def = '') { for (const k of keys) { if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]); } return def; }
function tzOffsetMinutesAt(tz, epochMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'shortOffset', year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    }).formatToParts(new Date(epochMs));
    const name = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
    const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1].startsWith('-') ? -1 : 1;
    const h = Math.abs(parseInt(m[1], 10));
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    return sign * (h * 60 + mm);
  } catch { return 0; }
}
function zonedToUtcISO(dateStr, timeStr, tz) {
  if (!dateStr || !timeStr || !tz) return null;
  try {
    const [y,m,d] = dateStr.split('-').map(Number);
    const [H,M]   = timeStr.split(':').map(Number);
    const naiveUTC = Date.UTC(y, (m??1)-1, d??1, H??0, M??0, 0, 0);
    const offMin   = tzOffsetMinutesAt(tz, naiveUTC);
    return new Date(naiveUTC - offMin * 60 * 1000).toISOString();
  } catch { return null; }
}
const p2 = v => v.toString().padStart(2,'0');
function buildLocalIso(dateStr, timeStr, addMinutes = 0) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const [H,M]   = timeStr.split(':').map(Number);
  const dt = new Date(y, m - 1, d, H, M + addMinutes, 0);
  return `${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}T${p2(dt.getHours())}:${p2(dt.getMinutes())}:${p2(dt.getSeconds())}`;
}
function prettyWhen(startISO, endISO, tz) {
  try {
    const s = new Date(startISO), e = new Date(endISO);
    const d  = new Intl.DateTimeFormat('en-US', { weekday:'short', month:'short', day:'numeric', timeZone: tz }).format(s);
    const t1 = new Intl.DateTimeFormat('en-US', { hour:'numeric', minute:'2-digit', timeZone: tz }).format(s);
    const t2 = new Intl.DateTimeFormat('en-US', { hour:'numeric', minute:'2-digit', timeZone: tz }).format(e);
    return `${d} • ${t1}–${t2} (${tz})`;
  } catch { return ''; }
}

/* ------------------------------------------------------------------ */
/* DB (optional) + SMTP bootstrap                                     */
/* ------------------------------------------------------------------ */

// ---- DB (optional)
const USE_DB = !!process.env.DATABASE_URL;
let pool = null;

async function initDbPool() {
  if (!USE_DB) { console.log('DB: disabled (no DATABASE_URL)'); return; }
  try {
    const u = new URL(process.env.DATABASE_URL);
    const host = u.hostname;
    const port = Number(u.port || 5432);
    const user = decodeURIComponent(u.username || '');
    const password = decodeURIComponent(u.password || '');
    const database = (u.pathname || '/').replace(/^\//, '');
    const sslRequired = u.searchParams.get('sslmode') === 'require' || process.env.PGSSLMODE === 'require';

    const { address } = await dnsPromises.lookup(host, { family: 4 });
    pool = new Pool({
      host: address, port, user, password, database,
      ssl: sslRequired ? { rejectUnauthorized: false, servername: host } : undefined,
      keepAlive: true,
    });
    console.log('DB: IPv4 pool ready ->', host);
  } catch (err) {
    console.warn('DB init failed:', err?.message);
  }
}
async function ensureSchema() {
  if (!pool) return; // skip if DB disabled
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id BIGSERIAL PRIMARY KEY,
        created_at timestamptz DEFAULT now(),
        name text, full_name text, email text, phone text, company text, notes text,
        timezone text, start_utc timestamptz, end_utc timestamptz, duration_min integer,
        source text, date date, "time" text
      );
    `);
    console.log('DB: schema ready');
  } catch (err) {
    console.error('DB ensure schema failed:', err?.message);
  }
}

// ---- SMTP
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
const smtpSecure = smtpSecureEnv ? ['1','true','yes','on'].includes(smtpSecureEnv) : smtpPort === 465;

const BRAND = process.env.BRAND_NAME || 'Agentlyne';
const FROM_ADDR = process.env.SMTP_FROM || process.env.FROM_EMAIL || 'no-reply@agentlyne.com';
const FROM_EMAIL = `${BRAND} <${FROM_ADDR}>`;
const SALES_EMAIL = process.env.BOOKINGS_INBOX || process.env.SALES_EMAIL || `sales@agentlyne.com`;

// NEW: archive & tagging knobs (Step-1 Option A)
const ARCHIVE_BCC = (process.env.BCC_ARCHIVE || 'chalfontwebs@gmail.com').trim();
const MAILGUN_TAG = (process.env.MAILGUN_TAG || 'booking').trim();

const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,        // Mailgun: smtp.mailgun.org
  port: smtpPort,                     // 587
  secure: smtpSecure,                 // false for 587, true for 465
  auth: (process.env.SMTP_USER || process.env.SMTP_PASS) ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  tls: { minVersion: 'TLSv1.2' },
  pool: true,
  logger: !!process.env.SMTP_DEBUG,
  debug: !!process.env.SMTP_DEBUG
}) : null;

if (transporter) {
  transporter.verify()
    .then(() => console.log('SMTP: ready (host=%s, port=%d)', process.env.SMTP_HOST, smtpPort))
    .catch(e => console.warn('SMTP verify failed:', e?.message));
} else {
  console.warn('SMTP: disabled (missing SMTP_HOST)');
}

/* ---- ICS builder (TZID, no UTC headaches) ---- */
function icsInvite({ title, description, startLocal, endLocal, tzid, organizerEmail, organizerName='Agentlyne' }) {
  const uid = crypto.randomUUID();
  const stamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const fmt = s => s.replaceAll('-','').replaceAll(':',''); // 'YYYYMMDDTHHMMSS'
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Agentlyne//Booking//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${tzid}:${fmt(startLocal)}`,
    `DTEND;TZID=${tzid}:${fmt(endLocal)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${(description || '').replace(/\n/g,'\\n')}`,
    `ORGANIZER;CN=${organizerName}:mailto:${organizerEmail}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/db-info', async (_req, res) => {
  try {
    if (!pool) return res.json({ ok:false, disabled:true });
    const cols = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='bookings'
      ORDER BY ordinal_position
    `);
    const u = new URL(process.env.DATABASE_URL);
    res.json({
      ok: true,
      user: u.username, host: u.hostname, port: Number(u.port || 5432),
      db: (u.pathname || '/').replace('/',''),
      sslRequired: u.searchParams.get('sslmode') === 'require',
      mode: 'IPv4 (static env)',
      columns: cols.rows.map(r => r.column_name)
    });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/db-migrate', async (_req, res) => {
  try { await ensureSchema(); res.json({ ok:true, disabled: !pool }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/email-verify', async (_req, res) => {
  if (!transporter) return res.json({ ok:false, error:'smtp_disabled' });
  try { await transporter.verify(); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/email-test', async (req, res) => {
  if (!transporter) return res.json({ ok:false, error:'smtp_disabled' });
  try {
    const to = clean(req.query.to || SALES_EMAIL || FROM_EMAIL);
    const info = await transporter.sendMail({ from: FROM_EMAIL, to, subject:'Agentlyne email test', text:'If you see this, SMTP works.' });
    res.json({ ok:true, id: info.messageId });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

/* ---- Slot suggestions (fallback UI) ---- */
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  const base = date ? new Date(`${date}T09:00:00`) : new Date();
  const mins = [60*10, 60*13, 60*15 + 30];
  const slots = mins.map(min => { const d = new Date(base); d.setUTCHours(0, min, 0, 0); return d.toISOString(); });
  res.json({ slots });
});

/* ---- In-memory dedupe for quick repeats ---- */
const DEDUP_SECONDS = Number(process.env.BOOKING_DEDUP_SECONDS || 120);
const recentBookings = new Map(); // key -> expiresAt(ms)
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of recentBookings) if (t <= now) recentBookings.delete(k);
}, 30000);

/* ---- Booking endpoint (used by form AND voice agent) ---- */
app.post('/api/book', async (req, res) => {
  const b = req.body || {};
  const logTag = `[BOOK ${b?.source || 'web'}]`;

  // Minimal, sanitized log so you can trace bookings in Render logs
  console.log(`${logTag} req:`, {
    fullName: b?.fullName, email: b?.email, date: b?.date, time: b?.time,
    timeZone: b?.timeZone, duration: b?.duration, source: b?.source
  });

  try {
    const fullName = clean(pick(b, ['fullName','full_name','name']));
    const email    = clean(pick(b, ['email','mail']));
    const phone    = clean(pick(b, ['phone','tel','telephone']));
    const company  = clean(pick(b, ['company','org']));
    const date     = clean(pick(b, ['date']));
    const time     = clean(pick(b, ['time']));
    const timeZone = clean(pick(b, ['timeZone','timezone','tz'])) || 'UTC';
    const notes    = String(pick(b, ['notes','message']));
    const duration = Number(pick(b, ['duration'], 60)) || 60;
    const plan     = clean(pick(b, ['plan']));
    const tier     = clean(pick(b, ['tier']));
    const source   = clean(pick(b, ['source'], 'pricing'));

    if (!fullName || !email || !date || !time) {
      console.warn(`${logTag} 400 missing fields`);
      return res.status(400).json({ ok:false, error:'Missing required fields: fullName, email, date, time.' });
    }

    // De-dupe quick repeats
    const dedupKey = `${email}|${date}|${time}|${timeZone}`;
    const now = Date.now();
    if (recentBookings.get(dedupKey) > now) {
      console.log(`${logTag} deduped`);
      return res.json({ ok:true, dedup:true });
    }
    recentBookings.set(dedupKey, now + DEDUP_SECONDS * 1000);

    // Store UTC times for analytics (if DB enabled)
    const startISO = zonedToUtcISO(date, time, timeZone);
    const endISO   = startISO ? new Date(new Date(startISO).getTime() + duration * 60000).toISOString() : null;

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO bookings
           (full_name, name, email, phone, company, notes, timezone,
            start_utc, end_utc, duration_min, source, date, "time")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [fullName, fullName, email, phone, company, notes || null, timeZone,
           startISO, endISO, duration, source, date || null, time || null]
        );
      } catch (e) { console.warn(`${logTag} db insert failed:`, e?.message); }
    }

    // Emails
    const emailStatus = { sales:false, user:false };
    if (transporter) {
      try {
        // ICS built with local wall-time + TZID
        const startLocal = buildLocalIso(date, time, 0);
        const endLocal   = buildLocalIso(date, time, duration);
        const ics = icsInvite({
          title: `${BRAND} — Intro Call (pending confirmation)`,
          description: `With: ${fullName}${company ? ` (${company})` : ''}\nPhone: ${phone || '—'}`,
          startLocal, endLocal, tzid: timeZone,
          organizerEmail: FROM_ADDR, organizerName: BRAND,
        });

        const whenLabel = prettyWhen(startISO, endISO, timeZone) || `${date} ${time} ${timeZone}`;
        const html = `
          <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
            <h2 style="margin:0 0 8px 0">${BRAND}</h2>
            <p style="margin:0 0 10px 0">
              Thanks for booking a call with ${BRAND}! We’ll reply shortly with the call information
              (Zoom/Google Meet) and next steps.
            </p>
            <div style="margin:16px 0;padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc">
              <div style="font-weight:700">Requested time</div>
              <div>${whenLabel}</div>
            </div>
            <p style="margin:8px 0">We’ve attached a calendar invite. If you need to change anything, just reply to this email.</p>
            <p style="margin:18px 0 0 0">— Team ${BRAND}</p>
          </div>
        `.trim();

        await transporter.sendMail({
          from: FROM_EMAIL,
          to: email,
          replyTo: process.env.SUPPORT_EMAIL || FROM_ADDR,
          subject: `Thanks for booking — we’ll confirm call details soon`,
          text: `Thanks for booking a call with ${BRAND}! We’ll reply shortly with the call information and next steps.
Requested time: ${whenLabel}
A calendar invite is attached. If you need to change anything, just reply to this email.

— Team ${BRAND}`,
          html,
          attachments: [{ filename:'invite.ics', content: ics, contentType:'text/calendar; charset=utf-8; method=REQUEST' }],

          // Step-1 Option A: archive + tag
          bcc: ARCHIVE_BCC || undefined,
          headers: { 'X-Mailgun-Tag': MAILGUN_TAG }
        });
        emailStatus.user = true;
      } catch (e) { console.warn(`${logTag} sendMail(user) failed:`, e?.message); }

      try {
        await transporter.sendMail({
          from: FROM_EMAIL,
          to: SALES_EMAIL,
          replyTo: email,
          subject: `New booking — ${fullName} — ${date} ${time}`,
          text:
`New booking request

Name:    ${fullName}
Email:   ${email}
Phone:   ${phone || '-'}
Company: ${company || '-'}

Plan:    ${plan} ${tier}
When:    ${date} ${time} (${timeZone})
Length:  ${duration} minutes

Notes:
${(notes || '-')}
`,

          // Step-1 Option A: archive + tag
          bcc: ARCHIVE_BCC || undefined,
          headers: { 'X-Mailgun-Tag': MAILGUN_TAG }
        });
        emailStatus.sales = true;
      } catch (e) { console.warn(`${logTag} sendMail(sales) failed:`, e?.message); }
    } else {
      console.warn(`${logTag} transporter missing, email not sent`);
    }

    console.log(`${logTag} ok -> email:`, emailStatus);
    res.json({ ok:true, email: emailStatus, debug: { db: !!pool, startISO, endISO } });
  } catch (err) {
    console.error('BOOK 500:', err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

/* ------------------------------------------------------------------ */
/* OpenAI Realtime: mint ephemeral client session (with booking proto) */
/* ------------------------------------------------------------------ */
app.post('/api/openai/realtime-session', async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    const voice = req.body?.voice || 'verse';

    const BRAND = process.env.BRAND_NAME || 'Agentlyne';
    const HOURS = process.env.BUSINESS_HOURS || 'Mon–Fri 9am–5pm';
    const BIZ_TZ = process.env.BUSINESS_TZ || 'America/New_York';
    const SLOT_MIN = Number(process.env.SLOT_INTERVAL_MIN || 60);
    const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);

    const bookingProtocol = `
You can schedule intro calls for ${BRAND}.
Collect: full name, email, (optional) phone/company, desired date, time, and the user's time zone (IANA).
Confirm details. When the user confirms, EMIT EXACTLY ONE LINE:

<<BOOK>>{"fullName":"...","email":"...","phone":"...","company":"...","date":"YYYY-MM-DD","time":"HH:mm","timeZone":"IANA/TZ","duration":${SLOT_MIN}}

Rules:
- The line must start with "<<BOOK>>" and then one compact JSON object.
- Use 24h HH:mm time in the user's own time zone.
- Default duration is ${SLOT_MIN} minutes.
- Business hours: ${HOURS} (${BIZ_TZ}); suggest within ${WINDOW_DAYS} days.
Do not add any other text on that line.
`.trim();

    const baseInstructions =
      'You are a warm, concise voice agent for the website. Keep replies under two sentences unless clarifying.\n' +
      bookingProtocol;

    const instructions = (req.body?.instructions ? `${req.body.instructions}\n` : '') + baseInstructions;

    const httpFetch = await getFetch();
    const r = await httpFetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice,
        modalities: ['text', 'audio'],
        instructions
      })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.client_secret?.value) {
      console.error('OpenAI realtime session failed:', r.status, data);
      return res.status(500).json({ error: data?.error?.message || `OpenAI returned ${r.status}` });
    }
    res.json({ client_secret: data.client_secret, model: data.model });
  } catch (e) {
    console.error('realtime-session error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* --- Bootstrap --- */
async function bootstrap() {
  await initDbPool();
  await ensureSchema();

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));
}

bootstrap().catch(err => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
