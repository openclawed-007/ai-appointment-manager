'use strict';

const { USE_POSTGRES, sqlite: getSqlite, pgPool: getPgPool, dbAll, getBusinessById, getSettings } = require('./db');

function normalizeBackupPayload(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid backup payload.');
  const appointmentTypes = Array.isArray(input.appointmentTypes) ? input.appointmentTypes : [];
  const appointments = Array.isArray(input.appointments) ? input.appointments : [];
  return {
    business: input.business && typeof input.business === 'object' ? input.business : {},
    settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
    appointmentTypes,
    appointments
  };
}

async function exportBusinessData(businessId) {
  const business = await getBusinessById(businessId);
  const settings = await getSettings(businessId);
  const types = await dbAll(
    `SELECT id, name, duration_minutes, price_cents, location_mode, color, active, created_at
     FROM appointment_types
     WHERE business_id = ?
     ORDER BY id ASC`,
    `SELECT id, name, duration_minutes, price_cents, location_mode, color, active, created_at
     FROM appointment_types
     WHERE business_id = $1
     ORDER BY id ASC`,
    [Number(businessId)]
  );
  const appointments = await dbAll(
    `SELECT id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source, created_at
     FROM appointments
     WHERE business_id = ?
     ORDER BY date ASC, time ASC, id ASC`,
    `SELECT id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source, created_at
     FROM appointments
     WHERE business_id = $1
     ORDER BY date ASC, time ASC, id ASC`,
    [Number(businessId)]
  );

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    business: business
      ? {
        id: Number(business.id),
        name: business.name,
        slug: business.slug,
        owner_email: business.owner_email || null,
        timezone: business.timezone || null
      }
      : null,
    settings: settings
      ? {
        business_name: settings.business_name || '',
        owner_email: settings.owner_email || null,
        timezone: settings.timezone || 'America/Los_Angeles'
      }
      : null,
    appointmentTypes: types.map((t) => ({
      id: Number(t.id),
      name: t.name,
      duration_minutes: Number(t.duration_minutes || 45),
      price_cents: Number(t.price_cents || 0),
      location_mode: t.location_mode || 'hybrid',
      color: t.color || null,
      active: t.active === true || t.active === 1,
      created_at: t.created_at || null
    })),
    appointments: appointments.map((a) => ({
      id: Number(a.id),
      type_id: a.type_id == null ? null : Number(a.type_id),
      title: a.title || null,
      client_name: a.client_name,
      client_email: a.client_email || null,
      date: typeof a.date === 'string' ? a.date.slice(0, 10) : a.date?.toISOString?.().slice(0, 10),
      time: typeof a.time === 'string' ? a.time.slice(0, 5) : '09:00',
      duration_minutes: Number(a.duration_minutes || 45),
      location: a.location || 'office',
      notes: a.notes || null,
      status: a.status || 'confirmed',
      source: a.source || 'owner',
      created_at: a.created_at || null
    }))
  };
}

async function importBusinessData(businessId, backup) {
  const payload = normalizeBackupPayload(backup);
  const mergedSettings = {
    business_name:
      String(
        payload.settings.business_name ||
        payload.business.name ||
        payload.business.business_name ||
        'IntelliBook'
      ).trim() || 'IntelliBook',
    owner_email: payload.settings.owner_email || payload.business.owner_email || null,
    timezone: payload.settings.timezone || payload.business.timezone || 'America/Los_Angeles'
  };

  if (USE_POSTGRES) {
    const tx = await getPgPool().connect();
    try {
      await tx.query('BEGIN');

      await tx.query(
        `UPDATE businesses
         SET name = $1, owner_email = $2, timezone = $3
         WHERE id = $4`,
        [mergedSettings.business_name, mergedSettings.owner_email, mergedSettings.timezone, Number(businessId)]
      );
      await tx.query(
        `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id) DO UPDATE SET
           business_name = EXCLUDED.business_name,
           owner_email = EXCLUDED.owner_email,
           timezone = EXCLUDED.timezone`,
        [Number(businessId), mergedSettings.business_name, mergedSettings.owner_email, mergedSettings.timezone]
      );

      await tx.query('DELETE FROM appointments WHERE business_id = $1', [Number(businessId)]);
      await tx.query('DELETE FROM appointment_types WHERE business_id = $1', [Number(businessId)]);

      const typeIdMap = new Map();
      for (const t of payload.appointmentTypes) {
        const inserted = await tx.query(
          `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            Number(businessId),
            String(t.name || 'General').trim() || 'General',
            Number(t.duration_minutes || 45),
            Number(t.price_cents || 0),
            String(t.location_mode || 'hybrid'),
            t.color || null,
            t.active == null ? true : Boolean(t.active)
          ]
        );
        typeIdMap.set(Number(t.id), Number(inserted.rows[0].id));
      }

      for (const a of payload.appointments) {
        const mappedTypeId = a.type_id == null ? null : typeIdMap.get(Number(a.type_id)) || null;
        await tx.query(
          `INSERT INTO appointments
           (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            Number(businessId),
            mappedTypeId,
            a.title || null,
            String(a.client_name || 'Client').trim() || 'Client',
            a.client_email || null,
            String(a.date || new Date().toISOString().slice(0, 10)),
            String(a.time || '09:00').slice(0, 5),
            Number(a.duration_minutes || 45),
            String(a.location || 'office'),
            a.notes || null,
            String(a.status || 'confirmed'),
            String(a.source || 'owner')
          ]
        );
      }

      await tx.query('COMMIT');
      return {
        importedTypes: payload.appointmentTypes.length,
        importedAppointments: payload.appointments.length
      };
    } catch (error) {
      try { await tx.query('ROLLBACK'); } catch { }
      throw error;
    } finally {
      tx.release();
    }
  }

  const db = getSqlite();
  const tx = db.transaction((input) => {
    db.prepare('UPDATE businesses SET name = ?, owner_email = ?, timezone = ? WHERE id = ?')
      .run(input.settings.business_name, input.settings.owner_email, input.settings.timezone, Number(input.businessId));
    db.prepare(
      `INSERT INTO business_settings (business_id, business_name, owner_email, timezone)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(business_id) DO UPDATE SET
         business_name = excluded.business_name,
         owner_email = excluded.owner_email,
         timezone = excluded.timezone`
    ).run(Number(input.businessId), input.settings.business_name, input.settings.owner_email, input.settings.timezone);

    db.prepare('DELETE FROM appointments WHERE business_id = ?').run(Number(input.businessId));
    db.prepare('DELETE FROM appointment_types WHERE business_id = ?').run(Number(input.businessId));

    const typeIdMap = new Map();
    const insertType = db.prepare(
      `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of input.payload.appointmentTypes) {
      const result = insertType.run(
        Number(input.businessId),
        String(t.name || 'General').trim() || 'General',
        Number(t.duration_minutes || 45),
        Number(t.price_cents || 0),
        String(t.location_mode || 'hybrid'),
        t.color || null,
        t.active == null ? 1 : Number(Boolean(t.active))
      );
      typeIdMap.set(Number(t.id), Number(result.lastInsertRowid));
    }

    const insertAppt = db.prepare(
      `INSERT INTO appointments
       (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of input.payload.appointments) {
      const mappedTypeId = a.type_id == null ? null : typeIdMap.get(Number(a.type_id)) || null;
      insertAppt.run(
        Number(input.businessId),
        mappedTypeId,
        a.title || null,
        String(a.client_name || 'Client').trim() || 'Client',
        a.client_email || null,
        String(a.date || new Date().toISOString().slice(0, 10)),
        String(a.time || '09:00').slice(0, 5),
        Number(a.duration_minutes || 45),
        String(a.location || 'office'),
        a.notes || null,
        String(a.status || 'confirmed'),
        String(a.source || 'owner')
      );
    }

    return {
      importedTypes: input.payload.appointmentTypes.length,
      importedAppointments: input.payload.appointments.length
    };
  });

  return tx({ businessId: Number(businessId), payload, settings: mergedSettings });
}

module.exports = { exportBusinessData, importBusinessData };
