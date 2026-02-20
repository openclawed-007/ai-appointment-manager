'use strict';

const crypto = require('crypto');
const { dbRun, dbGet, getBusinessById, slugifyBusinessName, COLORS } = require('./db');

const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const LOGIN_CODE_MINUTES = 10;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const LOGIN_RESEND_COOLDOWN_SECONDS = 30;
const PASSWORD_RESET_HOURS = 1;

// ── Crypto helpers ──────────────────────────────────────────────────────────

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
  const securePart = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${securePart}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── Session management ──────────────────────────────────────────────────────

async function createSession({ userId, businessId }) {
  const token = makeSessionToken();
  const tokenHash = hashToken(token);
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
  const tokenHash = hashToken(token);
  await dbRun(
    'DELETE FROM sessions WHERE token_hash = ?',
    'DELETE FROM sessions WHERE token_hash = $1',
    [tokenHash]
  );
}

async function getSessionByToken(token) {
  const tokenHash = hashToken(token);
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

async function deleteSessionsForUser(userId) {
  await dbRun(
    'DELETE FROM sessions WHERE user_id = ?',
    'DELETE FROM sessions WHERE user_id = $1',
    [Number(userId)]
  );
}

// ── Business creation ───────────────────────────────────────────────────────

async function createBusinessWithOwner({ businessName, name, email, passwordHash, timezone, slug }) {
  const SEED_DEFAULT_TYPES = process.env.SEED_DEFAULT_TYPES === 'true';
  const { USE_POSTGRES, sqlite: getSqlite, pgPool: getPgPool } = require('./db');

  if (USE_POSTGRES) {
    const tx = await getPgPool().connect();
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
      if (SEED_DEFAULT_TYPES) {
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
      }
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
      try { await tx.query('ROLLBACK'); } catch { }
      throw error;
    } finally {
      tx.release();
    }
  }

  const db = getSqlite();
  const tx = db.transaction((payload) => {
    const businessInsert = db
      .prepare(
        `INSERT INTO businesses (name, slug, owner_email, timezone)
         VALUES (?, ?, ?, ?)`
      )
      .run(payload.businessName, payload.slug, payload.email, payload.timezone || 'America/Los_Angeles');
    const businessId = Number(businessInsert.lastInsertRowid);

    db.prepare(
      `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
       VALUES (?, ?, ?, ?)`
    ).run(businessId, payload.businessName, payload.email, payload.timezone || 'America/Los_Angeles');

    if (SEED_DEFAULT_TYPES) {
      const insertType = db.prepare(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      [
        ['Consultation', 45, 15000, 'office', COLORS[0]],
        ['Strategy Session', 90, 30000, 'hybrid', COLORS[1]],
        ['Review', 60, 20000, 'virtual', COLORS[2]],
        ['Follow-up Call', 15, 0, 'phone', COLORS[3]]
      ].forEach((r) => insertType.run(businessId, ...r));
    }

    const userInsert = db
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

// ── Signup verification ─────────────────────────────────────────────────────

async function getPendingSignupByToken(token) {
  const tokenHash = hashToken(token);
  return dbGet(
    'SELECT * FROM signup_verifications WHERE token_hash = ?',
    'SELECT * FROM signup_verifications WHERE token_hash = $1',
    [tokenHash]
  );
}

// ── Login verification ──────────────────────────────────────────────────────

function generateLoginCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function createLoginVerification({ userId, businessId, email }) {
  const challengeToken = makeSessionToken();
  const code = generateLoginCode();
  const tokenHash = hashToken(challengeToken);
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + LOGIN_CODE_MINUTES * 60 * 1000).toISOString();

  await dbRun(
    'DELETE FROM login_verifications WHERE user_id = ?',
    'DELETE FROM login_verifications WHERE user_id = $1',
    [Number(userId)]
  );

  await dbRun(
    `INSERT INTO login_verifications (user_id, business_id, email, token_hash, code_hash, attempts, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    `INSERT INTO login_verifications (user_id, business_id, email, token_hash, code_hash, attempts, expires_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [Number(userId), Number(businessId), String(email).toLowerCase(), tokenHash, codeHash, expiresAt]
  );

  return { challengeToken, code, expiresAt };
}

async function getLoginVerificationByToken(challengeToken) {
  const tokenHash = hashToken(challengeToken);
  return dbGet(
    'SELECT * FROM login_verifications WHERE token_hash = ?',
    'SELECT * FROM login_verifications WHERE token_hash = $1',
    [tokenHash]
  );
}

async function deleteLoginVerificationById(id) {
  await dbRun(
    'DELETE FROM login_verifications WHERE id = ?',
    'DELETE FROM login_verifications WHERE id = $1',
    [Number(id)]
  );
}

// ── Password reset ──────────────────────────────────────────────────────────

async function createPasswordReset({ userId, email }) {
  const resetToken = makeSessionToken();
  const tokenHash = hashToken(resetToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_HOURS * 60 * 60 * 1000).toISOString();

  await dbRun(
    'DELETE FROM password_resets WHERE user_id = ?',
    'DELETE FROM password_resets WHERE user_id = $1',
    [Number(userId)]
  );

  await dbRun(
    `INSERT INTO password_resets (user_id, email, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    `INSERT INTO password_resets (user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [Number(userId), String(email).toLowerCase(), tokenHash, expiresAt]
  );

  return { resetToken, expiresAt };
}

async function getPasswordResetByToken(token) {
  const tokenHash = hashToken(token);
  return dbGet(
    'SELECT * FROM password_resets WHERE token_hash = ?',
    'SELECT * FROM password_resets WHERE token_hash = $1',
    [tokenHash]
  );
}

async function deletePasswordResetById(id) {
  await dbRun(
    'DELETE FROM password_resets WHERE id = ?',
    'DELETE FROM password_resets WHERE id = $1',
    [Number(id)]
  );
}

module.exports = {
  SESSION_COOKIE,
  SESSION_DAYS,
  VERIFY_HOURS,
  LOGIN_CODE_MINUTES,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_RESEND_COOLDOWN_SECONDS,
  PASSWORD_RESET_HOURS,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
  makeSessionToken,
  hashToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  deleteSessionByToken,
  getSessionByToken,
  deleteSessionsForUser,
  createBusinessWithOwner,
  getPendingSignupByToken,
  generateLoginCode,
  createLoginVerification,
  getLoginVerificationByToken,
  deleteLoginVerificationById,
  createPasswordReset,
  getPasswordResetByToken,
  deletePasswordResetById
};
