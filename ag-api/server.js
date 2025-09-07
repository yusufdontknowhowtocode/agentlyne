// Loads .env locally (on Render, env vars are injected)
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';

// Prefer IPv4 on platforms without IPv6 (avoids ENETUNREACH)
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

/* ------------------------------------------------------------------ */
/* App setup                                                          */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');

app.use(cors());              // you can tighten origins later
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Serve the static site (ag-api/public)
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Be explicit for "/" just in case
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ------------------------------------------------------------------ */
/* Database (Supabase / Postgres)                                     */
/* ------------------------------------------------------------------ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // keep ?sslmode=require at end
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined
});

async function ensureSchema() {
  const sql = `
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
    );`;
  try {
    await pool.query(sql);
    console.log('DB schema ready');
  } catch (err) {
    console.warn('DB not reachable yet; continuing. Detail:', err?.message);
  }
}
ensureSchema();

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
const clean = (s) =>
  String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

/* ------------------------------------------------------------------ */
/* API routes                                                         */
/* ------------------------------------------------------------------ */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

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

// Booking endpoint (auto-reply + internal notification)
app.post('/api/book', async (req, res) => {
  try {
    const {
      fullName = '',
      email = '',
      phone = '',
      company = '',
      date = '',
      time = '',
      timeZone = '',
      notes = '',
      duration = 30,
      plan = '',
      tier = ''
    } = req.body || {};

    if (!fullName.trim() || !email.trim() || !date || !time) {
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    }

    // Save to DB (best effort)
    try {
      await pool.query(
        `INSERT INTO bookings (full_name,email,phone,company,date,time,timezone,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fullName, email, phone, company, date, time, timeZone, notes]
      );
    } catch (e) {
      console.warn('DB insert failed (continuing):', e?.message);
    }

    // Internal notification
    const salesText = `
New booking request

Name:    ${clean(fullName)}
Email:   ${clean(email)}
Phone:   ${clean(phone) || '-'}
Company: ${clean(company) || '-'}

Plan:    ${clean(plan)} ${clean(tier)}
When:    ${clean(date)} ${clean(time)} (${clean(timeZone) || 'tz not set'})
Length:  ${Number(duration) || 30} minutes

Notes:
${String(notes ?? '').trim() || '-'}
`;
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: SALES_EMAIL,
      replyTo: clean(email),
      subject: `New booking — ${clean(fullName)} — ${clean(date)} ${clean(time)}`,
      text: salesText
    });

    // Auto-confirmation to submitter
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: clean(email),
      subject: `We received your request — ${clean(date)} ${clean(time)}`,
      text:
`Thanks ${clean(fullName)}! We received your request and will get right back to you.

What you submitted
- Email: ${clean(email)}
- Phone: ${clean(phone) || '-'}
- Company: ${clean(company) || '-'}
- Plan: ${clean(plan)} ${clean(tier)}
- Preferred time: ${clean(date)} ${clean(time)} ${clean(timeZone)}

If anything changes, just reply to this email.

— Team Agentlyne`
    });

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
