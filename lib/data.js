'use strict';

const { USE_POSTGRES, sqlite: getSqlite, pgPool: getPgPool, dbAll, getBusinessById, getSettings } = require('./db');
const { assertNoOverlap, parseTimeOrThrow, dateLockKey } = require('./appointments');

const AI_IMPORT_SCHEMA = {
  name: 'appointment_import_payload',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      appointments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            clientName: { type: 'string' },
            clientEmail: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            typeName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            date: { type: 'string' },
            time: { type: 'string' },
            durationMinutes: { type: 'number' },
            location: { type: 'string', enum: ['office', 'on-premises', 'virtual', 'phone'] },
            notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            status: { type: 'string', enum: ['pending', 'confirmed', 'completed', 'cancelled'] },
            source: { type: 'string', enum: ['owner', 'public', 'reminder'] }
          },
          required: ['clientName', 'clientEmail', 'title', 'typeName', 'date', 'time', 'durationMinutes', 'location', 'notes', 'status', 'source']
        }
      }
    },
    required: ['appointments']
  }
};

function parseBusinessHours(value) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_error) {
    return null;
  }
}

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

function normalizeAiImportPayload(input) {
  const payload = input && typeof input === 'object' ? input : {};
  return {
    fileName: String(payload.fileName || payload.filename || 'uploaded-file').trim() || 'uploaded-file',
    fileContent: String(payload.fileContent || payload.content || '')
  };
}

function extractJsonFromModelContent(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    // keep going
  }

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_error) {
      // keep going
    }
  }

  const objectStart = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const start = objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
  if (start < 0) return null;
  const candidate = raw.slice(start);
  const endChars = candidate[0] === '{' ? ['}'] : [']'];
  for (let i = candidate.length - 1; i >= 0; i -= 1) {
    if (!endChars.includes(candidate[i])) continue;
    const snippet = candidate.slice(0, i + 1);
    try {
      return JSON.parse(snippet);
    } catch (_error) {
      // keep going
    }
  }
  return null;
}

function normalizeLocation(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'office' || normalized === 'on-premises' || normalized === 'virtual' || normalized === 'phone') {
    return normalized;
  }
  return 'office';
}

function normalizeStatus(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'confirmed' || normalized === 'completed' || normalized === 'cancelled') {
    return normalized;
  }
  return 'confirmed';
}

function normalizeSource(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'owner' || normalized === 'public' || normalized === 'reminder') return normalized;
  return 'owner';
}

function clampDuration(value, fallback = 45) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 5) return 5;
  if (n > 720) return 720;
  return Math.round(n);
}

function normalizeAiAppointment(row, index) {
  const source = normalizeSource(row?.source);
  const rawName = String(row?.clientName || row?.client_name || '').trim();
  const rawTitle = String(row?.title || row?.typeName || row?.type_name || '').trim();
  const clientName = rawName || rawTitle || `Imported Appointment ${index + 1}`;
  const date = String(row?.date || '').slice(0, 10);
  const time = String(row?.time || '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { valid: false, reason: 'invalid date' };
  if (!/^\d{2}:\d{2}$/.test(time)) return { valid: false, reason: 'invalid time' };
  try {
    parseTimeOrThrow(time);
  } catch (_error) {
    return { valid: false, reason: 'invalid time' };
  }

  return {
    valid: true,
    appointment: {
      typeName: rawTitle || null,
      title: rawTitle || null,
      clientName,
      clientEmail: String(row?.clientEmail || row?.client_email || '').trim() || null,
      date,
      time,
      durationMinutes: clampDuration(row?.durationMinutes ?? row?.duration_minutes, 45),
      location: normalizeLocation(row?.location),
      notes: String(row?.notes || '').trim() || null,
      status: normalizeStatus(row?.status),
      source
    }
  };
}

async function mapTypeIdsForImport(businessId) {
  const rows = await dbAll(
    `SELECT id, name FROM appointment_types WHERE business_id = ? AND active = 1`,
    `SELECT id, name FROM appointment_types WHERE business_id = $1 AND active = TRUE`,
    [Number(businessId)]
  );
  const map = new Map();
  rows.forEach((row) => {
    const key = String(row.name || '').trim().toLowerCase();
    if (!key) return;
    map.set(key, Number(row.id));
  });
  return map;
}

async function normalizeAppointmentsWithOpenRouter({ fileName, fileContent }) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('OPENROUTER_API_KEY is not configured on the server.');
    error.statusCode = 503;
    throw error;
  }

  const truncatedContent = String(fileContent || '').slice(0, 180000);
  if (!truncatedContent.trim()) {
    const error = new Error('Uploaded file is empty.');
    error.statusCode = 400;
    throw error;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'x-ai/grok-4.1-fast',
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: AI_IMPORT_SCHEMA
      },
      messages: [
        {
          role: 'system',
          content:
            'You extract appointment rows from arbitrary files and must follow the provided JSON schema exactly. ' +
            'Infer missing fields conservatively. Return only valid structured data.'
        },
        {
          role: 'user',
          content:
            `Convert this appointment file into the required JSON schema.\n` +
            `Filename: ${fileName}\n\n` +
            `${truncatedContent}`
        }
      ]
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || `OpenRouter request failed (${response.status})`);
    error.statusCode = 502;
    throw error;
  }

  const parsedFromSchema = body?.choices?.[0]?.message?.parsed;
  const content = body?.choices?.[0]?.message?.content || '';
  const parsed = parsedFromSchema || extractJsonFromModelContent(content);
  const appts = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.appointments) ? parsed.appointments : [];
  if (!appts.length) {
    const error = new Error('AI could not parse appointments from this file.');
    error.statusCode = 400;
    throw error;
  }
  return appts;
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
        timezone: settings.timezone || 'America/Los_Angeles',
        open_time: String(settings.open_time || '09:00').slice(0, 5),
        close_time: String(settings.close_time || '18:00').slice(0, 5),
        business_hours: parseBusinessHours(settings.business_hours_json)
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
    timezone: payload.settings.timezone || payload.business.timezone || 'America/Los_Angeles',
    open_time: String(payload.settings.open_time || '09:00').slice(0, 5),
    close_time: String(payload.settings.close_time || '18:00').slice(0, 5),
    business_hours_json: payload.settings.business_hours || payload.settings.businessHours
      ? JSON.stringify(payload.settings.business_hours || payload.settings.businessHours)
      : null
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
        `INSERT INTO business_settings (business_id, business_name, owner_email, timezone, open_time, close_time, business_hours_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (business_id) DO UPDATE SET
           business_name = EXCLUDED.business_name,
           owner_email = EXCLUDED.owner_email,
           timezone = EXCLUDED.timezone,
           open_time = EXCLUDED.open_time,
           close_time = EXCLUDED.close_time,
           business_hours_json = COALESCE(EXCLUDED.business_hours_json, business_settings.business_hours_json)`,
        [
          Number(businessId),
          mergedSettings.business_name,
          mergedSettings.owner_email,
          mergedSettings.timezone,
          mergedSettings.open_time,
          mergedSettings.close_time,
          mergedSettings.business_hours_json
        ]
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
      `INSERT INTO business_settings (business_id, business_name, owner_email, timezone, open_time, close_time, business_hours_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id) DO UPDATE SET
         business_name = excluded.business_name,
         owner_email = excluded.owner_email,
         timezone = excluded.timezone,
         open_time = excluded.open_time,
         close_time = excluded.close_time,
         business_hours_json = COALESCE(excluded.business_hours_json, business_settings.business_hours_json)`
    ).run(
      Number(input.businessId),
      input.settings.business_name,
      input.settings.owner_email,
      input.settings.timezone,
      String(input.settings.open_time || '09:00').slice(0, 5),
      String(input.settings.close_time || '18:00').slice(0, 5),
      input.settings.business_hours_json || null
    );

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

async function importAiAppointments(businessId, input) {
  const scopedBusinessId = Number(businessId);
  const payload = normalizeAiImportPayload(input);
  const typeNameToId = await mapTypeIdsForImport(scopedBusinessId);
  const rawRows = await normalizeAppointmentsWithOpenRouter(payload);

  const prepared = [];
  const skippedInvalid = [];
  rawRows.forEach((row, index) => {
    const normalized = normalizeAiAppointment(row, index);
    if (!normalized.valid) {
      skippedInvalid.push({ index, reason: normalized.reason });
      return;
    }
    const appt = normalized.appointment;
    const typeId = appt.typeName ? (typeNameToId.get(String(appt.typeName).toLowerCase()) || null) : null;
    prepared.push({ ...appt, typeId });
  });

  let importedAppointments = 0;
  let skippedOverlaps = 0;
  const skippedOverlapRows = [];

  if (USE_POSTGRES) {
    const tx = await getPgPool().connect();
    try {
      await tx.query('BEGIN');
      const lockedDates = new Set();
      for (const row of prepared) {
        if (!lockedDates.has(row.date)) {
          await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [scopedBusinessId, dateLockKey(row.date)]);
          lockedDates.add(row.date);
        }

        const shouldCheckOverlap = row.status !== 'cancelled';
        if (shouldCheckOverlap) {
          try {
            await assertNoOverlap({
              businessId: scopedBusinessId,
              date: row.date,
              startMinutes: parseTimeOrThrow(row.time),
              durationMinutes: row.durationMinutes,
              pgClient: tx
            });
          } catch (_error) {
            skippedOverlaps += 1;
            skippedOverlapRows.push({ date: row.date, time: row.time, clientName: row.clientName });
            continue;
          }
        }

        await tx.query(
          `INSERT INTO appointments
           (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            scopedBusinessId,
            row.typeId,
            row.title || row.typeName || null,
            row.clientName,
            row.clientEmail,
            row.date,
            row.time,
            row.durationMinutes,
            row.location,
            row.notes,
            row.status,
            row.source
          ]
        );
        importedAppointments += 1;
      }
      await tx.query('COMMIT');
    } catch (error) {
      try { await tx.query('ROLLBACK'); } catch { }
      throw error;
    } finally {
      tx.release();
    }
  } else {
    const db = getSqlite();
    const insert = db.prepare(
      `INSERT INTO appointments
       (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const selectDay = db.prepare(
      `SELECT time, duration_minutes
       FROM appointments
       WHERE business_id = ? AND date = ? AND status != 'cancelled'
       ORDER BY time ASC`
    );
    const tx = db.transaction((rows) => {
      for (const row of rows) {
        const shouldCheckOverlap = row.status !== 'cancelled';
        if (shouldCheckOverlap) {
          try {
            const startMinutes = parseTimeOrThrow(row.time);
            const endMinutes = startMinutes + row.durationMinutes;
            const blockers = selectDay.all(scopedBusinessId, row.date);
            const overlaps = blockers.some((blocker) => {
              const otherStart = parseTimeOrThrow(String(blocker.time || '09:00').slice(0, 5));
              const otherEnd = otherStart + Number(blocker.duration_minutes || 45);
              return startMinutes < otherEnd && endMinutes > otherStart;
            });
            if (overlaps) throw new Error('overlap');
          } catch (_error) {
            skippedOverlaps += 1;
            skippedOverlapRows.push({ date: row.date, time: row.time, clientName: row.clientName });
            continue;
          }
        }
        insert.run(
          scopedBusinessId,
          row.typeId,
          row.title || row.typeName || null,
          row.clientName,
          row.clientEmail,
          row.date,
          row.time,
          row.durationMinutes,
          row.location,
          row.notes,
          row.status,
          row.source
        );
        importedAppointments += 1;
      }
    });
    tx(prepared);
  }

  return {
    importedAppointments,
    totalDetected: rawRows.length,
    totalValid: prepared.length,
    skippedOverlaps,
    skippedInvalid: skippedInvalid.length,
    overlapSamples: skippedOverlapRows.slice(0, 10),
    invalidSamples: skippedInvalid.slice(0, 10),
    model: 'x-ai/grok-4.1-fast'
  };
}

module.exports = { exportBusinessData, importBusinessData, importAiAppointments };
