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

app.use(cors()); // tighten origins later if needed
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Serve the static site (ag-api/public)
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Be explicit for "/" just in case
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ------------------------------------------------------------------ */
/* Database (Supabase / Postgres) — force IPv4 + SNI                  */
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
    const sslRequired =
      u.searchParams.get('sslmode') === 'require' || process.env.PGSSLMODE === 'require';

    // Resolve DB host to an IPv4 address explicitly
    const { address } = await dnsPromises.lookup(host, { family: 4 });
    pool = new Pool({
      host: address,
      port,
      user,
      password,
      database,
      // keep TLS and SNI as original hostname so cert matches
      ssl: sslRequired ? { rejectUnauthorized: false, servername: host } : undefined,
      keepAlive: true,
    });
    console.log('DB mode: IPv4 (static env)', address, `(SNI: ${host}) user: ${user}`);
  } catch (err) {
    console.warn('DB IPv4 resolve failed; using connectionString fallback:', err?.message);
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
    });
  }
} else {
  pool = new Pool(); // for local dev via .env defaults
}

/* ---------- schema / migration helpers ---------- */
async function ensureSchema() {
  const createSql = `
  CREATE TABLE IF NOT EXISTS bookings (
    id            BIGSERIAL PRIMARY KEY,
    created_at    timestamptz DEFAULT now(),
    /* legacy + new fields (we keep both "name" and "full_name") */
    name          text,
    full_name     text,
    email         text,
    phone         text,
    company       text,
    notes         text,
    timezone      text,
    /* meeting times */
    start_utc     timestamptz,
    end_utc       timestamptz,
    duration_min  integer,
    /* misc */
    source        text,
    /* form echo */
    date          date,
    "time"        text
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
const smtpSecure = smtpSecureEnv
  ? ['1', 'true', 'yes', 'on'].includes(smtpSecureEnv)
  : smtpPort === 465;

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

function pick(obj, keys, def = '') {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]);
  }
  return def;
}

function tzOffsetMinutesAt(tz, epochMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'shortOffset',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(new Date(epochMs));
    const name = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
    const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1].startsWith('-') ? -1 : 1;
    const h = Math.abs(parseInt(m[1], 10));
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    return sign * (h * 60 + mm);
  } catch {
    return 0;
  }
}

function zonedToUtcISO(dateStr, timeStr, tz) {
  if (!dateStr || !timeStr || !tz) return null;
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [H, M]   = timeStr.split(':').map(Number);
    const naiveUTC = Date.UTC(y, (m ?? 1) - 1, d ?? 1, H ?? 0, M ?? 0, 0, 0);
    const offMin   = tzOffsetMinutesAt(tz, naiveUTC);
    const finalMs  = naiveUTC - offMin * 60 * 1000;
    return new Date(finalMs).toISOString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* API: health + DB helpers                                           */
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
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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

/* ------------------------------------------------------------------ */
/* Email test endpoints                                               */
/* ------------------------------------------------------------------ */
app.get('/api/email-verify', async (_req, res) => {
  try {
    await transporter.verify();
    res.json({ ok: true });
  } catch (e) {
    console.error('verify error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

/* ------------------------------------------------------------------ */
/* Slots suggester (demo)                                             */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* Book a call                                                        */
/* ------------------------------------------------------------------ */
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
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: fullName, email, date, time.'
      });
    }

    const startISO = zonedToUtcISO(date, time, timeZone || 'UTC');
    const endISO   = startISO ? new Date(new Date(startISO).getTime() + duration * 60000).toISOString() : null;

    try {
      await pool.query(
        `INSERT INTO bookings
         (full_name, name, email, phone, company, notes, timezone,
          start_utc, end_utc, duration_min, source, date, "time")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          fullName,
          fullName,
          email,
          phone,
          company,
          notes || null,
          timeZone || null,
          startISO,
          endISO,
          duration,
          source,
          date || null,
          time || null
        ]
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
${(notes || '').trim() || '-'}
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
      subject: `We received your request — ${date} ${time}`,
      text:
`Thanks ${fullName}! We received your request and will get right back to you.

What you submitted
- Email: ${email}
- Phone: ${phone || '-'}
- Company: ${company || '-'}
- Plan: ${plan} ${tier}
- Preferred time: ${date} ${time} ${timeZone || ''}

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
/* Retell: mint Web Call token (used by the website modal)            */
/* ------------------------------------------------------------------ */
// === /api/retell/token ===
// === /api/retell/token ===
// Mints a web-call access token for the website demo
// === /api/retell/token (Retell v2) ===
app.post('/api/retell/token', async (req, res) => {
  try {
    const r = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RETELL_API_KEY}`, // keep the "key_..." prefix
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: process.env.RETELL_AGENT_ID, // full ag-... string
      }),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error('retell token error:', r.status, text);
      return res.status(r.status).json({ ok: false, error: 'retell-token-failed', status: r.status });
    }

    let data;
    try { data = JSON.parse(text); } catch (e) {
      console.error('retell token parse error:', e, text);
      return res.status(502).json({ ok: false, error: 'bad-retell-response' });
    }

    // v2 returns { call_id, access_token }
    return res.json({ ok: true, accessToken: data.access_token, callId: data.call_id });
  } catch (err) {
    console.error('retell token error:', err);
    return res.status(500).json({ ok: false, error: 'token_error' });
  }
});




/* ------------------------------------------------------------------ */
/* Retell: "book_demo" webhook (called by your Custom Function)       */
/* ------------------------------------------------------------------ */
app.post('/api/retell/book_demo', async (req, res) => {
  try {
    const { name, email, phone, company = '', notes = '' } = req.body || {};

    if (!name || !email || !phone) {
      return res.status(400).json({ ok: false, error: 'missing_required_fields' });
    }

    try {
      await pool.query(
        `INSERT INTO bookings
           (full_name, name, email, phone, company, notes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [name, name, email, phone, company || null, notes || null, 'retell_call']
      );
      console.log('retell lead saved → bookings');
    } catch (e) {
      console.warn('retell lead save failed:', e?.message);
    }

    try {
      const summary = `
New Retell call lead

Name:    ${name}
Email:   ${email}
Phone:   ${phone}
Company: ${company || '-'}

Notes:
${(notes || '').trim() || '-'}
`.trim();

      await transporter.sendMail({
        from: FROM_EMAIL,
        to: SALES_EMAIL,
        replyTo: email,
        subject: `New Retell call lead — ${name}`,
        text: summary
      });

      await transporter.sendMail({
        from: FROM_EMAIL,
        to: email,
        subject: `Thanks ${name}! We’ll send your demo details`,
        text: `Hi ${name},

Thanks for calling! We’ve got your info:
- Phone: ${phone}
- Company: ${company || '-'}

We’ll follow up shortly with scheduling details.

— Team Agentlyne`
      });
    } catch (e) {
      console.warn('retell mail send failed:', e?.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('retell book_demo error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/* ------------------------------------------------------------------ */
/* Start                                                              */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 10000; // Render sets PORT
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
