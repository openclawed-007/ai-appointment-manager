const path = require('path');
const fs = require('fs');
const request = require('supertest');

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
  const signup = await agent.post('/api/auth/signup').send(payload);
  expect(signup.statusCode).toBe(202);
  expect(signup.body.pendingVerification).toBe(true);
  expect(signup.body.verificationToken).toBeTruthy();

  const verify = await agent.post('/api/auth/verify-email').send({
    token: signup.body.verificationToken
  });
  expect(verify.statusCode).toBe(200);
  return verify.body;
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
    const loginRes = await agent.post('/api/auth/login').send({
      email: adminEmail,
      password: adminPassword
    });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.user.email).toBe(adminEmail);

    const meRes = await agent.get('/api/auth/me');
    expect(meRes.statusCode).toBe(200);
    expect(meRes.body.user.email).toBe(adminEmail);

    const settingsRes = await agent.get('/api/settings');
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.body.settings).toHaveProperty('business_name');
  });

  it('can create type and appointment, then update and delete it when authenticated', async () => {
    const agent = request.agent(app);
    const loginRes = await agent.post('/api/auth/login').send({
      email: adminEmail,
      password: adminPassword
    });
    expect(loginRes.statusCode).toBe(200);

    const typeRes = await agent.post('/api/types').send({
      name: 'Test Type',
      durationMinutes: 35,
      priceCents: 5000,
      locationMode: 'virtual'
    });

    expect(typeRes.statusCode).toBe(201);
    expect(typeRes.body.type.name).toBe('Test Type');

    const appointmentRes = await agent.post('/api/appointments').send({
      typeId: typeRes.body.type.id,
      clientName: 'QA User',
      clientEmail: 'qa@example.com',
      date: '2026-02-20',
      time: '09:30',
      durationMinutes: 35,
      location: 'virtual',
      notes: 'api test'
    });

    expect(appointmentRes.statusCode).toBe(201);
    const appointmentId = appointmentRes.body.appointment.id;

    const updateRes = await agent
      .patch(`/api/appointments/${appointmentId}/status`)
      .send({ status: 'completed' });

    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.body.appointment.status).toBe('completed');

    const deleteRes = await agent.delete(`/api/appointments/${appointmentId}`);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.ok).toBe(true);
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

    const typeARes = await agentA.post('/api/types').send({
      name: `Alpha Exclusive ${unique}`,
      durationMinutes: 30,
      priceCents: 2500,
      locationMode: 'office'
    });
    expect(typeARes.statusCode).toBe(201);

    const apptARes = await agentA.post('/api/appointments').send({
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

  it('rejects weak signup passwords', async () => {
    const weakRes = await request(app).post('/api/auth/signup').send({
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

    const first = await request(app).post('/api/auth/signup').send(payload);
    expect(first.statusCode).toBe(202);

    const second = await request(app).post('/api/auth/signup').send({
      ...payload,
      businessName: `Dup Biz Second ${ts}`
    });
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('Email already in use.');
  });

  it('dashboard and appointments endpoints return structured data for authenticated owner', async () => {
    const agent = request.agent(app);
    const loginRes = await agent.post('/api/auth/login').send({
      email: adminEmail,
      password: adminPassword
    });
    expect(loginRes.statusCode).toBe(200);

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
    const loginRes = await agent.post('/api/auth/login').send({
      email: adminEmail,
      password: adminPassword
    });
    expect(loginRes.statusCode).toBe(200);

    const unique = Date.now();
    const keepTypeName = `Backup Keep Type ${unique}`;
    const removeTypeName = `Backup Remove Type ${unique}`;
    const targetDate = '2026-04-01';

    const keepTypeRes = await agent.post('/api/types').send({
      name: keepTypeName,
      durationMinutes: 40,
      priceCents: 4400,
      locationMode: 'office'
    });
    expect(keepTypeRes.statusCode).toBe(201);

    const createApptRes = await agent.post('/api/appointments').send({
      typeId: keepTypeRes.body.type.id,
      clientName: `Backup Client ${unique}`,
      clientEmail: `backup-client-${unique}@example.com`,
      date: targetDate,
      time: '10:15',
      durationMinutes: 40,
      location: 'office',
      notes: 'backup test'
    });
    expect(createApptRes.statusCode).toBe(201);

    const exportRes = await agent.get('/api/data/export');
    expect(exportRes.statusCode).toBe(200);
    expect(Array.isArray(exportRes.body.appointmentTypes)).toBe(true);
    expect(Array.isArray(exportRes.body.appointments)).toBe(true);
    expect(exportRes.body.appointmentTypes.some((t) => t.name === keepTypeName)).toBe(true);

    const removeTypeRes = await agent.post('/api/types').send({
      name: removeTypeName,
      durationMinutes: 20,
      priceCents: 1500,
      locationMode: 'virtual'
    });
    expect(removeTypeRes.statusCode).toBe(201);

    const importRes = await agent.post('/api/data/import').send(exportRes.body);
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
  });

  it(
    'reliably restores varied datasets across 10 export/import rounds',
    async () => {
      const agent = request.agent(app);
      const loginRes = await agent.post('/api/auth/login').send({
        email: adminEmail,
        password: adminPassword
      });
      expect(loginRes.statusCode).toBe(200);

      for (let round = 1; round <= 10; round += 1) {
        const existing = await agent.get('/api/appointments');
        expect(existing.statusCode).toBe(200);
        for (const appt of existing.body.appointments) {
          const del = await agent.delete(`/api/appointments/${appt.id}`);
          expect(del.statusCode).toBe(200);
        }

        const typeRes = await agent.post('/api/types').send({
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

          const create = await agent.post('/api/appointments').send({
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
          const del = await agent.delete(`/api/appointments/${appt.id}`);
          expect(del.statusCode).toBe(200);
        }

        const importRes = await agent.post('/api/data/import').send(exportRes.body);
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
