'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// ── Internal modules ──────────────────────────────────────────────────────────
const {
  USE_POSTGRES,
  sqlite: getSqlite,
  pgPool: getPgPool,
  dbRun, dbGet, dbAll,
  initDb,
  getBusinessById, getBusinessBySlug, getSettings,
  getAiImportQuotaStatus,
  consumeAiImportQuota,
  rowToType, rowToAppointment, rowToClient, rowToClientNote,
  slugifyBusinessName, COLORS
} = require('./lib/db');

const { fmtTime, buildBrandedEmailHtml, buildCancellationEmailHtml, sendEmail } = require('./lib/email');
const { isValidEmailFormat } = require('./lib/security');
const {
  createAppointment,
  assertNoOverlap,
  parseTimeOrThrow,
  dateLockKey,
  getAvailableSlots,
  PUBLIC_SLOT_INTERVAL_MINUTES,
  DEFAULT_PUBLIC_BOOKING_OPEN_TIME,
  DEFAULT_PUBLIC_BOOKING_CLOSE_TIME
} = require('./lib/appointments');
const { createInsights } = require('./lib/insights');
const { exportBusinessData, importBusinessData, importAiAppointments } = require('./lib/data');
const registerAuthRoutes = require('./routes/auth');
const registerSettingsRoutes = require('./routes/settings');
const registerDataRoutes = require('./routes/data');
const registerTypeRoutes = require('./routes/types');
const registerClientRoutes = require('./routes/clients');
const registerAppointmentRoutes = require('./routes/appointments');
const registerDashboardRoutes = require('./routes/dashboard');
const registerPageRoutes = require('./routes/pages');
const {
  SESSION_COOKIE,
  VERIFY_HOURS, LOGIN_CODE_MINUTES, LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_RESEND_COOLDOWN_SECONDS, PASSWORD_RESET_HOURS,
  hashPassword, validatePasswordStrength, verifyPassword,
  makeSessionToken, hashToken,
  parseCookies, setSessionCookie, clearSessionCookie,
  createSession, deleteSessionByToken, getSessionByToken, deleteSessionsForUser,
  createBusinessWithOwner, getPendingSignupByToken,
  createLoginVerification, getLoginVerificationByToken, deleteLoginVerificationById,
  createPasswordReset, getPasswordResetByToken, deletePasswordResetById
} = require('./lib/auth');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const app = express();

function getMonthDateRange(monthValue = '') {
  const value = String(monthValue || '').trim();
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;

  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
  return { start, end };
}

const BUSINESS_HOURS_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function defaultBusinessHours(openTime = DEFAULT_PUBLIC_BOOKING_OPEN_TIME, closeTime = DEFAULT_PUBLIC_BOOKING_CLOSE_TIME) {
  return BUSINESS_HOURS_DAY_KEYS.reduce((acc, day) => {
    acc[day] = { closed: false, openTime, closeTime };
    return acc;
  }, {});
}

function normalizeBusinessHours(input, fallbackOpen = DEFAULT_PUBLIC_BOOKING_OPEN_TIME, fallbackClose = DEFAULT_PUBLIC_BOOKING_CLOSE_TIME) {
  const base = defaultBusinessHours(fallbackOpen, fallbackClose);
  if (!input || typeof input !== 'object') return base;
  const normalized = {};
  for (const day of BUSINESS_HOURS_DAY_KEYS) {
    const raw = input[day] && typeof input[day] === 'object' ? input[day] : {};
    const closed = Boolean(raw.closed);
    const openTime = String(raw.openTime || fallbackOpen).slice(0, 5);
    const closeTime = String(raw.closeTime || fallbackClose).slice(0, 5);
    if (!closed) {
      const openMinutes = parseTimeOrThrow(openTime);
      const closeMinutes = parseTimeOrThrow(closeTime);
      if (closeMinutes <= openMinutes) {
        throw new Error(`Close time must be later than open time for ${day.toUpperCase()}.`);
      }
    }
    normalized[day] = { closed, openTime, closeTime };
  }
  return normalized;
}

function parseBusinessHoursJson(value, fallbackOpen, fallbackClose) {
  if (!value) return defaultBusinessHours(fallbackOpen, fallbackClose);
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return normalizeBusinessHours(parsed, fallbackOpen, fallbackClose);
  } catch (_error) {
    return defaultBusinessHours(fallbackOpen, fallbackClose);
  }
}

function resolveBusinessHoursForDate(settings = {}, isoDate = '') {
  const fallbackOpen = String(settings.open_time || DEFAULT_PUBLIC_BOOKING_OPEN_TIME).slice(0, 5);
  const fallbackClose = String(settings.close_time || DEFAULT_PUBLIC_BOOKING_CLOSE_TIME).slice(0, 5);
  const businessHours = parseBusinessHoursJson(settings.business_hours_json, fallbackOpen, fallbackClose);
  const dateObj = new Date(`${String(isoDate || '').slice(0, 10)}T00:00:00Z`);
  const dayIndex = Number.isFinite(dateObj.getTime()) ? dateObj.getUTCDay() : 1;
  const dayKey = BUSINESS_HOURS_DAY_KEYS[dayIndex] || 'mon';
  const forDay = businessHours[dayKey] || { closed: false, openTime: fallbackOpen, closeTime: fallbackClose };
  return { dayKey, ...forDay, businessHours };
}

function isReminderModeEnabled(settings = {}) {
  return settings.reminder_mode === true || settings.reminder_mode === 1;
}

function normalizeWorkspaceMode(value, fallback = 'appointments') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'appointments' || mode === 'reminders' || mode === 'clients') return mode;
  return fallback;
}

function resolveWorkspaceMode(settings = {}) {
  const fallback = isReminderModeEnabled(settings) ? 'reminders' : 'appointments';
  return normalizeWorkspaceMode(settings.workspace_mode, fallback);
}

const CLIENT_STAGES = ['new', 'in_progress', 'waiting', 'completed', 'on_hold'];

function normalizeClientStage(value, fallback = 'new') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return CLIENT_STAGES.includes(normalized) ? normalized : null;
}

function splitDateTime(value) {
  if (!value) return { date: null, time: null };
  const asString = String(value).trim();
  if (!asString) return { date: null, time: null };
  const match = asString.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  if (match) return { date: match[1], time: match[2] };
  const fallback = asString.slice(0, 16);
  if (!fallback) return { date: null, time: null };
  const compact = fallback.replace('T', ' ');
  return { date: compact.slice(0, 10), time: compact.slice(11, 16) };
}

// Render/Neon deployments run behind a reverse proxy. Trust the first proxy hop
// so express-rate-limit can read client IP from X-Forwarded-For safely.
app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"]
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));

// CSRF mitigation: require the custom header sent by the SPA on all state-mutating
// API requests.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path === '/public/bookings' || req.path === '/public/bookings/') return next();
  const xrw = req.headers['x-requested-with'];
  if (!xrw || String(xrw).toLowerCase() !== 'xmlhttprequest') {
    return res.status(403).json({ error: 'Forbidden: missing CSRF header.' });
  }
  next();
});

// Rate-limit auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/auth', authLimiter);

// Public booking endpoint rate limit
const publicBookingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many booking attempts. Please try again shortly.' }
});
app.use('/api/public/bookings', publicBookingLimiter);

// ── Static files ──────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// ── Async route helper ────────────────────────────────────────────────────────
// Express 4 does not automatically forward rejected async handlers to error middleware.
for (const method of ['use', 'get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (...args) => {
    const wrapped = args.map((arg) => {
      if (typeof arg !== 'function') return arg;
      if (arg.length >= 4) return arg;
      const isAsync = arg.constructor && arg.constructor.name === 'AsyncFunction';
      if (!isAsync) return arg;
      return (req, res, next) => Promise.resolve(arg(req, res, next)).catch(next);
    });
    return original(...wrapped);
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    db: USE_POSTGRES ? 'postgres' : 'sqlite',
    devLoginEnabled: process.env.NODE_ENV !== 'production'
  });
});

// Dev-only auto-login (skips email verification)
registerAuthRoutes(app, {
  dbGet,
  dbRun,
  slugifyBusinessName,
  getBusinessBySlug,
  makeSessionToken,
  hashToken,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
  createBusinessWithOwner,
  getPendingSignupByToken,
  createSession,
  setSessionCookie,
  deleteSessionByToken,
  getSessionByToken,
  deleteSessionsForUser,
  getLoginVerificationByToken,
  createLoginVerification,
  deleteLoginVerificationById,
  createPasswordReset,
  getPasswordResetByToken,
  deletePasswordResetById,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  VERIFY_HOURS,
  LOGIN_CODE_MINUTES,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_RESEND_COOLDOWN_SECONDS,
  PASSWORD_RESET_HOURS,
  getBusinessById,
  sendEmail,
  buildBrandedEmailHtml,
  BASE_URL
});

// ── Settings routes

registerSettingsRoutes(app, {
  dbGet,
  dbRun,
  getSettings,
  getBusinessById,
  resolveWorkspaceMode,
  parseBusinessHoursJson,
  normalizeBusinessHours,
  normalizeWorkspaceMode,
  parseTimeOrThrow,
  DEFAULT_PUBLIC_BOOKING_OPEN_TIME,
  DEFAULT_PUBLIC_BOOKING_CLOSE_TIME,
  USE_POSTGRES
});

// ── Data export/import

registerDataRoutes(app, {
  exportBusinessData,
  importBusinessData,
  importAiAppointments,
  getSettings,
  getAiImportQuotaStatus,
  consumeAiImportQuota
});

// ── Types routes

registerTypeRoutes(app, {
  dbAll,
  dbRun,
  dbGet,
  rowToType,
  getBusinessBySlug,
  USE_POSTGRES,
  pgPool: getPgPool,
  sqlite: getSqlite,
  COLORS
});

// ── Clients routes ────────────────────────────────────────────────────────────

registerClientRoutes(app, {
  USE_POSTGRES,
  sqlite: getSqlite,
  pgPool: getPgPool,
  dbRun,
  dbGet,
  dbAll,
  rowToAppointment,
  rowToClient,
  rowToClientNote,
  CLIENT_STAGES,
  normalizeClientStage,
  splitDateTime
});

// ── Appointments routes ───────────────────────────────────────────────────────

registerAppointmentRoutes(app, {
  USE_POSTGRES,
  sqlite: getSqlite,
  pgPool: getPgPool,
  dbGet,
  rowToAppointment,
  createAppointment,
  assertNoOverlap,
  parseTimeOrThrow,
  dateLockKey,
  getAvailableSlots,
  PUBLIC_SLOT_INTERVAL_MINUTES,
  getBusinessBySlug,
  getSettings,
  getMonthDateRange,
  resolveBusinessHoursForDate,
  dbAll,
  isValidEmailFormat,
  sendEmail,
  fmtTime,
  buildBrandedEmailHtml,
  buildCancellationEmailHtml
});

// ── Notifications route

registerDashboardRoutes(app, {
  USE_POSTGRES,
  pgPool: getPgPool,
  sqlite: getSqlite,
  dbAll,
  rowToAppointment,
  rowToType,
  createInsights
});

// ── Page routes

registerPageRoutes(app, {
  path,
  crypto,
  publicDir: PUBLIC_DIR
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.use('/api', (err, _req, res, _next) => {
  console.error('API error:', err);
  if (res.headersSent) return;
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Backup file is too large. Try a smaller JSON export.' });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Process error handling ────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const db = {
  close: async () => {
    const pg = getPgPool();
    const sq = getSqlite();
    if (pg) await pg.end();
    if (sq) sq.close();
  },
  mode: USE_POSTGRES ? 'postgres' : 'sqlite'
};

const boot = initDb().then(() => {
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`🗓️  IntelliBook running on http://localhost:${PORT} (${db.mode})`);
    });
  }
});

module.exports = { app, db, boot };
