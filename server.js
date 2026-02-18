const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.db');
const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.OWNER_EMAIL || 'owner@example.com';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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

// Express 4 does not automatically forward rejected async handlers to error middleware.
// Wrap async route/middleware handlers so rejected promises become regular 500 responses
// instead of process-level unhandled rejections (which can trigger restarts/502s).
for (const method of ['use', 'get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (...args) => {
    const wrapped = args.map((arg) => {
      if (typeof arg !== 'function') return arg;
      if (arg.length >= 4) return arg; // keep error handlers unchanged
      const isAsync = arg.constructor && arg.constructor.name === 'AsyncFunction';
      if (!isAsync) return arg;
      return (req, res, next) => Promise.resolve(arg(req, res, next)).catch(next);
    });
    return original(...wrapped);
  };
}

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

function slugifyBusinessName(input = '') {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'business';
}

function hashPassword(password = '') {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function validatePasswordStrength(password = '') {
  const value = String(password || '');
  const rules = [
    { ok: value.length >= 12, message: 'at least 12 characters' },
    { ok: /[a-z]/.test(value), message: 'one lowercase letter' },
    { ok: /[A-Z]/.test(value), message: 'one uppercase letter' },
    { ok: /\d/.test(value), message: 'one number' },
    { ok: /[^A-Za-z0-9]/.test(value), message: 'one symbol' },
    { ok: !/\s/.test(value), message: 'no spaces' }
  ];

  const failed = rules.filter((r) => !r.ok).map((r) => r.message);
  return {
    ok: failed.length === 0,
    failed,
    error:
      failed.length === 0
        ? ''
        : `Password is too weak. Must include ${failed.join(', ')}.`
  };
}

function verifyPassword(password = '', stored = '') {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const attempt = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSessionToken(token = '') {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashToken(token = '') {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function addSqliteColumnIfMissing(tableName, columnName, definitionSql) {
  const cols = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => String(c.name) === String(columnName))) {
    sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
  }
}

async function initDb() {
  if (USE_POSTGRES) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL REFERENCES businesses(id),
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS signup_verifications (
        id SERIAL PRIMARY KEY,
        business_name TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        slug TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        business_id INTEGER,
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
      );

      CREATE TABLE IF NOT EXISTS appointment_types (
        id SERIAL PRIMARY KEY,
        business_id INTEGER,
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
        business_id INTEGER,
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

      CREATE TABLE IF NOT EXISTS business_settings (
        business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_signup_verifications_email ON signup_verifications(email);
      CREATE INDEX IF NOT EXISTS idx_business_settings_business ON business_settings(business_id);
    `);

    await pgPool.query('ALTER TABLE settings ADD COLUMN IF NOT EXISTS business_id INTEGER');
    await pgPool.query('ALTER TABLE appointment_types ADD COLUMN IF NOT EXISTS business_id INTEGER');
    await pgPool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS business_id INTEGER');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_settings_business ON settings(business_id)');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_appointments_business ON appointments(business_id)');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_types_business ON appointment_types(business_id)');

    const defaultBusinessName = process.env.BUSINESS_NAME || 'IntelliSchedule';
    const defaultSlug = slugifyBusinessName(defaultBusinessName);
    const businessRow = (
      await pgPool.query(
        `INSERT INTO businesses (name, slug, owner_email, timezone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING *`,
        [
          defaultBusinessName,
          defaultSlug,
          process.env.OWNER_EMAIL || null,
          process.env.TIMEZONE || 'America/Los_Angeles'
        ]
      )
    ).rows[0];

    await pgPool.query(
      `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id) DO UPDATE SET
         business_name = EXCLUDED.business_name,
         owner_email = COALESCE(business_settings.owner_email, EXCLUDED.owner_email),
         timezone = COALESCE(business_settings.timezone, EXCLUDED.timezone)`,
      [businessRow.id, defaultBusinessName, process.env.OWNER_EMAIL || null, process.env.TIMEZONE || 'America/Los_Angeles']
    );

    await pgPool.query('UPDATE settings SET business_id = $1 WHERE business_id IS NULL', [businessRow.id]);
    await pgPool.query('UPDATE appointment_types SET business_id = $1 WHERE business_id IS NULL', [businessRow.id]);
    await pgPool.query('UPDATE appointments SET business_id = $1 WHERE business_id IS NULL', [businessRow.id]);

    const existingTypeCount = Number(
      (await pgPool.query('SELECT COUNT(*)::int AS c FROM appointment_types WHERE business_id = $1', [businessRow.id])).rows[0].c
    );
    if (!existingTypeCount) {
      await pgPool.query(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES
           ($1, $2, $3, $4, $5, $6),
           ($1, $7, $8, $9, $10, $11),
           ($1, $12, $13, $14, $15, $16),
           ($1, $17, $18, $19, $20, $21)`,
        [
          businessRow.id,
          'Consultation', 45, 15000, 'office', COLORS[0],
          'Strategy Session', 90, 30000, 'hybrid', COLORS[1],
          'Review', 60, 20000, 'virtual', COLORS[2],
          'Follow-up Call', 15, 0, 'phone', COLORS[3]
        ]
      );
    }

    const existingUser = await pgPool.query('SELECT id FROM users WHERE email = $1', [DEFAULT_ADMIN_EMAIL.toLowerCase()]);
    if (!existingUser.rowCount) {
      await pgPool.query(
        `INSERT INTO users (business_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'owner')`,
        [businessRow.id, 'Owner', DEFAULT_ADMIN_EMAIL.toLowerCase(), hashPassword(DEFAULT_ADMIN_PASSWORD)]
      );
    }
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS businesses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(business_id) REFERENCES businesses(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        business_id INTEGER NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS signup_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        slug TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        business_id INTEGER,
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
      );

      CREATE TABLE IF NOT EXISTS appointment_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER,
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
        business_id INTEGER,
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

      CREATE TABLE IF NOT EXISTS business_settings (
        business_id INTEGER PRIMARY KEY,
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_signup_verifications_email ON signup_verifications(email);
      CREATE INDEX IF NOT EXISTS idx_business_settings_business ON business_settings(business_id);
    `);

    addSqliteColumnIfMissing('settings', 'business_id', 'business_id INTEGER');
    addSqliteColumnIfMissing('appointment_types', 'business_id', 'business_id INTEGER');
    addSqliteColumnIfMissing('appointments', 'business_id', 'business_id INTEGER');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_settings_business ON settings(business_id)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_appointments_business ON appointments(business_id)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_types_business ON appointment_types(business_id)');

    const defaultBusinessName = process.env.BUSINESS_NAME || 'IntelliSchedule';
    const defaultSlug = slugifyBusinessName(defaultBusinessName);
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO businesses (id, name, slug, owner_email, timezone)
         VALUES (1, ?, ?, ?, ?)`
      )
      .run(defaultBusinessName, defaultSlug, process.env.OWNER_EMAIL || null, process.env.TIMEZONE || 'America/Los_Angeles');

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO business_settings (business_id, business_name, owner_email, timezone)
         VALUES (1, ?, ?, ?)`
      )
      .run(defaultBusinessName, process.env.OWNER_EMAIL || null, process.env.TIMEZONE || 'America/Los_Angeles');

    sqlite.prepare('UPDATE settings SET business_id = 1 WHERE business_id IS NULL').run();
    sqlite.prepare('UPDATE appointment_types SET business_id = 1 WHERE business_id IS NULL').run();
    sqlite.prepare('UPDATE appointments SET business_id = 1 WHERE business_id IS NULL').run();

    const count = sqlite.prepare('SELECT COUNT(*) AS c FROM appointment_types WHERE business_id = 1').get().c;
    if (!count) {
      const insert = sqlite.prepare(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES (1, ?, ?, ?, ?, ?)`
      );
      [
        ['Consultation', 45, 15000, 'office', COLORS[0]],
        ['Strategy Session', 90, 30000, 'hybrid', COLORS[1]],
        ['Review', 60, 20000, 'virtual', COLORS[2]],
        ['Follow-up Call', 15, 0, 'phone', COLORS[3]]
      ].forEach((row) => insert.run(...row));
    }

    const existingUser = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(DEFAULT_ADMIN_EMAIL.toLowerCase());
    if (!existingUser) {
      sqlite
        .prepare(
          `INSERT INTO users (business_id, name, email, password_hash, role)
           VALUES (1, ?, ?, ?, 'owner')`
        )
        .run('Owner', DEFAULT_ADMIN_EMAIL.toLowerCase(), hashPassword(DEFAULT_ADMIN_PASSWORD));
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

async function getSettings(businessId) {
  const id = Number(businessId || 1);
  return dbGet(
    'SELECT * FROM business_settings WHERE business_id = ? LIMIT 1',
    'SELECT * FROM business_settings WHERE business_id = $1 LIMIT 1',
    [id]
  );
}

function normalizeBackupPayload(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid backup payload.');
  const appointmentTypes = Array.isArray(input.appointmentTypes) ? input.appointmentTypes : [];
  const appointments = Array.isArray(input.appointments) ? input.appointments : [];
  return {
    business: input.business && typeof input.business === 'object' ? input.business : {},
    settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
    appointmentTypes,
    appointments
  };
}

async function exportBusinessData(businessId) {
  const business = await getBusinessById(businessId);
  const settings = await getSettings(businessId);
  const types = await dbAll(
    `SELECT id, name, duration_minutes, price_cents, location_mode, color, active, created_at
     FROM appointment_types
     WHERE business_id = ?
     ORDER BY id ASC`,
    `SELECT id, name, duration_minutes, price_cents, location_mode, color, active, created_at
     FROM appointment_types
     WHERE business_id = $1
     ORDER BY id ASC`,
    [Number(businessId)]
  );
  const appointments = await dbAll(
    `SELECT id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source, created_at
     FROM appointments
     WHERE business_id = ?
     ORDER BY date ASC, time ASC, id ASC`,
    `SELECT id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source, created_at
     FROM appointments
     WHERE business_id = $1
     ORDER BY date ASC, time ASC, id ASC`,
    [Number(businessId)]
  );

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    business: business
      ? {
          id: Number(business.id),
          name: business.name,
          slug: business.slug,
          owner_email: business.owner_email || null,
          timezone: business.timezone || null
        }
      : null,
    settings: settings
      ? {
          business_name: settings.business_name || '',
          owner_email: settings.owner_email || null,
          timezone: settings.timezone || 'America/Los_Angeles'
        }
      : null,
    appointmentTypes: types.map((t) => ({
      id: Number(t.id),
      name: t.name,
      duration_minutes: Number(t.duration_minutes || 45),
      price_cents: Number(t.price_cents || 0),
      location_mode: t.location_mode || 'hybrid',
      color: t.color || null,
      active: t.active === true || t.active === 1,
      created_at: t.created_at || null
    })),
    appointments: appointments.map((a) => ({
      id: Number(a.id),
      type_id: a.type_id == null ? null : Number(a.type_id),
      title: a.title || null,
      client_name: a.client_name,
      client_email: a.client_email || null,
      date: typeof a.date === 'string' ? a.date.slice(0, 10) : a.date?.toISOString?.().slice(0, 10),
      time: typeof a.time === 'string' ? a.time.slice(0, 5) : '09:00',
      duration_minutes: Number(a.duration_minutes || 45),
      location: a.location || 'office',
      notes: a.notes || null,
      status: a.status || 'confirmed',
      source: a.source || 'owner',
      created_at: a.created_at || null
    }))
  };
}

async function importBusinessData(businessId, backup) {
  const payload = normalizeBackupPayload(backup);
  const mergedSettings = {
    business_name:
      String(
        payload.settings.business_name ||
          payload.business.name ||
          payload.business.business_name ||
          'IntelliSchedule'
      ).trim() || 'IntelliSchedule',
    owner_email: payload.settings.owner_email || payload.business.owner_email || null,
    timezone: payload.settings.timezone || payload.business.timezone || 'America/Los_Angeles'
  };

  if (USE_POSTGRES) {
    const tx = await pgPool.connect();
    try {
      await tx.query('BEGIN');

      await tx.query(
        `UPDATE businesses
         SET name = $1, owner_email = $2, timezone = $3
         WHERE id = $4`,
        [mergedSettings.business_name, mergedSettings.owner_email, mergedSettings.timezone, Number(businessId)]
      );
      await tx.query(
        `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id) DO UPDATE SET
           business_name = EXCLUDED.business_name,
           owner_email = EXCLUDED.owner_email,
           timezone = EXCLUDED.timezone`,
        [Number(businessId), mergedSettings.business_name, mergedSettings.owner_email, mergedSettings.timezone]
      );

      await tx.query('DELETE FROM appointments WHERE business_id = $1', [Number(businessId)]);
      await tx.query('DELETE FROM appointment_types WHERE business_id = $1', [Number(businessId)]);

      const typeIdMap = new Map();
      for (const t of payload.appointmentTypes) {
        const inserted = await tx.query(
          `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            Number(businessId),
            String(t.name || 'General').trim() || 'General',
            Number(t.duration_minutes || 45),
            Number(t.price_cents || 0),
            String(t.location_mode || 'hybrid'),
            t.color || null,
            t.active == null ? true : Boolean(t.active)
          ]
        );
        typeIdMap.set(Number(t.id), Number(inserted.rows[0].id));
      }

      for (const a of payload.appointments) {
        const mappedTypeId = a.type_id == null ? null : typeIdMap.get(Number(a.type_id)) || null;
        await tx.query(
          `INSERT INTO appointments
           (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            Number(businessId),
            mappedTypeId,
            a.title || null,
            String(a.client_name || 'Client').trim() || 'Client',
            a.client_email || null,
            String(a.date || new Date().toISOString().slice(0, 10)),
            String(a.time || '09:00').slice(0, 5),
            Number(a.duration_minutes || 45),
            String(a.location || 'office'),
            a.notes || null,
            String(a.status || 'confirmed'),
            String(a.source || 'owner')
          ]
        );
      }

      await tx.query('COMMIT');
      return {
        importedTypes: payload.appointmentTypes.length,
        importedAppointments: payload.appointments.length
      };
    } catch (error) {
      try {
        await tx.query('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      tx.release();
    }
  }

  const tx = sqlite.transaction((input) => {
    sqlite
      .prepare('UPDATE businesses SET name = ?, owner_email = ?, timezone = ? WHERE id = ?')
      .run(input.settings.business_name, input.settings.owner_email, input.settings.timezone, Number(input.businessId));
    sqlite
      .prepare(
        `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(business_id) DO UPDATE SET
           business_name = excluded.business_name,
           owner_email = excluded.owner_email,
           timezone = excluded.timezone`
      )
      .run(Number(input.businessId), input.settings.business_name, input.settings.owner_email, input.settings.timezone);

    sqlite.prepare('DELETE FROM appointments WHERE business_id = ?').run(Number(input.businessId));
    sqlite.prepare('DELETE FROM appointment_types WHERE business_id = ?').run(Number(input.businessId));

    const typeIdMap = new Map();
    const insertType = sqlite.prepare(
      `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of input.payload.appointmentTypes) {
      const result = insertType.run(
        Number(input.businessId),
        String(t.name || 'General').trim() || 'General',
        Number(t.duration_minutes || 45),
        Number(t.price_cents || 0),
        String(t.location_mode || 'hybrid'),
        t.color || null,
        t.active == null ? 1 : Number(Boolean(t.active))
      );
      typeIdMap.set(Number(t.id), Number(result.lastInsertRowid));
    }

    const insertAppt = sqlite.prepare(
      `INSERT INTO appointments
       (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of input.payload.appointments) {
      const mappedTypeId = a.type_id == null ? null : typeIdMap.get(Number(a.type_id)) || null;
      insertAppt.run(
        Number(input.businessId),
        mappedTypeId,
        a.title || null,
        String(a.client_name || 'Client').trim() || 'Client',
        a.client_email || null,
        String(a.date || new Date().toISOString().slice(0, 10)),
        String(a.time || '09:00').slice(0, 5),
        Number(a.duration_minutes || 45),
        String(a.location || 'office'),
        a.notes || null,
        String(a.status || 'confirmed'),
        String(a.source || 'owner')
      );
    }

    return {
      importedTypes: input.payload.appointmentTypes.length,
      importedAppointments: input.payload.appointments.length
    };
  });

  return tx({ businessId: Number(businessId), payload, settings: mergedSettings });
}

async function getBusinessById(id) {
  return dbGet('SELECT * FROM businesses WHERE id = ?', 'SELECT * FROM businesses WHERE id = $1', [Number(id)]);
}

async function getBusinessBySlug(slug) {
  return dbGet('SELECT * FROM businesses WHERE slug = ?', 'SELECT * FROM businesses WHERE slug = $1', [String(slug || '')]);
}

async function createSession({ userId, businessId }) {
  const token = makeSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await dbRun(
    `INSERT INTO sessions (user_id, business_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    `INSERT INTO sessions (user_id, business_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [Number(userId), Number(businessId), tokenHash, expiresAt]
  );
  return token;
}

async function deleteSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  await dbRun(
    'DELETE FROM sessions WHERE token_hash = ?',
    'DELETE FROM sessions WHERE token_hash = $1',
    [tokenHash]
  );
}

async function getSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  const row = await dbGet(
    `SELECT s.*, u.email, u.name, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    `SELECT s.*, u.email, u.name, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash]
  );
  if (!row) return null;
  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await deleteSessionByToken(token);
    return null;
  }
  return {
    userId: Number(row.user_id),
    businessId: Number(row.business_id),
    email: row.email,
    name: row.name,
    role: row.role
  };
}

async function createBusinessWithOwner({ businessName, name, email, passwordHash, timezone, slug }) {
  if (USE_POSTGRES) {
    const tx = await pgPool.connect();
    try {
      await tx.query('BEGIN');
      const business = (
        await tx.query(
          `INSERT INTO businesses (name, slug, owner_email, timezone)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [businessName, slug, email, timezone || 'America/Los_Angeles']
        )
      ).rows[0];
      await tx.query(
        `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
         VALUES ($1, $2, $3, $4)`,
        [business.id, businessName, email, timezone || 'America/Los_Angeles']
      );
      await tx.query(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES
           ($1, $2, $3, $4, $5, $6),
           ($1, $7, $8, $9, $10, $11),
           ($1, $12, $13, $14, $15, $16),
           ($1, $17, $18, $19, $20, $21)`,
        [
          business.id,
          'Consultation', 45, 15000, 'office', COLORS[0],
          'Strategy Session', 90, 30000, 'hybrid', COLORS[1],
          'Review', 60, 20000, 'virtual', COLORS[2],
          'Follow-up Call', 15, 0, 'phone', COLORS[3]
        ]
      );
      const user = (
        await tx.query(
          `INSERT INTO users (business_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, $4, 'owner')
           RETURNING *`,
          [business.id, name, email, passwordHash]
        )
      ).rows[0];
      await tx.query('COMMIT');
      return {
        user: { id: Number(user.id), name: user.name, email: user.email, role: user.role },
        business: { id: Number(business.id), name: business.name, slug: business.slug }
      };
    } catch (error) {
      try {
        await tx.query('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      tx.release();
    }
  }

  const tx = sqlite.transaction((payload) => {
    const businessInsert = sqlite
      .prepare(
        `INSERT INTO businesses (name, slug, owner_email, timezone)
         VALUES (?, ?, ?, ?)`
      )
      .run(payload.businessName, payload.slug, payload.email, payload.timezone || 'America/Los_Angeles');
    const businessId = Number(businessInsert.lastInsertRowid);

    sqlite
      .prepare(
        `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
         VALUES (?, ?, ?, ?)`
      )
      .run(businessId, payload.businessName, payload.email, payload.timezone || 'America/Los_Angeles');

    const insertType = sqlite.prepare(
      `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    [
      ['Consultation', 45, 15000, 'office', COLORS[0]],
      ['Strategy Session', 90, 30000, 'hybrid', COLORS[1]],
      ['Review', 60, 20000, 'virtual', COLORS[2]],
      ['Follow-up Call', 15, 0, 'phone', COLORS[3]]
    ].forEach((r) => insertType.run(businessId, ...r));

    const userInsert = sqlite
      .prepare(
        `INSERT INTO users (business_id, name, email, password_hash, role)
         VALUES (?, ?, ?, ?, 'owner')`
      )
      .run(businessId, payload.name, payload.email, payload.passwordHash);

    return {
      user: { id: Number(userInsert.lastInsertRowid), name: payload.name, email: payload.email, role: 'owner' },
      business: { id: businessId, name: payload.businessName, slug: payload.slug }
    };
  });

  return tx({ businessName, name, email, passwordHash, timezone, slug });
}

async function getPendingSignupByToken(token) {
  const tokenHash = hashToken(token);
  return dbGet(
    'SELECT * FROM signup_verifications WHERE token_hash = ?',
    'SELECT * FROM signup_verifications WHERE token_hash = $1',
    [tokenHash]
  );
}

function parseTimeOrThrow(timeValue) {
  const match = String(timeValue || '').match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw new Error('time must be in HH:MM format');
  return Number(match[1]) * 60 + Number(match[2]);
}

async function assertNoOverlap({ businessId, date, startMinutes, durationMinutes, excludeId = null }) {
  const rows = await dbAll(
    `SELECT id, time, duration_minutes
     FROM appointments
     WHERE business_id = ? AND date = ? AND status != 'cancelled'
     ORDER BY time ASC`,
    `SELECT id, time, duration_minutes
     FROM appointments
     WHERE business_id = $1 AND date = $2 AND status != 'cancelled'
     ORDER BY time ASC`,
    [Number(businessId), String(date)]
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
    businessId,
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
  const scopedBusinessId = Number(businessId);
  if (!Number.isFinite(scopedBusinessId) || scopedBusinessId <= 0) throw new Error('businessId is required');
  if (!date) throw new Error('date is required');
  if (!time) throw new Error('time is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date must be in YYYY-MM-DD format');

  const type = typeId
    ? await dbGet(
        'SELECT * FROM appointment_types WHERE id = ? AND business_id = ? AND active = 1',
        'SELECT * FROM appointment_types WHERE id = $1 AND business_id = $2 AND active = TRUE',
        [Number(typeId), scopedBusinessId]
      )
    : null;

  const resolvedDuration = Number(durationMinutes || type?.duration_minutes || 45);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    throw new Error('durationMinutes must be greater than 0');
  }
  const startMinutes = parseTimeOrThrow(time);
  await assertNoOverlap({
    businessId: scopedBusinessId,
    date: String(date),
    startMinutes,
    durationMinutes: resolvedDuration
  });

  const params = [
    scopedBusinessId,
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
       (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$11)
       RETURNING id`,
      params
    );
    id = insert.rows[0].id;
  } else {
    const result = sqlite
      .prepare(
        `INSERT INTO appointments
         (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
      )
      .run(...params);
    id = result.lastInsertRowid;
  }

  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ? AND a.business_id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1 AND a.business_id = $2`,
    [id, scopedBusinessId]
  );

  const appointment = rowToAppointment(row);
  const settings = await getSettings(scopedBusinessId);

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

async function createInsights(date, businessId) {
  const scopedBusinessId = Number(businessId);
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
       WHERE a.business_id = ? AND a.date >= ?
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date >= $2
       ORDER BY a.date ASC, a.time ASC`,
      [scopedBusinessId, from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date >= ? AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date >= $2 AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      [scopedBusinessId, from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date = ? AND a.status != 'cancelled'
       ORDER BY a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date = $2 AND a.status != 'cancelled'
       ORDER BY a.time ASC`,
      [scopedBusinessId, date]
    ),
    dbAll(
      `SELECT a.date
       FROM appointments a
       WHERE a.business_id = ? AND a.date BETWEEN ? AND ? AND a.status != 'cancelled'`,
      `SELECT a.date
       FROM appointments a
       WHERE a.business_id = $1 AND a.date BETWEEN $2 AND $3 AND a.status != 'cancelled'`,
      [scopedBusinessId, date, to7Str]
    ),
    dbGet(
      "SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND status = 'pending'",
      "SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND status = 'pending'",
      [scopedBusinessId]
    ),
    getSettings(scopedBusinessId)
  ]);
  const businessSettings = settings || {
    business_name: 'IntelliSchedule',
    timezone: 'America/Los_Angeles'
  };

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
      text: `Current timezone is ${businessSettings.timezone}.`,
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
    text: `Timezone is set to ${businessSettings.timezone}.`,
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

app.post('/api/auth/signup', async (req, res) => {
  const { businessName, name, email, password, timezone } = req.body || {};
  if (!businessName?.trim()) return res.status(400).json({ error: 'businessName is required' });
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!email?.trim()) return res.status(400).json({ error: 'email is required' });
  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

  const emailValue = String(email).trim().toLowerCase();
  const existingUser = await dbGet(
    'SELECT id FROM users WHERE email = ?',
    'SELECT id FROM users WHERE email = $1',
    [emailValue]
  );
  if (existingUser) {
    return res.status(409).json({ error: 'Email already in use.' });
  }

  const slugBase = slugifyBusinessName(businessName);
  let slug = slugBase;
  let suffix = 1;
  // ensure unique business slug
  while (await getBusinessBySlug(slug)) {
    suffix += 1;
    slug = `${slugBase}-${suffix}`;
  }

  try {
    const pendingExists = await dbGet(
      'SELECT id FROM signup_verifications WHERE email = ?',
      'SELECT id FROM signup_verifications WHERE email = $1',
      [emailValue]
    );
    if (pendingExists) {
      return res.status(409).json({ error: 'Email already in use.' });
    }

    const verifyToken = makeSessionToken();
    const tokenHash = hashToken(verifyToken);
    const expiresAt = new Date(Date.now() + VERIFY_HOURS * 60 * 60 * 1000).toISOString();
    const passwordHash = hashPassword(password);
    await dbRun(
      `INSERT INTO signup_verifications
       (business_name, name, email, password_hash, timezone, slug, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `INSERT INTO signup_verifications
       (business_name, name, email, password_hash, timezone, slug, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [businessName.trim(), name.trim(), emailValue, passwordHash, timezone || 'America/Los_Angeles', slug, tokenHash, expiresAt]
    );

    const verifyLink = `${BASE_URL}/verify-email?token=${encodeURIComponent(verifyToken)}`;
    const verifyText = `Hi ${name.trim()},\n\nConfirm your IntelliSchedule account by clicking this link:\n${verifyLink}\n\nThis link expires in ${VERIFY_HOURS} hours.`;
    const verifyResult = await sendEmail({
      to: emailValue,
      subject: 'Verify your IntelliSchedule account',
      text: verifyText,
      html: buildBrandedEmailHtml({
        businessName: businessName.trim(),
        title: 'Verify Your Email',
        subtitle: 'Account setup',
        message: `Hi ${name.trim()},\n\nClick below to verify your email and activate your account.\n${verifyLink}`,
        details: [{ label: 'Expires', value: `${VERIFY_HOURS} hours` }]
      })
    });

    const payload = {
      ok: true,
      pendingVerification: true,
      provider: verifyResult.provider || 'unknown',
      message: 'Verification email sent. Please confirm your inbox before logging in.'
    };
    if (process.env.NODE_ENV !== 'production') payload.verificationToken = verifyToken;
    return res.status(202).json(payload);
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'Email already in use.' });
    }
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });

  const pending = await getPendingSignupByToken(token);
  if (!pending) return res.status(400).json({ error: 'Invalid verification link.' });
  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    await dbRun(
      'DELETE FROM signup_verifications WHERE id = ?',
      'DELETE FROM signup_verifications WHERE id = $1',
      [Number(pending.id)]
    );
    return res.status(400).json({ error: 'Verification link expired. Sign up again.' });
  }

  const existingUser = await dbGet(
    'SELECT id FROM users WHERE email = ?',
    'SELECT id FROM users WHERE email = $1',
    [pending.email]
  );
  if (existingUser) {
    await dbRun(
      'DELETE FROM signup_verifications WHERE id = ?',
      'DELETE FROM signup_verifications WHERE id = $1',
      [Number(pending.id)]
    );
    return res.status(409).json({ error: 'Email already in use.' });
  }

  try {
    let resolvedSlug = String(pending.slug || slugifyBusinessName(pending.business_name));
    let counter = 1;
    while (await getBusinessBySlug(resolvedSlug)) {
      counter += 1;
      resolvedSlug = `${slugifyBusinessName(pending.business_name)}-${counter}`;
    }

    const created = await createBusinessWithOwner({
      businessName: pending.business_name,
      name: pending.name,
      email: pending.email,
      passwordHash: pending.password_hash,
      timezone: pending.timezone,
      slug: resolvedSlug
    });
    await dbRun(
      'DELETE FROM signup_verifications WHERE id = ?',
      'DELETE FROM signup_verifications WHERE id = $1',
      [Number(pending.id)]
    );

    const sessionToken = await createSession({
      userId: created.user.id,
      businessId: created.business.id
    });
    setSessionCookie(res, sessionToken);
    return res.json(created);
  } catch (error) {
    return res.status(500).json({ error: 'Could not verify account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const emailValue = String(email || '').trim().toLowerCase();
  if (!emailValue || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = await dbGet(
    'SELECT * FROM users WHERE email = ?',
    'SELECT * FROM users WHERE email = $1',
    [emailValue]
  );
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const business = await getBusinessById(user.business_id);
  const token = await createSession({ userId: user.id, businessId: user.business_id });
  setSessionCookie(res, token);
  return res.json({
    user: { id: Number(user.id), name: user.name, email: user.email, role: user.role },
    business: business ? { id: Number(business.id), name: business.name, slug: business.slug } : null
  });
});

app.post('/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) await deleteSessionByToken(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  const session = await getSessionByToken(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  const business = await getBusinessById(session.businessId);
  return res.json({
    user: { id: session.userId, name: session.name, email: session.email, role: session.role },
    business: business ? { id: Number(business.id), name: business.name, slug: business.slug } : null
  });
});

app.use('/api', async (req, res, next) => {
  if (
    req.path === '/health' ||
    req.path.startsWith('/auth/') ||
    req.path === '/public/bookings' ||
    (req.path === '/types' && req.method === 'GET' && req.query.businessSlug)
  ) {
    return next();
  }

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  const session = await getSessionByToken(token);
  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  req.auth = session;
  next();
});

app.get('/api/settings', async (req, res) => {
  res.json({ settings: await getSettings(req.auth.businessId) });
});

app.put('/api/settings', async (req, res) => {
  const { businessName, ownerEmail, timezone } = req.body || {};
  const businessId = req.auth.businessId;

  await dbRun(
    `UPDATE business_settings
     SET business_name = COALESCE(?, business_name),
         owner_email = COALESCE(?, owner_email),
         timezone = COALESCE(?, timezone)
     WHERE business_id = ?`,
    `UPDATE business_settings
     SET business_name = COALESCE($1, business_name),
         owner_email = COALESCE($2, owner_email),
         timezone = COALESCE($3, timezone)
     WHERE business_id = $4`,
    [businessName || null, ownerEmail || null, timezone || null, businessId]
  );

  res.json({ settings: await getSettings(businessId) });
});

app.get('/api/data/export', async (req, res) => {
  const businessId = req.auth.businessId;
  const data = await exportBusinessData(businessId);
  res.json(data);
});

app.post('/api/data/import', async (req, res) => {
  const businessId = req.auth.businessId;
  const imported = await importBusinessData(businessId, req.body || {});
  const settings = await getSettings(businessId);
  res.json({
    ok: true,
    importedTypes: imported.importedTypes,
    importedAppointments: imported.importedAppointments,
    settings
  });
});

app.get('/api/types', async (req, res) => {
  let businessId = req.auth?.businessId;
  if (!businessId && req.query.businessSlug) {
    const business = await getBusinessBySlug(String(req.query.businessSlug));
    if (!business) return res.status(404).json({ error: 'Business not found.' });
    businessId = Number(business.id);
  }
  if (!businessId) return res.status(401).json({ error: 'Authentication required.' });
  const rows = await dbAll(
    'SELECT * FROM appointment_types WHERE business_id = ? AND active = 1 ORDER BY id ASC',
    'SELECT * FROM appointment_types WHERE business_id = $1 AND active = TRUE ORDER BY id ASC',
    [businessId]
  );
  res.json({ types: rows.map(rowToType) });
});

app.post('/api/types', async (req, res) => {
  const businessId = req.auth.businessId;
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
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [businessId, ...params]
      )
    ).rows[0];
  } else {
    const result = sqlite
      .prepare(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(businessId, ...params);
    row = sqlite.prepare('SELECT * FROM appointment_types WHERE id = ?').get(result.lastInsertRowid);
  }

  res.status(201).json({ type: rowToType(row) });
});

app.put('/api/types/:id', async (req, res) => {
  const businessId = req.auth.businessId;
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
     WHERE id = ? AND business_id = ?`,
    `UPDATE appointment_types
     SET name = COALESCE($1, name),
         duration_minutes = COALESCE($2, duration_minutes),
         price_cents = COALESCE($3, price_cents),
         location_mode = COALESCE($4, location_mode),
         color = COALESCE($5, color),
         active = COALESCE($6, active)
     WHERE id = $7 AND business_id = $8`,
    [
      name || null,
      durationMinutes == null ? null : Number(durationMinutes),
      priceCents == null ? null : Number(priceCents),
      locationMode || null,
      color || null,
      active == null ? null : USE_POSTGRES ? !!active : Number(!!active),
      id,
      businessId
    ]
  );

  const row = await dbGet(
    'SELECT * FROM appointment_types WHERE id = ? AND business_id = ?',
    'SELECT * FROM appointment_types WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );

  if (!row) return res.status(404).json({ error: 'type not found' });
  res.json({ type: rowToType(row) });
});

app.delete('/api/types/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  await dbRun(
    'UPDATE appointment_types SET active = 0 WHERE id = ? AND business_id = ?',
    'UPDATE appointment_types SET active = FALSE WHERE id = $1 AND business_id = $2',
    [Number(req.params.id), businessId]
  );
  res.json({ ok: true });
});

app.get('/api/appointments', async (req, res) => {
  const businessId = req.auth.businessId;
  const { date, q, status } = req.query;

  if (!USE_POSTGRES) {
    let sql = `
      SELECT a.*, t.name AS type_name
      FROM appointments a
      LEFT JOIN appointment_types t ON t.id = a.type_id
      WHERE a.business_id = ?
    `;
    const params = [businessId];

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
    WHERE a.business_id = $1
  `;
  const params = [businessId];

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
    const result = await createAppointment({
      ...req.body,
      businessId: req.auth.businessId,
      source: req.body?.source || 'owner'
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/public/bookings', async (req, res) => {
  try {
    const slug = String(req.body?.businessSlug || '').trim();
    if (!slug) return res.status(400).json({ error: 'businessSlug is required for public bookings.' });
    const business = await getBusinessBySlug(slug);
    if (!business) return res.status(404).json({ error: 'Business not found.' });
    const result = await createAppointment({ ...req.body, businessId: business.id, source: 'public' });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/appointments/:id/email', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ? AND a.business_id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1 AND a.business_id = $2`,
    [id, businessId]
  );

  if (!row) return res.status(404).json({ error: 'appointment not found' });
  const appointment = rowToAppointment(row);
  if (!appointment.clientEmail) return res.status(400).json({ error: 'This appointment has no client email.' });

  const settings = await getSettings(businessId);
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
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const { typeId, clientName, clientEmail, date, time, durationMinutes, location, notes } = req.body || {};

  if (!clientName?.trim()) return res.status(400).json({ error: 'clientName is required' });
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!time) return res.status(400).json({ error: 'time is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });

  let selectedType = null;
  if (typeId != null) {
    selectedType = await dbGet(
      'SELECT * FROM appointment_types WHERE id = ? AND business_id = ? AND active = 1',
      'SELECT * FROM appointment_types WHERE id = $1 AND business_id = $2 AND active = TRUE',
      [Number(typeId), businessId]
    );
    if (!selectedType) return res.status(400).json({ error: 'Invalid appointment type' });
  }

  const resolvedDuration = Number(durationMinutes || selectedType?.duration_minutes || 45);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    return res.status(400).json({ error: 'durationMinutes must be greater than 0' });
  }

  try {
    await assertNoOverlap({
      businessId,
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
       WHERE id = $9 AND business_id = $10`,
      [
        selectedType?.id || null,
        clientName.trim(),
        clientEmail || null,
        String(date),
        String(time),
        resolvedDuration,
        location || selectedType?.location_mode || 'office',
        notes || null,
        id,
        businessId
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
         WHERE id = ? AND business_id = ?`
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
        id,
        businessId
      );
    if (!up.changes) return res.status(404).json({ error: 'appointment not found' });
  }

  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ? AND a.business_id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1 AND a.business_id = $2`,
    [id, businessId]
  );

  res.json({ appointment: rowToAppointment(row) });
});

app.delete('/api/appointments/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  if (USE_POSTGRES) {
    const result = await pgPool.query('DELETE FROM appointments WHERE id = $1 AND business_id = $2', [id, businessId]);
    if (!result.rowCount) return res.status(404).json({ error: 'appointment not found' });
    return res.json({ ok: true });
  }

  const info = sqlite.prepare('DELETE FROM appointments WHERE id = ? AND business_id = ?').run(id, businessId);
  if (!info.changes) return res.status(404).json({ error: 'appointment not found' });
  return res.json({ ok: true });
});

app.patch('/api/appointments/:id/status', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const { status, cancellationReason } = req.body || {};
  const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  if (USE_POSTGRES) {
    const up = await pgPool.query('UPDATE appointments SET status = $1 WHERE id = $2 AND business_id = $3', [status, id, businessId]);
    if (!up.rowCount) return res.status(404).json({ error: 'appointment not found' });
  } else {
    const up = sqlite.prepare('UPDATE appointments SET status = ? WHERE id = ? AND business_id = ?').run(status, id, businessId);
    if (!up.changes) return res.status(404).json({ error: 'appointment not found' });
  }

  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ? AND a.business_id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1 AND a.business_id = $2`,
    [id, businessId]
  );

  const appointment = rowToAppointment(row);
  const settings = await getSettings(businessId);
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
  const businessId = req.auth.businessId;
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  let stats;
  if (USE_POSTGRES) {
    const [today, week, pending, total] = await Promise.all([
      pgPool.query('SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND date = $2', [businessId, date]),
      pgPool.query(
        "SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND date BETWEEN $2::date AND ($2::date + INTERVAL '6 day')",
        [businessId, date]
      ),
      pgPool.query("SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND status = 'pending'", [businessId]),
      pgPool.query('SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1', [businessId])
    ]);

    stats = {
      today: today.rows[0].c,
      week: week.rows[0].c,
      pending: pending.rows[0].c,
      aiOptimized: total.rows[0].c
    };
  } else {
    stats = {
      today: sqlite.prepare('SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND date = ?').get(businessId, date).c,
      week: sqlite
        .prepare("SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND date BETWEEN date(?) AND date(?, '+6 day')")
        .get(businessId, date, date).c,
      pending: sqlite.prepare("SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND status = 'pending'").get(businessId).c,
      aiOptimized: sqlite.prepare('SELECT COUNT(*) AS c FROM appointments WHERE business_id = ?').get(businessId).c
    };
  }

  const appointments = (
    await dbAll(
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date = ?
       ORDER BY a.time ASC`,
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date = $2
       ORDER BY a.time ASC`,
      [businessId, date]
    )
  ).map(rowToAppointment);

  const typeRows = await dbAll(
    `SELECT t.*, COUNT(a.id) AS booking_count
     FROM appointment_types t
     LEFT JOIN appointments a ON a.type_id = t.id AND a.business_id = ?
     WHERE t.business_id = ? AND t.active = 1
     GROUP BY t.id
     ORDER BY t.id ASC`,
    `SELECT t.*, COUNT(a.id)::int AS booking_count
     FROM appointment_types t
     LEFT JOIN appointments a ON a.type_id = t.id AND a.business_id = $1
     WHERE t.business_id = $1 AND t.active = TRUE
     GROUP BY t.id
     ORDER BY t.id ASC`,
    [businessId]
  );

  const types = typeRows.map((row) => ({ ...rowToType(row), bookingCount: Number(row.booking_count || 0) }));

  res.json({ stats, appointments, types, insights: await createInsights(date, businessId) });
});

app.get('/book', (_req, res) => {
  res.sendFile(path.join(__dirname, 'booking.html'));
});

app.get('/verify-email', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).send('Missing verification token.');
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
  <body style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:560px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;">
      <h2 style="margin:0 0 10px;">Verifying your email...</h2>
      <p id="msg" style="color:#475569;">Please wait.</p>
      <a href="/" style="display:inline-block;margin-top:10px;">Go to dashboard</a>
    </div>
    <script>
      fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token: ${JSON.stringify(token)} })
      })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Verification failed');
        document.getElementById('msg').textContent = 'Email verified. Redirecting...';
        setTimeout(() => { window.location.href = '/'; }, 700);
      })
      .catch((e) => { document.getElementById('msg').textContent = e.message; });
    </script>
  </body>
</html>`);
});

app.use('/api', (err, _req, res, _next) => {
  console.error('API error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error.' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
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
