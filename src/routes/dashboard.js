'use strict';

function registerDashboardRoutes(app, deps) {
  const {
    USE_POSTGRES,
    pgPool: getPgPool,
    sqlite: getSqlite,
    dbAll,
    rowToAppointment,
    rowToType,
    createInsights
  } = deps;

// ── Notifications route ───────────────────────────────────────────────────────

app.get('/api/notifications', async (req, res) => {
  const businessId = req.auth.businessId;
  const today = new Date().toISOString().slice(0, 10);

  if (USE_POSTGRES) {
    const [todayQ, weekQ, pendingQ, pendingItemsQ] = await Promise.all([
      getPgPool().query('SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND date = $2', [businessId, today]),
      getPgPool().query(
        "SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND date BETWEEN $2::date AND ($2::date + INTERVAL '6 day')",
        [businessId, today]
      ),
      getPgPool().query("SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND status = 'pending'", [businessId]),
      getPgPool().query(
        `SELECT a.id, a.date, a.time, a.client_name, COALESCE(t.name, a.title, 'Appointment') AS type_name
         FROM appointments a
         LEFT JOIN appointment_types t ON t.id = a.type_id
         WHERE a.business_id = $1 AND a.status = 'pending'
         ORDER BY a.date ASC, a.time ASC
         LIMIT 6`,
        [businessId]
      )
    ]);

    return res.json({
      summary: {
        today: Number(todayQ.rows[0]?.c || 0),
        week: Number(weekQ.rows[0]?.c || 0),
        pending: Number(pendingQ.rows[0]?.c || 0)
      },
      pending: pendingItemsQ.rows.map((r) => ({
        id: Number(r.id),
        date: typeof r.date === 'string' ? r.date.slice(0, 10) : r.date?.toISOString?.().slice(0, 10),
        time: typeof r.time === 'string' ? r.time.slice(0, 5) : '09:00',
        clientName: r.client_name,
        typeName: r.type_name || 'Appointment'
      }))
    });
  }

  const todayCount = getSqlite().prepare('SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND date = ?').get(businessId, today).c;
  const weekCount = getSqlite()
    .prepare("SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND date BETWEEN date(?) AND date(?, '+6 day')")
    .get(businessId, today, today).c;
  const pendingCount = getSqlite().prepare("SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND status = 'pending'").get(businessId).c;
  const pendingRows = getSqlite().prepare(
    `SELECT a.id, a.date, a.time, a.client_name, COALESCE(t.name, a.title, 'Appointment') AS type_name
     FROM appointments a
     LEFT JOIN appointment_types t ON t.id = a.type_id
     WHERE a.business_id = ? AND a.status = 'pending'
     ORDER BY a.date ASC, a.time ASC
     LIMIT 6`
  ).all(businessId);

  return res.json({
    summary: {
      today: Number(todayCount || 0),
      week: Number(weekCount || 0),
      pending: Number(pendingCount || 0)
    },
    pending: pendingRows.map((r) => ({
      id: Number(r.id),
      date: r.date,
      time: String(r.time || '').slice(0, 5),
      clientName: r.client_name,
      typeName: r.type_name || 'Appointment'
    }))
  });
});

// ── Dashboard route ───────────────────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  const businessId = req.auth.businessId;
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  let stats;
  if (USE_POSTGRES) {
    const statsRow = (
      await getPgPool().query(
        `SELECT
           COUNT(*) FILTER (WHERE date = $2)::int AS today,
           COUNT(*) FILTER (WHERE date BETWEEN $2::date AND ($2::date + INTERVAL '6 day'))::int AS week,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM appointments
         WHERE business_id = $1`,
        [businessId, date]
      )
    ).rows[0] || {};
    stats = {
      today: Number(statsRow.today || 0),
      week: Number(statsRow.week || 0),
      pending: Number(statsRow.pending || 0)
    };
  } else {
    const statsRow = getSqlite().prepare(
      `SELECT
         SUM(CASE WHEN date = ? THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN date BETWEEN date(?) AND date(?, '+6 day') THEN 1 ELSE 0 END) AS week,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM appointments
       WHERE business_id = ?`
    ).get(date, date, date, businessId) || {};
    stats = {
      today: Number(statsRow.today || 0),
      week: Number(statsRow.week || 0),
      pending: Number(statsRow.pending || 0)
    };
  }

  const [appointmentRows, typeRows, insights] = await Promise.all([
    dbAll(
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date = ?
       ORDER BY a.time ASC`,
      `SELECT a.*, t.name AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date = $2
       ORDER BY a.time ASC`,
      [businessId, date]
    ),
    dbAll(
      `SELECT t.*, COUNT(a.id) AS booking_count
       FROM appointment_types t
       LEFT JOIN appointments a ON a.type_id = t.id AND a.business_id = ?
       WHERE t.business_id = ? AND t.active = 1
       GROUP BY t.id
       ORDER BY t.id ASC`,
      `SELECT t.*, COUNT(a.id)::int AS booking_count
       FROM appointment_types t
       LEFT JOIN appointments a ON a.type_id = t.id AND a.business_id = $1
       WHERE t.business_id = $2 AND t.active = TRUE
       GROUP BY t.id
       ORDER BY t.id ASC`,
      [businessId, businessId]
    ),
    createInsights(date, businessId)
  ]);

  const appointments = appointmentRows.map(rowToAppointment);
  const types = typeRows.map((row) => ({ ...rowToType(row), bookingCount: Number(row.booking_count || 0) }));

  res.json({ stats, appointments, types, insights });
});

}

module.exports = registerDashboardRoutes;
