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

  const type = typeId
    ? await dbGet(
        'SELECT * FROM appointment_types WHERE id = ? AND active = 1',
        'SELECT * FROM appointment_types WHERE id = $1 AND active = TRUE',
        [Number(typeId)]
      )
    : null;

  const params = [
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

  const ownerText = `New booking received in ${settings.business_name}\n\nType: ${appointment.typeName}\nClient: ${appointment.clientName}\nWhen: ${appointment.date} ${fmtTime(
    appointment.time
  )}\nSource: ${appointment.source}`;

  const notifyResults = await Promise.allSettled([
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

async function createInsights(date) {
  const byType = await dbAll(
    `SELECT t.name, COUNT(*) AS count
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.date >= date('now', '-30 day')
     GROUP BY t.name
     ORDER BY count DESC`,
    `SELECT t.name, COUNT(*)::int AS count
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.date >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY t.name
     ORDER BY count DESC`
  );

  const todayCount = Number(
    (
      await dbGet(
        'SELECT COUNT(*) AS c FROM appointments WHERE date = ?',
        'SELECT COUNT(*)::int AS c FROM appointments WHERE date = $1',
        [date]
      )
    ).c
  );

  const pendingCount = Number(
    (
      await dbGet(
        "SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending'",
        "SELECT COUNT(*)::int AS c FROM appointments WHERE status = 'pending'"
      )
    ).c
  );

  const settings = await getSettings();
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

app.put('/api/appointments/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { typeId, clientName, clientEmail, date, time, durationMinutes, location, notes } = req.body || {};

  if (!clientName?.trim()) return res.status(400).json({ error: 'clientName is required' });
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!time) return res.status(400).json({ error: 'time is required' });

  let selectedType = null;
  if (typeId != null) {
    selectedType = await dbGet(
      'SELECT * FROM appointment_types WHERE id = ? AND active = 1',
      'SELECT * FROM appointment_types WHERE id = $1 AND active = TRUE',
      [Number(typeId)]
    );
    if (!selectedType) return res.status(400).json({ error: 'Invalid appointment type' });
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
        Number(durationMinutes || selectedType?.duration_minutes || 45),
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
        Number(durationMinutes || selectedType?.duration_minutes || 45),
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
  const { status } = req.body || {};
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

  if (appointment.clientEmail) {
    await sendEmail({
      to: appointment.clientEmail,
      subject: `${settings.business_name}: Appointment ${status}`,
      text: `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(
        appointment.time
      )} is now ${status}.`
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
