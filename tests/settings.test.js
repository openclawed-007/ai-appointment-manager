'use strict';

/**
 * Tests for the settings page overhaul:
 *   1. Settings API — save/retrieve business profile and theme
 *   2. CSV export logic (triggerCsvDownload helpers, column correctness)
 *   3. Filtered export client-side logic (date, type, status filtering)
 *   4. Extract swatch colour helper
 *   5. HTML structure — new three-section settings layout
 *   6. index.html — key new element IDs exist
 *   7. app.js — new exported helpers are importable and correct
 */

const path = require('path');
const fs = require('fs');
const request = require('supertest');
const { JSDOM } = require('jsdom');

// ── Shared CSRF header (required by the server's CSRF middleware) ──────────────
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };
function post(agent, url) { return agent.post(url).set(CSRF); }
function put(agent, url)  { return agent.put(url).set(CSRF);  }

// ── Test DB setup ─────────────────────────────────────────────────────────────
const testDbDir  = path.join(__dirname, '.tmp-settings');
const testDbPath = path.join(testDbDir, 'settings-test.db');

let app;
let db;
let boot;
const adminEmail    = 'settings-owner@example.com';
const adminPassword = 'SettingsTest123!';
const appModule = require('../app.js');

beforeAll(async () => {
  fs.mkdirSync(testDbDir, { recursive: true });
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  process.env.DB_PATH      = testDbPath;
  process.env.DATABASE_URL = '';
  process.env.NODE_ENV     = 'test';
  process.env.ADMIN_EMAIL    = adminEmail;
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.RESEND_API_KEY = '';
  process.env.FROM_EMAIL     = '';
  process.env.SMTP_HOST      = '';
  process.env.SMTP_USER      = '';
  process.env.SMTP_PASS      = '';

  // Server module is cached by Node; isolate by clearing cache before require
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('server') || k.includes('lib/')) delete require.cache[k];
  });

  const mod = require('../server');
  app  = mod.app;
  db   = mod.db;
  boot = mod.boot;
  await boot;
});

afterAll(async () => {
  try { await db?.close(); } catch { /* ignore */ }
});

async function loginAndVerify(agent) {
  const challenge = await post(agent, '/api/auth/login').send({ email: adminEmail, password: adminPassword });
  expect(challenge.statusCode).toBe(202);
  const verify = await post(agent, '/api/auth/login/verify-code').send({
    challengeToken: challenge.body.challengeToken,
    code:           challenge.body.loginCode
  });
  expect(verify.statusCode).toBe(200);
  return verify.body;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Settings API
// ─────────────────────────────────────────────────────────────────────────────

describe('Settings API', () => {
  it('GET /api/settings returns business_name, owner_email, timezone', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);
    const res = await agent.get('/api/settings');
    expect(res.statusCode).toBe(200);
    expect(res.body.settings).toHaveProperty('business_name');
    expect(res.body.settings).toHaveProperty('owner_email');
    expect(res.body.settings).toHaveProperty('timezone');
    expect(res.body.settings).toHaveProperty('open_time');
    expect(res.body.settings).toHaveProperty('close_time');
  });

  it('PUT /api/settings updates business_name and returns updated settings', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    const newName = `Updated Biz ${Date.now()}`;
    const res = await put(agent, '/api/settings').send({ businessName: newName });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.business_name).toBe(newName);
  });

  it('PUT /api/settings updates timezone', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    const res = await put(agent, '/api/settings').send({ timezone: 'Europe/London' });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.timezone).toBe('Europe/London');
  });

  it('PUT /api/settings updates business open and close hours', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    const res = await put(agent, '/api/settings').send({ openTime: '08:30', closeTime: '19:15' });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.open_time).toBe('08:30');
    expect(res.body.settings.close_time).toBe('19:15');
    expect(res.body.settings.businessHours).toBeTruthy();
    expect(res.body.settings.businessHours.mon.openTime).toBe('08:30');
  });

  it('PUT /api/settings persists per-day business hours', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    const payload = {
      businessHours: {
        mon: { closed: false, openTime: '09:00', closeTime: '18:00' },
        tue: { closed: false, openTime: '09:00', closeTime: '18:00' },
        wed: { closed: false, openTime: '09:00', closeTime: '18:00' },
        thu: { closed: false, openTime: '09:00', closeTime: '18:00' },
        fri: { closed: false, openTime: '09:00', closeTime: '19:00' },
        sat: { closed: false, openTime: '08:00', closeTime: '16:00' },
        sun: { closed: true, openTime: '09:00', closeTime: '18:00' }
      }
    };
    const res = await put(agent, '/api/settings').send(payload);
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.businessHours.fri.closeTime).toBe('19:00');
    expect(res.body.settings.businessHours.sat.openTime).toBe('08:00');
    expect(res.body.settings.businessHours.sun.closed).toBe(true);
  });

  it('PUT /api/settings rejects close time before open time', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    const res = await put(agent, '/api/settings').send({ openTime: '18:00', closeTime: '09:00' });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error || '')).toContain('Close time');
  });

  it('PUT /api/settings accepts and persists theme preference', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    const darkRes = await put(agent, '/api/settings').send({ theme: 'dark' });
    expect(darkRes.statusCode).toBe(200);
    expect(darkRes.body.settings.theme).toBe('dark');

    const lightRes = await put(agent, '/api/settings').send({ theme: 'light' });
    expect(lightRes.statusCode).toBe(200);
    expect(lightRes.body.settings.theme).toBe('light');
  });

  it('PUT /api/settings ignores invalid theme values', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    const res = await put(agent, '/api/settings').send({ theme: 'rainbow' });
    expect(res.statusCode).toBe(200);
    // theme must be null or a valid value — not 'rainbow'
    expect(['dark', 'light', null]).toContain(res.body.settings.theme);
  });

  it('GET /api/settings requires authentication', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.statusCode).toBe(401);
  });

  it('PUT /api/settings requires authentication', async () => {
    const res = await request(app).put('/api/settings').set(CSRF).send({ businessName: 'No Auth' });
    expect(res.statusCode).toBe(401);
  });

  it('partial update preserves unset fields', async () => {
    const agent = request.agent(app);
    await loginAndVerify(agent);

    // Set known starting values
    await put(agent, '/api/settings').send({
      businessName: 'Preserve Test',
      timezone: 'America/Chicago'
    });

    // Update only businessName — timezone should not be wiped
    const res = await put(agent, '/api/settings').send({ businessName: 'New Name Only' });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.business_name).toBe('New Name Only');
    expect(res.body.settings.timezone).toBe('America/Chicago');
  });

  it('PUT /api/settings creates settings row when missing and persists business hours', async () => {
    const agent = request.agent(app);
    const auth = await loginAndVerify(agent);
    const businessId = Number(auth?.user?.businessId || auth?.business?.id || 1);

    const { dbRun } = require('../lib/db');
    await dbRun(
      'DELETE FROM business_settings WHERE business_id = ?',
      'DELETE FROM business_settings WHERE business_id = $1',
      [businessId]
    );

    const payload = {
      openTime: '08:00',
      closeTime: '17:00',
      businessHours: {
        mon: { closed: false, openTime: '08:00', closeTime: '17:00' },
        tue: { closed: false, openTime: '08:00', closeTime: '17:00' },
        wed: { closed: false, openTime: '08:00', closeTime: '17:00' },
        thu: { closed: false, openTime: '08:00', closeTime: '17:00' },
        fri: { closed: false, openTime: '09:00', closeTime: '19:00' },
        sat: { closed: true, openTime: '08:00', closeTime: '17:00' },
        sun: { closed: true, openTime: '08:00', closeTime: '17:00' }
      }
    };

    const save = await put(agent, '/api/settings').send(payload);
    expect(save.statusCode).toBe(200);
    expect(save.body.settings.open_time).toBe('08:00');
    expect(save.body.settings.close_time).toBe('17:00');
    expect(save.body.settings.businessHours.fri.closeTime).toBe('19:00');
    expect(save.body.settings.businessHours.sat.closed).toBe(true);

    const fresh = await agent.get('/api/settings');
    expect(fresh.statusCode).toBe(200);
    expect(fresh.body.settings.businessHours.fri.closeTime).toBe('19:00');
    expect(fresh.body.settings.businessHours.sat.closed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Filtered export — appointment data & filtering logic
// ─────────────────────────────────────────────────────────────────────────────

describe('Filtered export — data pipeline via /api/appointments', () => {
  let agent;
  let typeIdA, typeIdB;
  const appointments = [];

  beforeAll(async () => {
    agent = request.agent(app);
    await loginAndVerify(agent);

    // Create two distinct appointment types
    const tA = await post(agent, '/api/types').send({
      name: 'Haircut', durationMinutes: 30, priceCents: 3000, locationMode: 'office'
    });
    expect(tA.statusCode).toBe(201);
    typeIdA = tA.body.type.id;

    const tB = await post(agent, '/api/types').send({
      name: 'Consultation', durationMinutes: 60, priceCents: 8000, locationMode: 'virtual'
    });
    expect(tB.statusCode).toBe(201);
    typeIdB = tB.body.type.id;

    // Create appointments across different months
    const seeds = [
      { typeId: typeIdA, date: '2025-08-10', clientName: 'Alice',   status: 'confirmed'  },
      { typeId: typeIdA, date: '2025-09-15', clientName: 'Bob',     status: 'completed'  },
      { typeId: typeIdB, date: '2025-10-20', clientName: 'Charlie', status: 'confirmed'  },
      { typeId: typeIdB, date: '2026-01-05', clientName: 'Diana',   status: 'pending'    },
      { typeId: typeIdA, date: '2026-02-01', clientName: 'Evan',    status: 'cancelled'  },
      { typeId: typeIdA, date: '2026-02-15', clientName: 'Fiona',   status: 'completed'  },
    ];

    for (const s of seeds) {
      const r = await post(agent, '/api/appointments').send({
        typeId: s.typeId,
        clientName: s.clientName,
        clientEmail: `${s.clientName.toLowerCase()}@test.com`,
        date: s.date,
        time: '10:00',
        durationMinutes: 30,
        location: 'office',
        notes: 'export test'
      });
      expect(r.statusCode).toBe(201);
      // Patch status if not 'confirmed' (default)
      if (s.status !== 'confirmed') {
        const patch = await agent.patch(`/api/appointments/${r.body.appointment.id}/status`)
          .set(CSRF).send({ status: s.status });
        expect(patch.statusCode).toBe(200);
      }
      appointments.push({ ...r.body.appointment, clientName: s.clientName, status: s.status });
    }
  });

  it('GET /api/appointments returns all seeded appointments', async () => {
    const res = await agent.get('/api/appointments');
    expect(res.statusCode).toBe(200);
    const names = res.body.appointments.map((a) => a.clientName);
    for (const a of appointments) {
      expect(names).toContain(a.clientName);
    }
  });

  it('date range filter: from only excludes earlier appointments', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;
    const filtered = appModule.filterAppointmentsForExport(all, {
      from: '2026-01-01',
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    expect(filtered.every((a) => a.date >= '2026-01-01')).toBe(true);
    expect(filtered.some((a) => a.date < '2026-01-01')).toBe(false);
    // Should include Diana (2026-01-05), Evan (2026-02-01), Fiona (2026-02-15)
    expect(filtered.map((a) => a.clientName)).toContain('Diana');
    expect(filtered.map((a) => a.clientName)).toContain('Evan');
    expect(filtered.map((a) => a.clientName)).toContain('Fiona');
  });

  it('date range filter: to only excludes later appointments', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;
    const filtered = appModule.filterAppointmentsForExport(all, {
      to: '2025-09-30',
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    expect(filtered.every((a) => a.date <= '2025-09-30')).toBe(true);
    // Should include Alice (2025-08-10) and Bob (2025-09-15), not Charlie (2025-10-20)
    const names = filtered.map((a) => a.clientName);
    expect(names).toContain('Alice');
    expect(names).toContain('Bob');
    expect(names).not.toContain('Charlie');
  });

  it('date range filter: from + to returns inclusive range', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;
    const from = '2025-09-01';
    const to   = '2026-01-31';
    const filtered = appModule.filterAppointmentsForExport(all, {
      from,
      to,
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    const names = filtered.map((a) => a.clientName);
    // Bob (2025-09-15), Charlie (2025-10-20), Diana (2026-01-05)
    expect(names).toContain('Bob');
    expect(names).toContain('Charlie');
    expect(names).toContain('Diana');
    expect(names).not.toContain('Alice');   // 2025-08-10 — before from
    expect(names).not.toContain('Evan');    // 2026-02-01 — after to
    expect(names).not.toContain('Fiona');   // 2026-02-15 — after to
  });

  it('type filter: selecting only typeIdA excludes typeIdB appointments', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;
    const filtered = appModule.filterAppointmentsForExport(all, {
      selectedTypeIds: [typeIdA],
      totalTypes: 2
    });
    const names = filtered.map((a) => a.clientName);
    // Alice, Bob, Evan, Fiona are typeIdA; Charlie, Diana are typeIdB
    expect(names).toContain('Alice');
    expect(names).toContain('Bob');
    expect(names).not.toContain('Charlie');
    expect(names).not.toContain('Diana');
  });

  it('type filter: selecting only typeIdB excludes typeIdA appointments', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;
    const filtered = appModule.filterAppointmentsForExport(all, {
      selectedTypeIds: [typeIdB],
      totalTypes: 2
    });
    const names = filtered.map((a) => a.clientName);
    expect(names).toContain('Charlie');
    expect(names).toContain('Diana');
    expect(names).not.toContain('Alice');
    expect(names).not.toContain('Bob');
  });

  it('status filter: only returns appointments with matching status', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;

    const completed = appModule.filterAppointmentsForExport(all, {
      statusFilter: 'completed',
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    expect(completed.every((a) => a.status === 'completed')).toBe(true);
    expect(completed.map((a) => a.clientName)).toContain('Bob');
    expect(completed.map((a) => a.clientName)).toContain('Fiona');

    const pending = appModule.filterAppointmentsForExport(all, {
      statusFilter: 'pending',
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    expect(pending.every((a) => a.status === 'pending')).toBe(true);
    expect(pending.map((a) => a.clientName)).toContain('Diana');

    const cancelled = appModule.filterAppointmentsForExport(all, {
      statusFilter: 'cancelled',
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    expect(cancelled.every((a) => a.status === 'cancelled')).toBe(true);
    expect(cancelled.map((a) => a.clientName)).toContain('Evan');
  });

  it('combined date + type + status filter returns precise subset', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;

    const filtered = appModule.filterAppointmentsForExport(all, {
      from: '2025-08-01',
      to: '2025-12-31',
      statusFilter: 'confirmed',
      selectedTypeIds: [typeIdA],
      totalTypes: 2
    });

    // Only Alice matches (typeIdA, 2025-08-10, confirmed)
    expect(filtered).toHaveLength(1);
    expect(filtered[0].clientName).toBe('Alice');
  });

  it('empty date range with all types returns full dataset', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;
    const filtered = appModule.filterAppointmentsForExport(all, {
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    // No filters applied (all types selected) — should include all seeded appointments
    expect(filtered.length).toBeGreaterThanOrEqual(6);
  });

  it('non-matching filter combination returns empty result', async () => {
    const res = await agent.get('/api/appointments');
    const all = res.body.appointments;
    const filtered = appModule.filterAppointmentsForExport(all, {
      from: '2030-01-01',
      statusFilter: 'confirmed',
      selectedTypeIds: [typeIdA, typeIdB],
      totalTypes: 2
    });
    expect(filtered).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CSV generation logic (pure functions, no DOM needed)
// ─────────────────────────────────────────────────────────────────────────────

describe('CSV export helpers', () => {
  const {
    csvEscape,
    buildCsvLines,
    EXPORT_CSV_COLUMNS: CSV_COLUMNS,
    EXPORT_CSV_HEADERS: CSV_HEADERS
  } = appModule;

  it('header row contains all expected column names', () => {
    const csv = buildCsvLines([]);
    const header = csv.split('\r\n')[0];
    for (const h of CSV_HEADERS) {
      expect(header).toContain(h);
    }
  });

  it('produces correct column count per row', () => {
    const row = {
      id: 1, typeName: 'Haircut', clientName: 'Alice', clientEmail: 'a@b.com',
      date: '2026-01-01', time: '09:00', durationMinutes: 30, location: 'office',
      status: 'confirmed', notes: null, source: 'owner', createdAt: '2026-01-01T09:00:00Z'
    };
    const csv = buildCsvLines([row]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2); // header + 1 data row
    const dataColumns = lines[1].split(',');
    expect(dataColumns).toHaveLength(CSV_COLUMNS.length);
  });

  it('null values become empty strings', () => {
    const row = {
      id: 2, typeName: null, clientName: 'Bob', clientEmail: null,
      date: '2026-02-01', time: '10:00', durationMinutes: 45, location: 'virtual',
      status: 'pending', notes: null, source: 'public', createdAt: null
    };
    const csv = buildCsvLines([row]);
    const data = csv.split('\r\n')[1].split(',');
    // typeName (index 1) should be empty
    expect(data[1]).toBe('');
    // clientEmail (index 3) should be empty
    expect(data[3]).toBe('');
    // notes (index 8... wait, notes is index 8 in columns)
    const notesIdx = CSV_COLUMNS.indexOf('notes');
    expect(data[notesIdx]).toBe('');
  });

  it('values with commas are properly quoted', () => {
    const row = {
      id: 3, typeName: 'Cut, Style', clientName: 'Charlie', clientEmail: 'c@d.com',
      date: '2026-03-01', time: '11:00', durationMinutes: 60, location: 'office',
      status: 'confirmed', notes: 'Bring, ID', source: 'owner', createdAt: null
    };
    const csv = buildCsvLines([row]);
    const data = csv.split('\r\n')[1];
    expect(data).toContain('"Cut, Style"');
    expect(data).toContain('"Bring, ID"');
  });

  it('values with double-quotes are escaped as double-double-quotes', () => {
    expect(csvEscape('say "hello"')).toBe('"say ""hello"""');
  });

  it('values with newlines are quoted', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('plain values without special characters are not quoted', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape('2026-01-01')).toBe('2026-01-01');
  });

  it('multiple rows are separated by CRLF', () => {
    const rows = [
      { id: 1, typeName: 'A', clientName: 'X', clientEmail: '', date: '2026-01-01', time: '09:00', durationMinutes: 30, location: 'office', status: 'confirmed', notes: null, source: 'owner', createdAt: null },
      { id: 2, typeName: 'B', clientName: 'Y', clientEmail: '', date: '2026-01-02', time: '10:00', durationMinutes: 30, location: 'office', status: 'confirmed', notes: null, source: 'owner', createdAt: null }
    ];
    const csv = buildCsvLines(rows);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 data rows
  });

  it('client name with special characters is preserved', () => {
    const row = {
      id: 4, typeName: 'Type', clientName: 'O\'Brien, Jane', clientEmail: 'jane@ob.com',
      date: '2026-04-01', time: '09:00', durationMinutes: 30, location: 'office',
      status: 'confirmed', notes: null, source: 'owner', createdAt: null
    };
    const csv = buildCsvLines([row]);
    // O'Brien, Jane has a comma so must be quoted
    expect(csv).toContain('"O\'Brien, Jane"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Filtered export metadata helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('Filtered export metadata helpers', () => {
  it('buildFilteredExportFilename creates stable slug+date name', () => {
    const fixedNow = new Date('2026-07-04T12:34:56.000Z');
    expect(appModule.buildFilteredExportFilename('my-shop', fixedNow)).toBe('my-shop-export-2026-07-04');
    expect(appModule.buildFilteredExportFilename('', fixedNow)).toBe('business-export-2026-07-04');
  });

  it('buildFilteredExportJsonPayload includes filters, count, and exportedAt', () => {
    const fixedNow = new Date('2026-07-04T12:34:56.000Z');
    const rows = [{ id: 1, clientName: 'Alice' }];
    const payload = appModule.buildFilteredExportJsonPayload(
      rows,
      { from: '2026-07-01', to: '2026-07-31', status: 'confirmed', typeIds: [11, 12] },
      fixedNow
    );

    expect(payload.exportedAt).toBe('2026-07-04T12:34:56.000Z');
    expect(payload.count).toBe(1);
    expect(payload.appointments).toEqual(rows);
    expect(payload.filters).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
      status: 'confirmed',
      typeIds: [11, 12]
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. extractSwatchColour helper logic
// ─────────────────────────────────────────────────────────────────────────────

describe('extractSwatchColour', () => {
  // Replicate the logic from app.js
  function extractSwatchColour(colorStr) {
    if (!colorStr) return 'var(--text-muted)';
    const hexMatch = colorStr.match(/#[0-9a-fA-F]{3,6}/);
    if (hexMatch) return hexMatch[0];
    const rgbMatch = colorStr.match(/rgba?\([^)]+\)/);
    if (rgbMatch) return rgbMatch[0];
    return colorStr;
  }

  it('extracts first hex from a CSS gradient', () => {
    const grad = 'linear-gradient(135deg, #e2a84b 0%, #c4863a 100%)';
    expect(extractSwatchColour(grad)).toBe('#e2a84b');
  });

  it('extracts hex from a plain hex string', () => {
    expect(extractSwatchColour('#ff0000')).toBe('#ff0000');
    expect(extractSwatchColour('#abc')).toBe('#abc');
  });

  it('extracts rgb() from a gradient', () => {
    const grad = 'linear-gradient(135deg, rgb(100, 150, 200), rgb(50, 80, 120))';
    expect(extractSwatchColour(grad)).toBe('rgb(100, 150, 200)');
  });

  it('extracts rgba() from a gradient', () => {
    const grad = 'radial-gradient(ellipse, rgba(255, 0, 0, 0.5), transparent)';
    expect(extractSwatchColour(grad)).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('returns fallback var for null input', () => {
    expect(extractSwatchColour(null)).toBe('var(--text-muted)');
    expect(extractSwatchColour('')).toBe('var(--text-muted)');
    expect(extractSwatchColour(undefined)).toBe('var(--text-muted)');
  });

  it('returns the string itself when no hex or rgb pattern matches', () => {
    expect(extractSwatchColour('goldenrod')).toBe('goldenrod');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. index.html structure — three-section settings layout
// ─────────────────────────────────────────────────────────────────────────────

describe('index.html — settings page structure', () => {
  let dom;
  let document;

  beforeAll(() => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    dom = new JSDOM(html);
    document = dom.window.document;
  });

  it('settings section uses data-view="settings"', () => {
    const section = document.querySelector('[data-view="settings"]');
    expect(section).not.toBeNull();
  });

  it('settings page uses .settings-page wrapper', () => {
    const wrapper = document.querySelector('[data-view="settings"] .settings-page');
    expect(wrapper).not.toBeNull();
  });

  it('has exactly three .settings-section cards', () => {
    const sections = document.querySelectorAll('[data-view="settings"] .settings-section');
    expect(sections.length).toBe(3);
  });

  it('each .settings-section has a .settings-section-header', () => {
    const sections = document.querySelectorAll('[data-view="settings"] .settings-section');
    sections.forEach((sec) => {
      expect(sec.querySelector('.settings-section-header')).not.toBeNull();
    });
  });

  it('each .settings-section-header has an icon and a title', () => {
    const headers = document.querySelectorAll('[data-view="settings"] .settings-section-header');
    headers.forEach((h) => {
      expect(h.querySelector('.settings-section-icon')).not.toBeNull();
      expect(h.querySelector('.settings-section-title')).not.toBeNull();
      expect(h.querySelector('.settings-section-title h2')).not.toBeNull();
    });
  });

  // ── Section 1: Business Profile ──────────────────────────────────────────

  it('Business Profile section contains settings-form', () => {
    expect(document.getElementById('settings-form')).not.toBeNull();
  });

  it('Business Profile form has businessName, ownerEmail, timezone, and business-hours fields', () => {
    const form = document.getElementById('settings-form');
    expect(form.querySelector('[name="businessName"]')).not.toBeNull();
    expect(form.querySelector('[name="ownerEmail"]')).not.toBeNull();
    expect(form.querySelector('[name="timezone"]')).not.toBeNull();
    expect(form.querySelector('[name="openTime"]')).not.toBeNull();
    expect(form.querySelector('[name="closeTime"]')).not.toBeNull();
  });

  it('timezone autocomplete container is present', () => {
    expect(document.getElementById('timezone-suggestions')).not.toBeNull();
  });

  it('Business Profile section has a submit button', () => {
    const form = document.getElementById('settings-form');
    const submit = form.querySelector('button[type="submit"]');
    expect(submit).not.toBeNull();
  });

  // ── Section 2: Appearance ──────────────────────────────────────────────

  it('Appearance section has dark theme radio input', () => {
    expect(document.getElementById('settings-theme-dark')).not.toBeNull();
    const radio = document.getElementById('settings-theme-dark');
    expect(radio.getAttribute('type')).toBe('radio');
    expect(radio.getAttribute('value')).toBe('dark');
  });

  it('Appearance section has light theme radio input', () => {
    expect(document.getElementById('settings-theme-light')).not.toBeNull();
    const radio = document.getElementById('settings-theme-light');
    expect(radio.getAttribute('type')).toBe('radio');
    expect(radio.getAttribute('value')).toBe('light');
  });

  it('theme radios share the same name attribute (settings-theme)', () => {
    const dark  = document.getElementById('settings-theme-dark');
    const light = document.getElementById('settings-theme-light');
    expect(dark.getAttribute('name')).toBe('settings-theme');
    expect(light.getAttribute('name')).toBe('settings-theme');
  });

  it('dark theme option label has id theme-option-dark', () => {
    expect(document.getElementById('theme-option-dark')).not.toBeNull();
  });

  it('light theme option label has id theme-option-light', () => {
    expect(document.getElementById('theme-option-light')).not.toBeNull();
  });

  it('theme selector uses radiogroup role', () => {
    const selector = document.querySelector('.theme-selector');
    expect(selector).not.toBeNull();
    expect(selector.getAttribute('role')).toBe('radiogroup');
  });

  it('calendar client-names toggle is present', () => {
    const toggle = document.getElementById('settings-calendar-show-client-names');
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('type')).toBe('checkbox');
  });

  it('calendar toggle is wrapped in a .toggle-switch', () => {
    const toggle = document.getElementById('settings-calendar-show-client-names');
    expect(toggle.closest('.toggle-switch')).not.toBeNull();
  });

  // ── Section 3: Data & Exports ──────────────────────────────────────────

  it('export date-from input is present and is type date', () => {
    const el = document.getElementById('export-date-from');
    expect(el).not.toBeNull();
    expect(el.getAttribute('type')).toBe('date');
  });

  it('export date-to input is present and is type date', () => {
    const el = document.getElementById('export-date-to');
    expect(el).not.toBeNull();
    expect(el.getAttribute('type')).toBe('date');
  });

  it('export types grid container is present', () => {
    expect(document.getElementById('export-types-grid')).not.toBeNull();
  });

  it('export types select-all and select-none buttons are present', () => {
    expect(document.getElementById('export-types-select-all')).not.toBeNull();
    expect(document.getElementById('export-types-select-none')).not.toBeNull();
  });

  it('status filter select has correct options', () => {
    const sel = document.getElementById('export-status-filter');
    expect(sel).not.toBeNull();
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toContain('');
    expect(values).toContain('confirmed');
    expect(values).toContain('completed');
    expect(values).toContain('pending');
    expect(values).toContain('cancelled');
  });

  it('format toggle buttons are present with correct data-format attributes', () => {
    const btns = document.querySelectorAll('.format-toggle-btn');
    expect(btns.length).toBe(2);
    const formats = Array.from(btns).map((b) => b.dataset.format);
    expect(formats).toContain('json');
    expect(formats).toContain('csv');
  });

  it('JSON format button is active by default', () => {
    const jsonBtn = document.querySelector('.format-toggle-btn[data-format="json"]');
    expect(jsonBtn.classList.contains('active')).toBe(true);
  });

  it('export summary text element is present', () => {
    expect(document.getElementById('export-summary')).not.toBeNull();
  });

  it('filtered export download button is present', () => {
    expect(document.getElementById('btn-export-filtered')).not.toBeNull();
  });

  it('full backup export button is present', () => {
    expect(document.getElementById('btn-export-data')).not.toBeNull();
  });

  it('load backup button is present', () => {
    expect(document.getElementById('btn-import-data')).not.toBeNull();
  });

  it('customer booking link is present with data-public-booking-link', () => {
    const link = document.getElementById('btn-public-booking-settings');
    expect(link).not.toBeNull();
    expect(link.hasAttribute('data-public-booking-link')).toBe(true);
  });

  it('hidden file input for backup restore is present', () => {
    const input = document.getElementById('import-data-file');
    expect(input).not.toBeNull();
    expect(input.getAttribute('type')).toBe('file');
    expect(input.hasAttribute('hidden')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. app.js exported helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('app.js exported helpers', () => {
  it('exports toTime12', () => {
    expect(typeof appModule.toTime12).toBe('function');
  });

  it('exports escapeHtml', () => {
    expect(typeof appModule.escapeHtml).toBe('function');
  });

  it('exports monthLabel', () => {
    expect(typeof appModule.monthLabel).toBe('function');
  });

  it('exports setActiveView', () => {
    expect(typeof appModule.setActiveView).toBe('function');
  });

  it('exports state object', () => {
    expect(typeof appModule.state).toBe('object');
    expect(appModule.state).not.toBeNull();
  });

  it('state has types array', () => {
    expect(Array.isArray(appModule.state.types)).toBe(true);
  });

  it('exports export-filter helpers', () => {
    expect(typeof appModule.filterAppointmentsForExport).toBe('function');
    expect(typeof appModule.buildFilteredExportFilename).toBe('function');
    expect(typeof appModule.buildFilteredExportJsonPayload).toBe('function');
  });

  it('exports CSV helpers and constants', () => {
    expect(typeof appModule.csvEscape).toBe('function');
    expect(typeof appModule.buildCsvLines).toBe('function');
    expect(Array.isArray(appModule.EXPORT_CSV_COLUMNS)).toBe(true);
    expect(Array.isArray(appModule.EXPORT_CSV_HEADERS)).toBe(true);
  });

  it('escapeHtml handles all injection vectors', () => {
    const { escapeHtml } = appModule;
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    // The implementation encodes apostrophes as &#039;
    expect(escapeHtml("it's")).toBe('it&#039;s');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. CSS partial — settings.css exists and contains expected rules
// ─────────────────────────────────────────────────────────────────────────────

describe('css/settings.css', () => {
  let css;

  beforeAll(() => {
    css = fs.readFileSync(path.join(__dirname, '..', 'css', 'settings.css'), 'utf8');
  });

  it('file exists and is non-empty', () => {
    expect(css.length).toBeGreaterThan(100);
  });

  const expectedSelectors = [
    '.settings-page',
    '.settings-section',
    '.settings-section-header',
    '.settings-section-icon',
    '.settings-section-title',
    '.settings-section-body',
    '.settings-section-actions',
    '.toggle-switch',
    '.toggle-switch-track',
    '.toggle-switch-thumb',
    '.theme-selector',
    '.theme-option',
    '.theme-preview',
    '.export-panel',
    '.export-panel-header',
    '.export-panel-body',
    '.export-panel-footer',
    '.export-date-row',
    '.export-types-grid',
    '.export-type-chip',
    '.export-type-swatch',
    '.export-type-name',
    '.format-toggle',
    '.format-toggle-btn',
    '.settings-utility-list',
    '.settings-utility-item',
  ];

  expectedSelectors.forEach((selector) => {
    it(`contains rule for ${selector}`, () => {
      expect(css).toContain(selector);
    });
  });

  it('uses CSS custom properties (var(--...))', () => {
    expect(css).toContain('var(--');
  });

  it('includes responsive breakpoint for mobile', () => {
    expect(css).toContain('@media');
    expect(css).toContain('600px');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. styles.css — imports settings.css
// ─────────────────────────────────────────────────────────────────────────────

describe('styles.css', () => {
  let styles;

  beforeAll(() => {
    styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  });

  it("imports 'css/settings.css'", () => {
    expect(styles).toContain("@import url('css/settings.css')");
  });

  it('imports settings.css before responsive.css', () => {
    const settingsPos    = styles.indexOf("@import url('css/settings.css')");
    const responsivePos  = styles.indexOf("@import url('css/responsive.css')");
    expect(settingsPos).toBeGreaterThan(-1);
    expect(responsivePos).toBeGreaterThan(-1);
    expect(settingsPos).toBeLessThan(responsivePos);
  });
});
