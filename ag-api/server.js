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
import fs from 'fs/promises';

// Prefer IPv4 on platforms without IPv6 (avoids ENETUNREACH)
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* Serve vendored Retell SDK directly                                 */
/* ------------------------------------------------------------------ */
const RETELL_LOCAL = path.join(PUBLIC_DIR, 'vendor', 'retell-client-js-sdk-2.0.7.umd.js');

// Keep the old endpoint for compatibility, but just serve the file (or redirect to CDN)
app.get('/sdk/retell.v1.js', async (req, res) => {
  res.type('application/javascript; charset=utf-8');
  try {
    const buf = await fs.readFile(RETELL_LOCAL);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(buf);
  } catch {
    // Fallback to a known-good CDN build if the file wasn't deployed
    return res.redirect(302, 'https://cdn.jsdelivr.net/npm/retell-client-js-sdk@2.0.7/dist/index.umd.js');
  }
});

/* ------------------------------------------------------------------ */
/* Static site                                                        */
/* ------------------------------------------------------------------ */
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (ext && ext !== '.html') {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// debug helper
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
/* DB (IPv4 + SNI)                                                    */
/* ------------------------------------------------------------------ */
const DB_URL = process.env.DATABASE_URL;
let pool;
if (DB_URL) {
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
      ssl: DB_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
    });
  }
} else {
  pool = new Pool();
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
await ensureSchema();

/* ------------------------------------------------------------------ */
/* Email (SMTP)                                                       */
/* ------------------------------------------------------------------ */
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
const smtpSecure = smtpSecureEnv ? ['1','true','yes','on'].includes(smtpSecureEnv) : smtpPort === 465;

const transporter = nodemailer.createTransport({
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
    if (!m) return 0; const sign = m[1].startsWith('-') ? -1 : 1;
    const h = Math.abs(parseInt(m[1], 10)); const mm = m[2] ? parseInt(m[2], 10) : 0;
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
    const u = new URL(DB_URL);
    res.json({
      ok: true,
      user: u.username,
      host: u.hostname,
      port: Number(u.port || 5432),
      db: (u.pathname || '/').replace('/',''),
      sslRequired: u.searchParams.get('sslmode') === 'require',
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
  try { await transporter.verify(); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/email-test', async (req, res) => {
  try {
    const to = clean(req.query.to || SALES_EMAIL || FROM_EMAIL);
    const info = await transporter.sendMail({ from: FROM_EMAIL, to, subject:'Agentlyne email test', text:'If you see this, SMTP works.' });
    res.json({ ok:true, id: info.messageId });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  const base = date ? new Date(`${date}T09:00:00`) : new Date();
  const slots = [60*10, 60*13, 60*15+30].map(min => { const d = new Date(base); d.setUTCHours(0, min, 0, 0); return d.toISOString(); });
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
    const duration = Number(pick(b, ['duration'], 30)) || 30;
    const plan     = clean(pick(b, ['plan']));
    const tier     = clean(pick(b, ['tier']));
    const source   = clean(pick(b, ['source'], 'pricing'));

    if (!fullName || !email || !date || !time) {
      return res.status(400).json({ ok:false, error:'Missing required fields: fullName, email, date, time.' });
    }

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
`;
    await transporter.sendMail({ from: FROM_EMAIL, to: SALES_EMAIL, replyTo: email, subject:`New booking — ${fullName} — ${date} ${time}`, text: salesText });
    await transporter.sendMail({ from: FROM_EMAIL, to: email, subject:`We received your request — ${date} ${time}`, text:
`Thanks ${fullName}! We received your request and will get right back to you.

What you submitted
- Email: ${email}
- Phone: ${phone || '-'}
- Company: ${company || '-'}
- Plan: ${plan} ${tier}
- Preferred time: ${date} ${time} ${timeZone || ''}

If anything changes, just reply to this email.

— Team Agentlyne` });

    res.json({ ok:true });
  } catch (err) {
    console.error('book error:', err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

/* Retell: mint Web Call token */
async function handleCreateWebCall(_req, res) {
  try {
    const apiKey = process.env.RETELL_API_KEY;
    const agentId = process.env.RETELL_AGENT_ID;
    if (!apiKey || !agentId) return res.status(500).json({ error:'Missing RETELL_API_KEY or RETELL_AGENT_ID' });

    const resp = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.access_token) {
      console.error('Retell create-web-call failed:', resp.status, data);
      return res.status(500).json({ error: data?.error || `Retell returned ${resp.status}`, details: data });
    }
    res.json({ access_token: data.access_token });
  } catch (err) { res.status(500).json({ error: String(err) }); }
}
app.post('/api/retell/create-web-call', handleCreateWebCall);
app.post('/api/retell/token', handleCreateWebCall);

/* Retell: webhook for leads */
app.post('/api/retell/book_demo', async (req, res) => {
  try {
    const { name, email, phone, company = '', notes = '' } = req.body || {};
    if (!name || !email || !phone) return res.status(400).json({ ok:false, error:'missing_required_fields' });

    try {
      await pool.query(
        `INSERT INTO bookings (full_name, name, email, phone, company, notes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [name, name, email, phone, company || null, notes || null, 'retell_call']
      );
    } catch (e) { console.warn('retell lead save failed:', e?.message); }

    try {
      await transporter.sendMail({
        from: FROM_EMAIL, to: SALES_EMAIL, replyTo: email,
        subject: `New Retell call lead — ${name}`,
        text: `New Retell call lead\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nCompany: ${company || '-'}\n\nNotes:\n${(notes || '').trim() || '-'}`.trim()
      });
      await transporter.sendMail({
        from: FROM_EMAIL, to: email, subject:`Thanks ${name}! We’ll send your demo details`,
        text: `Hi ${name},\n\nThanks for calling! We’ve got your info:\n- Phone: ${phone}\n- Company: ${company || '-'}\n\nWe’ll follow up shortly with scheduling details.\n\n— Team Agentlyne`
      });
    } catch (e) { console.warn('retell mail send failed:', e?.message); }

    res.json({ ok:true });
  } catch (err) { res.status(500).json({ ok:false, error:'server_error' }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
