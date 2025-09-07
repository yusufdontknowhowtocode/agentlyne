// Loads .env locally (on Render, env vars are injected)
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';

// Prefer IPv4 on platforms without IPv6
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

/* ------------------------------------------------------------------ */
/* App setup                                                          */
/* ------------------------------------------------------------------ */
const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Serve the static site (ag-api/public)
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Be explicit for "/" just in case
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// CORS (you can tighten later)
app.use(cors());
app.use(express.json());

/* ------------------------------------------------------------------ */
/* Database (Supabase / Postgres)                                     */
/* ------------------------------------------------------------------ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,          // keep ?sslmode=require
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined
});

// Ensure table exists; don't crash service if DB is unreachable
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
/* Email (Mailgun via SMTP)                                           */
/* ------------------------------------------------------------------ */
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,       // smtp.mailgun.org
  port: smtpPort,                    // 587 or 465
  secure: smtpSecure,                // true only if 465
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const FROM_EMAIL  = process.env.FROM_EMAIL  || 'Agentlyne <no-reply@mg.agentlyne.com>';
const SALES_EMAIL = process.env.SALES_EMAIL || 'sales@agentlyne.com';

transporter.verify()
  .then(() => console.log('SMTP ready'))
  .catch(e => console.warn('SMTP not ready:', e?.message));

/* ------------------------------------------------------------------ */
/* API routes                                                         */
/* ------------------------------------------------------------------ */
// --- Routes
app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
      duration = 30
    } = req.body || {};

    if (!fullName.trim() || !email.trim() || !date || !time) {
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    }

    // Save to DB (best effort — don’t fail if DB is momentarily down)
    try {
      await pool.query(
        `INSERT INTO bookings (full_name,email,phone,company,date,time,timezone,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fullName, email, phone, company, date, time, timeZone, notes]
      );
    } catch (e) {
      console.warn('DB insert failed (continuing):', e?.message);
    }

    // Notify sales
    const salesText = `
New booking request

Name:   ${fullName}
Email:  ${email}
Phone:  ${phone || '-'}
Company:${company || '-'}

When:   ${date} ${time} (${timeZone || 'tz not set'})
Length: ${duration} minutes

Notes:
${notes || '-'}
`;
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: SALES_EMAIL,
      replyTo: email,
      subject: `New booking — ${fullName} — ${date} ${time}`,
      text: salesText
    });

    // Confirmation
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: email,
      subject: `Booked: ${date} ${time} (Agentlyne)`,
      text: `Thanks ${fullName}! We received your request and will send a calendar invite shortly.\n\nIf anything changes, just reply to this email.`
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ------------------------------------------------------------------ */
/* Start                                                              */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
