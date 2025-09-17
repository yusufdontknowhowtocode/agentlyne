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
// IMPORTANT: declare BEFORE the static middleware so it wins.
app.get('/config.js', (_req, res) => {
  const cfg = {
    API_BASE: (process.env.API_BASE ?? ''),
    SUPPORT_EMAIL: (process.env.SUPPORT_EMAIL ?? 'info@agentlyne.com'),
    BRAND_NAME: (process.env.BRAND_NAME ?? 'Agentlyne'),
    CALENDLY_URL: (process.env.CALENDLY_URL ?? ''),
  };
  const js = `window.APP_CONFIG = ${JSON.stringify(cfg, null, 2)};`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(js);
});

/* ------------------------------------------------------------------ */
/* Static site                                                         */
/* ------------------------------------------------------------------ */
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext && ext !== '.html') {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

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

// helpers for ICS local wall-times
const p2 = v => v.toString().padStart(2,'0');
function buildLocalIso(dateStr, timeStr, addMinutes = 0) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const [H,M]   = timeStr.split(':').map(Number);
  const dt = new Date(y, m - 1, d, H, M + addMinutes, 0);
  return `${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}T${p2(dt.getHours())}:${p2(dt.getMinutes())}:${p2(dt.getSeconds())}`;
}

// pretty label for confirmation email
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
/* DB + SMTP bootstrap                                                */
/* ------------------------------------------------------------------ */

const DB_URL = process.env.DATABASE_URL;
let pool = null;

async function initDbPool() {
  if (!DB_URL) { pool = new Pool(); return; }
  try {
    const u = new URL(DB_URL);
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
    console.log('DB mode: IPv4 (static env)', address, `(SNI: ${host}) user: ${user}`);
  } catch (err) {
    console.warn('DB IPv4 resolve failed; fallback to connectionString:', err?.message);
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
    });
  }
}

async function ensureSchema() {
  const createSql = `
  CREATE TABLE IF NOT EXISTS bookings (
    id BIGSERIAL PRIMARY KEY,
    created_at timestamptz DEFAULT now(),
    name text, full_name text, email text, phone text, company text, notes text,
    timezone text, start_utc timestamptz, end_utc timestamptz, duration_min integer,
    source text, date date, "time" text
  );`;
  try {
    await pool.query(createSql);
    try { await pool.query(`ALTER TABLE bookings ALTER COLUMN name DROP NOT NULL;`); } catch {}
    try { await pool.query(`ALTER TABLE bookings ALTER COLUMN start_utc DROP NOT NULL;`); } catch {}
    console.log('DB schema ready');
  } catch (err) {
    console.error('book db ensure failed:', err?.message);
  }
}

/* --- Email (SMTP) --- */
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
const smtpSecure = smtpSecureEnv ? ['1','true','yes','on'].includes(smtpSecureEnv) : smtpPort === 465;

const hasSMTP = !!process.env.SMTP_HOST;
const transporter = hasSMTP ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,                          // Mailgun: smtp.mailgun.org
  port: smtpPort,                                      // 587
  secure: smtpSecure,                                  // false for 587, true for 465
  auth: (process.env.SMTP_USER || process.env.SMTP_PASS) ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  tls: { minVersion: 'TLSv1.2' },
  pool: true
}) : null;

const BRAND = process.env.BRAND_NAME || 'Agentlyne';
const FROM_ADDR = process.env.SMTP_FROM || process.env.FROM_EMAIL || 'no-reply@agentlyne.com';
const FROM_EMAIL = `${BRAND} <${FROM_ADDR}>`;
const SALES_EMAIL = process.env.BOOKINGS_INBOX || process.env.SALES_EMAIL || `sales@agentlyne.com`;

if (transporter) {
  transporter.verify()
    .then(() => console.log('SMTP ready'))
    .catch(e => console.warn('SMTP not ready:', e?.message));
} else {
  console.warn('SMTP disabled: missing SMTP_HOST env');
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
    const cols = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='bookings'
      ORDER BY ordinal_position
    `);
    const u = DB_URL ? new URL(DB_URL) : null;
    res.json({
      ok: true,
      user: u?.username || null,
      host: u?.hostname || null,
      port: u ? Number(u.port || 5432) : null,
      db: u ? (u.pathname || '/').replace('/','') : null,
      sslRequired: u ? u.searchParams.get('sslmode') === 'require' : null,
      mode: 'IPv4 (static env)',
      columns: cols.rows.map(r => r.column_name)
    });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/db-migrate', async (_req, res) => {
  try { await ensureSchema(); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/email-verify', async (_req, res) => {
  if (!transporter) return res.status(200).json({ ok:false, error:'smtp_disabled' });
  try { await transporter.verify(); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/email-test', async (req, res) => {
  if (!transporter) return res.status(200).json({ ok:false, error:'smtp_disabled' });
  try {
    const to = clean(req.query.to || SALES_EMAIL || FROM_EMAIL);
    const info = await transporter.sendMail({ from: FROM_EMAIL, to, subject:'Agentlyne email test', text:'If you see this, SMTP works.' });
    res.json({ ok:true, id: info.messageId });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Simple slot suggestions for the fallback form
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  const base = date ? new Date(`${date}T09:00:00`) : new Date();
  const mins = [60*10, 60*13, 60*15 + 30];
  const slots = mins.map(min => { const d = new Date(base); d.setUTCHours(0, min, 0, 0); return d.toISOString(); });
  res.json({ slots });
});

app.post('/api/book', async (req, res) => {
  try {
    const b = req.body || {};
    const fullName = clean(pick(b, ['fullName','full_name','name']));
    const email    = clean(pick(b, ['email','mail']));
    const phone    = clean(pick(b, ['phone','tel','telephone']));
    const company  = clean(pick(b, ['company','org']));
    const date     = clean(pick(b, ['date']));
    const time     = clean(pick(b, ['time']));
    const timeZone = clean(pick(b, ['timeZone','timezone','tz']));
    const notes    = String(pick(b, ['notes','message']));
    const duration = Number(pick(b, ['duration'], 60)) || 60; // default to 60 now
    const plan     = clean(pick(b, ['plan']));
    const tier     = clean(pick(b, ['tier']));
    const source   = clean(pick(b, ['source'], 'pricing'));

    if (!fullName || !email || !date || !time) {
      return res.status(400).json({ ok:false, error:'Missing required fields: fullName, email, date, time.' });
    }

    // Store UTC times for analytics
    const startISO = zonedToUtcISO(date, time, timeZone || 'UTC');
    const endISO   = startISO ? new Date(new Date(startISO).getTime() + duration * 60000).toISOString() : null;

    try {
      await pool.query(
        `INSERT INTO bookings
         (full_name, name, email, phone, company, notes, timezone,
          start_utc, end_utc, duration_min, source, date, "time")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [fullName, fullName, email, phone, company, notes || null, timeZone || null,
         startISO, endISO, duration, source, date || null, time || null]
      );
    } catch (e) { console.error('book db insert failed:', e?.message); }

    // Email: ICS invite to user + internal notification
    const emailStatus = { sales:false, user:false };
    if (transporter) {
      // build ICS using local wall time with TZID
      const startLocal = buildLocalIso(date, time, 0);
      const endLocal   = buildLocalIso(date, time, duration);
      const ics = icsInvite({
        title: `${BRAND} — Intro Call (pending confirmation)`,
        description: `With: ${fullName}${company ? ` (${company})` : ''}\nPhone: ${phone || '—'}`,
        startLocal,
        endLocal,
        tzid: timeZone || 'UTC',
        organizerEmail: FROM_ADDR,
        organizerName: BRAND,
      });

      // Send to guest (updated subject + body)
      try {
        const whenLabel = prettyWhen(startISO, endISO, timeZone || 'UTC');
        const html = `
          <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
            <h2 style="margin:0 0 8px 0">${BRAND}</h2>
            <p style="margin:0 0 10px 0">
              Thanks for booking a call with ${BRAND}! We’ll reply shortly with the call information
              (Zoom/Google Meet) and next steps.
            </p>
            <div style="margin:16px 0;padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc">
              <div style="font-weight:700">Requested time</div>
              <div>${whenLabel || `${date} ${time} ${timeZone || ''}`}</div>
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
Requested time: ${whenLabel || `${date} ${time} ${timeZone || ''}`}
A calendar invite is attached. If you need to change anything, just reply to this email.

— Team ${BRAND}`,
          html,
          attachments: [{
            filename: 'invite.ics',
            content: ics,
            contentType: 'text/calendar; charset=utf-8; method=REQUEST',
          }],
        });
        emailStatus.user = true;
      } catch (e) {
        console.warn('sendMail(user) failed:', e?.message);
      }

      // Internal notification
      const salesText = `
New booking request

Name:    ${fullName}
Email:   ${email}
Phone:   ${phone || '-'}
Company: ${company || '-'}

Plan:    ${plan} ${tier}
When:    ${date} ${time} (${timeZone || 'tz not set'})
Length:  ${duration} minutes

Notes:
${(notes || '').trim() || '-'}
`.trim();

      try {
        await transporter.sendMail({
          from: FROM_EMAIL,
          to: SALES_EMAIL,
          replyTo: email,
          subject: `New booking — ${fullName} — ${date} ${time}`,
          text: salesText,
        });
        emailStatus.sales = true;
      } catch (e) {
        console.warn('sendMail(sales) failed:', e?.message);
      }
    }

    res.json({ ok:true, email: emailStatus });
  } catch (err) {
    console.error('book error:', err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

/* ------------------------------------------------------------------ */
/* OpenAI Realtime: mint ephemeral client session                      */
/* ------------------------------------------------------------------ */
app.post('/api/openai/realtime-session', async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    const voice = req.body?.voice || 'verse';
    const instructions =
      req.body?.instructions ||
      'You are a friendly website guide for Agentlyne. Greet quickly, keep answers under two sentences, and help visitors understand benefits and pricing.';

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
