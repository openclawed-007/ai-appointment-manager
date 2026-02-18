const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.db');

let sqlite = null;
let pgPool = null;

if (USE_POSTGRES) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
}

app.use(express.json());
app.use(express.static(__dirname));

const COLORS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)'
];

const typeClassMap = {
  consultation: 'consultation',
  strategy: 'strategy',
  review: 'review',
  call: 'call'
};

function qMarks(n) {
  return Array.from({ length: n }, (_, i) => (USE_POSTGRES ? `$${i + 1}` : '?')).join(', ');
}

async function dbRun(sqliteSql, postgresSql, params = []) {
  if (USE_POSTGRES) {
    const result = await pgPool.query(postgresSql, params);
    return result;
  }
  return sqlite.prepare(sqliteSql).run(...params);
}

async function dbGet(sqliteSql, postgresSql, params = []) {
  if (USE_POSTGRES) {
    const result = await pgPool.query(postgresSql, params);
    return result.rows[0] || null;
  }
  return sqlite.prepare(sqliteSql).get(...params) || null;
}

async function dbAll(sqliteSql, postgresSql, params = []) {
  if (USE_POSTGRES) {
    const result = await pgPool.query(postgresSql, params);
    return result.rows;
  }
  return sqlite.prepare(sqliteSql).all(...params);
}

async function initDb() {
  if (USE_POSTGRES) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
      );

      CREATE TABLE IF NOT EXISTS appointment_types (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        price_cents INTEGER NOT NULL DEFAULT 0,
        location_mode TEXT NOT NULL DEFAULT 'hybrid',
        color TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        type_id INTEGER REFERENCES appointment_types(id),
        title TEXT,
        client_name TEXT NOT NULL,
        client_email TEXT,
        date DATE NOT NULL,
        time TIME NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        location TEXT NOT NULL DEFAULT 'office',
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'confirmed',
        source TEXT NOT NULL DEFAULT 'owner',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
    `);

    await pgPool.query(
      `INSERT INTO settings (id, business_name, owner_email, timezone)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [
        process.env.BUSINESS_NAME || 'IntelliSchedule',
        process.env.OWNER_EMAIL || null,
        process.env.TIMEZONE || 'America/Los_Angeles'
      ]
    );

    const typeCount = Number((await pgPool.query('SELECT COUNT(*)::int as c FROM appointment_types')).rows[0].c);
    if (!typeCount) {
      await pgPool.query(
        `INSERT INTO appointment_types (name, duration_minutes, price_cents, location_mode, color)
         VALUES
           ($1, $2, $3, $4, $5),
           ($6, $7, $8, $9, $10),
           ($11, $12, $13, $14, $15),
           ($16, $17, $18, $19, $20)`,
        [
          'Consultation', 45, 15000, 'office', COLORS[0],
          'Strategy Session', 90, 30000, 'hybrid', COLORS[1],
          'Review', 60, 20000, 'virtual', COLORS[2],
          'Follow-up Call', 15, 0, 'phone', COLORS[3]
        ]
      );
    }
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
      );

      CREATE TABLE IF NOT EXISTS appointment_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        price_cents INTEGER NOT NULL DEFAULT 0,
        location_mode TEXT NOT NULL DEFAULT 'hybrid',
        color TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id INTEGER,
        title TEXT,
        client_name TEXT NOT NULL,
        client_email TEXT,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        location TEXT NOT NULL DEFAULT 'office',
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'confirmed',
        source TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(type_id) REFERENCES appointment_types(id)
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
    `);

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO settings (id, business_name, owner_email, timezone)
         VALUES (1, ?, ?, ?)`
      )
      .run(
        process.env.BUSINESS_NAME || 'IntelliSchedule',
        process.env.OWNER_EMAIL || null,
        process.env.TIMEZONE || 'America/Los_Angeles'
      );

    const count = sqlite.prepare('SELECT COUNT(*) AS c FROM appointment_types').get().c;
    if (!count) {
      const insert = sqlite.prepare(
        `INSERT INTO appointment_types (name, duration_minutes, price_cents, location_mode, color)
         VALUES (?, ?, ?, ?, ?)`
      );
      [
        ['Consultation', 45, 15000, 'office', COLORS[0]],
        ['Strategy Session', 90, 30000, 'hybrid', COLORS[1]],
        ['Review', 60, 20000, 'virtual', COLORS[2]],
        ['Follow-up Call', 15, 0, 'phone', COLORS[3]]
      ].forEach((row) => insert.run(...row));
    }
  }
}

function rowToType(row) {
  return {
    id: Number(row.id),
    name: row.name,
    durationMinutes: Number(row.duration_minutes),
    priceCents: Number(row.price_cents),
    locationMode: row.location_mode,
    color: row.color || COLORS[(Number(row.id) - 1) % COLORS.length],
    active: row.active === true || row.active === 1,
    createdAt: row.created_at
  };
}

function rowToAppointment(row) {
  const key = (row.type_name || '').toLowerCase().split(' ')[0];
  const date = typeof row.date === 'string' ? row.date.slice(0, 10) : row.date?.toISOString?.().slice(0, 10);
  const time = typeof row.time === 'string' ? row.time.slice(0, 5) : '09:00';

  return {
    id: Number(row.id),
    typeId: row.type_id ? Number(row.type_id) : null,
    typeName: row.type_name || 'General',
    typeClass: typeClassMap[key] || 'consultation',
    title: row.title || row.type_name || 'Appointment',
    clientName: row.client_name,
    clientEmail: row.client_email,
    date,
    time,
    durationMinutes: Number(row.duration_minutes),
    location: row.location,
    notes: row.notes,
    status: row.status,
    source: row.source,
    createdAt: row.created_at
  };
}

function fmtTime(time24) {
  const [h, m] = String(time24 || '09:00').split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

async function getSettings() {
  return dbGet('SELECT * FROM settings WHERE id = 1', 'SELECT * FROM settings WHERE id = 1');
}

function parseTimeOrThrow(timeValue) {
  const match = String(timeValue || '').match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw new Error('time must be in HH:MM format');
  return Number(match[1]) * 60 + Number(match[2]);
}

async function assertNoOverlap({ date, startMinutes, durationMinutes, excludeId = null }) {
  const rows = await dbAll(
    `SELECT id, time, duration_minutes
     FROM appointments
     WHERE date = ? AND status != 'cancelled'
     ORDER BY time ASC`,
    `SELECT id, time, duration_minutes
     FROM appointments
     WHERE date = $1 AND status != 'cancelled'
     ORDER BY time ASC`,
    [String(date)]
  );

  const endMinutes = startMinutes + durationMinutes;
  const blocker = rows.find((row) => {
    if (excludeId != null && Number(row.id) === Number(excludeId)) return false;
    const otherStart = parseTimeToMinutes(row.time);
    const otherEnd = otherStart + Number(row.duration_minutes || 45);
    return startMinutes < otherEnd && endMinutes > otherStart;
  });

  if (blocker) {
    const otherStart = parseTimeToMinutes(blocker.time);
    const otherEnd = otherStart + Number(blocker.duration_minutes || 45);
    throw new Error(`Time overlaps with another appointment (${humanTime(otherStart)}-${humanTime(otherEnd)}).`);
  }
}

function escapeHtmlEmail(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function textToHtmlParagraphs(text = '') {
  return escapeHtmlEmail(text).replaceAll('\n', '<br/>');
}

function buildBrandedEmailHtml({ businessName, title, subtitle, message, details = [] }) {
  const brand = escapeHtmlEmail(businessName || 'IntelliSchedule');
  const safeTitle = escapeHtmlEmail(title || 'Appointment Update');
  const safeSubtitle = subtitle ? `<p style="margin:6px 0 0;color:#64748b;font-size:14px;">${escapeHtmlEmail(subtitle)}</p>` : '';
  const safeMessage = textToHtmlParagraphs(message || '');
  const detailsHtml = details.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-collapse:separate;border-spacing:0 8px;">
        ${details
          .map(
            (d) => `
              <tr>
                <td style="padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:.4px;">${escapeHtmlEmail(
                  d.label
                )}</td>
                <td style="padding:8px 10px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;color:#0f172a;">${escapeHtmlEmail(
                  d.value
                )}</td>
              </tr>`
          )
          .join('')}
      </table>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#ffffff;">
                <div style="font-size:13px;opacity:.9;">${brand}</div>
                <div style="font-size:22px;font-weight:800;line-height:1.2;margin-top:4px;">${safeTitle}</div>
                ${safeSubtitle}
              </td>
            </tr>
            <tr>
              <td style="padding:20px;">
                <div style="font-size:14px;line-height:1.65;color:#0f172a;">${safeMessage}</div>
                ${detailsHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
                Sent by ${brand}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildCancellationEmailHtml({ businessName, appointment, cancellationReason = '' }) {
  const brand = escapeHtmlEmail(businessName || 'IntelliSchedule');
  const clientName = escapeHtmlEmail(appointment?.clientName || 'there');
  const typeName = escapeHtmlEmail(appointment?.typeName || 'Appointment');
  const dateValue = escapeHtmlEmail(appointment?.date || '');
  const timeValue = escapeHtmlEmail(fmtTime(appointment?.time));
  const location = escapeHtmlEmail(appointment?.location || 'office');
  const reasonValue = String(cancellationReason || '').trim();
  const reasonBlock = reasonValue
    ? `
                <p style="margin:12px 0 0;font-size:14px;line-height:1.65;color:#7c2d12;">
                  <strong>Reason:</strong> ${escapeHtmlEmail(reasonValue)}
                </p>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff7ed;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #fed7aa;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(135deg,#dc2626 0%,#f97316 100%);color:#ffffff;">
                <div style="font-size:13px;opacity:.95;">${brand}</div>
                <div style="font-size:22px;font-weight:800;line-height:1.2;margin-top:4px;">Appointment Cancelled</div>
                <p style="margin:6px 0 0;font-size:14px;opacity:.95;">${typeName}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px;">
                <p style="margin:0 0 10px;font-size:14px;line-height:1.65;color:#0f172a;">Hi ${clientName},</p>
                <p style="margin:0 0 12px;font-size:14px;line-height:1.65;color:#0f172a;">Your booking has been cancelled. If this was a mistake, reply to this email and we can help rebook quickly.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0 8px;">
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Service</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${typeName}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Date</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${dateValue}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Time</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${timeValue}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Location</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${location}</td>
                  </tr>
                </table>
                ${reasonBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #fed7aa;font-size:12px;color:#9a3412;">
                Sent by ${brand}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, reason: 'missing-to' };
  const fromEmail = process.env.FROM_EMAIL;

  if (process.env.RESEND_API_KEY && fromEmail) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: fromEmail, to: [to], subject, html, text })
      });

      if (!response.ok) {
        const body = await response.text();
        console.error('Resend failed:', body);
        return { ok: false, provider: 'resend', body };
      }
      return { ok: true, provider: 'resend' };
    } catch (error) {
      console.error('Resend error:', error);
      return { ok: false, provider: 'resend', error: String(error) };
    }
  }

  if (process.env.SMTP_HOST && fromEmail) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || 'false') === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      });

      await transporter.sendMail({ from: fromEmail, to, subject, html, text });
      return { ok: true, provider: 'smtp' };
    } catch (error) {
      console.error('SMTP error:', error);
      return { ok: false, provider: 'smtp', error: String(error) };
    }
  }

  console.log('[EMAIL_SIMULATION]', { to, subject, preview: text?.slice(0, 120) });
  return { ok: true, provider: 'simulation' };
}

async function createAppointment(payload = {}) {
  const {
    typeId,
    title,
    clientName,
    clientEmail,
    date,
    time,
    durationMinutes,
    location,
    notes,
    source
  } = payload;

  if (!clientName?.trim()) throw new Error('clientName is required');
  if (!date) throw new Error('date is required');
  if (!time) throw new Error('time is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date must be in YYYY-MM-DD format');

  const type = typeId
    ? await dbGet(
        'SELECT * FROM appointment_types WHERE id = ? AND active = 1',
        'SELECT * FROM appointment_types WHERE id = $1 AND active = TRUE',
        [Number(typeId)]
      )
    : null;

  const resolvedDuration = Number(durationMinutes || type?.duration_minutes || 45);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    throw new Error('durationMinutes must be greater than 0');
  }
  const startMinutes = parseTimeOrThrow(time);
  await assertNoOverlap({
    date: String(date),
    startMinutes,
    durationMinutes: resolvedDuration
  });

  const params = [
    type?.id || null,
    title || type?.name || 'Appointment',
    clientName.trim(),
    clientEmail || null,
    date,
    time,
    resolvedDuration,
    location || type?.location_mode || 'office',
    notes || null,
    source || 'owner'
  ];

  let id;
  if (USE_POSTGRES) {
    const insert = await pgPool.query(
      `INSERT INTO appointments
       (type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10)
       RETURNING id`,
      params
    );
    id = insert.rows[0].id;
  } else {
    const result = sqlite
      .prepare(
        `INSERT INTO appointments
         (type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
      )
      .run(...params);
    id = result.lastInsertRowid;
  }

  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1`,
    [id]
  );

  const appointment = rowToAppointment(row);
  const settings = await getSettings();

  const clientText = `Hi ${appointment.clientName},\n\nYour ${appointment.typeName} is confirmed for ${appointment.date} at ${fmtTime(
    appointment.time
  )}.\n\nLocation: ${appointment.location}\nDuration: ${appointment.durationMinutes} minutes\n\nThanks,\n${settings.business_name}`;
  const clientHtml = buildBrandedEmailHtml({
    businessName: settings.business_name,
    title: 'Appointment Confirmed',
    subtitle: appointment.typeName,
    message: `Hi ${appointment.clientName},\n\nYour appointment is confirmed.`,
    details: [
      { label: 'Service', value: appointment.typeName },
      { label: 'Date', value: appointment.date },
      { label: 'Time', value: fmtTime(appointment.time) },
      { label: 'Duration', value: `${appointment.durationMinutes} minutes` },
      { label: 'Location', value: appointment.location }
    ]
  });

  const ownerText = `New booking received in ${settings.business_name}\n\nType: ${appointment.typeName}\nClient: ${appointment.clientName}\nWhen: ${appointment.date} ${fmtTime(
    appointment.time
  )}\nSource: ${appointment.source}`;
  const ownerHtml = buildBrandedEmailHtml({
    businessName: settings.business_name,
    title: 'New Booking Alert',
    subtitle: 'Owner Notification',
    message: 'A new booking has been created.',
    details: [
      { label: 'Service', value: appointment.typeName },
      { label: 'Client', value: appointment.clientName },
      { label: 'When', value: `${appointment.date} ${fmtTime(appointment.time)}` },
      { label: 'Source', value: appointment.source }
    ]
  });

  const notifyResults = await Promise.allSettled([
    appointment.clientEmail
      ? sendEmail({
          to: appointment.clientEmail,
          subject: `${settings.business_name}: Appointment confirmed`,
          text: clientText,
          html: clientHtml
        })
      : Promise.resolve(),
    settings.owner_email
      ? sendEmail({
          to: settings.owner_email,
          subject: `[Owner Alert] New booking - ${settings.business_name}`,
          text: ownerText,
          html: ownerHtml
        })
      : Promise.resolve()
  ]);

  const provider = notifyResults
    .filter((r) => r.status === 'fulfilled' && r.value?.provider)
    .map((r) => r.value.provider)[0] || 'none';

  return {
    appointment,
    notifications: {
      mode: provider,
      sent: notifyResults.filter((r) => r.status === 'fulfilled' && r.value?.ok).length
    }
  };
}

function toYmd(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseTimeToMinutes(timeValue = '09:00') {
  const [h, m] = String(timeValue).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 9 * 60;
}

function humanTime(minutesFromMidnight = 540) {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return fmtTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

async function createInsights(date) {
  const focusDate = new Date(`${date}T00:00:00`);
  if (Number.isNaN(focusDate.getTime())) return [];

  const from30 = new Date(focusDate);
  from30.setDate(from30.getDate() - 29);
  const to7 = new Date(focusDate);
  to7.setDate(to7.getDate() + 6);

  const from30Str = toYmd(from30);
  const to7Str = toYmd(to7);

  const [recentAllRows, recentActiveRows, selectedDayRows, weekRows, pendingRow, settings] = await Promise.all([
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date >= ?
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date >= $1
       ORDER BY a.date ASC, a.time ASC`,
      [from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date >= ? AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date >= $1 AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      [from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date = ? AND a.status != 'cancelled'
       ORDER BY a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date = $1 AND a.status != 'cancelled'
       ORDER BY a.time ASC`,
      [date]
    ),
    dbAll(
      `SELECT a.date
       FROM appointments a
       WHERE a.date BETWEEN ? AND ? AND a.status != 'cancelled'`,
      `SELECT a.date
       FROM appointments a
       WHERE a.date BETWEEN $1 AND $2 AND a.status != 'cancelled'`,
      [date, to7Str]
    ),
    dbGet(
      "SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending'",
      "SELECT COUNT(*)::int AS c FROM appointments WHERE status = 'pending'"
    ),
    getSettings()
  ]);

  const insights = [];

  if (!recentAllRows.length) {
    insights.push({
      icon: '💡',
      text: 'No historical bookings yet. Add a few appointments to unlock utilization and trend insights.',
      action: 'Create your first week of slots, then check insights again.',
      confidence: 'Low confidence (not enough data)',
      time: 'Now'
    });
    insights.push({
      icon: '🎯',
      text: `Current timezone is ${settings.timezone}.`,
      action: 'Keep timezone synced for reminder accuracy.',
      confidence: 'High confidence',
      time: 'Now'
    });
    return insights;
  }

  const typeCounts = new Map();
  const hourCounts = new Map();
  recentActiveRows.forEach((row) => {
    const typeName = String(row.type_name || 'Appointment');
    typeCounts.set(typeName, (typeCounts.get(typeName) || 0) + 1);
    const mins = parseTimeToMinutes(row.time);
    const hour = Math.floor(mins / 60);
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  });

  const busiestType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (busiestType) {
    const pct = Math.round((busiestType[1] / Math.max(recentActiveRows.length, 1)) * 100);
    insights.push({
      icon: '📈',
      text: `${busiestType[0]} is your top service in the last 30 days (${busiestType[1]} bookings, ${pct}% share).`,
      action: 'Prioritize this service in peak-time slots and booking page order.',
      confidence: recentActiveRows.length >= 20 ? 'High confidence' : 'Medium confidence',
      time: '30-day trend'
    });
  }

  const peakHourEntry = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (peakHourEntry) {
    const peakStart = peakHourEntry[0] * 60;
    insights.push({
      icon: '🕒',
      text: `Peak demand window is around ${humanTime(peakStart)} (${peakHourEntry[1]} bookings).`,
      action: 'Protect this window for high-value services and avoid admin tasks here.',
      confidence: recentActiveRows.length >= 15 ? 'High confidence' : 'Medium confidence',
      time: 'Pattern'
    });
  }

  const dayLoad = new Map();
  weekRows.forEach((r) => dayLoad.set(String(r.date), (dayLoad.get(String(r.date)) || 0) + 1));
  const weekValues = Array.from(dayLoad.values());
  const maxDayLoad = weekValues.length ? Math.max(...weekValues) : 0;
  if (maxDayLoad >= 7) {
    const overloadedDay = [...dayLoad.entries()].sort((a, b) => b[1] - a[1])[0];
    insights.push({
      icon: '⚠️',
      text: `Heaviest upcoming day is ${overloadedDay[0]} with ${overloadedDay[1]} bookings.`,
      action: 'Add buffers or move 1-2 low-priority bookings to a lighter day.',
      confidence: 'High confidence',
      time: 'Next 7 days'
    });
  } else {
    insights.push({
      icon: '✅',
      text: `Upcoming load looks balanced (max ${maxDayLoad} bookings on any day in next 7 days).`,
      action: 'Open one extra premium slot on your lightest day to lift revenue.',
      confidence: 'High confidence',
      time: 'Next 7 days'
    });
  }

  if (selectedDayRows.length >= 2) {
    const blocks = selectedDayRows.map((r) => {
      const start = parseTimeToMinutes(r.time);
      const duration = Number(r.duration_minutes || 45);
      return { start, end: start + duration };
    });
    let bestGap = 0;
    let bestGapStart = null;
    for (let i = 0; i < blocks.length - 1; i += 1) {
      const gap = blocks[i + 1].start - blocks[i].end;
      if (gap > bestGap) {
        bestGap = gap;
        bestGapStart = blocks[i].end;
      }
    }
    if (bestGap >= 45 && bestGapStart != null) {
      insights.push({
        icon: '🧩',
        text: `There is a ${bestGap}-minute gap on ${date} starting around ${humanTime(bestGapStart)}.`,
        action: 'Good slot for a short consultation or same-day booking.',
        confidence: 'High confidence',
        time: 'Schedule optimization'
      });
    }
  }

  const totalRecent = recentAllRows.length;
  const cancelledRecent = recentAllRows.filter((r) => String(r.status) === 'cancelled').length;
  const cancelRate = totalRecent ? Math.round((cancelledRecent / totalRecent) * 100) : 0;
  if (cancelRate >= 15) {
    insights.push({
      icon: '📉',
      text: `Cancellation rate is ${cancelRate}% over the last 30 days.`,
      action: 'Use confirmation reminders 24 hours before start time to reduce churn.',
      confidence: totalRecent >= 20 ? 'High confidence' : 'Medium confidence',
      time: 'Reliability'
    });
  }

  const pendingCount = Number(pendingRow?.c || 0);
  if (pendingCount > 0) {
    insights.push({
      icon: '📬',
      text: `${pendingCount} booking${pendingCount === 1 ? '' : 's'} are pending confirmation.`,
      action: 'Clear pending items first to stabilize this week’s schedule.',
      confidence: 'High confidence',
      time: 'Action now'
    });
  }

  insights.push({
    icon: '🌍',
    text: `Timezone is set to ${settings.timezone}.`,
    action: 'Keep timezone aligned with business hours and reminder rules.',
    confidence: 'High confidence',
    time: 'Configuration'
  });

  return insights.slice(0, 6);
}

// API
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: USE_POSTGRES ? 'postgres' : 'sqlite' });
});

app.get('/api/settings', async (_req, res) => {
  res.json({ settings: await getSettings() });
});

app.put('/api/settings', async (req, res) => {
  const { businessName, ownerEmail, timezone } = req.body || {};

  await dbRun(
    `UPDATE settings
     SET business_name = COALESCE(?, business_name),
         owner_email = COALESCE(?, owner_email),
         timezone = COALESCE(?, timezone)
     WHERE id = 1`,
    `UPDATE settings
     SET business_name = COALESCE($1, business_name),
         owner_email = COALESCE($2, owner_email),
         timezone = COALESCE($3, timezone)
     WHERE id = 1`,
    [businessName || null, ownerEmail || null, timezone || null]
  );

  res.json({ settings: await getSettings() });
});

app.get('/api/types', async (_req, res) => {
  const rows = await dbAll(
    'SELECT * FROM appointment_types WHERE active = 1 ORDER BY id ASC',
    'SELECT * FROM appointment_types WHERE active = TRUE ORDER BY id ASC'
  );
  res.json({ types: rows.map(rowToType) });
});

app.post('/api/types', async (req, res) => {
  const { name, durationMinutes, priceCents, locationMode, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const params = [
    name.trim(),
    Number(durationMinutes || 45),
    Number(priceCents || 0),
    locationMode || 'hybrid',
    color || COLORS[Math.floor(Math.random() * COLORS.length)]
  ];

  let row;
  if (USE_POSTGRES) {
    row = (
      await pgPool.query(
        `INSERT INTO appointment_types (name, duration_minutes, price_cents, location_mode, color)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        params
      )
    ).rows[0];
  } else {
    const result = sqlite
      .prepare(
        `INSERT INTO appointment_types (name, duration_minutes, price_cents, location_mode, color)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(...params);
    row = sqlite.prepare('SELECT * FROM appointment_types WHERE id = ?').get(result.lastInsertRowid);
  }

  res.status(201).json({ type: rowToType(row) });
});

app.put('/api/types/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, durationMinutes, priceCents, locationMode, color, active } = req.body || {};

  await dbRun(
    `UPDATE appointment_types
     SET name = COALESCE(?, name),
         duration_minutes = COALESCE(?, duration_minutes),
         price_cents = COALESCE(?, price_cents),
         location_mode = COALESCE(?, location_mode),
         color = COALESCE(?, color),
         active = COALESCE(?, active)
     WHERE id = ?`,
    `UPDATE appointment_types
     SET name = COALESCE($1, name),
         duration_minutes = COALESCE($2, duration_minutes),
         price_cents = COALESCE($3, price_cents),
         location_mode = COALESCE($4, location_mode),
         color = COALESCE($5, color),
         active = COALESCE($6, active)
     WHERE id = $7`,
    [
      name || null,
      durationMinutes == null ? null : Number(durationMinutes),
      priceCents == null ? null : Number(priceCents),
      locationMode || null,
      color || null,
      active == null ? null : USE_POSTGRES ? !!active : Number(!!active),
      id
    ]
  );

  const row = await dbGet(
    'SELECT * FROM appointment_types WHERE id = ?',
    'SELECT * FROM appointment_types WHERE id = $1',
    [id]
  );

  if (!row) return res.status(404).json({ error: 'type not found' });
  res.json({ type: rowToType(row) });
});

app.delete('/api/types/:id', async (req, res) => {
  await dbRun(
    'UPDATE appointment_types SET active = 0 WHERE id = ?',
    'UPDATE appointment_types SET active = FALSE WHERE id = $1',
    [Number(req.params.id)]
  );
  res.json({ ok: true });
});

app.get('/api/appointments', async (req, res) => {
  const { date, q, status } = req.query;

  if (!USE_POSTGRES) {
    let sql = `
      SELECT a.*, t.name AS type_name
      FROM appointments a
      LEFT JOIN appointment_types t ON t.id = a.type_id
      WHERE 1 = 1
    `;
    const params = [];

    if (date) {
      sql += ' AND a.date = ?';
      params.push(String(date));
    }
    if (status) {
      sql += ' AND a.status = ?';
      params.push(String(status));
    }
    if (q) {
      sql += ' AND (a.client_name LIKE ? OR a.client_email LIKE ? OR a.title LIKE ? OR t.name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY a.date ASC, a.time ASC';
    const rows = sqlite.prepare(sql).all(...params).map(rowToAppointment);
    return res.json({ appointments: rows });
  }

  let sql = `
    SELECT a.*, t.name AS type_name
    FROM appointments a
    LEFT JOIN appointment_types t ON t.id = a.type_id
    WHERE 1 = 1
  `;
  const params = [];

  if (date) {
    params.push(String(date));
    sql += ` AND a.date = $${params.length}`;
  }
  if (status) {
    params.push(String(status));
    sql += ` AND a.status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    sql += ` AND (a.client_name ILIKE $${idx} OR a.client_email ILIKE $${idx} OR a.title ILIKE $${idx} OR t.name ILIKE $${idx})`;
  }

  sql += ' ORDER BY a.date ASC, a.time ASC';
  const rows = (await pgPool.query(sql, params)).rows.map(rowToAppointment);
  return res.json({ appointments: rows });
});

app.post('/api/appointments', async (req, res) => {
  try {
    const result = await createAppointment({ ...req.body, source: req.body?.source || 'owner' });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/public/bookings', async (req, res) => {
  try {
    const result = await createAppointment({ ...req.body, source: 'public' });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/appointments/:id/email', async (req, res) => {
  const id = Number(req.params.id);
  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1`,
    [id]
  );

  if (!row) return res.status(404).json({ error: 'appointment not found' });
  const appointment = rowToAppointment(row);
  if (!appointment.clientEmail) return res.status(400).json({ error: 'This appointment has no client email.' });

  const settings = await getSettings();
  const { template, subject, message } = req.body || {};
  const selectedTemplate = String(template || 'summary');

  let emailSubject = `${settings.business_name}: Appointment details`;
  let text;

  if (selectedTemplate === 'custom') {
    if (!String(message || '').trim()) {
      return res.status(400).json({ error: 'Custom message is required.' });
    }
    emailSubject = String(subject || `${settings.business_name}: Message about your appointment`).trim();
    text = `Hi ${appointment.clientName},\n\n${String(message).trim()}\n\n---\nAppointment reference:\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(
      appointment.time
    )}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\nStatus: ${appointment.status}\n\nThanks,\n${settings.business_name}`;
  } else if (selectedTemplate === 'reminder') {
    emailSubject = `${settings.business_name}: Appointment reminder`;
    text = `Hi ${appointment.clientName},\n\nQuick reminder for your upcoming appointment:\n\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(
      appointment.time
    )}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\n\nReply if you need to reschedule.\n\nThanks,\n${settings.business_name}`;
  } else {
    text = `Hi ${appointment.clientName},\n\nThis is your appointment summary:\n\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(
      appointment.time
    )}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\nStatus: ${appointment.status}\n\nThanks,\n${settings.business_name}`;
  }

  const result = await sendEmail({
    to: appointment.clientEmail,
    subject: emailSubject,
    text,
    html: buildBrandedEmailHtml({
      businessName: settings.business_name,
      title: emailSubject,
      subtitle: appointment.typeName,
      message: text,
      details: [
        { label: 'Service', value: appointment.typeName },
        { label: 'Date', value: appointment.date },
        { label: 'Time', value: fmtTime(appointment.time) },
        { label: 'Duration', value: `${appointment.durationMinutes} minutes` },
        { label: 'Location', value: appointment.location },
        { label: 'Status', value: appointment.status }
      ]
    })
  });

  if (!result.ok) {
    return res.status(502).json({ error: 'Could not send email right now.', provider: result.provider || 'unknown' });
  }

  return res.json({
    ok: true,
    provider: result.provider || 'unknown',
    appointmentId: appointment.id
  });
});

app.put('/api/appointments/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { typeId, clientName, clientEmail, date, time, durationMinutes, location, notes } = req.body || {};

  if (!clientName?.trim()) return res.status(400).json({ error: 'clientName is required' });
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!time) return res.status(400).json({ error: 'time is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });

  let selectedType = null;
  if (typeId != null) {
    selectedType = await dbGet(
      'SELECT * FROM appointment_types WHERE id = ? AND active = 1',
      'SELECT * FROM appointment_types WHERE id = $1 AND active = TRUE',
      [Number(typeId)]
    );
    if (!selectedType) return res.status(400).json({ error: 'Invalid appointment type' });
  }

  const resolvedDuration = Number(durationMinutes || selectedType?.duration_minutes || 45);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    return res.status(400).json({ error: 'durationMinutes must be greater than 0' });
  }

  try {
    await assertNoOverlap({
      date: String(date),
      startMinutes: parseTimeOrThrow(time),
      durationMinutes: resolvedDuration,
      excludeId: id
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (USE_POSTGRES) {
    const up = await pgPool.query(
      `UPDATE appointments
       SET type_id = $1,
           client_name = $2,
           client_email = $3,
           date = $4,
           time = $5,
           duration_minutes = $6,
           location = $7,
           notes = $8
       WHERE id = $9`,
      [
        selectedType?.id || null,
        clientName.trim(),
        clientEmail || null,
        String(date),
        String(time),
        resolvedDuration,
        location || selectedType?.location_mode || 'office',
        notes || null,
        id
      ]
    );
    if (!up.rowCount) return res.status(404).json({ error: 'appointment not found' });
  } else {
    const up = sqlite
      .prepare(
        `UPDATE appointments
         SET type_id = ?,
             client_name = ?,
             client_email = ?,
             date = ?,
             time = ?,
             duration_minutes = ?,
             location = ?,
             notes = ?
         WHERE id = ?`
      )
      .run(
        selectedType?.id || null,
        clientName.trim(),
        clientEmail || null,
        String(date),
        String(time),
        resolvedDuration,
        location || selectedType?.location_mode || 'office',
        notes || null,
        id
      );
    if (!up.changes) return res.status(404).json({ error: 'appointment not found' });
  }

  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1`,
    [id]
  );

  res.json({ appointment: rowToAppointment(row) });
});

app.delete('/api/appointments/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (USE_POSTGRES) {
    const result = await pgPool.query('DELETE FROM appointments WHERE id = $1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'appointment not found' });
    return res.json({ ok: true });
  }

  const info = sqlite.prepare('DELETE FROM appointments WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'appointment not found' });
  return res.json({ ok: true });
});

app.patch('/api/appointments/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const { status, cancellationReason } = req.body || {};
  const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  if (USE_POSTGRES) {
    const up = await pgPool.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, id]);
    if (!up.rowCount) return res.status(404).json({ error: 'appointment not found' });
  } else {
    const up = sqlite.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
    if (!up.changes) return res.status(404).json({ error: 'appointment not found' });
  }

  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1`,
    [id]
  );

  const appointment = rowToAppointment(row);
  const settings = await getSettings();
  const cleanCancellationReason = String(cancellationReason || '').trim();

  if (appointment.clientEmail) {
    const isCancelled = status === 'cancelled';
    const statusText = isCancelled
      ? `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(
          appointment.time
        )} has been cancelled.${cleanCancellationReason ? `\n\nReason: ${cleanCancellationReason}` : ''}`
      : `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(
          appointment.time
        )} is now ${status}.`;
    await sendEmail({
      to: appointment.clientEmail,
      subject: isCancelled ? `${settings.business_name}: Appointment cancelled` : `${settings.business_name}: Appointment ${status}`,
      text: statusText,
      html: isCancelled
        ? buildCancellationEmailHtml({
            businessName: settings.business_name,
            appointment,
            cancellationReason: cleanCancellationReason
          })
        : buildBrandedEmailHtml({
            businessName: settings.business_name,
            title: `Appointment ${status}`,
            subtitle: appointment.typeName,
            message: statusText,
            details: [
              { label: 'Date', value: appointment.date },
              { label: 'Time', value: fmtTime(appointment.time) },
              { label: 'Status', value: status }
            ]
          })
    });
  }

  res.json({ appointment });
});

app.get('/api/dashboard', async (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  let stats;
  if (USE_POSTGRES) {
    const [today, week, pending, total] = await Promise.all([
      pgPool.query('SELECT COUNT(*)::int AS c FROM appointments WHERE date = $1', [date]),
      pgPool.query(
        "SELECT COUNT(*)::int AS c FROM appointments WHERE date BETWEEN $1::date AND ($1::date + INTERVAL '6 day')",
        [date]
      ),
      pgPool.query("SELECT COUNT(*)::int AS c FROM appointments WHERE status = 'pending'"),
      pgPool.query('SELECT COUNT(*)::int AS c FROM appointments')
    ]);

    stats = {
      today: today.rows[0].c,
      week: week.rows[0].c,
      pending: pending.rows[0].c,
      aiOptimized: total.rows[0].c
    };
  } else {
    stats = {
      today: sqlite.prepare('SELECT COUNT(*) AS c FROM appointments WHERE date = ?').get(date).c,
      week: sqlite
        .prepare("SELECT COUNT(*) AS c FROM appointments WHERE date BETWEEN date(?) AND date(?, '+6 day')")
        .get(date, date).c,
      pending: sqlite.prepare("SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending'").get().c,
      aiOptimized: sqlite.prepare('SELECT COUNT(*) AS c FROM appointments').get().c
    };
  }

  const appointments = (
    await dbAll(
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date = ?
       ORDER BY a.time ASC`,
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date = $1
       ORDER BY a.time ASC`,
      [date]
    )
  ).map(rowToAppointment);

  const typeRows = await dbAll(
    `SELECT t.*, COUNT(a.id) AS booking_count
     FROM appointment_types t
     LEFT JOIN appointments a ON a.type_id = t.id
     WHERE t.active = 1
     GROUP BY t.id
     ORDER BY t.id ASC`,
    `SELECT t.*, COUNT(a.id)::int AS booking_count
     FROM appointment_types t
     LEFT JOIN appointments a ON a.type_id = t.id
     WHERE t.active = TRUE
     GROUP BY t.id
     ORDER BY t.id ASC`
  );

  const types = typeRows.map((row) => ({ ...rowToType(row), bookingCount: Number(row.booking_count || 0) }));

  res.json({ stats, appointments, types, insights: await createInsights(date) });
});

app.get('/book', (_req, res) => {
  res.sendFile(path.join(__dirname, 'booking.html'));
});

const db = {
  close: async () => {
    if (pgPool) await pgPool.end();
    if (sqlite) sqlite.close();
  },
  mode: USE_POSTGRES ? 'postgres' : 'sqlite'
};

const boot = initDb().then(() => {
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`🗓️ IntelliSchedule running on http://localhost:${PORT} (${db.mode})`);
    });
  }
});

module.exports = { app, db, boot };
