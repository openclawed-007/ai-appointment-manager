'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const { hashPassword } = require('./security');

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'data.db');

let sqlite = null;
let pgPool = null;

if (USE_POSTGRES) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true }
  });
} else {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
}

// ── Query helpers ──────────────────────────────────────────────────────────────

function qMarks(n) {
  return Array.from({ length: n }, (_, i) => (USE_POSTGRES ? `$${i + 1}` : '?')).join(', ');
}

async function dbRun(sqliteSql, postgresSql, params = []) {
  if (USE_POSTGRES) {
    return pgPool.query(postgresSql, params);
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

function addSqliteColumnIfMissing(tableName, columnName, definitionSql) {
  const cols = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => String(c.name) === String(columnName))) {
    sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
  }
}

async function ensurePostgresConstraint(constraintName, ddlSql) {
  const result = await pgPool.query(
    'SELECT 1 FROM pg_constraint WHERE conname = $1 LIMIT 1',
    [constraintName]
  );
  if (!result.rowCount) {
    await pgPool.query(ddlSql);
  }
}

async function ensurePostgresIndex(indexName, ddlSql) {
  const result = await pgPool.query('SELECT to_regclass($1) AS index_name', [indexName]);
  if (!result.rows[0]?.index_name) {
    await pgPool.query(ddlSql);
  }
}

// ── Schema initialisation ──────────────────────────────────────────────────────

const COLORS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)'
];

function slugifyBusinessName(input = '') {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'business';
}

async function initDb() {
  const SEED_DEFAULT_TYPES = process.env.SEED_DEFAULT_TYPES === 'true';
  const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.OWNER_EMAIL || '';
  const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

  if (USE_POSTGRES) {
    await pgPool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

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
        theme_preference TEXT NOT NULL DEFAULT 'light',
        accent_color TEXT NOT NULL DEFAULT 'green',
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

      CREATE TABLE IF NOT EXISTS login_verifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
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
        client_id INTEGER,
        title TEXT,
        client_name TEXT NOT NULL,
        client_email TEXT,
        date DATE NOT NULL,
        time TIME NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        location TEXT NOT NULL DEFAULT 'office',
        notes TEXT,
        reminder_offset_minutes INTEGER NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'confirmed',
        source TEXT NOT NULL DEFAULT 'owner',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        stage TEXT NOT NULL DEFAULT 'new',
        progress_summary TEXT,
        archived_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_notes (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS business_settings (
        business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        notify_owner_email BOOLEAN NOT NULL DEFAULT TRUE,
        reminder_mode BOOLEAN NOT NULL DEFAULT FALSE,
        workspace_mode TEXT NOT NULL DEFAULT 'appointments',
        open_time TEXT NOT NULL DEFAULT '09:00',
        close_time TEXT NOT NULL DEFAULT '18:00',
        business_hours_json TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_import_usage (
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        usage_date DATE NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (business_id, usage_date)
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_appointments_business_date_time ON appointments(business_id, date, time);
      CREATE INDEX IF NOT EXISTS idx_appointments_business_status ON appointments(business_id, status);
      CREATE INDEX IF NOT EXISTS idx_appointments_business_type ON appointments(business_id, type_id);
      CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_signup_verifications_email ON signup_verifications(email);
      CREATE INDEX IF NOT EXISTS idx_login_verifications_token_hash ON login_verifications(token_hash);
      CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
      CREATE INDEX IF NOT EXISTS idx_business_settings_business ON business_settings(business_id);
      CREATE INDEX IF NOT EXISTS idx_ai_import_usage_business_date ON ai_import_usage(business_id, usage_date);
      CREATE INDEX IF NOT EXISTS idx_clients_business_updated ON clients(business_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clients_business_stage ON clients(business_id, stage);
      CREATE INDEX IF NOT EXISTS idx_client_notes_client_created ON client_notes(client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_client_notes_business_client ON client_notes(business_id, client_id);
    `);

    await pgPool.query('ALTER TABLE settings ADD COLUMN IF NOT EXISTS business_id INTEGER');
    await pgPool.query('ALTER TABLE appointment_types ADD COLUMN IF NOT EXISTS business_id INTEGER');
    await pgPool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS business_id INTEGER');
    await pgPool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS client_id INTEGER');
    await pgPool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_offset_minutes INTEGER NOT NULL DEFAULT 10');
    await pgPool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'light'");
    await pgPool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT 'green'");
    await pgPool.query('ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS notify_owner_email BOOLEAN NOT NULL DEFAULT TRUE');
    await pgPool.query('ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS reminder_mode BOOLEAN NOT NULL DEFAULT FALSE');
    await pgPool.query("ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS workspace_mode TEXT NOT NULL DEFAULT 'appointments'");
    await pgPool.query("ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS open_time TEXT NOT NULL DEFAULT '09:00'");
    await pgPool.query("ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS close_time TEXT NOT NULL DEFAULT '18:00'");
    await pgPool.query('ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS business_hours_json TEXT');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_settings_business ON settings(business_id)');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_appointments_business ON appointments(business_id)');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_types_business ON appointment_types(business_id)');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments(client_id)');
    await pgPool.query(
      'CREATE INDEX IF NOT EXISTS idx_appointments_client_name_trgm ON appointments USING gin (client_name gin_trgm_ops)'
    );
    await pgPool.query(
      'CREATE INDEX IF NOT EXISTS idx_appointments_client_email_trgm ON appointments USING gin (client_email gin_trgm_ops)'
    );
    await pgPool.query(
      'CREATE INDEX IF NOT EXISTS idx_appointments_title_trgm ON appointments USING gin (title gin_trgm_ops)'
    );
    await pgPool.query(
      'CREATE INDEX IF NOT EXISTS idx_appointment_types_name_trgm ON appointment_types USING gin (name gin_trgm_ops)'
    );
    await pgPool.query(
      'CREATE INDEX IF NOT EXISTS idx_clients_name_trgm ON clients USING gin (name gin_trgm_ops)'
    );
    await pgPool.query(
      'CREATE INDEX IF NOT EXISTS idx_clients_email_trgm ON clients USING gin (email gin_trgm_ops)'
    );

    const defaultBusinessName = process.env.BUSINESS_NAME || 'IntelliBook';
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

    await ensurePostgresIndex(
      'ux_appointment_types_business_id_id',
      'CREATE UNIQUE INDEX ux_appointment_types_business_id_id ON appointment_types (business_id, id)'
    );
    await ensurePostgresIndex(
      'ux_clients_business_id_id',
      'CREATE UNIQUE INDEX ux_clients_business_id_id ON clients (business_id, id)'
    );

    await ensurePostgresConstraint(
      'fk_appointment_types_business',
      `ALTER TABLE appointment_types
         ADD CONSTRAINT fk_appointment_types_business
         FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE NOT VALID`
    );
    await ensurePostgresConstraint(
      'fk_appointments_business',
      `ALTER TABLE appointments
         ADD CONSTRAINT fk_appointments_business
         FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE NOT VALID`
    );
    await ensurePostgresConstraint(
      'fk_appointments_business_type',
      `ALTER TABLE appointments
         ADD CONSTRAINT fk_appointments_business_type
         FOREIGN KEY (business_id, type_id) REFERENCES appointment_types(business_id, id) NOT VALID`
    );
    await ensurePostgresConstraint(
      'fk_appointments_business_client',
      `ALTER TABLE appointments
         ADD CONSTRAINT fk_appointments_business_client
         FOREIGN KEY (business_id, client_id) REFERENCES clients(business_id, id) NOT VALID`
    );
    await ensurePostgresConstraint(
      'chk_appointment_types_location_mode',
      `ALTER TABLE appointment_types
         ADD CONSTRAINT chk_appointment_types_location_mode
         CHECK (location_mode IN ('office', 'hybrid', 'virtual', 'phone')) NOT VALID`
    );
    await ensurePostgresConstraint(
      'chk_appointments_status',
      `ALTER TABLE appointments
         ADD CONSTRAINT chk_appointments_status
         CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')) NOT VALID`
    );
    await ensurePostgresConstraint(
      'chk_appointments_source',
      `ALTER TABLE appointments
         ADD CONSTRAINT chk_appointments_source
         CHECK (source IN ('owner', 'public', 'reminder')) NOT VALID`
    );
    await ensurePostgresConstraint(
      'chk_appointments_duration_minutes',
      `ALTER TABLE appointments
         ADD CONSTRAINT chk_appointments_duration_minutes
         CHECK (duration_minutes >= 0) NOT VALID`
    );
    await ensurePostgresConstraint(
      'chk_appointments_reminder_offset_minutes',
      `ALTER TABLE appointments
         ADD CONSTRAINT chk_appointments_reminder_offset_minutes
         CHECK (reminder_offset_minutes BETWEEN 0 AND 10080) NOT VALID`
    );
    await ensurePostgresConstraint(
      'chk_clients_stage',
      `ALTER TABLE clients
         ADD CONSTRAINT chk_clients_stage
         CHECK (stage IN ('new', 'in_progress', 'waiting', 'completed', 'on_hold')) NOT VALID`
    );
    await ensurePostgresConstraint(
      'chk_business_settings_workspace_mode',
      `ALTER TABLE business_settings
         ADD CONSTRAINT chk_business_settings_workspace_mode
         CHECK (workspace_mode IN ('appointments', 'reminders', 'clients')) NOT VALID`
    );

    const existingTypeCount = Number(
      (await pgPool.query('SELECT COUNT(*)::int AS c FROM appointment_types WHERE business_id = $1', [businessRow.id])).rows[0].c
    );
    if (SEED_DEFAULT_TYPES && !existingTypeCount) {
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

    if (DEFAULT_ADMIN_EMAIL && DEFAULT_ADMIN_PASSWORD) {
      const existingUser = await pgPool.query('SELECT id FROM users WHERE email = $1', [DEFAULT_ADMIN_EMAIL.toLowerCase()]);
      if (!existingUser.rowCount) {
        await pgPool.query(
          `INSERT INTO users (business_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, $4, 'owner')`,
          [businessRow.id, 'Owner', DEFAULT_ADMIN_EMAIL.toLowerCase(), hashPassword(DEFAULT_ADMIN_PASSWORD)]
        );
      }
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
        theme_preference TEXT NOT NULL DEFAULT 'light',
        accent_color TEXT NOT NULL DEFAULT 'green',
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

      CREATE TABLE IF NOT EXISTS login_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        business_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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
        client_id INTEGER,
        title TEXT,
        client_name TEXT NOT NULL,
        client_email TEXT,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        location TEXT NOT NULL DEFAULT 'office',
        notes TEXT,
        reminder_offset_minutes INTEGER NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'confirmed',
        source TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(type_id) REFERENCES appointment_types(id),
        FOREIGN KEY(client_id) REFERENCES clients(id)
      );

      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        stage TEXT NOT NULL DEFAULT 'new',
        progress_summary TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS client_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER NOT NULL,
        client_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS business_settings (
        business_id INTEGER PRIMARY KEY,
        business_name TEXT NOT NULL,
        owner_email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        notify_owner_email INTEGER NOT NULL DEFAULT 1,
        reminder_mode INTEGER NOT NULL DEFAULT 0,
        workspace_mode TEXT NOT NULL DEFAULT 'appointments',
        open_time TEXT NOT NULL DEFAULT '09:00',
        close_time TEXT NOT NULL DEFAULT '18:00',
        business_hours_json TEXT,
        FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS ai_import_usage (
        business_id INTEGER NOT NULL,
        usage_date TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (business_id, usage_date),
        FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_appointments_business_date_time ON appointments(business_id, date, time);
      CREATE INDEX IF NOT EXISTS idx_appointments_business_status ON appointments(business_id, status);
      CREATE INDEX IF NOT EXISTS idx_appointments_business_type ON appointments(business_id, type_id);
      CREATE INDEX IF NOT EXISTS idx_clients_business_updated ON clients(business_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_clients_business_stage ON clients(business_id, stage);
      CREATE INDEX IF NOT EXISTS idx_client_notes_client_created ON client_notes(client_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_client_notes_business_client ON client_notes(business_id, client_id);
      CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_signup_verifications_email ON signup_verifications(email);
      CREATE INDEX IF NOT EXISTS idx_login_verifications_token_hash ON login_verifications(token_hash);
      CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
      CREATE INDEX IF NOT EXISTS idx_business_settings_business ON business_settings(business_id);
      CREATE INDEX IF NOT EXISTS idx_ai_import_usage_business_date ON ai_import_usage(business_id, usage_date);
    `);

    addSqliteColumnIfMissing('settings', 'business_id', 'business_id INTEGER');
    addSqliteColumnIfMissing('appointment_types', 'business_id', 'business_id INTEGER');
    addSqliteColumnIfMissing('appointments', 'business_id', 'business_id INTEGER');
    addSqliteColumnIfMissing('appointments', 'client_id', 'client_id INTEGER');
    addSqliteColumnIfMissing('appointments', 'reminder_offset_minutes', 'reminder_offset_minutes INTEGER NOT NULL DEFAULT 10');
    addSqliteColumnIfMissing('users', 'theme_preference', "theme_preference TEXT NOT NULL DEFAULT 'light'");
    addSqliteColumnIfMissing('users', 'accent_color', "accent_color TEXT NOT NULL DEFAULT 'green'");
    addSqliteColumnIfMissing('business_settings', 'notify_owner_email', 'notify_owner_email INTEGER NOT NULL DEFAULT 1');
    addSqliteColumnIfMissing('business_settings', 'reminder_mode', 'reminder_mode INTEGER NOT NULL DEFAULT 0');
    addSqliteColumnIfMissing('business_settings', 'workspace_mode', "workspace_mode TEXT NOT NULL DEFAULT 'appointments'");
    addSqliteColumnIfMissing('business_settings', 'open_time', "open_time TEXT NOT NULL DEFAULT '09:00'");
    addSqliteColumnIfMissing('business_settings', 'close_time', "close_time TEXT NOT NULL DEFAULT '18:00'");
    addSqliteColumnIfMissing('business_settings', 'business_hours_json', 'business_hours_json TEXT');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_settings_business ON settings(business_id)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_appointments_business ON appointments(business_id)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_types_business ON appointment_types(business_id)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments(client_id)');

    const foreignKeyViolations = sqlite.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length) {
      console.warn(`[db] SQLite foreign key check found ${foreignKeyViolations.length} violation(s). Existing rows were left untouched.`);
    }

    const defaultBusinessName = process.env.BUSINESS_NAME || 'IntelliBook';
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
    if (SEED_DEFAULT_TYPES && !count) {
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

    if (DEFAULT_ADMIN_EMAIL && DEFAULT_ADMIN_PASSWORD) {
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
}

// ── Business & Settings helpers ─────────────────────────────────────────────

async function getBusinessById(id) {
  return dbGet('SELECT * FROM businesses WHERE id = ?', 'SELECT * FROM businesses WHERE id = $1', [Number(id)]);
}

async function getBusinessBySlug(slug) {
  return dbGet('SELECT * FROM businesses WHERE slug = ?', 'SELECT * FROM businesses WHERE slug = $1', [String(slug || '')]);
}

async function getSettings(businessId) {
  const id = Number(businessId || 1);
  return dbGet(
    'SELECT * FROM business_settings WHERE business_id = ? LIMIT 1',
    'SELECT * FROM business_settings WHERE business_id = $1 LIMIT 1',
    [id]
  );
}

async function getAiImportQuotaStatus(businessId, usageDate, limitPerDay = 3) {
  const scopedBusinessId = Number(businessId || 0);
  const day = String(usageDate || '').slice(0, 10);
  const limit = Number(limitPerDay || 3);
  if (!scopedBusinessId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('Invalid quota parameters.');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Invalid quota limit.');
  }

  const row = await dbGet(
    'SELECT usage_count FROM ai_import_usage WHERE business_id = ? AND usage_date = ?',
    'SELECT usage_count FROM ai_import_usage WHERE business_id = $1 AND usage_date = $2',
    [scopedBusinessId, day]
  );
  const used = Number(row?.usage_count || 0);
  const remaining = Math.max(0, limit - used);
  return {
    allowed: used < limit,
    used,
    remaining,
    limit,
    usageDate: day
  };
}

async function consumeAiImportQuota(businessId, usageDate, limitPerDay = 3) {
  const scopedBusinessId = Number(businessId || 0);
  const day = String(usageDate || '').slice(0, 10);
  const limit = Number(limitPerDay || 3);
  if (!scopedBusinessId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('Invalid quota parameters.');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Invalid quota limit.');
  }

  if (USE_POSTGRES) {
    const result = await pgPool.query(
      `INSERT INTO ai_import_usage (business_id, usage_date, usage_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (business_id, usage_date) DO UPDATE
         SET usage_count = ai_import_usage.usage_count + 1
       WHERE ai_import_usage.usage_count < $3
       RETURNING usage_count`,
      [scopedBusinessId, day, limit]
    );

    if (result.rowCount) {
      const used = Number(result.rows[0].usage_count || 0);
      return { allowed: true, used, remaining: Math.max(0, limit - used), limit, usageDate: day };
    }

    const row = await dbGet(
      'SELECT usage_count FROM ai_import_usage WHERE business_id = ? AND usage_date = ?',
      'SELECT usage_count FROM ai_import_usage WHERE business_id = $1 AND usage_date = $2',
      [scopedBusinessId, day]
    );
    const used = Number(row?.usage_count || limit);
    return { allowed: false, used, remaining: Math.max(0, limit - used), limit, usageDate: day };
  }

  const db = sqlite;
  const tx = db.transaction((input) => {
    const existing = db.prepare(
      `SELECT usage_count
       FROM ai_import_usage
       WHERE business_id = ? AND usage_date = ?`
    ).get(input.businessId, input.usageDate);

    if (!existing) {
      db.prepare(
        `INSERT INTO ai_import_usage (business_id, usage_date, usage_count)
         VALUES (?, ?, 1)`
      ).run(input.businessId, input.usageDate);
      return { allowed: true, used: 1, remaining: Math.max(0, input.limit - 1), limit: input.limit, usageDate: input.usageDate };
    }

    const current = Number(existing.usage_count || 0);
    if (current >= input.limit) {
      return { allowed: false, used: current, remaining: 0, limit: input.limit, usageDate: input.usageDate };
    }

    const next = current + 1;
    db.prepare(
      `UPDATE ai_import_usage
       SET usage_count = ?
       WHERE business_id = ? AND usage_date = ?`
    ).run(next, input.businessId, input.usageDate);
    return { allowed: true, used: next, remaining: Math.max(0, input.limit - next), limit: input.limit, usageDate: input.usageDate };
  });

  return tx({ businessId: scopedBusinessId, usageDate: day, limit });
}

// ── Row mappers ─────────────────────────────────────────────────────────────

const typeClassMap = {
  consultation: 'consultation',
  strategy: 'strategy',
  review: 'review',
  call: 'call'
};

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
    clientId: row.client_id ? Number(row.client_id) : null,
    typeName: row.type_name || 'General',
    typeClass: typeClassMap[key] || 'consultation',
    title: row.title || row.type_name || 'Appointment',
    clientName: row.client_name,
    clientEmail: row.client_email,
    date,
    time,
    durationMinutes: Number(row.duration_minutes),
    reminderOffsetMinutes: Number(row.reminder_offset_minutes == null ? 10 : row.reminder_offset_minutes),
    location: row.location,
    notes: row.notes,
    status: row.status,
    source: row.source,
    createdAt: row.created_at
  };
}

function rowToClient(row) {
  return {
    id: Number(row.id),
    businessId: Number(row.business_id),
    name: row.name,
    email: row.email || null,
    phone: row.phone || null,
    stage: row.stage || 'new',
    progressSummary: row.progress_summary || null,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToClientNote(row) {
  return {
    id: Number(row.id),
    businessId: Number(row.business_id),
    clientId: Number(row.client_id),
    note: row.note || '',
    createdByUserId: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
    createdAt: row.created_at
  };
}

module.exports = {
  USE_POSTGRES,
  sqlite: () => sqlite,
  pgPool: () => pgPool,
  qMarks,
  dbRun,
  dbGet,
  dbAll,
  addSqliteColumnIfMissing,
  COLORS,
  slugifyBusinessName,
  initDb,
  getBusinessById,
  getBusinessBySlug,
  getSettings,
  getAiImportQuotaStatus,
  consumeAiImportQuota,
  rowToType,
  rowToAppointment,
  rowToClient,
  rowToClientNote
};
