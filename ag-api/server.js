// --- server.js ---------------------------------------------------------------
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ---------- Static site (Option B: serve repo root) ----------
// ag-api/server.js sits inside the "ag-api" folder.
// One level up (..) is your repo root where index.html, book.html, etc. live.
const PUBLIC_DIR = path.join(__dirname, '..');

// Block access to the server code folder just in case.
app.use('/ag-api', (_req, res) => res.status(404).end());

// Serve static site from repo root
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], dotfiles: 'ignore' }));
// If you want unknown routes to go to the homepage, uncomment:
// app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ---------- CORS ----------
app.use(cors()); // permissive for now
app.use(express.json());

// ---------- Database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
    );
  `;
  try { await pool.query(sql); } catch (e) { console.warn('DB ensureSchema skipped:', e.message); }
}
ensureSchema();

// ---------- Mail ----------
const smtpPort   = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpSecure,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const FROM_EMAIL  = process.env.FROM_EMAIL  || 'Agentlyne <no-reply@mg.agentlyne.com>';
const SALES_EMAIL = process.env.SALES_EMAIL || 'sales@agentlyne.com';

transporter.verify()
  .then(() => console.log('SMTP ready'))
  .catch(err => console.warn('SMTP not ready:', err?.message));

// ---------- API ----------
app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
    const { fullName = '', email = '', phone = '', company = '',
            date = '', time = '', timeZone = '', notes = '', duration = 30 } = req.body || {};

    if (!fullName.trim() || !email.trim() || !date || !time) {
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    }

    await pool.query(
      `INSERT INTO bookings (full_name,email,phone,company,date,time,timezone,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [fullName, email, phone, company, date, time, timeZone, notes]
    );

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

// ---------- Start ----------
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
