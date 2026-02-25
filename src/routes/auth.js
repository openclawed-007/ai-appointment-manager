'use strict';

function registerAuthRoutes(app, deps) {
  const {
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
  } = deps;

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
    req.path === '/public/available-slots' ||
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

}

module.exports = registerAuthRoutes;
