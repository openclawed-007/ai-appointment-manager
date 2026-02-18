const path = require('path');
const fs = require('fs');
const request = require('supertest');

const testDbDir = path.join(__dirname, '.tmp');
const testDbPath = path.join(testDbDir, 'test-data.db');

let app;
let db;

beforeAll(() => {
  fs.mkdirSync(testDbDir, { recursive: true });
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = 'test';

  const mod = require('../server');
  app = mod.app;
  db = mod.db;
});

afterAll(() => {
  try {
    db?.close();
  } catch {}
});

describe('API smoke', () => {
  it('health should be ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('can create type and appointment, then update and delete it', async () => {
    const typeRes = await request(app).post('/api/types').send({
      name: 'Test Type',
      durationMinutes: 35,
      priceCents: 5000,
      locationMode: 'virtual'
    });

    expect(typeRes.statusCode).toBe(201);
    expect(typeRes.body.type.name).toBe('Test Type');

    const appointmentRes = await request(app).post('/api/appointments').send({
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

    const updateRes = await request(app)
      .patch(`/api/appointments/${appointmentId}/status`)
      .send({ status: 'completed' });

    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.body.appointment.status).toBe('completed');

    const deleteRes = await request(app).delete(`/api/appointments/${appointmentId}`);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.ok).toBe(true);
  });

  it('dashboard and appointments endpoints return structured data', async () => {
    const dashRes = await request(app).get('/api/dashboard');
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.body).toHaveProperty('stats');
    expect(Array.isArray(dashRes.body.types)).toBe(true);

    const appointmentsRes = await request(app).get('/api/appointments');
    expect(appointmentsRes.statusCode).toBe(200);
    expect(Array.isArray(appointmentsRes.body.appointments)).toBe(true);
  });
});
