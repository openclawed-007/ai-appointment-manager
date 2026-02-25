'use strict';

function registerTypeRoutes(app, deps) {
  const {
    dbAll,
    dbRun,
    dbGet,
    rowToType,
    getBusinessBySlug,
    USE_POSTGRES,
    pgPool: getPgPool,
    sqlite: getSqlite,
    COLORS
  } = deps;

// ── Types routes ──────────────────────────────────────────────────────────────

app.get('/api/types', async (req, res) => {
  let businessId = req.auth?.businessId;
  if (!businessId && req.query.businessSlug) {
    const business = await getBusinessBySlug(String(req.query.businessSlug));
    if (!business) return res.status(404).json({ error: 'Business not found.' });
    businessId = Number(business.id);
  }
  if (!businessId) return res.status(401).json({ error: 'Authentication required.' });
  const rows = await dbAll(
    'SELECT * FROM appointment_types WHERE business_id = ? AND active = 1 ORDER BY id ASC',
    'SELECT * FROM appointment_types WHERE business_id = $1 AND active = TRUE ORDER BY id ASC',
    [businessId]
  );
  res.json({ types: rows.map(rowToType) });
});

app.post('/api/types', async (req, res) => {
  const businessId = req.auth.businessId;
  const { name, durationMinutes, priceCents, locationMode, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (String(name).trim().length > 200) return res.status(400).json({ error: 'name is too long (max 200 characters)' });

  const params = [
    name.trim(),
    Number(durationMinutes || 45),
    Number(priceCents || 0),
    locationMode || 'hybrid',
    color || COLORS[Math.floor(Math.random() * COLORS.length)]
  ];

  let row;
  if (USE_POSTGRES) {
    row = (
      await getPgPool().query(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [businessId, ...params]
      )
    ).rows[0];
  } else {
    const result = getSqlite()
      .prepare(
        `INSERT INTO appointment_types (business_id, name, duration_minutes, price_cents, location_mode, color)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(businessId, ...params);
    row = getSqlite().prepare('SELECT * FROM appointment_types WHERE id = ?').get(result.lastInsertRowid);
  }

  res.status(201).json({ type: rowToType(row) });
});

app.put('/api/types/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  const { name, durationMinutes, priceCents, locationMode, color, active } = req.body || {};

  await dbRun(
    `UPDATE appointment_types
     SET name = COALESCE(?, name),
         duration_minutes = COALESCE(?, duration_minutes),
         price_cents = COALESCE(?, price_cents),
         location_mode = COALESCE(?, location_mode),
         color = COALESCE(?, color),
         active = COALESCE(?, active)
     WHERE id = ? AND business_id = ?`,
    `UPDATE appointment_types
     SET name = COALESCE($1, name),
         duration_minutes = COALESCE($2, duration_minutes),
         price_cents = COALESCE($3, price_cents),
         location_mode = COALESCE($4, location_mode),
         color = COALESCE($5, color),
         active = COALESCE($6, active)
     WHERE id = $7 AND business_id = $8`,
    [
      name || null,
      durationMinutes == null ? null : Number(durationMinutes),
      priceCents == null ? null : Number(priceCents),
      locationMode || null,
      color || null,
      active == null ? null : USE_POSTGRES ? !!active : Number(!!active),
      id,
      businessId
    ]
  );

  const row = await dbGet(
    'SELECT * FROM appointment_types WHERE id = ? AND business_id = ?',
    'SELECT * FROM appointment_types WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );

  if (!row) return res.status(404).json({ error: 'type not found' });
  res.json({ type: rowToType(row) });
});

app.delete('/api/types/:id', async (req, res) => {
  const businessId = req.auth.businessId;
  await dbRun(
    'UPDATE appointment_types SET active = 0 WHERE id = ? AND business_id = ?',
    'UPDATE appointment_types SET active = FALSE WHERE id = $1 AND business_id = $2',
    [Number(req.params.id), businessId]
  );
  res.json({ ok: true });
});

}

module.exports = registerTypeRoutes;
