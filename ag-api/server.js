// Loads .env locally (on Render, env vars are injected)
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';
import { promises as dnsPromises } from 'dns';

// Prefer IPv4 when available (avoids ENETUNREACH on IPv6-only hosts)
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

/* ------------------------------------------------------------------ */
/* App setup                                                          */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');

app.use(cors()); // tighten origins later if needed
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Serve the static site (ag-api/public)
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Explicit root file
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ------------------------------------------------------------------ */
/* Database (Supabase / Postgres) — IPv4 + SNI                        */
/* ------------------------------------------------------------------ */
const DB_URL = process.env.DATABASE_URL;

let pool;
async function initDbPool() {
  if (!DB_URL) {
    console.warn('No DATABASE_URL set; DB features disabled');
    pool = new Pool(); // will still let /api/db-info say "no url"
    return;
  }

  const u = new URL(DB_URL);
  const host = u.hostname;
  const port = Number(u.port || 5432);
  const user = decodeURIComponent(u.username || '');
  const password = decodeURIComponent(u.password || '');
  const database = (u.pathname || '/').replace(/^\//, '');
  const sslRequired =
    u.searchParams.get('sslmode') === 'require' ||
    process.env.PGSSLMODE === 'require';

  // Try to pin to IPv4 for the connection (Render-friendly)
  try {
    const { address } = await dnsPromises.lookup(host, { family: 4 });
    pool = new Pool({
      host: address,         // IPv4 literal address
      port,
      user,
      password,
      database,
      ssl: sslRequired ? { rejectUnauthorized: false, servername: host } : undefined,
      keepAlive: true,
      max: 5,
    });
    console.log(`DB mode: IPv4 (static env) ${address} (SNI: ${host}) user: ${user}`);
  } catch (err) {
    console.warn('DB IPv4 resolve failed; using connectionString fallback:', err?.message);
    pool = new Pool({
      connectionString: DB_URL,
      ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
      max: 5,
    });
  }
}

await initDbPool();

/**
 * Ensure schema:
 * - Create table if missing
 * - Add any missing columns (safe if they already exist)
 */
async function ensureSchema() {
  if (!DB_URL) return;

  const baseSql = `CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY);`;
  const columnDefs = [
    `created_at timestamptz DEFAULT now()`,
    `full_name  text`,
    `email      text`,
    `phone      text`,
    `company    text`,
    `"date"     date`,
    `"time"     text`,
    `timezone   text`,
    `notes      text`,
  ];

  try {
    await pool.query(baseSql);
    // Add columns idempotently
    for (const def of columnDefs) {
      // extract column name (first token, accounting for quoted names)
      const col = def.split(/\s+/)[0];
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ${def};`);
      // Optional: for created_at, ensure default is present if column existed without it
      if (col === 'created_at') {
        await pool.query(`ALTER TABLE bookings ALTER COLUMN created_at SET DEFAULT now();`);
      }
    }
    console.log('DB schema ready');
  } catch (err) {
    console.error('book db ensure failed:', err?.message);
  }
}
await ensureSchema();

/* ------------------------------------------------------------------ */
/* Email (SMTP)                                                       */
/* ------------------------------------------------------------------ */
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
const smtpSecure = smtpSecureEnv
  ? ['1', 'true', 'yes', 'on'].includes(smtpSecureEnv)
  : smtpPort === 465; // infer if not provided

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,           // e.g. smtp.mailgun.org / smtp.gmail.com
  port: smtpPort,                        // 587 or 465
  secure: smtpSecure,                    // true only for 465
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { minVersion: 'TLSv1.2' },
  pool: true
});

const FROM_EMAIL  = process.env.FROM_EMAIL  || 'Agentlyne <no-reply@agentlyne.com>';
const SALES_EMAIL = process.env.SALES_EMAIL || 'sales@agentlyne.com';

transporter.verify()
  .then(() => console.log('SMTP ready'))
  .catch(e => console.warn('SMTP not ready:', e?.message));

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

function pick(obj, keys, def = '') {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]);
  }
  return def;
}

/* ------------------------------------------------------------------ */
/* API routes                                                         */
/* ------------------------------------------------------------------ */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Quick DB info (what the server *thinks* it’s using)
app.get('/api/db-info', (_req, res) => {
  try {
    if (!DB_URL) return res.json({ ok: false, error: 'no DATABASE_URL' });
    const u = new URL(DB_URL);
    const sslRequired =
      u.searchParams.get('sslmode') === 'require' ||
      process.env.PGSSLMODE === 'require';
    res.json({
      ok: true,
      user: decodeURIComponent(u.username || ''),
      host: u.hostname,
      port: Number(u.port || 5432),
      db: (u.pathname || '/').replace(/^\//, ''),
      sslRequired,
      mode: 'IPv4 (static env)',
    });
  } catch (e) {
    res.json({ ok: false, error: e?.message || 'parse error' });
  }
});

// DB connectivity smoke test
app.get('/api/db-test', async (_req, res) => {
  try {
    const r = await pool.query('select now()');
    res.json({ ok: true, now: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || '' });
  }
});

// Re-run schema ensure on demand (handy after password/env changes)
app.post('/api/db-migrate', async (_req, res) => {
  try {
    await ensureSchema();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'migrate failed' });
  }
});

// SMTP connectivity test
app.get('/api/email-verify', async (_req, res) => {
  try {
    await transporter.verify();
    res.json({ ok: true });
  } catch (e) {
    console.error('verify error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Send a one-off test email
app.get('/api/email-test', async (req, res) => {
  try {
    const to = clean(req.query.to || SALES_EMAIL || FROM_EMAIL);
    const info = await transporter.sendMail({
      from: FROM_EMAIL,
      to,
      subject: 'Agentlyne email test',
      text: 'If you see this, SMTP works.'
    });
    console.log('email-test id:', info.messageId);
    res.json({ ok: true, id: info.messageId });
  } catch (e) {
    console.error('email-test error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Quick slot suggester
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  const base = date ? new Date(`${date}T09:00:00`) : new Date();
  const slots = [60 * 10, 60 * 13, 60 * 15 + 30].map(min => {
    const d = new Date(base);
    d.setUTCHours(0, min, 0, 0);
    return d.toISOString();
  });
  res.json({ slots });
});

// Booking endpoint (auto-reply + internal notification)
app.post('/api/book', async (req, res) => {
  try {
    const b = req.body || {};

    const fullName = clean(pick(b, ['fullName', 'full_name', 'name']));
    const email    = clean(pick(b, ['email', 'mail']));
    const phone    = clean(pick(b, ['phone', 'tel', 'telephone']));
    const company  = clean(pick(b, ['company', 'org']));
    const date     = clean(pick(b, ['date']));
    const time     = clean(pick(b, ['time']));
    const timeZone = clean(pick(b, ['timeZone', 'timezone', 'tz']));
    const notes    = String(pick(b, ['notes', 'message']));

    const duration = Number(pick(b, ['duration'], 30)) || 30;
    const plan     = clean(pick(b, ['plan']));
    const tier     = clean(pick(b, ['tier']));

    if (!fullName || !email || !date || !time) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: fullName, email, date, time.'
      });
    }

    // Save to DB (best effort)
    try {
      await pool.query(
        `INSERT INTO bookings (full_name,email,phone,company,"date","time",timezone,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fullName, email, phone, company, date, time, timeZone, notes]
      );
      console.log('book db insert: ok');
    } catch (e) {
      console.error('book db insert failed:', e?.message);
      // continue; DB is best-effort
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
${notes.trim() || '-'}
`;
    const salesInfo = await transporter.sendMail({
      from: FROM_EMAIL,
      to: SALES_EMAIL,
      replyTo: email,
      subject: `New booking — ${fullName} — ${date} ${time}`,
      text: salesText
    });
    console.log('booking->sales msg id:', salesInfo.messageId);

    // Auto-confirmation to submitter
    const ackInfo = await transporter.sendMail({
      from: FROM_EMAIL,
      to: email,
      subject: `We received your request — ${date} ${time}`,
      text:
`Thanks ${fullName}! We received your request and will get right back to you.

What you submitted
- Email: ${email}
- Phone: ${phone || '-'}
- Company: ${company || '-'}
- Plan: ${plan} ${tier}
- Preferred time: ${date} ${time} ${timeZone}

If anything changes, just reply to this email.

— Team Agentlyne`
    });
    console.log('booking->ack msg id:', ackInfo.messageId);

    res.json({ ok: true });
  } catch (err) {
    console.error('book error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ------------------------------------------------------------------ */
/* Start                                                              */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 10000; // Render sets PORT
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
