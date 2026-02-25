const path = require('path');
const fs = require('fs');
const request = require('supertest');

// All state-mutating requests must include X-Requested-With to pass CSRF check.
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

function post(agent, url) { return agent.post(url).set(CSRF); }
function put(agent, url) { return agent.put(url).set(CSRF); }
function patch(agent, url) { return agent.patch(url).set(CSRF); }
function del(agent, url) { return agent.delete(url).set(CSRF); }

const testDbDir = path.join(__dirname, '.tmp');
const testDbPath = path.join(testDbDir, 'test-data.db');

let app;
let db;
let boot;
let adminEmail;
let adminPassword;

beforeAll(async () => {
  fs.mkdirSync(testDbDir, { recursive: true });
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  adminEmail = 'owner-test@example.com';
  adminPassword = 'TestPass123!';
  process.env.DB_PATH = testDbPath;
  process.env.DATABASE_URL = '';
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_EMAIL = adminEmail;
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.RESEND_API_KEY = '';
  process.env.FROM_EMAIL = '';
  process.env.SMTP_HOST = '';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASS = '';

  const mod = require('../server');
  app = mod.app;
  db = mod.db;
  boot = mod.boot;
  await boot;
});

afterAll(async () => {
  try {
    await db?.close();
  } catch {}
});

async function signupAndVerify(agent, payload) {
  const signup = await post(agent, '/api/auth/signup').send(payload);
  expect(signup.statusCode).toBe(202);
  expect(signup.body.pendingVerification).toBe(true);
  expect(signup.body.verificationToken).toBeTruthy();

  const verify = await post(agent, '/api/auth/verify-email').send({
    token: signup.body.verificationToken
  });
  expect(verify.statusCode).toBe(200);
  return verify.body;
}

async function loginAndVerify(agent, email, password) {
  const loginRes = await post(agent, '/api/auth/login').send({ email, password });
  expect(loginRes.statusCode).toBe(202);
  expect(loginRes.body.codeRequired).toBe(true);
  expect(loginRes.body.challengeToken).toBeTruthy();
  expect(loginRes.body.loginCode).toBeTruthy();

  const verifyRes = await post(agent, '/api/auth/login/verify-code').send({
    challengeToken: loginRes.body.challengeToken,
    code: loginRes.body.loginCode
  });
  expect(verifyRes.statusCode).toBe(200);
  return verifyRes.body;
}

describe('API smoke', () => {
  it('health should be ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('requires auth for protected endpoints', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.statusCode).toBe(401);
  });

  it('default owner can login and access protected endpoints', async () => {
    const agent = request.agent(app);
    const loginRes = await loginAndVerify(agent, adminEmail, adminPassword);
    expect(loginRes.user.email).toBe(adminEmail);

    const meRes = await agent.get('/api/auth/me');
    expect(meRes.statusCode).toBe(200);
    expect(meRes.body.user.email).toBe(adminEmail);

    const settingsRes = await agent.get('/api/settings');
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.body.settings).toHaveProperty('business_name');
  });

  it('requires valid email code to complete login', async () => {
    const agent = request.agent(app);
    const challenge = await post(agent, '/api/auth/login').send({
      email: adminEmail,
      password: adminPassword
    });

    expect(challenge.statusCode).toBe(202);
    expect(challenge.body.codeRequired).toBe(true);
    expect(challenge.body.challengeToken).toBeTruthy();
    expect(challenge.body.loginCode).toBeTruthy();

    const wrongCode = challenge.body.loginCode === '000000' ? '111111' : '000000';
    const wrong = await post(agent, '/api/auth/login/verify-code').send({
      challengeToken: challenge.body.challengeToken,
      code: wrongCode
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await post(agent, '/api/auth/login/verify-code').send({
      challengeToken: challenge.body.challengeToken,
      code: challenge.body.loginCode
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.user.email).toBe(adminEmail);

    const reused = await post(agent, '/api/auth/login/verify-code').send({
      challengeToken: challenge.body.challengeToken,
      code: challenge.body.loginCode
    });
    expect(reused.statusCode).toBe(400);
  });

  it('enforces login-code resend cooldown', async () => {
    const agent = request.agent(app);
    const challenge = await post(agent, '/api/auth/login').send({
      email: adminEmail,
      password: adminPassword
    });
    expect(challenge.statusCode).toBe(202);
    expect(challenge.body.challengeToken).toBeTruthy();

    const resend = await post(agent, '/api/auth/login/resend-code').send({
      challengeToken: challenge.body.challengeToken
    });
    expect(resend.statusCode).toBe(429);
    expect(String(resend.body.error || '')).toContain('Please wait');
  });

  it('can create type and appointment, then update and delete it when authenticated', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const typeRes = await post(agent, '/api/types').send({
      name: 'Test Type',
      durationMinutes: 35,
      priceCents: 5000,
      locationMode: 'virtual'
    });

    expect(typeRes.statusCode).toBe(201);
    expect(typeRes.body.type.name).toBe('Test Type');

    const appointmentRes = await post(agent, '/api/appointments').send({
      typeId: typeRes.body.type.id,
      clientName: 'QA User',
      clientEmail: 'qa@example.com',
      date: '2026-02-20',
      time: '09:30',
      durationMinutes: 35,
      reminderOffsetMinutes: 120,
      location: 'virtual',
      notes: 'api test'
    });

    expect(appointmentRes.statusCode).toBe(201);
    expect(appointmentRes.body.appointment.reminderOffsetMinutes).toBe(120);
    const appointmentId = appointmentRes.body.appointment.id;

    const updateRes = await patch(agent, `/api/appointments/${appointmentId}/status`)
      .send({ status: 'completed' });

    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.body.appointment.status).toBe('completed');

    const deleteRes = await del(agent, `/api/appointments/${appointmentId}`);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.ok).toBe(true);
  });

  it('archives clients on delete and excludes them from active client routes', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const unique = Date.now();
    const createClient = await post(agent, '/api/clients').send({
      name: `Archive Client ${unique}`,
      email: `archive-client-${unique}@example.com`,
      stage: 'new'
    });
    expect(createClient.statusCode).toBe(201);
    const clientId = createClient.body.client.id;

    const noteRes = await post(agent, `/api/clients/${clientId}/notes`).send({
      note: 'Client note before archive',
      stage: 'in_progress'
    });
    expect(noteRes.statusCode).toBe(201);

    const archiveRes = await del(agent, `/api/clients/${clientId}`);
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.body.success).toBe(true);
    expect(archiveRes.body.archived).toBe(true);

    const listRes = await agent.get('/api/clients');
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.clients.some((c) => Number(c.id) === Number(clientId))).toBe(false);

    const notesAfterArchive = await agent.get(`/api/clients/${clientId}/notes`);
    expect(notesAfterArchive.statusCode).toBe(404);

    const archiveAgain = await del(agent, `/api/clients/${clientId}`);
    expect(archiveAgain.statusCode).toBe(404);
  });

  it('supports reminder offset create/update validation and persistence', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const typeRes = await post(agent, '/api/types').send({
      name: `Offset Type ${Date.now()}`,
      durationMinutes: 30,
      priceCents: 2500,
      locationMode: 'office'
    });
    expect(typeRes.statusCode).toBe(201);

    const createRes = await post(agent, '/api/appointments').send({
      typeId: typeRes.body.type.id,
      clientName: 'Offset Client',
      clientEmail: 'offset@example.com',
      date: '2026-03-20',
      time: '11:00',
      durationMinutes: 30,
      reminderOffsetMinutes: 60,
      location: 'office',
      notes: 'offset create'
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.body.appointment.reminderOffsetMinutes).toBe(60);
    const appointmentId = createRes.body.appointment.id;

    const updateWithoutOffset = await put(agent, `/api/appointments/${appointmentId}`).send({
      typeId: typeRes.body.type.id,
      clientName: 'Offset Client Updated',
      clientEmail: 'offset@example.com',
      date: '2026-03-20',
      time: '11:30',
      durationMinutes: 30,
      location: 'office',
      notes: 'offset unchanged'
    });
    expect(updateWithoutOffset.statusCode).toBe(200);
    expect(updateWithoutOffset.body.appointment.reminderOffsetMinutes).toBe(60);

    const updateWithOffset = await put(agent, `/api/appointments/${appointmentId}`).send({
      typeId: typeRes.body.type.id,
      clientName: 'Offset Client Updated 2',
      clientEmail: 'offset@example.com',
      date: '2026-03-20',
      time: '12:00',
      durationMinutes: 30,
      reminderOffsetMinutes: 15,
      location: 'office',
      notes: 'offset updated'
    });
    expect(updateWithOffset.statusCode).toBe(200);
    expect(updateWithOffset.body.appointment.reminderOffsetMinutes).toBe(15);

    const invalidOffset = await put(agent, `/api/appointments/${appointmentId}`).send({
      typeId: typeRes.body.type.id,
      clientName: 'Offset Client Invalid',
      clientEmail: 'offset@example.com',
      date: '2026-03-20',
      time: '12:30',
      durationMinutes: 30,
      reminderOffsetMinutes: 10081,
      location: 'office',
      notes: 'invalid offset'
    });
    expect(invalidOffset.statusCode).toBe(400);
    expect(String(invalidOffset.body.error || '')).toContain('reminderOffsetMinutes');
  });

  it('allows overlapping reminders without requiring duration', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const reminderA = await post(agent, '/api/appointments').send({
      clientName: 'Reminder A',
      date: '2026-07-10',
      time: '10:15',
      source: 'reminder',
      reminderOffsetMinutes: 10
    });
    expect(reminderA.statusCode).toBe(201);
    expect(reminderA.body.appointment.source).toBe('reminder');
    expect(reminderA.body.appointment.durationMinutes).toBe(0);

    const reminderB = await post(agent, '/api/appointments').send({
      clientName: 'Reminder B',
      date: '2026-07-10',
      time: '10:15',
      source: 'reminder',
      reminderOffsetMinutes: 5
    });
    expect(reminderB.statusCode).toBe(201);
    expect(reminderB.body.appointment.durationMinutes).toBe(0);

    const updateReminder = await put(agent, `/api/appointments/${reminderA.body.appointment.id}`).send({
      clientName: 'Reminder A Updated',
      date: '2026-07-10',
      time: '10:15',
      source: 'reminder',
      reminderOffsetMinutes: 15
    });
    expect(updateReminder.statusCode).toBe(200);
    expect(updateReminder.body.appointment.source).toBe('reminder');
    expect(updateReminder.body.appointment.durationMinutes).toBe(0);
  });

  it('returns 503 for AI import when OPENROUTER_API_KEY is not configured', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const originalKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const res = await post(agent, '/api/data/import-ai').send({
        fileName: 'sample.csv',
        fileContent: 'name,date,time\nAlice,2026-02-21,09:00'
      });

      expect(res.statusCode).toBe(503);
      expect(String(res.body.error || '')).toContain('OPENROUTER_API_KEY');
    } finally {
      if (originalKey == null) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it('returns AI import quota status for the signed-in business', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const before = await agent.get('/api/data/import-ai/quota');
    expect(before.statusCode).toBe(200);
    expect(before.body.quota?.limit).toBe(3);
    expect(Number(before.body.quota?.used || 0)).toBeGreaterThanOrEqual(0);
    expect(Number(before.body.quota?.remaining || 0)).toBeLessThanOrEqual(3);
  });

  it('enforces AI import quota at 3 per business per day', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const originalKey = process.env.OPENROUTER_API_KEY;
    const originalFetch = global.fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';
    let callCount = 0;
    global.fetch = async () => {
      callCount += 1;
      const hour = String(8 + callCount).padStart(2, '0');
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                parsed: {
                  appointments: [
                    {
                      clientName: `Quota Client ${callCount}`,
                      clientEmail: null,
                      title: 'Quota Test',
                      typeName: 'Quota Test',
                      date: `2026-08-0${callCount}`,
                      time: `${hour}:00`,
                      durationMinutes: 30,
                      location: 'office',
                      notes: null,
                      status: 'confirmed',
                      source: 'owner'
                    }
                  ]
                }
              }
            }
          ]
        })
      };
    };

    try {
      for (let i = 0; i < 3; i += 1) {
        const okRes = await post(agent, '/api/data/import-ai').send({
          fileName: `quota-${i + 1}.txt`,
          fileContent: `Quota test row ${i + 1}`
        });
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body.quota?.used).toBe(i + 1);
      }

      const blocked = await post(agent, '/api/data/import-ai').send({
        fileName: 'quota-4.txt',
        fileContent: 'Quota test row 4'
      });
      expect(blocked.statusCode).toBe(429);
      expect(String(blocked.body.error || '')).toContain('AI import limit reached');
      expect(blocked.body.quota?.limit).toBe(3);
    } finally {
      if (originalKey == null) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
      global.fetch = originalFetch;
    }
  });

  it('isolates data between businesses', async () => {
    const unique = Date.now();
    const agentA = request.agent(app);
    const agentB = request.agent(app);

    const verifiedA = await signupAndVerify(agentA, {
      businessName: `Alpha ${unique}`,
      name: 'Alpha Owner',
      email: `alpha-${unique}@example.com`,
      password: 'AlphaPass123!',
      timezone: 'America/Los_Angeles'
    });
    const businessASlug = verifiedA.business.slug;

    const typeARes = await post(agentA, '/api/types').send({
      name: `Alpha Exclusive ${unique}`,
      durationMinutes: 30,
      priceCents: 2500,
      locationMode: 'office'
    });
    expect(typeARes.statusCode).toBe(201);

    const apptARes = await post(agentA, '/api/appointments').send({
      typeId: typeARes.body.type.id,
      clientName: 'Alpha Client',
      clientEmail: `alpha-client-${unique}@example.com`,
      date: '2026-03-01',
      time: '09:00',
      durationMinutes: 30,
      location: 'office',
      notes: 'alpha-only'
    });
    expect(apptARes.statusCode).toBe(201);

    await signupAndVerify(agentB, {
      businessName: `Beta ${unique}`,
      name: 'Beta Owner',
      email: `beta-${unique}@example.com`,
      password: 'BetaPass123!',
      timezone: 'America/New_York'
    });

    const bAppointments = await agentB.get('/api/appointments');
    expect(bAppointments.statusCode).toBe(200);
    expect(bAppointments.body.appointments.some((a) => a.clientName === 'Alpha Client')).toBe(false);

    const publicTypesA = await request(app).get(`/api/types?businessSlug=${encodeURIComponent(businessASlug)}`);
    expect(publicTypesA.statusCode).toBe(200);
    expect(publicTypesA.body.types.some((t) => t.name === `Alpha Exclusive ${unique}`)).toBe(true);
  });

  it('returns public available slots and excludes overlapping times', async () => {
    const unique = Date.now();
    const agent = request.agent(app);
    const verified = await signupAndVerify(agent, {
      businessName: `Slots ${unique}`,
      name: 'Slots Owner',
      email: `slots-${unique}@example.com`,
      password: 'SlotsPass123!',
      timezone: 'America/Los_Angeles'
    });

    const typeRes = await post(agent, '/api/types').send({
      name: `Slots Type ${unique}`,
      durationMinutes: 30,
      priceCents: 3000,
      locationMode: 'office'
    });
    expect(typeRes.statusCode).toBe(201);
    const typeId = typeRes.body.type.id;

    const hoursRes = await put(agent, '/api/settings').send({
      openTime: '10:00',
      closeTime: '14:00',
      businessHours: {
        mon: { closed: false, openTime: '10:00', closeTime: '14:00' },
        tue: { closed: false, openTime: '10:00', closeTime: '14:00' },
        wed: { closed: false, openTime: '10:00', closeTime: '14:00' },
        thu: { closed: false, openTime: '10:00', closeTime: '14:00' },
        fri: { closed: false, openTime: '10:00', closeTime: '14:00' },
        sat: { closed: false, openTime: '08:00', closeTime: '16:00' },
        sun: { closed: true, openTime: '10:00', closeTime: '14:00' }
      }
    });
    expect(hoursRes.statusCode).toBe(200);

    const createA = await post(agent, '/api/appointments').send({
      typeId,
      clientName: 'Booked A',
      clientEmail: `booked-a-${unique}@example.com`,
      date: '2026-06-12',
      time: '09:00',
      durationMinutes: 30,
      location: 'office'
    });
    expect(createA.statusCode).toBe(201);

    const createB = await post(agent, '/api/appointments').send({
      typeId,
      clientName: 'Booked B',
      clientEmail: `booked-b-${unique}@example.com`,
      date: '2026-06-12',
      time: '10:00',
      durationMinutes: 30,
      location: 'office'
    });
    expect(createB.statusCode).toBe(201);

    const slotsRes = await request(app).get(
      `/api/public/available-slots?businessSlug=${encodeURIComponent(verified.business.slug)}&date=2026-06-12&typeId=${typeId}`
    );
    expect(slotsRes.statusCode).toBe(200);
    expect(slotsRes.body.durationMinutes).toBe(30);
    expect(slotsRes.body.openTime).toBe('10:00');
    expect(slotsRes.body.closeTime).toBe('14:00');
    expect(Array.isArray(slotsRes.body.availableSlots)).toBe(true);
    expect(slotsRes.body.availableSlots).not.toContain('09:00');
    expect(slotsRes.body.availableSlots).not.toContain('09:30');
    expect(slotsRes.body.availableSlots).not.toContain('10:00');
    expect(slotsRes.body.availableSlots).toContain('10:30');
    expect(slotsRes.body.availableSlots).toContain('13:30');
    expect(slotsRes.body.availableSlots).not.toContain('14:00');

    const closedDayRes = await request(app).get(
      `/api/public/available-slots?businessSlug=${encodeURIComponent(verified.business.slug)}&date=2026-06-14&typeId=${typeId}`
    );
    expect(closedDayRes.statusCode).toBe(200);
    expect(closedDayRes.body.dayKey).toBe('sun');
    expect(closedDayRes.body.closed).toBe(true);
    expect(closedDayRes.body.availableSlots).toEqual([]);
  });

  it('rejects weak signup passwords', async () => {
    const weakRes = await request(app).post('/api/auth/signup').set(CSRF).send({
      businessName: `Weak Biz ${Date.now()}`,
      name: 'Weak Owner',
      email: `weak-${Date.now()}@example.com`,
      password: 'weakpass',
      timezone: 'America/Los_Angeles'
    });
    expect(weakRes.statusCode).toBe(400);
    expect(String(weakRes.body.error || '')).toContain('Password is too weak');
  });

  it('rejects duplicate signup email before creating account', async () => {
    const ts = Date.now();
    const email = `dup-${ts}@example.com`;
    const payload = {
      businessName: `Dup Biz ${ts}`,
      name: 'Dup Owner',
      email,
      password: 'StrongPass123!',
      timezone: 'America/Los_Angeles'
    };

    const first = await request(app).post('/api/auth/signup').set(CSRF).send(payload);
    expect(first.statusCode).toBe(202);

    const second = await request(app).post('/api/auth/signup').set(CSRF).send({
      ...payload,
      businessName: `Dup Biz Second ${ts}`
    });
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('Email already in use.');
  });

  it('can reset password via emailed reset token', async () => {
    const email = `reset-${Date.now()}@example.com`;
    const originalPassword = 'ResetPass123!';
    const newPassword = 'ResetPass456!';
    const agent = request.agent(app);

    await signupAndVerify(agent, {
      businessName: `Reset Biz ${Date.now()}`,
      name: 'Reset Owner',
      email,
      password: originalPassword,
      timezone: 'America/Los_Angeles'
    });

    const requestReset = await request(app).post('/api/auth/password-reset/request').set(CSRF).send({ email });
    expect(requestReset.statusCode).toBe(200);
    expect(requestReset.body.ok).toBe(true);
    expect(requestReset.body.resetToken).toBeTruthy();

    const confirmReset = await request(app).post('/api/auth/password-reset/confirm').set(CSRF).send({
      token: requestReset.body.resetToken,
      password: newPassword
    });
    expect(confirmReset.statusCode).toBe(200);
    expect(confirmReset.body.ok).toBe(true);

    const oldLogin = await request(app).post('/api/auth/login').set(CSRF).send({
      email,
      password: originalPassword
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await request(app).post('/api/auth/login').set(CSRF).send({
      email,
      password: newPassword
    });
    expect(newLogin.statusCode).toBe(202);
    expect(newLogin.body.codeRequired).toBe(true);
  });

  it('dashboard and appointments endpoints return structured data for authenticated owner', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const dashRes = await agent.get('/api/dashboard');
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.body).toHaveProperty('stats');
    expect(Array.isArray(dashRes.body.types)).toBe(true);

    const appointmentsRes = await agent.get('/api/appointments');
    expect(appointmentsRes.statusCode).toBe(200);
    expect(Array.isArray(appointmentsRes.body.appointments)).toBe(true);
  });

  it('can export and import business data backup', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent, adminEmail, adminPassword);

    const unique = Date.now();
    const keepTypeName = `Backup Keep Type ${unique}`;
    const removeTypeName = `Backup Remove Type ${unique}`;
    const targetDate = '2026-04-01';
    const expectedOffset = 90;

    const settingsRes = await put(agent, '/api/settings').send({ reminderMode: true });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.body.settings.reminder_mode).toBe(true);

    const keepTypeRes = await post(agent, '/api/types').send({
      name: keepTypeName,
      durationMinutes: 40,
      priceCents: 4400,
      locationMode: 'office'
    });
    expect(keepTypeRes.statusCode).toBe(201);

    const createApptRes = await post(agent, '/api/appointments').send({
      typeId: keepTypeRes.body.type.id,
      clientName: `Backup Client ${unique}`,
      clientEmail: `backup-client-${unique}@example.com`,
      date: targetDate,
      time: '10:15',
      durationMinutes: 40,
      reminderOffsetMinutes: expectedOffset,
      location: 'office',
      notes: 'backup test'
    });
    expect(createApptRes.statusCode).toBe(201);

    const exportRes = await agent.get('/api/data/export');
    expect(exportRes.statusCode).toBe(200);
    expect(Array.isArray(exportRes.body.appointmentTypes)).toBe(true);
    expect(Array.isArray(exportRes.body.appointments)).toBe(true);
    expect(exportRes.body.appointmentTypes.some((t) => t.name === keepTypeName)).toBe(true);
    expect(exportRes.body.settings?.reminder_mode).toBe(true);
    const exportedAppointment = exportRes.body.appointments.find((a) => a.client_name === `Backup Client ${unique}`);
    expect(exportedAppointment).toBeTruthy();
    expect(exportedAppointment.reminder_offset_minutes).toBe(expectedOffset);

    const removeTypeRes = await post(agent, '/api/types').send({
      name: removeTypeName,
      durationMinutes: 20,
      priceCents: 1500,
      locationMode: 'virtual'
    });
    expect(removeTypeRes.statusCode).toBe(201);

    const importRes = await post(agent, '/api/data/import').send(exportRes.body);
    expect(importRes.statusCode).toBe(200);
    expect(importRes.body.ok).toBe(true);
    expect(importRes.body.importedAppointments).toBe(exportRes.body.appointments.length);
    expect(importRes.body.importedTypes).toBe(exportRes.body.appointmentTypes.length);

    const typesAfter = await agent.get('/api/types');
    expect(typesAfter.statusCode).toBe(200);
    expect(typesAfter.body.types.some((t) => t.name === keepTypeName)).toBe(true);
    expect(typesAfter.body.types.some((t) => t.name === removeTypeName)).toBe(false);

    const apptsAfter = await agent.get('/api/appointments');
    expect(apptsAfter.statusCode).toBe(200);
    expect(apptsAfter.body.appointments.length).toBe(exportRes.body.appointments.length);
    const restoredAppointment = apptsAfter.body.appointments.find((a) => a.clientName === `Backup Client ${unique}`);
    expect(restoredAppointment).toBeTruthy();
    expect(restoredAppointment.reminderOffsetMinutes).toBe(expectedOffset);

    const settingsAfter = await agent.get('/api/settings');
    expect(settingsAfter.statusCode).toBe(200);
    expect(settingsAfter.body.settings.reminder_mode).toBe(true);
  });

  it(
    'reliably restores varied datasets across 10 export/import rounds',
    async () => {
      const agent = request.agent(app);
      await loginAndVerify(agent, adminEmail, adminPassword);

      for (let round = 1; round <= 10; round += 1) {
        const existing = await agent.get('/api/appointments');
        expect(existing.statusCode).toBe(200);
        for (const appt of existing.body.appointments) {
          const delRes = await del(agent, `/api/appointments/${appt.id}`);
          expect(delRes.statusCode).toBe(200);
        }

        const typeRes = await post(agent, '/api/types').send({
          name: `Round ${round} Type ${Date.now()}`,
          durationMinutes: 20 + round * 5,
          priceCents: round * 1000,
          locationMode: round % 2 === 0 ? 'virtual' : 'office'
        });
        expect(typeRes.statusCode).toBe(201);
        const typeId = typeRes.body.type.id;

        const count = (round % 6) + 1; // 2..7 appointments per round
        const expectedClients = [];
        for (let i = 0; i < count; i += 1) {
          const day = String(round + i + 1).padStart(2, '0');
          const hour = String(8 + i).padStart(2, '0');
          const minute = i % 2 === 0 ? '00' : '30';
          const clientName = `Round${round}-Client${i + 1}`;
          expectedClients.push(clientName);

          const create = await post(agent, '/api/appointments').send({
            typeId,
            clientName,
            clientEmail: `r${round}c${i + 1}@example.com`,
            date: `2026-05-${day}`,
            time: `${hour}:${minute}`,
            durationMinutes: 25,
            location: 'office',
            notes: `round ${round}`
          });
          expect(create.statusCode).toBe(201);
        }

        const exportRes = await agent.get('/api/data/export');
        expect(exportRes.statusCode).toBe(200);
        expect(exportRes.body.appointments.length).toBe(count);

        const toDelete = await agent.get('/api/appointments');
        expect(toDelete.statusCode).toBe(200);
        for (const appt of toDelete.body.appointments) {
          const delRes = await del(agent, `/api/appointments/${appt.id}`);
          expect(delRes.statusCode).toBe(200);
        }

        const importRes = await post(agent, '/api/data/import').send(exportRes.body);
        expect(importRes.statusCode).toBe(200);
        expect(importRes.body.ok).toBe(true);
        expect(importRes.body.importedAppointments).toBe(count);

        const afterImport = await agent.get('/api/appointments');
        expect(afterImport.statusCode).toBe(200);
        expect(afterImport.body.appointments.length).toBe(count);
        const names = new Set(afterImport.body.appointments.map((a) => a.clientName));
        for (const expected of expectedClients) {
          expect(names.has(expected)).toBe(true);
        }
      }
    },
    120000
  );
});
