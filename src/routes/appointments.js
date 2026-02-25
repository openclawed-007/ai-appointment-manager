'use strict';

function registerAppointmentRoutes(app, deps) {
  const {
    USE_POSTGRES,
    sqlite: getSqlite,
    pgPool: getPgPool,
    dbGet,
    rowToAppointment,
    createAppointment,
    assertNoOverlap,
    parseTimeOrThrow,
    dateLockKey,
    getAvailableSlots,
    PUBLIC_SLOT_INTERVAL_MINUTES,
    getBusinessBySlug,
    getSettings,
    getMonthDateRange,
    resolveBusinessHoursForDate,
    dbAll,
    sendEmail,
    fmtTime,
    buildBrandedEmailHtml,
    buildCancellationEmailHtml
  } = deps;

app.get('/api/calendar/month', async (req, res) => {
  const businessId = req.auth.businessId;
  const { month } = req.query;
  const monthRange = month ? getMonthDateRange(month) : null;
  if (!monthRange) return res.status(400).json({ error: 'month must be in YYYY-MM format' });

  if (!USE_POSTGRES) {
    const rows = getSqlite().prepare(
      `SELECT a.id, a.date, a.time, a.duration_minutes, a.status, a.client_name, a.title, a.source, a.type_id, a.location,
              COALESCE(t.name, a.title, 'Appointment') AS type_name,
              t.color AS type_color
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ?
         AND a.date >= ?
         AND a.date < ?
         AND a.status != 'completed'
         AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`
    ).all(businessId, monthRange.start, monthRange.end);

    return res.json({
      appointments: rows.map((r) => ({
        id: Number(r.id),
        date: r.date,
        time: String(r.time || '').slice(0, 5),
        durationMinutes: Number(r.duration_minutes || 45),
        status: r.status,
        clientName: r.client_name,
        title: r.title || r.type_name || 'Appointment',
        source: r.source || 'owner',
        typeId: r.type_id == null ? null : Number(r.type_id),
        location: r.location || 'office',
        typeName: r.type_name || 'Appointment',
        color: r.type_color || null
      }))
    });
  }

  const rows = (
    await getPgPool().query(
      `SELECT a.id, a.date, a.time, a.duration_minutes, a.status, a.client_name, a.title, a.source, a.type_id, a.location,
              COALESCE(t.name, a.title, 'Appointment') AS type_name,
              t.color AS type_color
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1
         AND a.date >= $2
         AND a.date < $3
         AND a.status != 'completed'
         AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      [businessId, monthRange.start, monthRange.end]
    )
  ).rows;

  return res.json({
    appointments: rows.map((r) => ({
      id: Number(r.id),
      date: typeof r.date === 'string' ? r.date.slice(0, 10) : r.date?.toISOString?.().slice(0, 10),
      time: typeof r.time === 'string' ? r.time.slice(0, 5) : '09:00',
      durationMinutes: Number(r.duration_minutes || 45),
      status: r.status,
      clientName: r.client_name,
      title: r.title || r.type_name || 'Appointment',
      source: r.source || 'owner',
      typeId: r.type_id == null ? null : Number(r.type_id),
      location: r.location || 'office',
      typeName: r.type_name || 'Appointment',
      color: r.type_color || null
    }))
  });
});

app.get('/api/appointments', async (req, res) => {
  const businessId = req.auth.businessId;
  const { date, q, status, month, from, to, limit } = req.query;
  const searchQuery = String(q || '').trim();
  const monthRange = month ? getMonthDateRange(month) : null;
  const fromDate = from == null ? '' : String(from).trim();
  const toDate = to == null ? '' : String(to).trim();
  const limitRaw = limit == null ? '' : String(limit).trim();
  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : null;
  const limitValue = Number.isFinite(parsedLimit) ? parsedLimit : null;
  if (month && !monthRange) return res.status(400).json({ error: 'month must be in YYYY-MM format' });
  if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return res.status(400).json({ error: 'from must be in YYYY-MM-DD format' });
  if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return res.status(400).json({ error: 'to must be in YYYY-MM-DD format' });
  if (fromDate && toDate && fromDate > toDate) return res.status(400).json({ error: 'from must be on or before to' });
  if (limitRaw && (!limitValue || limitValue <= 0 || limitValue > 5000)) {
    return res.status(400).json({ error: 'limit must be between 1 and 5000' });
  }
  if (searchQuery && searchQuery.length < 2) return res.json({ appointments: [] });

  if (!USE_POSTGRES) {
    let sql = `
      SELECT a.*, t.name AS type_name, t.color AS type_color
      FROM appointments a
      LEFT JOIN appointment_types t ON t.id = a.type_id
      WHERE a.business_id = ?
    `;
    const params = [businessId];

    if (date) { sql += ' AND a.date = ?'; params.push(String(date)); }
    if (monthRange) { sql += ' AND a.date >= ? AND a.date < ?'; params.push(monthRange.start, monthRange.end); }
    if (fromDate) { sql += ' AND a.date >= ?'; params.push(fromDate); }
    if (toDate) { sql += ' AND a.date <= ?'; params.push(toDate); }
    if (status) { sql += ' AND a.status = ?'; params.push(String(status)); }
    if (searchQuery) {
      sql += ' AND (a.client_name LIKE ? OR a.client_email LIKE ?)';
      params.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }
    sql += ' ORDER BY a.date ASC, a.time ASC';
    if (limitValue) {
      sql += ' LIMIT ?';
      params.push(limitValue);
    }
    const rows = getSqlite().prepare(sql).all(...params).map((r) => {
      const appt = rowToAppointment(r);
      if (r.type_color) appt.color = r.type_color;
      return appt;
    });
    return res.json({ appointments: rows });
  }

  let sql = `
    SELECT a.*, t.name AS type_name, t.color AS type_color
    FROM appointments a
    LEFT JOIN appointment_types t ON t.id = a.type_id
    WHERE a.business_id = $1
  `;
  const params = [businessId];
  let orderByClause = ' ORDER BY a.date ASC, a.time ASC';

  if (date) { params.push(String(date)); sql += ` AND a.date = $${params.length}`; }
  if (monthRange) {
    params.push(monthRange.start);
    sql += ` AND a.date >= $${params.length}`;
    params.push(monthRange.end);
    sql += ` AND a.date < $${params.length}`;
  }
  if (fromDate) {
    params.push(fromDate);
    sql += ` AND a.date >= $${params.length}`;
  }
  if (toDate) {
    params.push(toDate);
    sql += ` AND a.date <= $${params.length}`;
  }
  if (status) { params.push(String(status)); sql += ` AND a.status = $${params.length}`; }
  if (searchQuery) {
    params.push(`%${searchQuery}%`);
    const patternIdx = params.length;
    params.push(searchQuery);
    const termIdx = params.length;
    const similarityExpr = `
      GREATEST(
        similarity(a.client_name, $${termIdx}),
        similarity(COALESCE(a.client_email, ''), $${termIdx})
      )
    `;
    sql += ` AND (
      a.client_name ILIKE $${patternIdx}
      OR a.client_email ILIKE $${patternIdx}
      OR (${similarityExpr}) >= 0.62
    )`;
    orderByClause = ` ORDER BY ${similarityExpr} DESC, a.date ASC, a.time ASC`;
  }

  sql += orderByClause;
  if (limitValue) {
    params.push(limitValue);
    sql += ` LIMIT $${params.length}`;
  } else if (searchQuery) {
    sql += ' LIMIT 100';
  }
  const rows = (await getPgPool().query(sql, params)).rows.map((r) => {
    const appt = rowToAppointment(r);
    if (r.type_color) appt.color = r.type_color;
    return appt;
  });
  return res.json({ appointments: rows });
});

app.post('/api/appointments', async (req, res) => {
  try {
    const result = await createAppointment({
      ...req.body,
      businessId: req.auth.businessId,
      source: req.body?.source || 'owner'
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/public/bookings', async (req, res) => {
  try {
    const honeypot = String(req.body?.website || '').trim();
    if (honeypot) return res.status(400).json({ error: 'Invalid request.' });

    const slug = String(req.body?.businessSlug || '').trim();
    if (!slug) return res.status(400).json({ error: 'businessSlug is required for public bookings.' });
    const business = await getBusinessBySlug(slug);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    const requestedTypeId = Number(req.body?.typeId);
    if (!Number.isFinite(requestedTypeId) || requestedTypeId <= 0) {
      return res.status(400).json({ error: 'typeId is required for public bookings.' });
    }
    const type = await dbGet(
      'SELECT id, duration_minutes, location_mode FROM appointment_types WHERE id = ? AND business_id = ? AND active = 1',
      'SELECT id, duration_minutes, location_mode FROM appointment_types WHERE id = $1 AND business_id = $2 AND active = TRUE',
      [requestedTypeId, Number(business.id)]
    );
    if (!type) return res.status(404).json({ error: 'Appointment type not found.' });

    const enforcedDurationMinutes = Number(type.duration_minutes || 45);
    const enforcedLocation = String(type.location_mode || 'office');
    const settings = (await getSettings(Number(business.id))) || {};
    const hoursForDate = resolveBusinessHoursForDate(settings, String(req.body?.date || ''));
    if (hoursForDate.closed) {
      return res.status(400).json({ error: `Business is closed on ${hoursForDate.dayKey.toUpperCase()}.` });
    }
    const openTime = hoursForDate.openTime;
    const closeTime = hoursForDate.closeTime;
    const requestedTime = String(req.body?.time || '').slice(0, 5);
    const startMinutes = parseTimeOrThrow(requestedTime);
    const endMinutes = startMinutes + enforcedDurationMinutes;
    const openMinutes = parseTimeOrThrow(openTime);
    const closeMinutes = parseTimeOrThrow(closeTime);
    if (startMinutes < openMinutes || endMinutes > closeMinutes) {
      return res.status(400).json({ error: `Selected time is outside business hours (${fmtTime(openTime)}-${fmtTime(closeTime)}).` });
    }
    const result = await createAppointment({
      ...req.body,
      durationMinutes: enforcedDurationMinutes,
      location: enforcedLocation,
      businessId: business.id,
      source: 'public'
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/public/available-slots', async (req, res) => {
  try {
    const slug = String(req.query?.businessSlug || '').trim();
    const date = String(req.query?.date || '').trim();
    const typeId = Number(req.query?.typeId);

    if (!slug) return res.status(400).json({ error: 'businessSlug is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });
    if (!Number.isFinite(typeId) || typeId <= 0) return res.status(400).json({ error: 'typeId is required.' });

    const business = await getBusinessBySlug(slug);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    const type = await dbGet(
      'SELECT id, duration_minutes FROM appointment_types WHERE id = ? AND business_id = ? AND active = 1',
      'SELECT id, duration_minutes FROM appointment_types WHERE id = $1 AND business_id = $2 AND active = TRUE',
      [typeId, Number(business.id)]
    );
    if (!type) return res.status(404).json({ error: 'Appointment type not found.' });

    const settings = (await getSettings(Number(business.id))) || {};
    const hoursForDate = resolveBusinessHoursForDate(settings, date);
    const openTime = hoursForDate.openTime;
    const closeTime = hoursForDate.closeTime;
    const durationMinutes = Number(type.duration_minutes || 45);
    const availableSlots = hoursForDate.closed
      ? []
      : await getAvailableSlots({
        businessId: Number(business.id),
        date,
        durationMinutes,
        openTime,
        closeTime
      });

    return res.json({
      date,
      durationMinutes,
      slotIntervalMinutes: PUBLIC_SLOT_INTERVAL_MINUTES,
      dayKey: hoursForDate.dayKey,
      closed: Boolean(hoursForDate.closed),
      openTime,
      closeTime,
      availableSlots
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/appointments/:id/email', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const row = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ? AND a.business_id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1 AND a.business_id = $2`,
    [id, businessId]
  );

  if (!row) return res.status(404).json({ error: 'appointment not found' });
  const appointment = rowToAppointment(row);
  if (!appointment.clientEmail) return res.status(400).json({ error: 'This appointment has no client email.' });

  const settings = await getSettings(businessId);
  const { template, subject, message } = req.body || {};
  const selectedTemplate = String(template || 'summary');

  let emailSubject = `${settings.business_name}: Appointment details`;
  let text;

  if (selectedTemplate === 'custom') {
    if (!String(message || '').trim()) return res.status(400).json({ error: 'Custom message is required.' });
    emailSubject = String(subject || `${settings.business_name}: Message about your appointment`).trim();
    text = `Hi ${appointment.clientName},\n\n${String(message).trim()}\n\n---\nAppointment reference:\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(appointment.time)}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\nStatus: ${appointment.status}\n\nThanks,\n${settings.business_name}`;
  } else if (selectedTemplate === 'reminder') {
    emailSubject = `${settings.business_name}: Appointment reminder`;
    text = `Hi ${appointment.clientName},\n\nQuick reminder for your upcoming appointment:\n\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(appointment.time)}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\n\nReply if you need to reschedule.\n\nThanks,\n${settings.business_name}`;
  } else {
    text = `Hi ${appointment.clientName},\n\nThis is your appointment summary:\n\nService: ${appointment.typeName}\nDate: ${appointment.date}\nTime: ${fmtTime(appointment.time)}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\nStatus: ${appointment.status}\n\nThanks,\n${settings.business_name}`;
  }

  const result = await sendEmail({
    to: appointment.clientEmail,
    subject: emailSubject,
    text,
    html: buildBrandedEmailHtml({
      businessName: settings.business_name,
      title: emailSubject,
      subtitle: appointment.typeName,
      message: text,
      details: [
        { label: 'Service', value: appointment.typeName },
        { label: 'Date', value: appointment.date },
        { label: 'Time', value: fmtTime(appointment.time) },
        { label: 'Duration', value: `${appointment.durationMinutes} minutes` },
        { label: 'Location', value: appointment.location },
        { label: 'Status', value: appointment.status }
      ]
    })
  });

  if (!result.ok) {
    return res.status(502).json({ error: 'Could not send email right now.', provider: result.provider || 'unknown' });
  }
  return res.json({ ok: true, provider: result.provider || 'unknown', appointmentId: appointment.id });
});

app.put('/api/appointments/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const { typeId, clientName, clientEmail, date, time, durationMinutes, reminderOffsetMinutes, location, notes, source } = req.body || {};

  if (!clientName?.trim()) return res.status(400).json({ error: 'clientName is required' });
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!time) return res.status(400).json({ error: 'time is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });

  let selectedType = null;
  if (typeId != null) {
    selectedType = await dbGet(
      'SELECT * FROM appointment_types WHERE id = ? AND business_id = ? AND active = 1',
      'SELECT * FROM appointment_types WHERE id = $1 AND business_id = $2 AND active = TRUE',
      [Number(typeId), businessId]
    );
    if (!selectedType) return res.status(400).json({ error: 'Invalid appointment type' });
  }

  const previousRow = await dbGet(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = ? AND a.business_id = ?`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.id = $1 AND a.business_id = $2`,
    [id, businessId]
  );

  if (!previousRow) return res.status(404).json({ error: 'appointment not found' });
  const requestedSource = String(source || '').toLowerCase();
  const persistedSource = String(previousRow.source || '').toLowerCase();
  const isReminderEntry = requestedSource === 'reminder' || persistedSource === 'reminder';
  const resolvedDuration = isReminderEntry
    ? 0
    : Number(durationMinutes || selectedType?.duration_minutes || 45);
  if (!isReminderEntry && (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0)) {
    return res.status(400).json({ error: 'durationMinutes must be greater than 0' });
  }
  const previousAppointment = rowToAppointment(previousRow);
  const hasReminderOffsetMinutes = !(reminderOffsetMinutes == null || reminderOffsetMinutes === '');
  const resolvedReminderOffsetMinutes = hasReminderOffsetMinutes
    ? Number(reminderOffsetMinutes)
    : Number(previousRow.reminder_offset_minutes == null ? 10 : previousRow.reminder_offset_minutes);
  if (!Number.isFinite(resolvedReminderOffsetMinutes) || resolvedReminderOffsetMinutes < 0 || resolvedReminderOffsetMinutes > 10080) {
    return res.status(400).json({ error: 'reminderOffsetMinutes must be between 0 and 10080' });
  }

  const resolvedSource = source === undefined
    ? String(previousRow.source || 'owner')
    : String(source || 'owner');

  try {
    const startMinutes = parseTimeOrThrow(time);
    if (USE_POSTGRES) {
      const tx = await getPgPool().connect();
      try {
        await tx.query('BEGIN');
        await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [Number(businessId), dateLockKey(date)]);
        if (!isReminderEntry) {
          await assertNoOverlap({
            businessId,
            date: String(date),
            startMinutes,
            durationMinutes: resolvedDuration,
            excludeId: id,
            pgClient: tx
          });
        }
        const up = await tx.query(
          `UPDATE appointments
           SET type_id = $1, client_name = $2, client_email = $3, date = $4, time = $5,
               duration_minutes = $6, reminder_offset_minutes = $7, location = $8, notes = $9, source = $10
           WHERE id = $11 AND business_id = $12`,
          [
            selectedType?.id || null, clientName.trim(), clientEmail || null,
            String(date), String(time), resolvedDuration,
            resolvedReminderOffsetMinutes,
            location || selectedType?.location_mode || 'office',
            notes || null, resolvedSource, id, businessId
          ]
        );
        if (!up.rowCount) {
          await tx.query('ROLLBACK');
          return res.status(404).json({ error: 'appointment not found' });
        }
        await tx.query('COMMIT');
      } catch (error) {
        try { await tx.query('ROLLBACK'); } catch { }
        return res.status(400).json({ error: error.message });
      } finally {
        tx.release();
      }
    } else {
      if (!isReminderEntry) {
        await assertNoOverlap({
          businessId,
          date: String(date),
          startMinutes,
          durationMinutes: resolvedDuration,
          excludeId: id
        });
      }
      const up = getSqlite()
        .prepare(
          `UPDATE appointments
           SET type_id = ?, client_name = ?, client_email = ?, date = ?, time = ?,
               duration_minutes = ?, reminder_offset_minutes = ?, location = ?, notes = ?, source = ?
           WHERE id = ? AND business_id = ?`
        )
        .run(
          selectedType?.id || null, clientName.trim(), clientEmail || null,
          String(date), String(time), resolvedDuration,
          resolvedReminderOffsetMinutes,
          location || selectedType?.location_mode || 'office',
          notes || null, resolvedSource, id, businessId
        );
      if (!up.changes) return res.status(404).json({ error: 'appointment not found' });
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
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
    [id, businessId]
  );

  const appointment = rowToAppointment(row);
  const scheduleChanged = previousAppointment.date !== appointment.date || previousAppointment.time !== appointment.time;

  if (scheduleChanged && appointment.clientEmail) {
    const settings = await getSettings(businessId);
    const message = `Hi ${appointment.clientName},\n\nYour appointment has been rescheduled.\n\nPrevious: ${previousAppointment.date} at ${fmtTime(previousAppointment.time)}\nNew: ${appointment.date} at ${fmtTime(appointment.time)}\n\nService: ${appointment.typeName}\nDuration: ${appointment.durationMinutes} minutes\nLocation: ${appointment.location}\n\nIf this change does not work for you, reply to this email and we can help.\n\nThanks,\n${settings.business_name}`;

    await sendEmail({
      to: appointment.clientEmail,
      subject: `${settings.business_name}: Appointment rescheduled`,
      text: message,
      html: buildBrandedEmailHtml({
        businessName: settings.business_name,
        title: 'Appointment Rescheduled',
        subtitle: appointment.typeName,
        message,
        details: [
          { label: 'Previous', value: `${previousAppointment.date} • ${fmtTime(previousAppointment.time)}` },
          { label: 'New', value: `${appointment.date} • ${fmtTime(appointment.time)}` },
          { label: 'Duration', value: `${appointment.durationMinutes} minutes` },
          { label: 'Location', value: appointment.location }
        ]
      })
    });
  }

  res.json({ appointment });
});

app.delete('/api/appointments/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  if (USE_POSTGRES) {
    const result = await getPgPool().query('DELETE FROM appointments WHERE id = $1 AND business_id = $2', [id, businessId]);
    if (!result.rowCount) return res.status(404).json({ error: 'appointment not found' });
    return res.json({ ok: true });
  }

  const info = getSqlite().prepare('DELETE FROM appointments WHERE id = ? AND business_id = ?').run(id, businessId);
  if (!info.changes) return res.status(404).json({ error: 'appointment not found' });
  return res.json({ ok: true });
});

app.patch('/api/appointments/:id/status', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const { status, cancellationReason } = req.body || {};
  const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  if (USE_POSTGRES) {
    const up = await getPgPool().query('UPDATE appointments SET status = $1 WHERE id = $2 AND business_id = $3', [status, id, businessId]);
    if (!up.rowCount) return res.status(404).json({ error: 'appointment not found' });
  } else {
    const up = getSqlite().prepare('UPDATE appointments SET status = ? WHERE id = ? AND business_id = ?').run(status, id, businessId);
    if (!up.changes) return res.status(404).json({ error: 'appointment not found' });
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
    [id, businessId]
  );

  const appointment = rowToAppointment(row);
  const settings = await getSettings(businessId);
  const cleanCancellationReason = String(cancellationReason || '').trim();

  if (appointment.clientEmail) {
    const isCancelled = status === 'cancelled';
    const statusText = isCancelled
      ? `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(appointment.time)} has been cancelled.${cleanCancellationReason ? `\n\nReason: ${cleanCancellationReason}` : ''}`
      : `Hi ${appointment.clientName}, your appointment on ${appointment.date} at ${fmtTime(appointment.time)} is now ${status}.`;

    await sendEmail({
      to: appointment.clientEmail,
      subject: isCancelled
        ? `${settings.business_name}: Appointment cancelled`
        : `${settings.business_name}: Appointment ${status}`,
      text: statusText,
      html: isCancelled
        ? buildCancellationEmailHtml({
          businessName: settings.business_name,
          appointment,
          cancellationReason: cleanCancellationReason
        })
        : buildBrandedEmailHtml({
          businessName: settings.business_name,
          title: `Appointment ${status}`,
          subtitle: appointment.typeName,
          message: statusText,
          details: [
            { label: 'Date', value: appointment.date },
            { label: 'Time', value: fmtTime(appointment.time) },
            { label: 'Status', value: status }
          ]
        })
    });
  }

  res.json({ appointment });
});

}

module.exports = registerAppointmentRoutes;
