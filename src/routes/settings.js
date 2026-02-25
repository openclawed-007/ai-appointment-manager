'use strict';

function registerSettingsRoutes(app, deps) {
  const {
    dbGet,
    dbRun,
    getSettings,
    getBusinessById,
    resolveWorkspaceMode,
    parseBusinessHoursJson,
    normalizeBusinessHours,
    normalizeWorkspaceMode,
    parseTimeOrThrow,
    DEFAULT_PUBLIC_BOOKING_OPEN_TIME,
    DEFAULT_PUBLIC_BOOKING_CLOSE_TIME,
    USE_POSTGRES
  } = deps;

// ── Settings routes ───────────────────────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  const settings = (await getSettings(req.auth.businessId)) || {};
  const workspaceMode = resolveWorkspaceMode(settings);
  const businessHours = parseBusinessHoursJson(
    settings.business_hours_json,
    String(settings.open_time || DEFAULT_PUBLIC_BOOKING_OPEN_TIME).slice(0, 5),
    String(settings.close_time || DEFAULT_PUBLIC_BOOKING_CLOSE_TIME).slice(0, 5)
  );
  const userPrefs = await dbGet(
    'SELECT theme_preference, accent_color FROM users WHERE id = ? AND business_id = ?',
    'SELECT theme_preference, accent_color FROM users WHERE id = $1 AND business_id = $2',
    [req.auth.userId, req.auth.businessId]
  );
  res.json({
    settings: {
      ...settings,
      reminder_mode: workspaceMode === 'reminders',
      workspace_mode: workspaceMode,
      businessHours,
      theme: (userPrefs?.theme_preference === 'dark' || userPrefs?.theme_preference === 'light')
        ? userPrefs.theme_preference
        : null,
      accentColor: userPrefs?.accent_color || 'green'
    }
  });
});

app.put('/api/settings', async (req, res) => {
  const { businessName, ownerEmail, timezone, notifyOwnerEmail, reminderMode, workspaceMode, openTime, closeTime, businessHours } = req.body || {};
  const incomingTheme = req.body?.theme;
  const incomingAccent = req.body?.accentColor;
  const businessId = req.auth.businessId;
  const currentSettings = (await getSettings(businessId)) || {};
  const business = await getBusinessById(businessId);
  const normalizedOpenTime = openTime == null || openTime === '' ? null : String(openTime).slice(0, 5);
  const normalizedCloseTime = closeTime == null || closeTime === '' ? null : String(closeTime).slice(0, 5);
  let normalizedBusinessHours = null;
  try {
    if (normalizedOpenTime) parseTimeOrThrow(normalizedOpenTime);
    if (normalizedCloseTime) parseTimeOrThrow(normalizedCloseTime);
    if (normalizedOpenTime && normalizedCloseTime) {
      const openMinutes = parseTimeOrThrow(normalizedOpenTime);
      const closeMinutes = parseTimeOrThrow(normalizedCloseTime);
      if (closeMinutes <= openMinutes) {
        return res.status(400).json({ error: 'Close time must be later than open time.' });
      }
    }
    normalizedBusinessHours = businessHours == null
      ? null
      : normalizeBusinessHours(
        businessHours,
        normalizedOpenTime || DEFAULT_PUBLIC_BOOKING_OPEN_TIME,
        normalizedCloseTime || DEFAULT_PUBLIC_BOOKING_CLOSE_TIME
      );
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const nextBusinessName = String(
    businessName ??
    currentSettings.business_name ??
    business?.name ??
    'IntelliBook'
  ).trim() || 'IntelliBook';
  const nextOwnerEmail = ownerEmail ?? currentSettings.owner_email ?? business?.owner_email ?? null;
  const nextTimezone = timezone ?? currentSettings.timezone ?? business?.timezone ?? 'America/Los_Angeles';
  const nextNotifyOwnerEmail = notifyOwnerEmail === undefined
    ? currentSettings.notify_owner_email
    : notifyOwnerEmail;
  const currentWorkspaceMode = resolveWorkspaceMode(currentSettings);
  const nextWorkspaceMode = workspaceMode !== undefined
    ? normalizeWorkspaceMode(workspaceMode, currentWorkspaceMode)
    : (reminderMode === undefined
      ? currentWorkspaceMode
      : (Boolean(reminderMode) ? 'reminders' : 'appointments'));
  const nextReminderMode = nextWorkspaceMode === 'reminders';
  const nextOpenTime = normalizedOpenTime
    || String(currentSettings.open_time || DEFAULT_PUBLIC_BOOKING_OPEN_TIME).slice(0, 5);
  const nextCloseTime = normalizedCloseTime
    || String(currentSettings.close_time || DEFAULT_PUBLIC_BOOKING_CLOSE_TIME).slice(0, 5);
  const nextBusinessHoursJson = normalizedBusinessHours
    ? JSON.stringify(normalizedBusinessHours)
    : (currentSettings.business_hours_json || null);

  await dbRun(
    `INSERT INTO business_settings
       (business_id, business_name, owner_email, timezone, notify_owner_email, reminder_mode, workspace_mode, open_time, close_time, business_hours_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(business_id) DO UPDATE SET
       business_name = excluded.business_name,
       owner_email = excluded.owner_email,
       timezone = excluded.timezone,
       notify_owner_email = excluded.notify_owner_email,
       reminder_mode = excluded.reminder_mode,
       workspace_mode = excluded.workspace_mode,
       open_time = excluded.open_time,
       close_time = excluded.close_time,
       business_hours_json = excluded.business_hours_json`,
    `INSERT INTO business_settings
       (business_id, business_name, owner_email, timezone, notify_owner_email, reminder_mode, workspace_mode, open_time, close_time, business_hours_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (business_id) DO UPDATE SET
       business_name = EXCLUDED.business_name,
       owner_email = EXCLUDED.owner_email,
       timezone = EXCLUDED.timezone,
       notify_owner_email = EXCLUDED.notify_owner_email,
       reminder_mode = EXCLUDED.reminder_mode,
       workspace_mode = EXCLUDED.workspace_mode,
       open_time = EXCLUDED.open_time,
       close_time = EXCLUDED.close_time,
       business_hours_json = EXCLUDED.business_hours_json`,
    [
      businessId,
      nextBusinessName,
      nextOwnerEmail,
      nextTimezone,
      USE_POSTGRES
        ? Boolean(nextNotifyOwnerEmail == null ? true : nextNotifyOwnerEmail)
        : Number(Boolean(nextNotifyOwnerEmail == null ? true : nextNotifyOwnerEmail)),
      USE_POSTGRES ? Boolean(nextReminderMode) : Number(Boolean(nextReminderMode)),
      nextWorkspaceMode,
      nextOpenTime,
      nextCloseTime,
      nextBusinessHoursJson
    ]
  );

  const normalizedTheme = incomingTheme === 'dark' || incomingTheme === 'light' ? incomingTheme : null;
  const VALID_COLORS = ['green', 'blue', 'red', 'purple', 'amber'];
  const normalizedAccent = VALID_COLORS.includes(incomingAccent) ? incomingAccent : null;

  if (normalizedTheme || normalizedAccent) {
    await dbRun(
      `UPDATE users
       SET theme_preference = COALESCE(?, theme_preference),
           accent_color = COALESCE(?, accent_color)
       WHERE id = ? AND business_id = ?`,
      `UPDATE users
       SET theme_preference = COALESCE($1, theme_preference),
           accent_color = COALESCE($2, accent_color)
       WHERE id = $3 AND business_id = $4`,
      [normalizedTheme, normalizedAccent, req.auth.userId, businessId]
    );
  }

  const settings = (await getSettings(businessId)) || {};
  const responseWorkspaceMode = resolveWorkspaceMode(settings);
  const responseBusinessHours = parseBusinessHoursJson(
    settings.business_hours_json,
    String(settings.open_time || DEFAULT_PUBLIC_BOOKING_OPEN_TIME).slice(0, 5),
    String(settings.close_time || DEFAULT_PUBLIC_BOOKING_CLOSE_TIME).slice(0, 5)
  );
  const userPrefs = await dbGet(
    'SELECT theme_preference, accent_color FROM users WHERE id = ? AND business_id = ?',
    'SELECT theme_preference, accent_color FROM users WHERE id = $1 AND business_id = $2',
    [req.auth.userId, businessId]
  );
  res.json({
    settings: {
      ...settings,
      reminder_mode: responseWorkspaceMode === 'reminders',
      workspace_mode: responseWorkspaceMode,
      businessHours: responseBusinessHours,
      theme: (userPrefs?.theme_preference === 'dark' || userPrefs?.theme_preference === 'light')
        ? userPrefs.theme_preference
        : null,
      accentColor: userPrefs?.accent_color || 'green'
    }
  });
});

}

module.exports = registerSettingsRoutes;
