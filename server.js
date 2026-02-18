const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

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

initDb();

function initDb() {
  db.pragma('journal_mode = WAL');

  db.exec(`
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

  db.prepare(
    `INSERT OR IGNORE INTO settings (id, business_name, owner_email, timezone)
     VALUES (1, ?, ?, ?)`
  ).run(
    process.env.BUSINESS_NAME || 'IntelliSchedule',
    process.env.OWNER_EMAIL || null,
    process.env.TIMEZONE || 'America/Los_Angeles'
  );

  const count = db.prepare('SELECT COUNT(*) AS c FROM appointment_types').get().c;
  if (!count) {
    const insert = db.prepare(
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

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

function rowToType(row) {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
    locationMode: row.location_mode,
    color: row.color || COLORS[(row.id - 1) % COLORS.length],
    active: !!row.active,
    createdAt: row.created_at
  };
}

function rowToAppointment(row) {
  const key = (row.type_name || '').toLowerCase().split(' ')[0];
  return {
    id: row.id,
    typeId: row.type_id,
    typeName: row.type_name || 'General',
    typeClass: typeClassMap[key] || 'consultation',
    title: row.title || row.type_name || 'Appointment',
    clientName: row.client_name,
    clientEmail: row.client_email,
    date: row.date,
    time: row.time,
    durationMinutes: row.duration_minutes,
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

async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, reason: 'missing-to' };

  const fromEmail = process.env.FROM_EMAIL;

  // Option 1: Resend API (recommended)
  if (process.env.RESEND_API_KEY && fromEmail) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [to],
          subject,
          html,
          text
        })
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

  // Option 2: SMTP fallback
  if (process.env.SMTP_HOST && fromEmail) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || 'false') === 'true',
        auth: process.env.SMTP_USER
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS
            }
          : undefined
      });

      await transporter.sendMail({ from: fromEmail, to, subject, html, text });
      return { ok: true, provider: 'smtp' };
    } catch (error) {
      console.error('SMTP error:', error);
      return { ok: false, provider: 'smtp', error: String(error) };
    }
  }

  // Option 3: simulation (no email config yet)
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

  const type = typeId
    ? db.prepare('SELECT * FROM appointment_types WHERE id = ? AND active = 1').get(Number(typeId))
    : null;

  const result = db
    .prepare(
      `INSERT INTO appointments
       (type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
    )
    .run(
      type?.id || null,
      title || type?.name || 'Appointment',
      clientName.trim(),
      clientEmail || null,
      date,
      time,
      Number(durationMinutes || type?.duration_minutes || 45),
      location || type?.location_mode || 'office',
      notes || null,
      source || 'owner'
    );

  const appointment = rowToAppointment(
    db
      .prepare(
        `SELECT a.*, t.name AS type_name
         FROM appointments a
         LEFT JOIN appointment_types t ON t.id = a.type_id
         WHERE a.id = ?`
      )
      .get(result.lastInsertRowid)
  );

  const settings = getSettings();
  const clientText = `Hi ${appointment.clientName},\n\nYour ${appointment.typeName} is confirmed for ${appointment.date} at ${fmtTime(
    appointment.time
  )}.\n\nLocation: ${appointment.location}\nDuration: ${appointment.durationMinutes} minutes\n\nThanks,\n${settings.business_name}`;

  const ownerText = `New booking received in ${settings.business_name}\n\nType: ${appointment.typeName}\nClient: ${appointment.clientName}\nWhen: ${appointment.date} ${fmtTime(
    appointment.time
  )}\nSource: ${appointment.source}`;

  await Promise.allSettled([
    appointment.clientEmail
      ? sendEmail({
          to: appointment.clientEmail,
          subject: `${settings.business_name}: Appointment confirmed`,
          text: clientText,
          html: `<p>${clientText.replace(/\n/g, '<br/>')}</p>`
        })
      : Promise.resolve(),
    settings.owner_email
      ? sendEmail({
          to: settings.owner_email,
          subject: `[Owner Alert] New booking - ${settings.business_name}`,
          text: ownerText,
          html: `<p>${ownerText.replace(/\n/g, '<br/>')}</p>`
        })
      : Promise.resolve()
  ]);

  return appointment;
}

function createInsights(date) {
  const byType = db
    .prepare(
      `SELECT t.name, COUNT(*) AS count
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date >= date('now', '-30 day')
       GROUP BY t.name
       ORDER BY count DESC`
    )
    .all();

  const todayCount = db.prepare('SELECT COUNT(*) AS c FROM appointments WHERE date = ?').get(date).c;
  const pendingCount = db
    .prepare(`SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending'`)
    .get().c;

  const settings = getSettings();
  const busiest = byType[0];

  return [
    {
      icon: '💡',
      text: busiest
        ? `${busiest.name} is your most booked service this month (${busiest.count} bookings).`
        : 'No trend data yet. Add appointments to unlock stronger AI insights.',
      time: 'Live'
    },
    {
      icon: '📊',
      text:
        todayCount > 0
          ? `You have ${todayCount} booking${todayCount === 1 ? '' : 's'} today. Recommended: 15-minute buffers between meetings.`
          : 'No bookings today. Good window to open new slots.',
      time: 'Live'
    },
    {
      icon: '⚠️',
      text:
        pendingCount > 0
          ? `${pendingCount} booking${pendingCount === 1 ? '' : 's'} are pending confirmation.`
          : 'No pending confirmations. You are fully up to date.',
      time: 'Live'
    },
    {
      icon: '🎯',
      text: `Current timezone: ${settings.timezone}. Keep this synced for reminder accuracy.`,
      time: 'Live'
    }
  ];
}

// API
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/settings', (_req, res) => {
  res.json({ settings: getSettings() });
});

app.put('/api/settings', (req, res) => {
  const { businessName, ownerEmail, timezone } = req.body || {};
  db.prepare(
    `UPDATE settings
     SET business_name = COALESCE(?, business_name),
         owner_email = COALESCE(?, owner_email),
         timezone = COALESCE(?, timezone)
     WHERE id = 1`
  ).run(businessName || null, ownerEmail || null, timezone || null);

  res.json({ settings: getSettings() });
});

app.get('/api/types', (_req, res) => {
  const rows = db.prepare('SELECT * FROM appointment_types WHERE active = 1 ORDER BY id ASC').all();
  res.json({ types: rows.map(rowToType) });
});

app.post('/api/types', (req, res) => {
  const { name, durationMinutes, priceCents, locationMode, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const result = db
    .prepare(
      `INSERT INTO appointment_types (name, duration_minutes, price_cents, location_mode, color)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      name.trim(),
      Number(durationMinutes || 45),
      Number(priceCents || 0),
      locationMode || 'hybrid',
      color || COLORS[Math.floor(Math.random() * COLORS.length)]
    );

  const row = db.prepare('SELECT * FROM appointment_types WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ type: rowToType(row) });
});

app.put('/api/types/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, durationMinutes, priceCents, locationMode, color, active } = req.body || {};

  db.prepare(
    `UPDATE appointment_types
     SET name = COALESCE(?, name),
         duration_minutes = COALESCE(?, duration_minutes),
         price_cents = COALESCE(?, price_cents),
         location_mode = COALESCE(?, location_mode),
         color = COALESCE(?, color),
         active = COALESCE(?, active)
     WHERE id = ?`
  ).run(
    name || null,
    durationMinutes == null ? null : Number(durationMinutes),
    priceCents == null ? null : Number(priceCents),
    locationMode || null,
    color || null,
    active == null ? null : Number(!!active),
    id
  );

  const row = db.prepare('SELECT * FROM appointment_types WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'type not found' });

  res.json({ type: rowToType(row) });
});

app.delete('/api/types/:id', (req, res) => {
  db.prepare('UPDATE appointment_types SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/appointments', (req, res) => {
  const { date, q, status } = req.query;

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

  const rows = db.prepare(sql).all(...params).map(rowToAppointment);
  res.json({ appointments: rows });
});

app.post('/api/appointments', async (req, res) => {
  try {
    const appointment = await createAppointment({ ...req.body, source: req.body?.source || 'owner' });
    res.status(201).json({ appointment });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/public/bookings', async (req, res) => {
  try {
    const appointment = await createAppointment({ ...req.body, source: 'public' });
    res.status(201).json({ appointment });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/appointments/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  const info = db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
  if (!info.changes) return res.status(404).json({ error: 'appointment not found' });

  const row = db
    .prepare(
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.id = ?`
    )
    .get(id);

  const appointment = rowToAppointment(row);
  const settings = getSettings();

  if (appointment.clientEmail) {
    await sendEmail({
      to: appointment.clientEmail,
      subject: `${settings.business_name}: Appointment ${status}`,
      text: `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(appointment.time)} is now ${status}.`
    });
  }

  res.json({ appointment });
});

app.get('/api/dashboard', (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  const stats = {
    today: db.prepare('SELECT COUNT(*) AS c FROM appointments WHERE date = ?').get(date).c,
    week: db
      .prepare('SELECT COUNT(*) AS c FROM appointments WHERE date BETWEEN date(?) AND date(?, \'+6 day\')')
      .get(date, date).c,
    pending: db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending'").get().c,
    aiOptimized: db.prepare('SELECT COUNT(*) AS c FROM appointments').get().c
  };

  const appointments = db
    .prepare(
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.date = ?
       ORDER BY a.time ASC`
    )
    .all(date)
    .map(rowToAppointment);

  const types = db
    .prepare(
      `SELECT t.*, COUNT(a.id) AS booking_count
       FROM appointment_types t
       LEFT JOIN appointments a ON a.type_id = t.id
       WHERE t.active = 1
       GROUP BY t.id
       ORDER BY t.id ASC`
    )
    .all()
    .map((row) => ({ ...rowToType(row), bookingCount: row.booking_count || 0 }));

  res.json({ stats, appointments, types, insights: createInsights(date) });
});

app.get('/book', (_req, res) => {
  res.sendFile(path.join(__dirname, 'booking.html'));
});

app.listen(PORT, () => {
  console.log(`🗓️ IntelliSchedule running on http://localhost:${PORT}`);
});
