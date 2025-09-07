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

try { dns.setDefaultResultOrder('ipv4first'); } catch {}

/* ------------------------------------------------------------------ */
/* App                                                                */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ------------------------------------------------------------------ */
/* Database (Supabase / Postgres) — IPv4 + SNI                        */
/* ------------------------------------------------------------------ */
const DB_URL = process.env.DATABASE_URL;
let pool;

async function initDbPool() {
  if (!DB_URL) {
    console.warn('No DATABASE_URL set');
    pool = new Pool();
    return;
  }

  try {
    const u = new URL(DB_URL);
    const host = u.hostname;
    const port = Number(u.port || 5432);
    const user = decodeURIComponent(u.username || '');
    const password = decodeURIComponent(u.password || '');
    const database = (u.pathname || '/').replace(/^\//, '');
    const sslRequired =
      u.searchParams.get('sslmode') === 'require' || process.env.PGSSLMODE === 'require';

    const { address } = await dnsPromises.lookup(host, { family: 4 });
    pool = new Pool({
      host: address,
      port,
      user,
      password,
      database,
      ssl: sslRequired ? { rejectUnauthorized: false, servername: host } : undefined,
      keepAlive: true,
    });
    console.log('DB mode: IPv4 (static env)', address, '(SNI:', host, ') user:', user);
  } catch (err) {
    console.warn('DB IPv4 resolve failed; using connectionString fallback:', err?.message);
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
    });
  }
}
await initDbPool();

/** Create/repair schema so inserts never 500 */
async function ensureSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS bookings (
    id           BIGSERIAL PRIMARY KEY,
    created_at   timestamptz DEFAULT now(),
    -- both "full_name" and "name" so we can be compatible either way
    full_name    text,
    name         text,
    email        text,
    phone        text,
    company      text,
    notes        text,
    timezone     text,
    -- optional scheduling fields (nullable)
    start_utc    timestamptz,
    end_utc      timestamptz,
    duration_min integer,
    source       text,
    plan         text,
    tier         text,
    date         date,
    time         text
  );

  -- Make sure these columns exist (safe no-ops if already there)
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS full_name    text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS name         text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS email        text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone        text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS company      text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes        text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS timezone     text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS start_utc    timestamptz;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS end_utc      timestamptz;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS duration_min integer;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source       text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plan         text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tier         text;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS date         date;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS time         text;

  -- Remove accidental NOT NULLs that break inserts
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='bookings' AND column_name='name' AND is_nullable='NO'
    ) THEN
      EXECUTE 'ALTER TABLE bookings ALTER COLUMN name DROP NOT NULL';
    END IF;
  END $$;
  `;
  await pool.query(sql);
  console.log('DB schema ready');
}
await ensureSchema();

/* Introspection helpers */
app.get('/api/db-info', async (_req, res) => {
  try {
    if (!DB_URL) return res.json({ ok: false, error: 'no DATABASE_URL' });
    const u = new URL(DB_URL);
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='bookings' ORDER BY ordinal_position`
    );
    res.json({
      ok: true,
      user: decodeURIComponent(u.username || ''),
      host: u.hostname,
      port: Number(u.port || 5432),
      db: (u.pathname || '/').slice(1),
      sslRequired: u.searchParams.get('sslmode') === 'require',
      mode: 'IPv4 (static env)',
      columns: r.rows.map(x => x.column_name),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/db-migrate', async (_req, res) => {
  try {
    await ensureSchema();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/db-test', async (_req, res) => {
  try {
    const r = await pool.query('select now()');
    res.json({ ok: true, now: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || '' });
  }
});

/* ------------------------------------------------------------------ */
/* Email (SMTP)                                                       */
/* ------------------------------------------------------------------ */
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
const smtpSecure = smtpSecureEnv
  ? ['1', 'true', 'yes', 'on'].includes(smtpSecureEnv)
  : smtpPort === 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpSecure,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { minVersion: 'TLSv1.2' },
  pool: true,
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
  for (const k of keys) if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]);
  return def;
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// simple slot suggester
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  const base = date ? new Date(`${date}T09:00:00Z`) : new Date();
  const mins = [600, 780, 930]; // 10:00, 13:00, 15:30 UTC
  const slots = mins.map(m => {
    const d = new Date(base); d.setUTCHours(0, m, 0, 0); return d.toISOString();
  });
  res.json({ slots });
});

// booking
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
    const source   = clean(pick(b, ['source'], 'pricing'));

    if (!fullName || !email || !date || !time) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: fullName, email, date, time.' });
    }

    // DB write (best effort). Populate BOTH full_name and name.
    try {
      await pool.query(
        `INSERT INTO bookings
         (full_name, name, email, phone, company, notes, timezone, duration_min, source, plan, tier, date, time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [fullName, fullName, email, phone, company, notes, timeZone, duration, source, plan, tier, date, time]
      );
    } catch (e) {
      console.error('book db insert failed:', e?.message);
      // keep going (emails still send)
    }

    // Sales notification
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
${(notes || '-').trim()}
`.trim();

    const salesInfo = await transporter.sendMail({
      from: FROM_EMAIL,
      to: SALES_EMAIL,
      replyTo: email,
      subject: `New booking — ${fullName} — ${date} ${time}`,
      text: salesText
    });
    console.log('booking->sales msg id:', salesInfo.messageId);

    // Acknowledgement to submitter
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
