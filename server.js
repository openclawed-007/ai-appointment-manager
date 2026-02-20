'use strict';

const path = require('path');
const fs = require('fs');
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
  rowToType, rowToAppointment,
  slugifyBusinessName, COLORS
} = require('./lib/db');

const { fmtTime, buildBrandedEmailHtml, buildCancellationEmailHtml, sendEmail } = require('./lib/email');
const { createAppointment, assertNoOverlap, parseTimeOrThrow } = require('./lib/appointments');
const { createInsights } = require('./lib/insights');
const { exportBusinessData, importBusinessData } = require('./lib/data');
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
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
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
const STATIC_FILES = [
  'index.html', 'app.js', 'booking.html', 'booking.js',
  'reset-password.html', 'reset-password.js', 'styles.css',
  'manifest.webmanifest', 'sw.js', 'favicon.ico', 'favicon.svg'
];
STATIC_FILES.forEach((f) => {
  const full = path.join(__dirname, f);
  if (fs.existsSync(full)) app.use(`/${f}`, express.static(full));
});
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/logo', express.static(path.join(__dirname, 'logo')));

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
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/auth/dev-login', async (_req, res) => {
    const devEmail = 'dev@test.local';
    let user = await dbGet(
      'SELECT * FROM users WHERE email = ?',
      'SELECT * FROM users WHERE email = $1',
      [devEmail]
    );
    if (!user) {
      try {
        const created = await createBusinessWithOwner({
          businessName: 'Dev Test Business',
          name: 'Dev User',
          email: devEmail,
          passwordHash: hashPassword('devpassword123!'),
          timezone: 'America/Los_Angeles',
          slug: 'dev-test'
        });
        user = { id: created.user.id, business_id: created.business.id, name: created.user.name, email: devEmail, role: 'owner' };
      } catch (_e) {
        user = await dbGet(
          'SELECT * FROM users WHERE email = ?',
          'SELECT * FROM users WHERE email = $1',
          [devEmail]
        );
      }
    }
    if (!user) return res.status(500).json({ error: 'Could not create dev user.' });
    const business = await getBusinessById(user.business_id);
    const token = await createSession({ userId: user.id, businessId: user.business_id });
    setSessionCookie(res, token);
    return res.json({
      user: { id: Number(user.id), name: user.name, email: user.email, role: user.role },
      business: business ? { id: Number(business.id), name: business.name, slug: business.slug } : null
    });
  });
}

app.post('/api/auth/signup', async (req, res) => {
  const { businessName, name, email, password, timezone } = req.body || {};
  if (!businessName?.trim()) return res.status(400).json({ error: 'businessName is required' });
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!email?.trim()) return res.status(400).json({ error: 'email is required' });
  if (String(businessName).trim().length > 200) return res.status(400).json({ error: 'businessName is too long (max 200 characters)' });
  if (String(name).trim().length > 200) return res.status(400).json({ error: 'name is too long (max 200 characters)' });
  if (String(email).trim().length > 320) return res.status(400).json({ error: 'email is too long' });

  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

  const emailValue = String(email).trim().toLowerCase();
  const existingUser = await dbGet(
    'SELECT id FROM users WHERE email = ?',
    'SELECT id FROM users WHERE email = $1',
    [emailValue]
  );
  if (existingUser) return res.status(409).json({ error: 'Email already in use.' });

  const slugBase = slugifyBusinessName(businessName);
  let slug = slugBase;
  let suffix = 1;
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
    if (pendingExists) return res.status(409).json({ error: 'Email already in use.' });

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
    const verifyResult = await sendEmail({
      to: emailValue,
      subject: 'Verify your IntelliBook account',
      text: `Hi ${name.trim()},\n\nConfirm your IntelliBook account by clicking this link:\n${verifyLink}\n\nThis link expires in ${VERIFY_HOURS} hours.`,
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

    const sessionToken = await createSession({ userId: created.user.id, businessId: created.business.id });
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

  const challenge = await createLoginVerification({
    userId: user.id,
    businessId: user.business_id,
    email: user.email
  });

  const business = await getBusinessById(user.business_id);
  const businessName = business?.name || 'IntelliBook';
  const notify = await sendEmail({
    to: user.email,
    subject: `${businessName}: Your login code`,
    text: `Hi ${user.name || 'there'},\n\nYour IntelliBook login code is ${challenge.code}.\n\nThis code expires in ${LOGIN_CODE_MINUTES} minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: buildBrandedEmailHtml({
      businessName,
      title: 'Your Login Code',
      subtitle: 'Sign in verification',
      message: `Use this one-time code to finish signing in:\n${challenge.code}`,
      details: [{ label: 'Expires', value: `${LOGIN_CODE_MINUTES} minutes` }]
    })
  });

  const payload = {
    ok: true,
    codeRequired: true,
    challengeToken: challenge.challengeToken,
    provider: notify.provider || 'unknown',
    message: 'A login verification code was sent to your email.'
  };
  if (process.env.NODE_ENV !== 'production') payload.loginCode = challenge.code;
  return res.status(202).json(payload);
});

app.post('/api/auth/login/resend-code', async (req, res) => {
  const challengeToken = String(req.body?.challengeToken || '').trim();
  if (!challengeToken) return res.status(400).json({ error: 'challengeToken is required' });

  const existing = await getLoginVerificationByToken(challengeToken);
  if (!existing) return res.status(400).json({ error: 'Invalid or expired login challenge.' });

  const expiresAt = new Date(existing.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await deleteLoginVerificationById(existing.id);
    return res.status(400).json({ error: 'Login code expired. Please sign in again.' });
  }

  const createdAtMs = new Date(existing.created_at).getTime();
  const ageSeconds = Number.isFinite(createdAtMs) ? Math.floor((Date.now() - createdAtMs) / 1000) : LOGIN_RESEND_COOLDOWN_SECONDS;
  const retryAfterSeconds = Math.max(0, LOGIN_RESEND_COOLDOWN_SECONDS - ageSeconds);
  if (retryAfterSeconds > 0) {
    return res.status(429).json({
      error: `Please wait ${retryAfterSeconds}s before requesting another code.`,
      retryAfterSeconds
    });
  }

  const user = await dbGet(
    'SELECT * FROM users WHERE id = ?',
    'SELECT * FROM users WHERE id = $1',
    [Number(existing.user_id)]
  );
  if (!user) {
    await deleteLoginVerificationById(existing.id);
    return res.status(401).json({ error: 'User not found.' });
  }

  const challenge = await createLoginVerification({ userId: user.id, businessId: user.business_id, email: user.email });
  const business = await getBusinessById(user.business_id);
  const businessName = business?.name || 'IntelliBook';
  const notify = await sendEmail({
    to: user.email,
    subject: `${businessName}: Your login code`,
    text: `Hi ${user.name || 'there'},\n\nYour IntelliBook login code is ${challenge.code}.\n\nThis code expires in ${LOGIN_CODE_MINUTES} minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: buildBrandedEmailHtml({
      businessName,
      title: 'Your Login Code',
      subtitle: 'Sign in verification',
      message: `Use this one-time code to finish signing in:\n${challenge.code}`,
      details: [{ label: 'Expires', value: `${LOGIN_CODE_MINUTES} minutes` }]
    })
  });

  const payload = {
    ok: true,
    codeRequired: true,
    challengeToken: challenge.challengeToken,
    provider: notify.provider || 'unknown',
    message: 'A new login verification code was sent to your email.'
  };
  if (process.env.NODE_ENV !== 'production') payload.loginCode = challenge.code;
  return res.status(200).json(payload);
});

app.post('/api/auth/login/verify-code', async (req, res) => {
  const challengeToken = String(req.body?.challengeToken || '').trim();
  const code = String(req.body?.code || '').trim();
  if (!challengeToken || !code) {
    return res.status(400).json({ error: 'challengeToken and code are required' });
  }

  const verification = await getLoginVerificationByToken(challengeToken);
  if (!verification) return res.status(400).json({ error: 'Invalid or expired login challenge.' });

  const expiresAt = new Date(verification.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await deleteLoginVerificationById(verification.id);
    return res.status(400).json({ error: 'Login code expired. Please sign in again.' });
  }

  const attempts = Number(verification.attempts || 0);
  if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
    await deleteLoginVerificationById(verification.id);
    return res.status(429).json({ error: 'Too many invalid code attempts. Sign in again.' });
  }

  if (hashToken(code) !== String(verification.code_hash)) {
    await dbRun(
      'UPDATE login_verifications SET attempts = attempts + 1 WHERE id = ?',
      'UPDATE login_verifications SET attempts = attempts + 1 WHERE id = $1',
      [Number(verification.id)]
    );
    return res.status(401).json({ error: 'Invalid verification code.' });
  }

  const user = await dbGet(
    'SELECT * FROM users WHERE id = ?',
    'SELECT * FROM users WHERE id = $1',
    [Number(verification.user_id)]
  );
  if (!user) {
    await deleteLoginVerificationById(verification.id);
    return res.status(401).json({ error: 'User not found.' });
  }

  await deleteLoginVerificationById(verification.id);

  const business = await getBusinessById(user.business_id);
  const token = await createSession({ userId: user.id, businessId: user.business_id });
  setSessionCookie(res, token);
  return res.json({
    user: { id: Number(user.id), name: user.name, email: user.email, role: user.role },
    business: business ? { id: Number(business.id), name: business.name, slug: business.slug } : null
  });
});

app.post('/api/auth/password-reset/request', async (req, res) => {
  const emailValue = String(req.body?.email || '').trim().toLowerCase();
  const response = {
    ok: true,
    message: 'If an account exists for that email, a reset link has been sent.'
  };
  if (!emailValue) return res.json(response);

  const user = await dbGet(
    'SELECT * FROM users WHERE email = ?',
    'SELECT * FROM users WHERE email = $1',
    [emailValue]
  );
  if (!user) return res.json(response);

  const reset = await createPasswordReset({ userId: user.id, email: user.email });
  const business = await getBusinessById(user.business_id);
  const businessName = business?.name || 'IntelliBook';
  const resetLink = `${BASE_URL}/reset-password?token=${encodeURIComponent(reset.resetToken)}`;
  await sendEmail({
    to: user.email,
    subject: `${businessName}: Reset your password`,
    text: `Hi ${user.name || 'there'},\n\nYou requested a password reset.\n\nReset your password here:\n${resetLink}\n\nThis link expires in ${PASSWORD_RESET_HOURS} hour${PASSWORD_RESET_HOURS === 1 ? '' : 's'}.\n\nIf you did not request this, you can ignore this email.`,
    html: buildBrandedEmailHtml({
      businessName,
      title: 'Reset Password',
      subtitle: 'Account security',
      message: `Use this secure link to reset your password:\n${resetLink}`,
      details: [{ label: 'Expires', value: `${PASSWORD_RESET_HOURS} hour${PASSWORD_RESET_HOURS === 1 ? '' : 's'}` }]
    })
  });

  if (process.env.NODE_ENV !== 'production') response.resetToken = reset.resetToken;
  return res.json(response);
});

app.post('/api/auth/password-reset/confirm', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });

  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

  const reset = await getPasswordResetByToken(token);
  if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link.' });

  const expiresAt = new Date(reset.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await deletePasswordResetById(reset.id);
    return res.status(400).json({ error: 'Invalid or expired reset link.' });
  }

  await dbRun(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [hashPassword(password), Number(reset.user_id)]
  );
  await deletePasswordResetById(reset.id);
  await deleteSessionsForUser(reset.user_id);
  clearSessionCookie(res);

  return res.json({ ok: true, message: 'Password has been reset. You can sign in with your new password.' });
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

// ── Auth middleware (all /api routes below require a valid session) ────────────
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

// ── Settings routes ───────────────────────────────────────────────────────────

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

// ── Data export/import ────────────────────────────────────────────────────────

app.get('/api/data/export', async (req, res) => {
  res.json(await exportBusinessData(req.auth.businessId));
});

app.post('/api/data/import', async (req, res) => {
  const businessId = req.auth.businessId;
  const imported = await importBusinessData(businessId, req.body || {});
  const settings = await getSettings(businessId);
  res.json({ ok: true, importedTypes: imported.importedTypes, importedAppointments: imported.importedAppointments, settings });
});

// ── Types routes ──────────────────────────────────────────────────────────────

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
  if (String(name).trim().length > 200) return res.status(400).json({ error: 'name is too long (max 200 characters)' });

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
      await getPgPool().query(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [businessId, ...params]
      )
    ).rows[0];
  } else {
    const result = getSqlite()
      .prepare(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(businessId, ...params);
    row = getSqlite().prepare('SELECT * FROM appointment_types WHERE id = ?').get(result.lastInsertRowid);
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

// ── Appointments routes ───────────────────────────────────────────────────────

app.get('/api/appointments', async (req, res) => {
  const businessId = req.auth.businessId;
  const { date, q, status, month } = req.query;

  if (!USE_POSTGRES) {
    let sql = `
      SELECT a.*, t.name AS type_name, t.color AS type_color
      FROM appointments a
      LEFT JOIN appointment_types t ON t.id = a.type_id
      WHERE a.business_id = ?
    `;
    const params = [businessId];

    if (date) { sql += ' AND a.date = ?'; params.push(String(date)); }
    if (month) { sql += ' AND a.date LIKE ?'; params.push(`${String(month)}%`); }
    if (status) { sql += ' AND a.status = ?'; params.push(String(status)); }
    if (q) {
      sql += ' AND (a.client_name LIKE ? OR a.client_email LIKE ? OR a.title LIKE ? OR t.name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY a.date ASC, a.time ASC';
    const rows = getSqlite().prepare(sql).all(...params).map((r) => {
      const appt = rowToAppointment(r);
      if (r.type_color) appt.color = r.type_color;
      return appt;
    });
    return res.json({ appointments: rows });
  }

  let sql = `
    SELECT a.*, t.name AS type_name, t.color AS type_color
    FROM appointments a
    LEFT JOIN appointment_types t ON t.id = a.type_id
    WHERE a.business_id = $1
  `;
  const params = [businessId];

  if (date) { params.push(String(date)); sql += ` AND a.date = $${params.length}`; }
  if (month) { params.push(`${String(month)}%`); sql += ` AND a.date::text LIKE $${params.length}`; }
  if (status) { params.push(String(status)); sql += ` AND a.status = $${params.length}`; }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    sql += ` AND (a.client_name ILIKE $${idx} OR a.client_email ILIKE $${idx} OR a.title ILIKE $${idx} OR t.name ILIKE $${idx})`;
  }

  sql += ' ORDER BY a.date ASC, a.time ASC';
  const rows = (await getPgPool().query(sql, params)).rows.map((r) => {
    const appt = rowToAppointment(r);
    if (r.type_color) appt.color = r.type_color;
    return appt;
  });
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
    const honeypot = String(req.body?.website || '').trim();
    if (honeypot) return res.status(400).json({ error: 'Invalid request.' });

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
    if (!String(message || '').trim()) return res.status(400).json({ error: 'Custom message is required.' });
    emailSubject = String(subject || `${settings.business_name}: Message about your appointment`).trim();
    text = `Hi ${appointment.clientName},\n\n${String(message).trim()}\n\n---\nAppointment reference:\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(appointment.time)}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\nStatus: ${appointment.status}\n\nThanks,\n${settings.business_name}`;
  } else if (selectedTemplate === 'reminder') {
    emailSubject = `${settings.business_name}: Appointment reminder`;
    text = `Hi ${appointment.clientName},\n\nQuick reminder for your upcoming appointment:\n\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(appointment.time)}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\n\nReply if you need to reschedule.\n\nThanks,\n${settings.business_name}`;
  } else {
    text = `Hi ${appointment.clientName},\n\nThis is your appointment summary:\n\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(appointment.time)}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\nStatus: ${appointment.status}\n\nThanks,\n${settings.business_name}`;
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
  return res.json({ ok: true, provider: result.provider || 'unknown', appointmentId: appointment.id });
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

  const previousRow = await dbGet(
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

  if (!previousRow) return res.status(404).json({ error: 'appointment not found' });
  const previousAppointment = rowToAppointment(previousRow);

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
    const up = await getPgPool().query(
      `UPDATE appointments
       SET type_id = $1, client_name = $2, client_email = $3, date = $4, time = $5,
           duration_minutes = $6, location = $7, notes = $8
       WHERE id = $9 AND business_id = $10`,
      [
        selectedType?.id || null, clientName.trim(), clientEmail || null,
        String(date), String(time), resolvedDuration,
        location || selectedType?.location_mode || 'office',
        notes || null, id, businessId
      ]
    );
    if (!up.rowCount) return res.status(404).json({ error: 'appointment not found' });
  } else {
    const up = getSqlite()
      .prepare(
        `UPDATE appointments
         SET type_id = ?, client_name = ?, client_email = ?, date = ?, time = ?,
             duration_minutes = ?, location = ?, notes = ?
         WHERE id = ? AND business_id = ?`
      )
      .run(
        selectedType?.id || null, clientName.trim(), clientEmail || null,
        String(date), String(time), resolvedDuration,
        location || selectedType?.location_mode || 'office',
        notes || null, id, businessId
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

  const appointment = rowToAppointment(row);
  const scheduleChanged = previousAppointment.date !== appointment.date || previousAppointment.time !== appointment.time;

  if (scheduleChanged && appointment.clientEmail) {
    const settings = await getSettings(businessId);
    const message = `Hi ${appointment.clientName},\n\nYour appointment has been rescheduled.\n\nPrevious: ${previousAppointment.date} at ${fmtTime(previousAppointment.time)}\nNew: ${appointment.date} at ${fmtTime(appointment.time)}\n\nService: ${appointment.typeName}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\n\nIf this change does not work for you, reply to this email and we can help.\n\nThanks,\n${settings.business_name}`;

    await sendEmail({
      to: appointment.clientEmail,
      subject: `${settings.business_name}: Appointment rescheduled`,
      text: message,
      html: buildBrandedEmailHtml({
        businessName: settings.business_name,
        title: 'Appointment Rescheduled',
        subtitle: appointment.typeName,
        message,
        details: [
          { label: 'Previous', value: `${previousAppointment.date} • ${fmtTime(previousAppointment.time)}` },
          { label: 'New', value: `${appointment.date} • ${fmtTime(appointment.time)}` },
          { label: 'Duration', value: `${appointment.durationMinutes} minutes` },
          { label: 'Location', value: appointment.location }
        ]
      })
    });
  }

  res.json({ appointment });
});

app.delete('/api/appointments/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  if (USE_POSTGRES) {
    const result = await getPgPool().query('DELETE FROM appointments WHERE id = $1 AND business_id = $2', [id, businessId]);
    if (!result.rowCount) return res.status(404).json({ error: 'appointment not found' });
    return res.json({ ok: true });
  }

  const info = getSqlite().prepare('DELETE FROM appointments WHERE id = ? AND business_id = ?').run(id, businessId);
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
    const up = await getPgPool().query('UPDATE appointments SET status = $1 WHERE id = $2 AND business_id = $3', [status, id, businessId]);
    if (!up.rowCount) return res.status(404).json({ error: 'appointment not found' });
  } else {
    const up = getSqlite().prepare('UPDATE appointments SET status = ? WHERE id = ? AND business_id = ?').run(status, id, businessId);
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
      ? `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(appointment.time)} has been cancelled.${cleanCancellationReason ? `\n\nReason: ${cleanCancellationReason}` : ''}`
      : `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(appointment.time)} is now ${status}.`;

    await sendEmail({
      to: appointment.clientEmail,
      subject: isCancelled
        ? `${settings.business_name}: Appointment cancelled`
        : `${settings.business_name}: Appointment ${status}`,
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

// ── Dashboard route ───────────────────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  const businessId = req.auth.businessId;
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  let stats;
  if (USE_POSTGRES) {
    const [today, week, pending] = await Promise.all([
      getPgPool().query('SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND date = $2', [businessId, date]),
      getPgPool().query(
        "SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND date BETWEEN $2::date AND ($2::date + INTERVAL '6 day')",
        [businessId, date]
      ),
      getPgPool().query("SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND status = 'pending'", [businessId])
    ]);
    stats = { today: today.rows[0].c, week: week.rows[0].c, pending: pending.rows[0].c };
  } else {
    stats = {
      today: getSqlite().prepare('SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND date = ?').get(businessId, date).c,
      week: getSqlite()
        .prepare("SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND date BETWEEN date(?) AND date(?, '+6 day')")
        .get(businessId, date, date).c,
      pending: getSqlite().prepare("SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND status = 'pending'").get(businessId).c
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
     WHERE t.business_id = $2 AND t.active = TRUE
     GROUP BY t.id
     ORDER BY t.id ASC`,
    [businessId, businessId]
  );

  const types = typeRows.map((row) => ({ ...rowToType(row), bookingCount: Number(row.booking_count || 0) }));

  res.json({ stats, appointments, types, insights: await createInsights(date, businessId) });
});

// ── Page routes ───────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/book', (_req, res) => res.sendFile(path.join(__dirname, 'booking.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));

app.get('/verify-email', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).send('Missing verification token.');
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`
  );
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
  <body style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:560px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;">
      <h2 style="margin:0 0 10px;">Verifying your email...</h2>
      <p id="msg" style="color:#475569;">Please wait.</p>
      <a href="/" style="display:inline-block;margin-top:10px;">Go to dashboard</a>
    </div>
    <script nonce="${nonce}">
      fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
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
