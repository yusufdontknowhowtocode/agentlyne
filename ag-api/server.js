// --- server.js ---------------------------------------------------------------
// Loads .env when running locally (Render already injects env vars)
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

// resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express(); // <-- define app FIRST

// --- Middleware
app.use(cors());            // keep it open for now; tighten later if you want
app.use(express.json());

// --- Serve static site (ag-api/public)
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
// Optional: force "/" to index.html explicitly
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
// Optional SPA fallback (only if you need it):
// app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// --- DB (Supabase / Postgres)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // keep ?sslmode=require at the end
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined
});

// Ensure table exists (simple schema for bookings)
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
  await pool.query(sql);
}
ensureSchema().catch(console.error);

// --- Mail (Mailgun via SMTP)
const smtpPort   = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,           // e.g. smtp.mailgun.org
  port: smtpPort,                        // 587 or 465
  secure: smtpSecure,                    // true only if 465
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const FROM_EMAIL  = process.env.FROM_EMAIL  || 'Agentlyne <no-reply@mg.agentlyne.com>';
const SALES_EMAIL = process.env.SALES_EMAIL || 'sales@agentlyne.com';

// Verify SMTP on boot (logs only)
transporter.verify()
  .then(() => console.log('SMTP ready'))
  .catch(err => console.warn('SMTP not ready:', err?.message));

// --- Routes
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Quick slot suggester (client passes ?date=YYYY-MM-DD)
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  const base = date ? new Date(`${date}T09:00:00`) : new Date();
  // 10:00, 13:00, 15:30 (UTC) as a simple demo
  const slots = [60 * 10, 60 * 13, 60 * 15 + 30].map(min => {
    const d = new Date(base);
    d.setUTCHours(0, min, 0, 0);
    return d.toISOString();
  });
  res.json({ slots });
});

// Booking endpoint used by book.html
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

    // Save to DB
    await pool.query(
      `INSERT INTO bookings (full_name,email,phone,company,date,time,timezone,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [fullName, email, phone, company, date, time, timeZone, notes]
    );

    // Email to Sales
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

    // Confirmation to customer
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

// --- Start
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
