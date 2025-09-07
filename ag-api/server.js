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

// Prefer IPv4 on platforms without IPv6 (avoids ENETUNREACH)
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

/* ------------------------------------------------------------------ */
/* App setup                                                          */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Serve static site
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ------------------------------------------------------------------ */
/* Database (Supabase / Postgres) — prefer IPv4, show sanitized info  */
/* ------------------------------------------------------------------ */
const DB_URL = process.env.DATABASE_URL ?? '';
const FORCED_IPV4 = process.env.DATABASE_HOST_IPV4 || '';

function parseDb(url) {
  try {
    const u = new URL(url);
    return {
      user: decodeURIComponent(u.username || ''),
      passPresent: !!u.password,
      host: u.hostname,
      port: Number(u.port || 5432),
      db: (u.pathname || '/').slice(1),
      sslRequired:
        u.searchParams.get('sslmode') === 'require' || process.env.PGSSLMODE === 'require',
      raw: u,
    };
  } catch { return null; }
}

const dbInfo = parseDb(DB_URL);
if (!dbInfo) {
  console.warn('No/invalid DATABASE_URL set');
}

let pool;
(async () => {
  if (!dbInfo) { pool = new Pool(); return; }

  const tls = dbInfo.sslRequired ? { rejectUnauthorized: false, servername: dbInfo.host } : undefined;

  try {
    let targetHost = dbInfo.host;
    let mode = 'DNS IPv4 lookup';
    if (FORCED_IPV4) {
      targetHost = FORCED_IPV4;
      mode = 'IPv4 (static env)';
    } else {
      const { address } = await dnsPromises.lookup(dbInfo.host, { family: 4 });
      targetHost = address;
    }

    pool = new Pool({
      host: targetHost,
      port: dbInfo.port,
      user: dbInfo.user,
      password: dbInfo.raw.password,
      database: dbInfo.db,
      ssl: tls,
      keepAlive: true,
    });

    console.log(
      `DB mode: ${FORCED_IPV4 ? 'IPv4 (static env)' : 'IPv4 (lookup)'} ${targetHost} ` +
      `(SNI: ${dbInfo.host}) user: ${dbInfo.user}`
    );
  } catch (err) {
    console.warn('DB IPv4 resolve failed; falling back to connectionString:', err?.message);
    pool = new Pool({
      connectionString: DB_URL,
      ssl: dbInfo.sslRequired ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
    });
  }

  // Ensure schema
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id BIGSERIAL PRIMARY KEY,
        created_at timestamptz DEFAULT now(),
        full_name text,
        email text,
        phone text,
        company text,
        date date,
        time text,
        timezone text,
        notes text
      );
    `);
    console.log('DB schema ready');
  } catch (e) {
    console.error('book db ensure failed:', e?.message);
  }
})();

/* ------------------------------------------------------------------ */
/* Email (SMTP)                                                       */
/* ------------------------------------------------------------------ */
import nodemailerPkg from 'nodemailer';
const nodemailer2 = nodemailerPkg; // (just to be explicit in some bundlers)
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
const smtpSecure = smtpSecureEnv
  ? ['1', 'true', 'yes', 'on'].includes(smtpSecureEnv)
  : smtpPort === 465;

const transporter = nodemailer2.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpSecure,
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

// Show sanitized DB info (no password)
app.get('/api/db-info', (_req, res) => {
  if (!dbInfo) return res.json({ ok: false, error: 'no DATABASE_URL' });
  res.json({
    ok: true,
    user: dbInfo.user,
    host: dbInfo.host,
    port: dbInfo.port,
    db: dbInfo.db,
    sslRequired: dbInfo.sslRequired,
    mode: FORCED_IPV4 ? 'IPv4 (static env)' : 'IPv4 (lookup)',
  });
});

// DB connectivity smoke test
app.get('/api/db-test', async (_req, res) => {
  try {
    const r = await pool.query('select now()');
    res.json({ ok: true, now: r.rows[0] });
  } catch (e) {
    console.error(e);
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

// Booking endpoint
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
      return res.status(400).json({ ok: false, error: 'Missing required fields: fullName, email, date, time.' });
    }

    try {
      await pool.query(
        `INSERT INTO bookings (full_name,email,phone,company,date,time,timezone,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fullName, email, phone, company, date, time, timeZone, notes]
      );
      console.log('book db insert: ok');
    } catch (e) {
      console.error('book db insert failed:', e?.message);
    }

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
