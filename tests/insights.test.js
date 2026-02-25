const path = require('path');
const fs = require('fs');

const testDbDir = path.join(__dirname, '.tmp-insights');
const testDbPath = path.join(testDbDir, 'insights-unit.db');

let sqlite;
let createInsights;
let nextBusinessId = 5000;

function makeBusiness(id, { open = '09:00', close = '17:00', timezone = 'America/Los_Angeles' } = {}) {
  sqlite.prepare('INSERT INTO businesses (id, name, slug, owner_email, timezone) VALUES (?, ?, ?, ?, ?)')
    .run(id, `Biz ${id}`, `biz-${id}`, `owner-${id}@example.com`, timezone);
  sqlite.prepare(
    `INSERT INTO business_settings
      (business_id, business_name, owner_email, timezone, notify_owner_email, open_time, close_time, business_hours_json)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(id, `Biz ${id}`, `owner-${id}@example.com`, timezone, open, close, null);
}

function addAppt({
  businessId,
  date,
  time,
  duration = 45,
  status = 'confirmed',
  source = 'owner',
  title = 'Consultation'
}) {
  sqlite.prepare(
    `INSERT INTO appointments
      (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'office', NULL, ?, ?)`
  ).run(
    businessId,
    title,
    `${title} Client`,
    `${businessId}-${date}-${time}@example.com`,
    date,
    time,
    duration,
    status,
    source
  );
}

describe('createInsights (integration with sqlite)', () => {
  beforeAll(async () => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    process.env.DB_PATH = testDbPath;
    process.env.DATABASE_URL = '';
    process.env.NODE_ENV = 'test';

    const dbModule = require('../src/lib/db');
    await dbModule.initDb();
    sqlite = dbModule.sqlite();
    ({ createInsights } = require('../src/lib/insights'));
  });

  it('detects upward booking momentum', async () => {
    const businessId = nextBusinessId++;
    makeBusiness(businessId);

    ['2026-01-28', '2026-02-01', '2026-02-05'].forEach((date) => {
      addAppt({ businessId, date, time: '10:00' });
    });
    ['2026-02-10', '2026-02-11', '2026-02-12', '2026-02-13', '2026-02-14', '2026-02-15'].forEach((date) => {
      addAppt({ businessId, date, time: '11:00' });
      addAppt({ businessId, date, time: '12:00' });
    });

    const insights = await createInsights('2026-02-23', businessId);
    expect(insights.some((i) => String(i.text).includes('Booking velocity is up'))).toBe(true);
  });

  it('calculates utilization and largest day gap', async () => {
    const businessId = nextBusinessId++;
    makeBusiness(businessId, { open: '09:00', close: '17:00' });

    addAppt({ businessId, date: '2026-02-23', time: '10:00', duration: 60 });
    addAppt({ businessId, date: '2026-02-23', time: '13:00', duration: 60 });
    addAppt({ businessId, date: '2026-02-22', time: '09:30', duration: 45, title: 'Review' });

    const insights = await createInsights('2026-02-23', businessId);
    expect(insights.some((i) => String(i.text).includes('is 25% utilized'))).toBe(true);
    expect(insights.some((i) => String(i.text).includes('There is a 180-minute gap'))).toBe(true);
  });

  it('includes reminder mix insight when reminders are a large share', async () => {
    const businessId = nextBusinessId++;
    makeBusiness(businessId);

    const rows = [
      { date: '2026-02-23', source: 'reminder', title: 'Call Back' },
      { date: '2026-02-22', source: 'reminder', title: 'Follow-up' },
      { date: '2026-02-21', source: 'reminder', title: 'Invoice Ping' },
      { date: '2026-02-20', source: 'reminder', title: 'Reminder Note' },
      { date: '2026-02-19', source: 'owner', title: 'Consultation' },
      { date: '2026-02-18', source: 'owner', title: 'Review' },
      { date: '2026-02-17', source: 'owner', title: 'Planning' },
      { date: '2026-02-16', source: 'owner', title: 'Intro Call' }
    ];
    rows.forEach((row) => addAppt({
      businessId,
      date: row.date,
      time: '09:00',
      duration: 30,
      source: row.source,
      title: row.title
    }));

    const insights = await createInsights('2026-02-23', businessId);
    expect(insights.some((i) => String(i.text).includes('active items are reminders'))).toBe(true);
  });
});
