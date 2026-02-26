'use strict';

function registerClientRoutes(app, deps) {
  const {
    USE_POSTGRES,
    sqlite: getSqlite,
    pgPool: getPgPool,
    dbRun,
    dbGet,
    dbAll,
    rowToAppointment,
    rowToClient,
    rowToClientNote,
    CLIENT_STAGES,
    normalizeClientStage,
    splitDateTime
  } = deps;

app.get('/api/clients', async (req, res) => {
  const businessId = req.auth.businessId;
  const query = String(req.query.q || '').trim();
  const stage = String(req.query.stage || '').trim();
  const liteRaw = String(req.query.lite || '').trim().toLowerCase();
  const isLite = liteRaw === '1' || liteRaw === 'true';
  const limitRaw = req.query.limit == null ? '' : String(req.query.limit).trim();
  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : null;
  const limitValue = Number.isFinite(parsedLimit) ? parsedLimit : null;
  if (limitRaw && (!limitValue || limitValue <= 0 || limitValue > 500)) {
    return res.status(400).json({ error: 'limit must be between 1 and 500' });
  }
  const rowLimit = limitValue || (isLite ? 100 : 500);
  const normalizedStage = stage ? normalizeClientStage(stage, '') : '';
  if (stage && !normalizedStage) {
    return res.status(400).json({ error: `stage must be one of: ${CLIENT_STAGES.join(', ')}` });
  }
  if (query && query.length < 2) return res.json({ clients: [] });

  if (!USE_POSTGRES) {
    if (isLite) {
      let liteSql = `
        SELECT c.*
        FROM clients c
        WHERE c.business_id = ?
          AND c.archived_at IS NULL
      `;
      const liteParams = [businessId];
      if (normalizedStage) {
        liteSql += ' AND c.stage = ?';
        liteParams.push(normalizedStage);
      }
      if (query) {
        liteSql += ' AND (c.name LIKE ? OR COALESCE(c.email, \'\') LIKE ? OR COALESCE(c.phone, \'\') LIKE ?)';
        liteParams.push(`%${query}%`, `%${query}%`, `%${query}%`);
      }
      liteSql += ' ORDER BY c.updated_at DESC, c.id DESC LIMIT ?';
      liteParams.push(rowLimit);
      const rows = getSqlite().prepare(liteSql).all(...liteParams);
      return res.json({
        clients: rows.map((row) => ({
          ...rowToClient(row),
          lastNote: null,
          lastNoteAt: null,
          nextAppointmentDate: null,
          nextAppointmentTime: null
        }))
      });
    }

    let sql = `
      SELECT c.*,
             (SELECT cn.note
              FROM client_notes cn
              WHERE cn.client_id = c.id
              ORDER BY cn.created_at DESC
              LIMIT 1) AS last_note,
             (SELECT cn.created_at
              FROM client_notes cn
              WHERE cn.client_id = c.id
              ORDER BY cn.created_at DESC
              LIMIT 1) AS last_note_at,
             (SELECT MIN(a.date || ' ' || a.time)
              FROM appointments a
              WHERE a.business_id = c.business_id
                AND (
                  a.client_id = c.id
                  OR (
                    a.client_id IS NULL
                    AND lower(a.client_name) = lower(c.name)
                    AND (
                      c.email IS NULL
                      OR c.email = ''
                      OR lower(COALESCE(a.client_email, '')) = lower(c.email)
                    )
                  )
                )
                AND a.status != 'completed'
                AND a.status != 'cancelled') AS next_appointment_at
      FROM clients c
      WHERE c.business_id = ?
        AND c.archived_at IS NULL
    `;
    const params = [businessId];
    if (normalizedStage) {
      sql += ' AND c.stage = ?';
      params.push(normalizedStage);
    }
    if (query) {
      sql += ' AND (c.name LIKE ? OR COALESCE(c.email, \'\') LIKE ? OR COALESCE(c.phone, \'\') LIKE ?)';
      params.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }
    sql += ' ORDER BY c.updated_at DESC, c.id DESC LIMIT ?';
    params.push(rowLimit);

    const rows = getSqlite().prepare(sql).all(...params);
    return res.json({
      clients: rows.map((row) => {
        const mapped = rowToClient(row);
        const next = splitDateTime(row.next_appointment_at);
        return {
          ...mapped,
          lastNote: row.last_note || null,
          lastNoteAt: row.last_note_at || null,
          nextAppointmentDate: next.date,
          nextAppointmentTime: next.time
        };
      })
    });
  }

  if (isLite) {
    let liteSql = `
      SELECT c.*
      FROM clients c
      WHERE c.business_id = $1
        AND c.archived_at IS NULL
    `;
    const liteParams = [businessId];
    if (normalizedStage) {
      liteParams.push(normalizedStage);
      liteSql += ` AND c.stage = $${liteParams.length}`;
    }
    if (query) {
      liteParams.push(`%${query}%`);
      const patternIdx = liteParams.length;
      liteSql += ` AND (
        c.name ILIKE $${patternIdx}
        OR COALESCE(c.email, '') ILIKE $${patternIdx}
        OR COALESCE(c.phone, '') ILIKE $${patternIdx}
      )`;
    }
    liteParams.push(rowLimit);
    liteSql += ` ORDER BY c.updated_at DESC, c.id DESC LIMIT $${liteParams.length}`;
    const rows = (await getPgPool().query(liteSql, liteParams)).rows;
    return res.json({
      clients: rows.map((row) => ({
        ...rowToClient(row),
        lastNote: null,
        lastNoteAt: null,
        nextAppointmentDate: null,
        nextAppointmentTime: null
      }))
    });
  }

  let sql = `
    SELECT c.*,
           (
             SELECT cn.note
             FROM client_notes cn
             WHERE cn.client_id = c.id
             ORDER BY cn.created_at DESC
             LIMIT 1
           ) AS last_note,
           (
             SELECT cn.created_at
             FROM client_notes cn
             WHERE cn.client_id = c.id
             ORDER BY cn.created_at DESC
             LIMIT 1
           ) AS last_note_at,
           (
             SELECT MIN(a.date + a.time)
             FROM appointments a
             WHERE a.business_id = c.business_id
               AND (
                 a.client_id = c.id
                 OR (
                   a.client_id IS NULL
                   AND lower(a.client_name) = lower(c.name)
                   AND (
                     c.email IS NULL
                     OR c.email = ''
                     OR lower(COALESCE(a.client_email, '')) = lower(c.email)
                   )
                 )
               )
               AND a.status != 'completed'
               AND a.status != 'cancelled'
           ) AS next_appointment_at
    FROM clients c
    WHERE c.business_id = $1
      AND c.archived_at IS NULL
  `;
  const params = [businessId];
  if (normalizedStage) {
    params.push(normalizedStage);
    sql += ` AND c.stage = $${params.length}`;
  }
  if (query) {
    params.push(`%${query}%`);
    const patternIdx = params.length;
    sql += ` AND (
      c.name ILIKE $${patternIdx}
      OR COALESCE(c.email, '') ILIKE $${patternIdx}
      OR COALESCE(c.phone, '') ILIKE $${patternIdx}
    )`;
  }
  params.push(rowLimit);
  sql += ` ORDER BY c.updated_at DESC, c.id DESC LIMIT $${params.length}`;

  const rows = (await getPgPool().query(sql, params)).rows;
  return res.json({
    clients: rows.map((row) => {
      const mapped = rowToClient(row);
      const nextSource = row.next_appointment_at?.toISOString?.() || row.next_appointment_at || null;
      const next = splitDateTime(nextSource);
      return {
        ...mapped,
        lastNote: row.last_note || null,
        lastNoteAt: row.last_note_at || null,
        nextAppointmentDate: next.date,
        nextAppointmentTime: next.time
      };
    })
  });
});

app.post('/api/clients', async (req, res) => {
  const businessId = req.auth.businessId;
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim() || null;
  const phone = String(req.body?.phone || '').trim() || null;
  const progressSummary = String(req.body?.progressSummary || '').trim() || null;
  const stage = normalizeClientStage(req.body?.stage, 'new');
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 200) return res.status(400).json({ error: 'name is too long (max 200 characters)' });
  if (email && email.length > 320) return res.status(400).json({ error: 'email is too long' });
  if (phone && phone.length > 60) return res.status(400).json({ error: 'phone is too long' });
  if (progressSummary && progressSummary.length > 1000) {
    return res.status(400).json({ error: 'progressSummary is too long (max 1000 characters)' });
  }
  if (!stage) return res.status(400).json({ error: `stage must be one of: ${CLIENT_STAGES.join(', ')}` });

  let row;
  if (USE_POSTGRES) {
    row = (
      await getPgPool().query(
        `INSERT INTO clients (business_id, name, email, phone, stage, progress_summary)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [businessId, name, email, phone, stage, progressSummary]
      )
    ).rows[0];
  } else {
    const insert = getSqlite().prepare(
      `INSERT INTO clients (business_id, name, email, phone, stage, progress_summary)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(businessId, name, email, phone, stage, progressSummary);
    row = getSqlite().prepare('SELECT * FROM clients WHERE id = ? AND business_id = ?').get(insert.lastInsertRowid, businessId);
  }

  res.status(201).json({ client: rowToClient(row) });
});

app.get('/api/clients/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid client id' });

  const row = await dbGet(
    'SELECT * FROM clients WHERE id = ? AND business_id = ? AND archived_at IS NULL',
    'SELECT * FROM clients WHERE id = $1 AND business_id = $2 AND archived_at IS NULL',
    [id, businessId]
  );
  if (!row) return res.status(404).json({ error: 'client not found' });
  res.json({ client: rowToClient(row) });
});

app.put('/api/clients/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const name = req.body?.name == null ? null : String(req.body.name).trim();
  const email = req.body?.email == null ? null : (String(req.body.email).trim() || '');
  const phone = req.body?.phone == null ? null : (String(req.body.phone).trim() || '');
  const progressSummary = req.body?.progressSummary == null ? null : (String(req.body.progressSummary).trim() || '');
  const stage = req.body?.stage == null ? null : normalizeClientStage(req.body.stage, '');
  if (stage === null) return res.status(400).json({ error: `stage must be one of: ${CLIENT_STAGES.join(', ')}` });
  if (name != null && !name) return res.status(400).json({ error: 'name cannot be empty' });
  if (name && name.length > 200) return res.status(400).json({ error: 'name is too long (max 200 characters)' });
  if (email && email.length > 320) return res.status(400).json({ error: 'email is too long' });
  if (phone && phone.length > 60) return res.status(400).json({ error: 'phone is too long' });
  if (progressSummary && progressSummary.length > 1000) {
    return res.status(400).json({ error: 'progressSummary is too long (max 1000 characters)' });
  }

  if (USE_POSTGRES) {
    const result = await getPgPool().query(
      `UPDATE clients
       SET name = COALESCE($1, name),
           email = CASE WHEN $2 IS NULL THEN email ELSE NULLIF($2, '') END,
           phone = CASE WHEN $3 IS NULL THEN phone ELSE NULLIF($3, '') END,
           stage = COALESCE($4, stage),
           progress_summary = CASE WHEN $5 IS NULL THEN progress_summary ELSE NULLIF($5, '') END,
           updated_at = NOW()
       WHERE id = $6 AND business_id = $7`,
      [name, email, phone, stage, progressSummary, id, businessId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'client not found' });
  } else {
    const result = getSqlite().prepare(
      `UPDATE clients
       SET name = COALESCE(?, name),
           email = CASE WHEN ? IS NULL THEN email ELSE NULLIF(?, '') END,
           phone = CASE WHEN ? IS NULL THEN phone ELSE NULLIF(?, '') END,
           stage = COALESCE(?, stage),
           progress_summary = CASE WHEN ? IS NULL THEN progress_summary ELSE NULLIF(?, '') END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND business_id = ?`
    ).run(name, email, email, phone, phone, stage, progressSummary, progressSummary, id, businessId);
    if (!result.changes) return res.status(404).json({ error: 'client not found' });
  }

  const row = await dbGet(
    'SELECT * FROM clients WHERE id = ? AND business_id = ?',
    'SELECT * FROM clients WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );
  if (!row) return res.status(404).json({ error: 'client not found' });
  res.json({ client: rowToClient(row) });
});

app.delete('/api/clients/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid client id' });

  // Archive instead of hard-deleting so historical appointment data stays intact.
  const result = await dbRun(
    'UPDATE clients SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? AND archived_at IS NULL',
    'UPDATE clients SET archived_at = NOW(), updated_at = NOW() WHERE id = $1 AND business_id = $2 AND archived_at IS NULL',
    [id, businessId]
  );
  const affectedRows = USE_POSTGRES ? Number(result?.rowCount || 0) : Number(result?.changes || 0);
  if (!affectedRows) return res.status(404).json({ error: 'client not found' });
  res.json({ success: true, archived: true });
});

app.get('/api/clients/:id/notes', async (req, res) => {
  const businessId = req.auth.businessId;
  const clientId = Number(req.params.id);
  const client = await dbGet(
    'SELECT id FROM clients WHERE id = ? AND business_id = ? AND archived_at IS NULL',
    'SELECT id FROM clients WHERE id = $1 AND business_id = $2 AND archived_at IS NULL',
    [clientId, businessId]
  );
  if (!client) return res.status(404).json({ error: 'client not found' });

  const rows = await dbAll(
    'SELECT * FROM client_notes WHERE business_id = ? AND client_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
    'SELECT * FROM client_notes WHERE business_id = $1 AND client_id = $2 ORDER BY created_at DESC, id DESC LIMIT 200',
    [businessId, clientId]
  );
  res.json({ notes: rows.map(rowToClientNote) });
});

app.post('/api/clients/:id/notes', async (req, res) => {
  const businessId = req.auth.businessId;
  const userId = req.auth.userId;
  const clientId = Number(req.params.id);
  const note = String(req.body?.note || '').trim();
  const nextStage = req.body?.stage == null ? null : normalizeClientStage(req.body.stage, '');
  if (!note) return res.status(400).json({ error: 'note is required' });
  if (note.length > 5000) return res.status(400).json({ error: 'note is too long (max 5000 characters)' });
  if (nextStage === null) return res.status(400).json({ error: `stage must be one of: ${CLIENT_STAGES.join(', ')}` });

  const existing = await dbGet(
    'SELECT id FROM clients WHERE id = ? AND business_id = ? AND archived_at IS NULL',
    'SELECT id FROM clients WHERE id = $1 AND business_id = $2 AND archived_at IS NULL',
    [clientId, businessId]
  );
  if (!existing) return res.status(404).json({ error: 'client not found' });

  let noteId = null;
  if (USE_POSTGRES) {
    const tx = await getPgPool().connect();
    try {
      await tx.query('BEGIN');
      const inserted = await tx.query(
        `INSERT INTO client_notes (business_id, client_id, note, created_by_user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [businessId, clientId, note, userId]
      );
      noteId = Number(inserted.rows[0]?.id || 0);
      await tx.query(
        `UPDATE clients
         SET updated_at = NOW(),
             stage = COALESCE($1, stage)
         WHERE id = $2 AND business_id = $3`,
        [nextStage, clientId, businessId]
      );
      await tx.query('COMMIT');
    } catch (error) {
      try { await tx.query('ROLLBACK'); } catch { }
      throw error;
    } finally {
      tx.release();
    }
  } else {
    const tx = getSqlite().transaction((payload) => {
      const inserted = getSqlite().prepare(
        `INSERT INTO client_notes (business_id, client_id, note, created_by_user_id)
         VALUES (?, ?, ?, ?)`
      ).run(payload.businessId, payload.clientId, payload.note, payload.userId);
      getSqlite().prepare(
        `UPDATE clients
         SET updated_at = CURRENT_TIMESTAMP,
             stage = COALESCE(?, stage)
         WHERE id = ? AND business_id = ?`
      ).run(payload.stage, payload.clientId, payload.businessId);
      return Number(inserted.lastInsertRowid);
    });
    noteId = tx({ businessId, clientId, note, userId, stage: nextStage });
  }

  const row = await dbGet(
    'SELECT * FROM client_notes WHERE id = ? AND business_id = ?',
    'SELECT * FROM client_notes WHERE id = $1 AND business_id = $2',
    [noteId, businessId]
  );
  const clientRow = await dbGet(
    'SELECT * FROM clients WHERE id = ? AND business_id = ?',
    'SELECT * FROM clients WHERE id = $1 AND business_id = $2',
    [clientId, businessId]
  );
  res.status(201).json({
    note: rowToClientNote(row),
    client: clientRow ? rowToClient(clientRow) : null
  });
});

app.get('/api/clients/:id/appointments', async (req, res) => {
  const businessId = req.auth.businessId;
  const clientId = Number(req.params.id);
  const client = await dbGet(
    'SELECT * FROM clients WHERE id = ? AND business_id = ? AND archived_at IS NULL',
    'SELECT * FROM clients WHERE id = $1 AND business_id = $2 AND archived_at IS NULL',
    [clientId, businessId]
  );
  if (!client) return res.status(404).json({ error: 'client not found' });

  const clientName = String(client.name || '').trim();
  const clientEmail = String(client.email || '').trim();
  const rows = await dbAll(
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.business_id = ?
       AND (
         a.client_id = ?
         OR (
           a.client_id IS NULL
           AND lower(a.client_name) = lower(?)
           AND (
             ? = ''
             OR lower(COALESCE(a.client_email, '')) = lower(?)
           )
         )
       )
     ORDER BY a.date DESC, a.time DESC
     LIMIT 200`,
    `SELECT a.*, t.name AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.business_id = $1
       AND (
         a.client_id = $2
         OR (
           a.client_id IS NULL
           AND lower(a.client_name) = lower($3)
           AND (
             $4 = ''
             OR lower(COALESCE(a.client_email, '')) = lower($5)
           )
         )
       )
     ORDER BY a.date DESC, a.time DESC
     LIMIT 200`,
    [businessId, clientId, clientName, clientEmail, clientEmail]
  );

  res.json({ appointments: rows.map(rowToAppointment) });
});
}

module.exports = registerClientRoutes;
