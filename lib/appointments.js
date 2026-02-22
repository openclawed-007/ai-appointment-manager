'use strict';

const { USE_POSTGRES, sqlite: getSqlite, pgPool: getPgPool, dbGet, dbAll, rowToAppointment, getSettings } = require('./db');
const { fmtTime, sendEmail, buildBrandedEmailHtml } = require('./email');

function parseTimeOrThrow(timeValue) {
  const match = String(timeValue || '').match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw new Error('time must be in HH:MM format');
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseTimeToMinutes(timeValue = '09:00') {
  const [h, m] = String(timeValue).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 9 * 60;
}

function humanTime(minutesFromMidnight = 540) {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return fmtTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

const PUBLIC_SLOT_INTERVAL_MINUTES = 15;
const DEFAULT_PUBLIC_BOOKING_OPEN_TIME = '09:00';
const DEFAULT_PUBLIC_BOOKING_CLOSE_TIME = '18:00';

function minutesToTimeString(minutesFromMidnight = 540) {
  const safeMinutes = Math.max(0, Number(minutesFromMidnight) || 0);
  const h = Math.floor(safeMinutes / 60);
  const m = safeMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dateLockKey(dateValue = '') {
  const normalized = String(dateValue || '').replace(/-/g, '');
  const key = Number.parseInt(normalized, 10);
  if (!Number.isFinite(key)) throw new Error('date must be in YYYY-MM-DD format');
  return key;
}

async function assertNoOverlap({ businessId, date, startMinutes, durationMinutes, excludeId = null, pgClient = null }) {
  const rows = USE_POSTGRES && pgClient
    ? (
      await pgClient.query(
        `SELECT id, time, duration_minutes
         FROM appointments
         WHERE business_id = $1 AND date = $2 AND status != 'cancelled'
         ORDER BY time ASC`,
        [Number(businessId), String(date)]
      )
    ).rows
    : await dbAll(
      `SELECT id, time, duration_minutes
       FROM appointments
       WHERE business_id = ? AND date = ? AND status != 'cancelled'
       ORDER BY time ASC`,
      `SELECT id, time, duration_minutes
       FROM appointments
       WHERE business_id = $1 AND date = $2 AND status != 'cancelled'
       ORDER BY time ASC`,
      [Number(businessId), String(date)]
    );

  const endMinutes = startMinutes + durationMinutes;
  const blocker = rows.find((row) => {
    if (excludeId != null && Number(row.id) === Number(excludeId)) return false;
    const otherStart = parseTimeToMinutes(row.time);
    const otherEnd = otherStart + Number(row.duration_minutes || 45);
    return startMinutes < otherEnd && endMinutes > otherStart;
  });

  if (blocker) {
    const otherStart = parseTimeToMinutes(blocker.time);
    const otherEnd = otherStart + Number(blocker.duration_minutes || 45);
    throw new Error(`Time overlaps with another appointment (${humanTime(otherStart)}-${humanTime(otherEnd)}).`);
  }
}

async function getAvailableSlots({ businessId, date, durationMinutes, openTime = DEFAULT_PUBLIC_BOOKING_OPEN_TIME, closeTime = DEFAULT_PUBLIC_BOOKING_CLOSE_TIME }) {
  const scopedBusinessId = Number(businessId);
  if (!Number.isFinite(scopedBusinessId) || scopedBusinessId <= 0) throw new Error('businessId is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('date must be in YYYY-MM-DD format');

  const requestedDuration = Number(durationMinutes || 45);
  if (!Number.isFinite(requestedDuration) || requestedDuration <= 0) {
    throw new Error('durationMinutes must be greater than 0');
  }
  const windowStartMinutes = parseTimeOrThrow(openTime);
  const windowEndMinutes = parseTimeOrThrow(closeTime);
  if (windowEndMinutes <= windowStartMinutes) {
    throw new Error('closeTime must be later than openTime');
  }

  const rows = await dbAll(
    `SELECT id, time, duration_minutes
     FROM appointments
     WHERE business_id = ? AND date = ? AND status != 'cancelled'
     ORDER BY time ASC`,
    `SELECT id, time, duration_minutes
     FROM appointments
     WHERE business_id = $1 AND date = $2 AND status != 'cancelled'
     ORDER BY time ASC`,
    [scopedBusinessId, String(date)]
  );

  const blockers = rows.map((row) => {
    const start = parseTimeToMinutes(row.time);
    const duration = Number(row.duration_minutes || 45);
    return {
      start,
      end: start + duration
    };
  });

  const lastStart = windowEndMinutes - requestedDuration;
  const slots = [];
  for (
    let slotStart = windowStartMinutes;
    slotStart <= lastStart;
    slotStart += PUBLIC_SLOT_INTERVAL_MINUTES
  ) {
    const slotEnd = slotStart + requestedDuration;
    const overlaps = blockers.some((b) => slotStart < b.end && slotEnd > b.start);
    if (!overlaps) slots.push(minutesToTimeString(slotStart));
  }

  return slots;
}

async function createAppointment(payload = {}) {
  const {
    businessId,
    typeId,
    title,
    clientName,
    clientEmail,
    date,
    time,
    durationMinutes,
    location,
    notes,
    source
  } = payload;

  if (!clientName?.trim()) throw new Error('clientName is required');
  if (String(clientName).trim().length > 200) throw new Error('clientName is too long (max 200 characters)');
  if (clientEmail && String(clientEmail).length > 320) throw new Error('clientEmail is too long');
  if (notes && String(notes).length > 5000) throw new Error('notes is too long (max 5000 characters)');
  if (title && String(title).length > 500) throw new Error('title is too long (max 500 characters)');

  const scopedBusinessId = Number(businessId);
  if (!Number.isFinite(scopedBusinessId) || scopedBusinessId <= 0) throw new Error('businessId is required');
  if (!date) throw new Error('date is required');
  if (!time) throw new Error('time is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date must be in YYYY-MM-DD format');

  const type = typeId
    ? await dbGet(
      'SELECT * FROM appointment_types WHERE id = ? AND business_id = ? AND active = 1',
      'SELECT * FROM appointment_types WHERE id = $1 AND business_id = $2 AND active = TRUE',
      [Number(typeId), scopedBusinessId]
    )
    : null;

  const resolvedDuration = Number(durationMinutes || type?.duration_minutes || 45);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    throw new Error('durationMinutes must be greater than 0');
  }
  const startMinutes = parseTimeOrThrow(time);

  const params = [
    scopedBusinessId,
    type?.id || null,
    title || type?.name || 'Appointment',
    clientName.trim(),
    clientEmail || null,
    date,
    time,
    resolvedDuration,
    location || type?.location_mode || 'office',
    notes || null
  ];

  const resolvedStatus = (source === 'public') ? 'pending' : 'confirmed';
  const resolvedSource = source || 'owner';

  let id;
  if (USE_POSTGRES) {
    const tx = await getPgPool().connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [scopedBusinessId, dateLockKey(date)]);
      await assertNoOverlap({
        businessId: scopedBusinessId,
        date: String(date),
        startMinutes,
        durationMinutes: resolvedDuration,
        pgClient: tx
      });
      const insert = await tx.query(
        `INSERT INTO appointments
         (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [...params, resolvedStatus, resolvedSource]
      );
      id = insert.rows[0].id;
      await tx.query('COMMIT');
    } catch (error) {
      try { await tx.query('ROLLBACK'); } catch { }
      throw error;
    } finally {
      tx.release();
    }
  } else {
    await assertNoOverlap({
      businessId: scopedBusinessId,
      date: String(date),
      startMinutes,
      durationMinutes: resolvedDuration
    });
    const result = getSqlite()
      .prepare(
        `INSERT INTO appointments
         (business_id, type_id, title, client_name, client_email, date, time, duration_minutes, location, notes, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...params, resolvedStatus, resolvedSource);
    id = result.lastInsertRowid;
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
    [id, scopedBusinessId]
  );

  const appointment = rowToAppointment(row);
  const settings = await getSettings(scopedBusinessId);
  const isPublic = appointment.source === 'public';

  const clientText = isPublic
    ? `Hi ${appointment.clientName},\n\nYour ${appointment.typeName} request for ${appointment.date} at ${fmtTime(
      appointment.time
    )} has been received and is awaiting confirmation from the business.\n\nLocation: ${appointment.location}\nDuration: ${appointment.durationMinutes} minutes\n\nYou will be notified once it is confirmed.\n\nThanks,\n${settings.business_name}`
    : `Hi ${appointment.clientName},\n\nYour ${appointment.typeName} is confirmed for ${appointment.date} at ${fmtTime(
      appointment.time
    )}.\n\nLocation: ${appointment.location}\nDuration: ${appointment.durationMinutes} minutes\n\nThanks,\n${settings.business_name}`;

  const clientHtml = buildBrandedEmailHtml({
    businessName: settings.business_name,
    title: isPublic ? 'Booking Received — Awaiting Confirmation' : 'Appointment Confirmed',
    subtitle: appointment.typeName,
    message: isPublic
      ? `Hi ${appointment.clientName},\n\nYour booking request has been received and is pending confirmation.`
      : `Hi ${appointment.clientName},\n\nYour appointment is confirmed.`,
    details: [
      { label: 'Service', value: appointment.typeName },
      { label: 'Date', value: appointment.date },
      { label: 'Time', value: fmtTime(appointment.time) },
      { label: 'Duration', value: `${appointment.durationMinutes} minutes` },
      { label: 'Location', value: appointment.location },
      { label: 'Status', value: isPublic ? 'Pending Confirmation' : 'Confirmed' }
    ]
  });

  const ownerText = isPublic
    ? `New booking request in ${settings.business_name} — ACTION REQUIRED\n\nType: ${appointment.typeName}\nClient: ${appointment.clientName}\nWhen: ${appointment.date} ${fmtTime(
      appointment.time
    )}\nSource: ${appointment.source}\n\nLog in to your dashboard to confirm or decline this booking.`
    : `New booking received in ${settings.business_name}\n\nType: ${appointment.typeName}\nClient: ${appointment.clientName}\nWhen: ${appointment.date} ${fmtTime(
      appointment.time
    )}\nSource: ${appointment.source}`;

  const ownerHtml = buildBrandedEmailHtml({
    businessName: settings.business_name,
    title: isPublic ? 'New Booking Request — Action Required' : 'New Booking Alert',
    subtitle: 'Owner Notification',
    message: isPublic
      ? 'A new booking request needs your approval. Log in to confirm or decline.'
      : 'A new booking has been created.',
    details: [
      { label: 'Service', value: appointment.typeName },
      { label: 'Client', value: appointment.clientName },
      { label: 'When', value: `${appointment.date} ${fmtTime(appointment.time)}` },
      { label: 'Source', value: appointment.source },
      ...(isPublic ? [{ label: 'Status', value: 'Pending Your Approval' }] : [])
    ]
  });

  const notifyResults = await Promise.allSettled([
    appointment.clientEmail
      ? sendEmail({
        to: appointment.clientEmail,
        subject: isPublic
          ? `${settings.business_name}: Booking received — awaiting confirmation`
          : `${settings.business_name}: Appointment confirmed`,
        text: clientText,
        html: clientHtml
      })
      : Promise.resolve(),
    (settings.owner_email && (settings.notify_owner_email == null || Boolean(settings.notify_owner_email)))
      ? sendEmail({
        to: settings.owner_email,
        subject: `[Owner Alert] New booking - ${settings.business_name}`,
        text: ownerText,
        html: ownerHtml
      })
      : Promise.resolve()
  ]);

  const provider = notifyResults
    .filter((r) => r.status === 'fulfilled' && r.value?.provider)
    .map((r) => r.value.provider)[0] || 'none';

  return {
    appointment,
    notifications: {
      mode: provider,
      sent: notifyResults.filter((r) => r.status === 'fulfilled' && r.value?.ok).length
    }
  };
}

module.exports = {
  parseTimeOrThrow,
  parseTimeToMinutes,
  humanTime,
  dateLockKey,
  assertNoOverlap,
  createAppointment,
  getAvailableSlots,
  PUBLIC_SLOT_INTERVAL_MINUTES,
  DEFAULT_PUBLIC_BOOKING_OPEN_TIME,
  DEFAULT_PUBLIC_BOOKING_CLOSE_TIME
};
