const fs = require('fs');
const path = require('path');

describe('DB hardening', () => {
  it('enables SQLite foreign key enforcement during initialization', async () => {
    const testDbDir = path.join(__dirname, '.tmp-db');
    const testDbPath = path.join(testDbDir, 'db-hardening.db');
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    process.env.DB_PATH = testDbPath;
    process.env.DATABASE_URL = '';
    process.env.NODE_ENV = 'test';

    const modulePath = require.resolve('../src/lib/db');
    delete require.cache[modulePath];
    const dbModule = require('../src/lib/db');
    await dbModule.initDb();

    const pragmaValue = dbModule.sqlite().pragma('foreign_keys', { simple: true });
    expect(pragmaValue).toBe(1);
  });

  it('defines additive Postgres constraints and composite indexes for tenant safety', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'db.js'), 'utf8');

    [
      'ux_appointment_types_business_id_id',
      'ux_clients_business_id_id',
      'fk_appointment_types_business',
      'fk_appointments_business',
      'fk_appointments_business_type',
      'fk_appointments_business_client',
      'chk_appointment_types_location_mode',
      'chk_appointments_status',
      'chk_appointments_source',
      'chk_appointments_duration_minutes',
      'chk_appointments_reminder_offset_minutes',
      'chk_clients_stage',
      'chk_business_settings_workspace_mode'
    ].forEach((name) => expect(source.includes(name)).toBe(true));

    expect(source.includes("sqlite.pragma('foreign_keys = ON')")).toBe(true);
    expect(source.includes("PRAGMA foreign_key_check")).toBe(true);
  });
});
