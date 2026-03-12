const appStateCore = (() => {
  if (typeof module !== 'undefined' && module.exports) {
    return require('./state');
  }
  if (typeof window !== 'undefined' && window.AppStateCore) {
    return window.AppStateCore;
  }
  throw new Error('AppStateCore is not initialized.');
})();

const {
  state,
  CALENDAR_MONTH_CACHE_TTL_MS,
  CALENDAR_VIEW_MODES,
  calendarMonthCache,
  calendarMonthInFlight,
  OFFLINE_MUTATION_QUEUE_KEY,
  AUTH_SNAPSHOT_KEY,
  ACCENT_COLORS,
  WORKSPACE_MODES,
  MOBILE_NAV_MODE_KEY,
  REMINDER_NOTIFIED_KEYS_STORAGE,
  BUSINESS_HOURS_DAYS,
  GLOBAL_SEARCH_SETTINGS_OPTIONS
} = appStateCore;
const BROWSER_NOTIFICATIONS_KEY = 'browserNotificationsEnabled';
const appUtils = (() => {
  if (typeof module !== 'undefined' && module.exports) {
    return require('./utils');
  }
  if (typeof window !== 'undefined' && window.AppUtils) {
    return window.AppUtils;
  }
  throw new Error('AppUtils is not initialized.');
})();
const {
  EXPORT_CSV_COLUMNS,
  EXPORT_CSV_HEADERS,
  localYmd,
  parseYmd,
  getWeekStart,
  addDays,
  toTime12,
  toTimeCompact,
  escapeHtml,
  monthLabel,
  csvEscape,
  buildCsvLines,
  filterAppointmentsForExport,
  buildFilteredExportFilename,
  buildFilteredExportJsonPayload
} = appUtils;

function getStoredBoolean(key, fallback = false) {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    return localStorage.getItem(key) === 'true';
  } catch (_error) {
    return fallback;
  }
}

function setStoredValue(key, value) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, String(value));
  } catch (_error) {
    // Ignore storage write failures.
  }
}

function canUseBrowserNotifications() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function getNotificationPermission() {
  if (!canUseBrowserNotifications()) return 'denied';
  return Notification.permission;
}

function loadNotifiedReminderKeys() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(REMINDER_NOTIFIED_KEYS_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function saveNotifiedReminderKeys(keys = {}) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(REMINDER_NOTIFIED_KEYS_STORAGE, JSON.stringify(keys));
  } catch (_error) {
    // Ignore storage write failures.
  }
}

function pruneNotifiedReminderKeys(keys = {}, maxAgeMs = 3 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(keys).filter(([, seenAt]) => Number.isFinite(Number(seenAt)) && now - Number(seenAt) <= maxAgeMs)
  );
}

function getStoredCalendarViewMode() {
  if (typeof localStorage === 'undefined') return 'month';
  try {
    return normalizeCalendarViewMode(localStorage.getItem('calendarViewMode'));
  } catch (_error) {
    return 'month';
  }
}

function normalizeCalendarViewMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return CALENDAR_VIEW_MODES.includes(mode) ? mode : 'month';
}

function normalizeAccentColor(value) {
  const color = String(value || '').trim();
  return ACCENT_COLORS.includes(color) ? color : 'green';
}

function normalizeWorkspaceMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return WORKSPACE_MODES.includes(mode) ? mode : 'appointments';
}

function getStoredWorkspaceMode(fallback = 'appointments') {
  if (typeof localStorage === 'undefined') return normalizeWorkspaceMode(fallback);
  try {
    const raw = localStorage.getItem('workspaceMode');
    if (raw) return normalizeWorkspaceMode(raw);
    return normalizeWorkspaceMode(fallback);
  } catch (_error) {
    return normalizeWorkspaceMode(fallback);
  }
}

function applyAccentColor(color) {
  const normalized = normalizeAccentColor(color);
  ACCENT_COLORS.forEach((accent) => {
    if (accent !== 'green') {
      document.body.classList.remove(`theme-color-${accent}`);
    }
  });
  if (normalized !== 'green') {
    document.body.classList.add(`theme-color-${normalized}`);
  }
  return normalized;
}

function buildDefaultBusinessHours(openTime = '09:00', closeTime = '18:00') {
  return BUSINESS_HOURS_DAYS.reduce((acc, day) => {
    acc[day] = { closed: false, openTime, closeTime };
    return acc;
  }, {});
}

function normalizeBusinessHoursInput(input, fallbackOpen = '09:00', fallbackClose = '18:00') {
  const defaults = buildDefaultBusinessHours(fallbackOpen, fallbackClose);
  if (!input || typeof input !== 'object') return defaults;
  return BUSINESS_HOURS_DAYS.reduce((acc, day) => {
    const value = input[day] && typeof input[day] === 'object' ? input[day] : {};
    acc[day] = {
      closed: Boolean(value.closed),
      openTime: String(value.openTime || fallbackOpen).slice(0, 5),
      closeTime: String(value.closeTime || fallbackClose).slice(0, 5)
    };
    return acc;
  }, {});
}

function setBusinessHoursRowClosedState(dayKey, closed) {
  const row = document.querySelector(`.business-hours-row[data-day-key="${dayKey}"]`);
  row?.classList.toggle('is-closed', Boolean(closed));
}

function applyBusinessHoursToForm(hours, fallbackOpen = '09:00', fallbackClose = '18:00') {
  const normalized = normalizeBusinessHoursInput(hours, fallbackOpen, fallbackClose);
  BUSINESS_HOURS_DAYS.forEach((day) => {
    const closedInput = document.getElementById(`settings-hours-${day}-closed`);
    const openInput = document.getElementById(`settings-hours-${day}-open`);
    const closeInput = document.getElementById(`settings-hours-${day}-close`);
    if (closedInput) closedInput.checked = Boolean(normalized[day].closed);
    if (openInput) openInput.value = normalized[day].openTime;
    if (closeInput) closeInput.value = normalized[day].closeTime;
    setBusinessHoursRowClosedState(day, normalized[day].closed);
  });
}

function setBusinessHoursDayValues(day, values) {
  const closedInput = document.getElementById(`settings-hours-${day}-closed`);
  const openInput = document.getElementById(`settings-hours-${day}-open`);
  const closeInput = document.getElementById(`settings-hours-${day}-close`);
  if (closedInput) closedInput.checked = Boolean(values.closed);
  if (openInput) openInput.value = String(values.openTime || '09:00').slice(0, 5);
  if (closeInput) closeInput.value = String(values.closeTime || '18:00').slice(0, 5);
  setBusinessHoursRowClosedState(day, Boolean(values.closed));
}

function collectBusinessHoursFromForm({ validate = true } = {}) {
  const result = {};
  for (const day of BUSINESS_HOURS_DAYS) {
    const closed = Boolean(document.getElementById(`settings-hours-${day}-closed`)?.checked);
    const openTime = String(document.getElementById(`settings-hours-${day}-open`)?.value || '09:00').slice(0, 5);
    const closeTime = String(document.getElementById(`settings-hours-${day}-close`)?.value || '18:00').slice(0, 5);
    if (validate && !closed && openTime >= closeTime) {
      throw new Error(`Close time must be later than open time for ${day.toUpperCase()}.`);
    }
    result[day] = { closed, openTime, closeTime };
  }
  return result;
}

function isReminderModeEnabled() {
  return String(state.workspaceMode || '').toLowerCase() === 'reminders';
}

function isClientModeEnabled() {
  return String(state.workspaceMode || '').toLowerCase() === 'clients';
}

function setWorkspaceMode(mode, { persist = true } = {}) {
  const normalized = normalizeWorkspaceMode(mode);
  state.workspaceMode = normalized;
  state.reminderMode = normalized === 'reminders';
  if (persist) {
    setStoredValue('workspaceMode', normalized);
    setStoredValue('reminderMode', state.reminderMode);
  }
  const reminderToggle = document.getElementById('settings-reminder-mode');
  if (reminderToggle) {
    reminderToggle.checked = state.reminderMode;
    reminderToggle.disabled = normalized === 'clients';
  }
  const workspaceSelect = document.getElementById('settings-workspace-mode');
  if (workspaceSelect && workspaceSelect.value !== normalized) workspaceSelect.value = normalized;
  applyReminderModeUi();
}

function getEntryWordPlural() {
  return isReminderModeEnabled() ? 'reminders' : 'appointments';
}

function getEntryWordSingularTitle() {
  return isReminderModeEnabled() ? 'Reminder' : 'Appointment';
}

function getEntryWordPluralTitle() {
  return isReminderModeEnabled() ? 'Reminders' : 'Appointments';
}

function isReminderEntry(entry = {}) {
  return String(entry?.source || '').toLowerCase() === 'reminder';
}

function formatEntryTimeRange(entry = {}) {
  const start = toTime12(entry.time || '09:00');
  const duration = Number(entry.durationMinutes || 0);
  if (isReminderEntry(entry) || duration <= 0) return start;
  return `${start} - ${toTime12(addMinutesToTime(entry.time, duration))}`;
}

function syncAppointmentDurationFieldVisibility() {
  const form = document.getElementById('appointment-form');
  if (!form) return;
  const durationGroup = document.getElementById('appt-duration-group');
  const durationSelect = form.querySelector('select[name="durationMinutes"]');
  const isReminder = isReminderModeEnabled() || String(form.dataset.entrySource || '').toLowerCase() === 'reminder';
  if (durationGroup) durationGroup.classList.toggle('hidden', isReminder);
  if (durationSelect) {
    durationSelect.disabled = isReminder;
    if (isReminder) durationSelect.value = '0';
  }
}

function applyReminderModeUi() {
  const reminderMode = isReminderModeEnabled();
  const clientMode = isClientModeEnabled();
  document.body.classList.toggle('reminder-mode', reminderMode);
  document.body.classList.toggle('clients-mode', clientMode);

  const setText = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  };

  const entrySingularTitle = getEntryWordSingularTitle();
  const entryPluralTitle = getEntryWordPluralTitle();
  const entryPlural = getEntryWordPlural();

  setText('#nav-appointments span', entryPluralTitle);
  setText('.mobile-nav-item[data-view="appointments"] span', reminderMode ? 'Reminders' : 'Appointments');
  setText('section[data-view="appointments"] .page-header-main h2', entryPluralTitle);
  setText('#btn-new-appointment span', `New ${entrySingularTitle}`);
  setText('#stat-card-today .stat-hint', `${entryPlural} today`);
  setText('#stat-card-week .stat-hint', reminderMode ? 'scheduled this week' : 'booked this week');

  const searchInput = document.getElementById('global-search');
  if (searchInput) {
    searchInput.placeholder = clientMode
      ? 'Search clients, notes, or status...'
      : (reminderMode
        ? 'Search reminders, notes, or types...'
        : 'Search appointments, clients, or types...');
  }

  const openCloseRow = document.getElementById('settings-open-close-row');
  const businessHoursSection = document.getElementById('settings-business-hours-section');
  if (openCloseRow) openCloseRow.classList.toggle('hidden', reminderMode || clientMode);
  if (businessHoursSection) businessHoursSection.classList.toggle('hidden', reminderMode || clientMode);

  const openInput = document.getElementById('settings-open-time');
  const closeInput = document.getElementById('settings-close-time');
  if (openInput) openInput.disabled = reminderMode || clientMode;
  if (closeInput) closeInput.disabled = reminderMode || clientMode;

  const scheduleCard = document.querySelector('.schedule-card');
  if (scheduleCard) {
    scheduleCard.removeAttribute('hidden');
    scheduleCard.classList.remove('hidden');
  }

  document.querySelectorAll('.nav-item[data-view="ai"], .mobile-nav-item[data-view="ai"]').forEach((node) => {
    if (reminderMode || clientMode) {
      node.setAttribute('hidden', 'hidden');
      node.classList.add('hidden');
    } else {
      node.removeAttribute('hidden');
      node.classList.remove('hidden');
    }
  });
  const aiView = document.querySelector('.app-view[data-view="ai"]');
  if (aiView) {
    if (reminderMode || clientMode) {
      aiView.setAttribute('hidden', 'hidden');
      aiView.classList.add('hidden');
    } else {
      aiView.removeAttribute('hidden');
      aiView.classList.remove('hidden');
    }
  }
  if ((reminderMode || clientMode) && getActiveView() === 'ai') {
    setActiveView('dashboard');
  }

  document.querySelectorAll('.nav-item[data-view="types"], .mobile-nav-item[data-view="types"]').forEach((node) => {
    if (reminderMode || clientMode) {
      node.setAttribute('hidden', 'hidden');
      node.classList.add('hidden');
    } else {
      node.removeAttribute('hidden');
      node.classList.remove('hidden');
    }
  });
  const typesView = document.querySelector('.app-view[data-view="types"]');
  if (typesView) {
    if (reminderMode || clientMode) {
      typesView.setAttribute('hidden', 'hidden');
      typesView.classList.add('hidden');
    } else {
      typesView.removeAttribute('hidden');
      typesView.classList.remove('hidden');
    }
  }
  const manageTypesBtn = document.getElementById('btn-manage-types');
  const dashboardTypesCard = manageTypesBtn?.closest('.card');
  if (dashboardTypesCard) {
    if (reminderMode || clientMode) {
      dashboardTypesCard.setAttribute('hidden', 'hidden');
      dashboardTypesCard.classList.add('hidden');
    } else {
      dashboardTypesCard.removeAttribute('hidden');
      dashboardTypesCard.classList.remove('hidden');
    }
  }
  if ((reminderMode || clientMode) && getActiveView() === 'types') {
    setActiveView('dashboard');
  }

  document.querySelectorAll('.nav-item[data-view="dashboard"], .mobile-nav-item[data-view="dashboard"]').forEach((node) => {
    node.removeAttribute('hidden');
    node.classList.remove('hidden');
  });
  const dashboardView = document.querySelector('.app-view[data-view="dashboard"]');
  if (dashboardView) {
    dashboardView.removeAttribute('hidden');
    dashboardView.classList.remove('hidden');
  }

  document.querySelectorAll('.nav-item[data-view="appointments"], .mobile-nav-item[data-view="appointments"]').forEach((node) => {
    if (clientMode) {
      node.setAttribute('hidden', 'hidden');
      node.classList.add('hidden');
    } else {
      node.removeAttribute('hidden');
      node.classList.remove('hidden');
    }
  });
  const appointmentsView = document.querySelector('.app-view[data-view="appointments"]');
  if (appointmentsView) {
    if (clientMode) {
      appointmentsView.setAttribute('hidden', 'hidden');
      appointmentsView.classList.add('hidden');
    } else {
      appointmentsView.removeAttribute('hidden');
      appointmentsView.classList.remove('hidden');
    }
  }

  const createBtn = document.getElementById('btn-new-appointment');
  if (createBtn) {
    createBtn.removeAttribute('hidden');
    createBtn.classList.remove('hidden');
  }

  if (clientMode && getActiveView() === 'appointments') {
    setActiveView('dashboard');
  }

  const typeHeader = document.querySelector('section[data-view="dashboard"] .card .card-header h2');
  if (typeHeader && (typeHeader.textContent === 'Appointment Types' || typeHeader.textContent === 'Reminder Types')) {
    typeHeader.textContent = `${entrySingularTitle} Types`;
  }
  syncAppointmentDurationFieldVisibility();
}

function normalizeMobileNavMode(mode) {
  return mode === 'sidebar' ? 'sidebar' : 'bottom';
}

function getStoredMobileNavMode() {
  if (typeof localStorage === 'undefined') return 'bottom';
  try {
    return normalizeMobileNavMode(localStorage.getItem(MOBILE_NAV_MODE_KEY));
  } catch (_error) {
    return 'bottom';
  }
}

function applyMobileNavMode(mode, { persist = true } = {}) {
  const normalized = normalizeMobileNavMode(mode);
  const useBottomTabs = normalized === 'bottom';
  document.body.classList.toggle('mobile-nav-mode-bottom', useBottomTabs);
  document.body.classList.toggle('mobile-nav-mode-sidebar', !useBottomTabs);
  if (persist) setStoredValue(MOBILE_NAV_MODE_KEY, normalized);

  const navModeToggle = document.getElementById('settings-mobile-nav-bottom-tabs');
  if (navModeToggle && navModeToggle.checked !== useBottomTabs) {
    navModeToggle.checked = useBottomTabs;
  }
  const navModeLabel = document.getElementById('settings-mobile-nav-mode-label');
  if (navModeLabel) {
    navModeLabel.textContent = useBottomTabs ? 'Bottom Tabs' : 'Sidebar Menu';
  }

  if (useBottomTabs) {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    if (sidebarBackdrop) {
      sidebarBackdrop.classList.remove('visible');
      sidebarBackdrop.hidden = true;
    }
    document.body.classList.remove('sidebar-open');
    document.getElementById('btn-mobile-menu')?.setAttribute('aria-expanded', 'false');
  }

  return normalized;
}

function loadAuthSnapshot() {
  try {
    const raw = localStorage.getItem(AUTH_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.user || !parsed.business) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

function saveAuthSnapshot(user, business) {
  try {
    if (!user || !business) {
      localStorage.removeItem(AUTH_SNAPSHOT_KEY);
      return;
    }
    localStorage.setItem(
      AUTH_SNAPSHOT_KEY,
      JSON.stringify({
        user,
        business,
        updatedAt: new Date().toISOString()
      })
    );
  } catch (_error) {
    // Ignore storage failures.
  }
}

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('hidden'));
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  state.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (modalId === 'new-appointment') setAppointmentDefaults();
  const focusables = getFocusableElements(modal);
  focusables[0]?.focus();
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove('active');
  document.body.style.overflow = '';
  state.lastFocusedElement?.focus?.();
  if (modalId === 'new-appointment') {
    state.editingAppointmentId = null;
    updateAppointmentEditorUi(false);
  }
}

function updateAppointmentEditorUi(isEditing) {
  const title = document.getElementById('new-appointment-title');
  const subtitle = document.getElementById('new-appointment-subtitle');
  const submit = document.querySelector('#appointment-form button[type="submit"]');
  const form = document.getElementById('appointment-form');
  const reminderModeEnabled = isReminderModeEnabled() || String(form?.dataset?.entrySource || '').toLowerCase() === 'reminder';
  const entryWord = getEntryWordSingularTitle();
  if (title) title.textContent = isEditing ? `Edit ${entryWord}` : `Create ${entryWord}`;
  if (subtitle) {
    subtitle.textContent = isEditing
      ? `Update details for this ${entryWord.toLowerCase()}.`
      : reminderModeEnabled
        ? 'Capture a reminder with date and time.'
        : 'Add client details, lock a slot, and send confirmation.';
  }
  if (submit) submit.textContent = isEditing ? 'Save Changes' : `Create ${entryWord}`;

  const clientNameLabel = document.querySelector('label[for="appt-client-name"]');
  if (clientNameLabel) clientNameLabel.textContent = reminderModeEnabled ? 'Reminder' : 'Client Name';
  const clientNameInput = document.getElementById('appt-client-name');
  if (clientNameInput) {
    clientNameInput.placeholder = reminderModeEnabled ? 'e.g. Pay rent' : 'e.g. Jane Smith';
  }
  syncAppointmentDurationFieldVisibility();
}

function fillAppointmentForm(appointment) {
  const form = document.getElementById('appointment-form');
  if (!form || !appointment) return;

  if (appointment.typeId) state.selectedTypeId = Number(appointment.typeId);
  renderTypeSelector(state.types);

  form.clientName.value = appointment.clientName || '';
  form.clientEmail.value = appointment.clientEmail || '';
  form.date.value = appointment.date || '';
  form.time.value = appointment.time || '';
  form.durationMinutes.value = String(appointment.durationMinutes || 45);
  if (form.reminderOffsetMinutes) {
    form.reminderOffsetMinutes.value = String(
      appointment.reminderOffsetMinutes == null ? 10 : Number(appointment.reminderOffsetMinutes)
    );
  }
  if (appointment.notes != null) form.notes.value = appointment.notes;
  const locationRadio = form.querySelector(`input[name="location"][value="${appointment.location || 'office'}"]`);
  if (locationRadio) locationRadio.checked = true;
  form.dataset.entrySource = isReminderEntry(appointment) ? 'reminder' : 'owner';
  syncAppointmentDurationFieldVisibility();
  updateAppointmentEditorUi(Boolean(state.editingAppointmentId));
  updateAppointmentPreview();
}

function startEditAppointment(appointment) {
  if (!appointment) return;
  state.editingAppointmentId = Number(appointment.id);
  updateAppointmentEditorUi(true);
  openModal('new-appointment');
  fillAppointmentForm(appointment);
}

function formatMenuDate(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return dateStr;
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatNoteTimestamp(value) {
  const dt = new Date(value || '');
  if (Number.isNaN(dt.getTime())) return 'Recently';
  return dt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getVisibleWeekDates(baseDate = state.calendarDate) {
  const start = getWeekStart(baseDate);
  return Array.from({ length: 7 }, (_, idx) => localYmd(addDays(start, idx)));
}

function getVisibleCalendarDates(baseDate = state.calendarDate, mode = state.calendarViewMode) {
  const resolvedMode = normalizeCalendarViewMode(mode);
  if (resolvedMode === 'day') {
    return [localYmd(baseDate)];
  }
  if (resolvedMode === 'week') {
    return getVisibleWeekDates(baseDate);
  }
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, idx) => {
    const day = String(idx + 1).padStart(2, '0');
    const mm = String(month + 1).padStart(2, '0');
    return `${year}-${mm}-${day}`;
  });
}

function getCalendarHeaderLabel() {
  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode === 'month') return monthLabel(state.calendarDate);
  if (mode === 'day') {
    const date = parseYmd(localYmd(state.calendarDate));
    if (!date) return monthLabel(state.calendarDate);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const weekDates = getVisibleCalendarDates(state.calendarDate, 'week');
  const start = parseYmd(weekDates[0]);
  const end = parseYmd(weekDates[6]);
  if (!start || !end) return monthLabel(state.calendarDate);
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    const month = start.toLocaleDateString('en-US', { month: 'short' });
    return `${month} ${start.getDate()} - ${end.getDate()}`;
  }
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endLabel = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${startLabel} - ${endLabel}`;
}

function dayOrdinal(day) {
  const v = Number(day);
  if (v % 100 >= 11 && v % 100 <= 13) return `${v}th`;
  if (v % 10 === 1) return `${v}st`;
  if (v % 10 === 2) return `${v}nd`;
  if (v % 10 === 3) return `${v}rd`;
  return `${v}th`;
}

function formatScheduleDate(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return dateStr;
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'long' });
  const month = dt.toLocaleDateString('en-US', { month: 'short' });
  return `${weekday} ${month} ${dayOrdinal(dt.getDate())}`;
}

function formatTimelineDayLabel(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return dateStr;
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'long' });
  return `${weekday} ${dayOrdinal(dt.getDate())}`;
}

function ensureDayMenu() {
  let menu = document.getElementById('calendar-day-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'calendar-day-menu';
  menu.className = 'day-menu hidden';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'false');
  document.body.appendChild(menu);
  return menu;
}

function closeDayMenu() {
  const menu = document.getElementById('calendar-day-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.innerHTML = '';
  state.dayMenuDate = null;
  state.dayMenuAnchorEl = null;
}

function ensureQuickCreateMenu() {
  let menu = document.getElementById('calendar-quick-create-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'calendar-quick-create-menu';
  menu.className = 'quick-create-menu hidden';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'false');
  document.body.appendChild(menu);
  return menu;
}

function ensureQuickCreateBackdrop() {
  let backdrop = document.getElementById('calendar-quick-create-backdrop');
  if (backdrop) return backdrop;
  backdrop = document.createElement('div');
  backdrop.id = 'calendar-quick-create-backdrop';
  backdrop.className = 'quick-create-backdrop hidden';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.addEventListener('click', closeQuickCreateMenu);
  document.body.appendChild(backdrop);
  return backdrop;
}

function closeQuickCreateMenu() {
  const menu = document.getElementById('calendar-quick-create-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  const backdrop = document.getElementById('calendar-quick-create-backdrop');
  backdrop?.classList.add('hidden');
  menu.innerHTML = '';
  state.quickCreateDate = '';
  state.quickCreateTime = '';
  state.quickCreateAppointmentId = null;
  state.quickCreateAnchorEl = null;
}

function renderQuickCreateDurationOptions(selectedDuration = 45) {
  const options = [15, 30, 45, 60, 90];
  const unique = Array.from(new Set([Number(selectedDuration || 45), ...options]));
  unique.sort((a, b) => a - b);
  return unique
    .map((mins) => `<option value="${mins}" ${Number(mins) === Number(selectedDuration) ? 'selected' : ''}>${mins} min</option>`)
    .join('');
}

function renderNotifyOffsetOptions(selectedOffset = 10) {
  const options = [
    { value: 0, label: 'At time of event' },
    { value: 5, label: '5 minutes before' },
    { value: 10, label: '10 minutes before' },
    { value: 15, label: '15 minutes before' },
    { value: 30, label: '30 minutes before' },
    { value: 60, label: '1 hour before' },
    { value: 120, label: '2 hours before' },
    { value: 1440, label: '1 day before' }
  ];
  const normalized = Number.isFinite(Number(selectedOffset)) ? Number(selectedOffset) : 10;
  return options
    .map((opt) => `<option value="${opt.value}" ${opt.value === normalized ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('');
}

async function openQuickCreateMenu(anchorEl, date, time, appointment = null) {
  if (!anchorEl || !date || !time) return;
  closeDayMenu();

  const menu = ensureQuickCreateMenu();
  const backdrop = ensureQuickCreateBackdrop();
  backdrop.classList.remove('hidden');
  state.quickCreateAnchorEl = anchorEl;
  const resolvedDate = String(appointment?.date || date);
  const resolvedTime = String(appointment?.time || time).slice(0, 5);
  state.quickCreateDate = resolvedDate;
  state.quickCreateTime = resolvedTime;
  state.quickCreateAppointmentId = appointment?.id != null ? Number(appointment.id) : null;

  const defaultType = state.types.find((t) => Number(t.id) === Number(appointment?.typeId || state.selectedTypeId)) || state.types[0] || null;
  const defaultTypeId = defaultType ? Number(defaultType.id) : '';
  const defaultDuration = Number(appointment?.durationMinutes || defaultType?.durationMinutes || 45);
  const defaultLocation = appointment?.location
    ? normalizeAppointmentLocation(appointment.location)
    : resolveDefaultLocationForType(defaultType);
  const defaultClientName = String(appointment?.clientName || '');
  const defaultReminderOffset = Number(appointment?.reminderOffsetMinutes == null ? 10 : appointment.reminderOffsetMinutes);
  const reminderModeEnabled = isReminderModeEnabled();
  const clientModeEnabled = isClientModeEnabled();
  const defaultEntryMode = reminderModeEnabled
    ? 'reminder'
    : (String(appointment?.source || '').toLowerCase() === 'reminder' ? 'reminder' : 'appointment');
  const isEditing = state.quickCreateAppointmentId != null;
  const lockReminderMode = reminderModeEnabled || (isEditing && defaultEntryMode === 'reminder');
  const quickCreateTitle = isEditing
    ? (defaultEntryMode === 'reminder' ? 'Edit Reminder' : 'Edit Appointment')
    : `Quick Add ${reminderModeEnabled ? 'Reminder' : 'Appointment'}`;
  const typeOptions = state.types.length
    ? state.types.map((t) =>
      `<option value="${Number(t.id)}" data-duration="${Number(t.durationMinutes || 45)}" ${Number(t.id) === defaultTypeId ? 'selected' : ''}>${escapeHtml(t.name)} (${Number(t.durationMinutes || 45)}m)</option>`
    ).join('')
    : '<option value="">No appointment types</option>';

  menu.innerHTML = `
    <div class="quick-create-header">
      <div class="quick-create-title-wrap">
        <p class="quick-create-kicker">Calendar</p>
        <h3>${quickCreateTitle}</h3>
      </div>
      <button type="button" class="quick-create-close" aria-label="Close quick add">×</button>
    </div>
    <div class="quick-create-meta">
      <div class="quick-create-meta-item">
        <small>Date</small>
        <strong>${escapeHtml(formatMenuDate(resolvedDate))}</strong>
      </div>
      <div class="quick-create-meta-item">
        <small>Time</small>
        <strong>${escapeHtml(toTime12(resolvedTime))}</strong>
      </div>
    </div>
    <div class="quick-create-client-context" id="quick-create-client-context">
      <small>Client details will appear here when a matching client is found.</small>
    </div>
    <form class="quick-create-form">
      ${lockReminderMode ? '' : `
        <div class="quick-create-section">
          <div class="quick-entry-mode" role="group" aria-label="Entry type">
            <button type="button" class="quick-entry-mode-btn ${defaultEntryMode === 'appointment' ? 'active' : ''}" data-entry-mode="appointment">Appointment</button>
            <button type="button" class="quick-entry-mode-btn ${defaultEntryMode === 'reminder' ? 'active' : ''}" data-entry-mode="reminder">Reminder</button>
          </div>
        </div>
      `}
      <input type="hidden" name="entryMode" value="${defaultEntryMode}" />
      <div class="quick-create-section">
        <div class="form-group">
          <label for="quick-create-client" id="quick-create-client-label">${defaultEntryMode === 'reminder' ? 'Reminder' : 'Client / Title'}</label>
          <input id="quick-create-client" name="clientName" type="text" required placeholder="${defaultEntryMode === 'reminder' ? 'Reminder note or title' : 'Client or appointment title'}" value="${escapeHtml(defaultClientName)}" />
        </div>
      </div>
      <div class="quick-create-section">
        <div class="quick-create-grid">
          <div class="form-group quick-create-field quick-create-type-group">
            <label for="quick-create-type">Type</label>
            <select id="quick-create-type" name="typeId" ${state.types.length ? '' : 'disabled'}>${typeOptions}</select>
          </div>
          <div class="form-group quick-create-field">
            <label for="quick-create-time">Start Time</label>
            <input id="quick-create-time" name="time" type="time" step="60" required value="${escapeHtml(resolvedTime)}" />
          </div>
        </div>
      </div>
      <div class="quick-create-section">
        <div class="quick-create-grid">
          <div class="form-group quick-create-field quick-create-duration-group">
            <label for="quick-create-duration">Duration</label>
            <select id="quick-create-duration" name="durationMinutes">${renderQuickCreateDurationOptions(defaultDuration)}</select>
          </div>
          <div class="form-group quick-create-field">
            <label for="quick-create-reminder-offset">Notify</label>
            <select id="quick-create-reminder-offset" name="reminderOffsetMinutes">${renderNotifyOffsetOptions(defaultReminderOffset)}</select>
          </div>
          <div class="form-group quick-create-field quick-create-location-group">
            <label for="quick-create-location">Location</label>
            <select id="quick-create-location" name="location">
              <option value="office" ${defaultLocation === 'office' ? 'selected' : ''}>Office</option>
              <option value="on-premises" ${defaultLocation === 'on-premises' ? 'selected' : ''}>On premises</option>
              <option value="virtual" ${defaultLocation === 'virtual' ? 'selected' : ''}>Virtual</option>
              <option value="phone" ${defaultLocation === 'phone' ? 'selected' : ''}>Phone</option>
            </select>
          </div>
        </div>
      </div>
      <div class="quick-create-actions">
        ${(isEditing && defaultEntryMode !== 'reminder')
      ? '<button type="button" class="btn-secondary quick-create-open-client">Client info</button>'
      : ''
    }
        ${isEditing ? '<button type="button" class="btn-secondary quick-create-delete">Delete</button>' : ''}
        <button type="button" class="btn-secondary quick-create-cancel">Cancel</button>
        <button type="submit" class="btn-primary quick-create-submit">${isEditing ? 'Save' : 'Create'}</button>
      </div>
    </form>
  `;

  positionDayMenu(anchorEl, menu);

  menu.querySelector('.quick-create-close')?.addEventListener('click', closeQuickCreateMenu);
  menu.querySelector('.quick-create-cancel')?.addEventListener('click', closeQuickCreateMenu);
  menu.querySelector('.quick-create-open-client')?.addEventListener('click', async () => {
    const currentName = String(menu.querySelector('input[name="clientName"]')?.value || appointment?.clientName || '').trim();
    const target = appointment || { clientName: currentName, title: currentName };
    closeQuickCreateMenu();
    try {
      await openClientFromAppointment(target);
    } catch (error) {
      showToast(error.message || 'Could not open client info.', 'error');
    }
  });
  menu.querySelector('.quick-create-delete')?.addEventListener('click', async () => {
    if (state.quickCreateAppointmentId == null) return;
    const isReminderDelete = defaultEntryMode === 'reminder';
    const ok = await showConfirm(
      isReminderDelete ? 'Delete Reminder' : 'Delete Appointment',
      isReminderDelete
        ? 'This reminder will be permanently removed.'
        : 'This appointment will be permanently removed.'
    );
    if (!ok) return;
    const deleteBtn = menu.querySelector('.quick-create-delete');
    const oldText = deleteBtn?.textContent || 'Delete';
    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';
    }
    try {
      const result = await queueAwareMutation(`/api/appointments/${state.quickCreateAppointmentId}`, { method: 'DELETE' }, {
        allowOfflineQueue: true,
        description: isReminderDelete ? 'Reminder deletion' : 'Appointment deletion'
      });
      closeQuickCreateMenu();
      if (!result.queued) showToast(isReminderDelete ? 'Reminder removed.' : 'Appointment removed.', 'success');
      const targetDate = state.selectedDate || state.quickCreateDate || date;
      await loadDashboard(targetDate, { refreshDots: false });
      await loadAppointmentsTable();
      await refreshCalendarDots({ force: true });
    } catch (error) {
      showToast(error.message, 'error');
      if (deleteBtn) {
        deleteBtn.disabled = false;
        deleteBtn.textContent = oldText;
      }
    }
  });

  const typeSelect = menu.querySelector('select[name="typeId"]');
  const durationSelect = menu.querySelector('select[name="durationMinutes"]');
  const locationSelect = menu.querySelector('select[name="location"]');
  const entryModeInput = menu.querySelector('input[name="entryMode"]');
  const entryLabel = menu.querySelector('#quick-create-client-label');
  const entryInput = menu.querySelector('input[name="clientName"]');
  const typeGroup = menu.querySelector('.quick-create-type-group');
  const durationGroup = menu.querySelector('.quick-create-duration-group');
  const locationGroup = menu.querySelector('.quick-create-location-group');
  const clientContext = menu.querySelector('#quick-create-client-context');
  let clientContextRequestId = 0;
  const renderClientContextState = (html) => {
    if (!clientContext) return;
    clientContext.innerHTML = html;
  };
  const refreshClientContext = async () => {
    const requestId = ++clientContextRequestId;
    const mode = String(entryModeInput?.value || 'appointment');
    const name = String(entryInput?.value || '').trim();
    if (mode === 'reminder') {
      renderClientContextState('<small>Client details are hidden for reminders.</small>');
      return;
    }
    if (!name || name.length < 2) {
      renderClientContextState('<small>Type a client name to show saved client details.</small>');
      return;
    }
    renderClientContextState('<small>Matching client...</small>');
    try {
      const payload = await api(`/api/clients?q=${encodeURIComponent(name)}&lite=1&limit=20`);
      if (requestId !== clientContextRequestId) return;
      const clients = Array.isArray(payload?.clients) ? payload.clients : [];
      const exact = clients.find((item) => String(item.name || '').trim().toLowerCase() === name.toLowerCase())
        || clients[0]
        || null;
      if (!exact?.id) {
        renderClientContextState('<small>No saved client profile matched this name yet.</small>');
        return;
      }
      const notesPayload = await api(`/api/clients/${Number(exact.id)}/notes`);
      if (requestId !== clientContextRequestId) return;
      const notes = Array.isArray(notesPayload?.notes) ? notesPayload.notes.slice(0, 2) : [];
      const notesHtml = notes.length
        ? notes.map((note) => `<div class="quick-create-client-note">${escapeHtml(String(note.note || ''))}</div>`).join('')
        : '<div class="quick-create-client-note">No notes yet.</div>';
      renderClientContextState(`
        <div class="quick-create-client-head">
          <strong>${escapeHtml(exact.name || '')}</strong>
          <span>${escapeHtml(formatClientStage(exact.stage || 'new'))}</span>
        </div>
        <div class="quick-create-client-meta">${escapeHtml(exact.email || 'No email')} • ${escapeHtml(exact.phone || 'No phone')}</div>
        <div class="quick-create-client-notes">${notesHtml}</div>
      `);
    } catch (_error) {
      if (requestId !== clientContextRequestId) return;
      renderClientContextState('<small>Could not load client details right now.</small>');
    }
  };
  const syncEntryModeUi = () => {
    if (lockReminderMode && entryModeInput) entryModeInput.value = 'reminder';
    const mode = String(entryModeInput?.value || 'appointment');
    const isReminder = mode === 'reminder';
    if (typeSelect) typeSelect.disabled = isReminder || !state.types.length;
    if (durationSelect) durationSelect.disabled = isReminder;
    if (locationSelect) locationSelect.disabled = isReminder;
    if (typeGroup) typeGroup.classList.toggle('hidden', isReminder || clientModeEnabled);
    if (durationGroup) durationGroup.classList.toggle('hidden', isReminder);
    if (locationGroup) locationGroup.classList.toggle('hidden', isReminder);
    if (entryLabel) entryLabel.textContent = isReminder ? 'Reminder' : (clientModeEnabled ? 'Client Name' : 'Client / Title');
    if (entryInput) {
      entryInput.placeholder = isReminder
        ? 'Reminder note or title'
        : (clientModeEnabled ? 'Client name' : 'Client or appointment title');
    }
    menu.querySelectorAll('.quick-entry-mode-btn[data-entry-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.entryMode === mode);
    });
    void refreshClientContext();
  };

  menu.querySelectorAll('.quick-entry-mode-btn[data-entry-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (lockReminderMode) return;
      if (!entryModeInput) return;
      entryModeInput.value = String(btn.dataset.entryMode || 'appointment');
      syncEntryModeUi();
    });
  });
  syncEntryModeUi();

  typeSelect?.addEventListener('change', () => {
    const selectedOption = typeSelect.options[typeSelect.selectedIndex];
    const suggested = Number(selectedOption?.dataset?.duration || 45);
    if (durationSelect) durationSelect.value = String(suggested);
  });

  entryInput?.addEventListener('blur', () => {
    void refreshClientContext();
  });

  entryInput?.addEventListener('change', () => {
    void refreshClientContext();
  });

  menu.querySelector('.quick-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('.quick-create-submit');
    const oldText = submitBtn?.textContent || (isEditing ? 'Save' : 'Create');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = isEditing ? 'Saving...' : 'Creating...';
    }

    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const requestDate = state.quickCreateDate;
      const requestTime = String(data.time || state.quickCreateTime || '09:00').slice(0, 5);
      const entryMode = String(data.entryMode || 'appointment');
      const isReminder = entryMode === 'reminder';
      const payload = {
        clientName: String(data.clientName || '').trim(),
        typeId: isReminder ? null : (data.typeId ? Number(data.typeId) : null),
        title: isReminder ? String(data.clientName || '').trim() : undefined,
        source: isReminder ? 'reminder' : 'owner',
        date: requestDate,
        time: requestTime,
        durationMinutes: isReminder ? 0 : Number(data.durationMinutes || 45),
        reminderOffsetMinutes: Number(data.reminderOffsetMinutes == null ? 10 : data.reminderOffsetMinutes),
        location: isReminder ? 'office' : String(data.location || 'office')
      };
      if (!payload.clientName) throw new Error('Please enter a name or title.');

      const isUpdate = state.quickCreateAppointmentId != null;
      const targetUrl = isUpdate
        ? `/api/appointments/${state.quickCreateAppointmentId}`
        : '/api/appointments';
      const method = isUpdate ? 'PUT' : 'POST';
      const result = await queueAwareMutation(targetUrl, {
        method,
        body: JSON.stringify(payload)
      }, {
        allowOfflineQueue: true,
        description: isUpdate ? (isReminder ? 'Reminder update' : 'Appointment update') : (isReminder ? 'Reminder creation' : 'Appointment creation')
      });

      closeQuickCreateMenu();
      if (result.queued) {
        await loadDashboard(payload.date, { refreshDots: false });
        await refreshCalendarDots({ force: true });
        return;
      }
      showToast(
        isReminder
          ? (isUpdate ? 'Reminder updated.' : 'Reminder added.')
          : (isUpdate ? 'Appointment updated.' : 'Appointment created.'),
        'success'
      );
      state.selectedDate = payload.date;
      await loadDashboard(payload.date, { refreshDots: false });
      await loadAppointmentsTable();
      await refreshCalendarDots({ force: true });
    } catch (error) {
      showToast(error.message, 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = oldText;
      }
    }
  });

  void refreshClientContext();
  menu.querySelector('input[name="clientName"]')?.focus();
}

function ensureNotificationsMenu() {
  let menu = document.getElementById('notifications-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'notifications-menu';
  menu.className = 'notifications-menu hidden';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'false');
  document.body.appendChild(menu);
  return menu;
}

function closeNotificationsMenu() {
  const menu = document.getElementById('notifications-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.innerHTML = '';
  state.notificationMenuAnchorEl = null;
}

function positionNotificationsMenu(anchorEl, menu) {
  if (!anchorEl || !menu) return;
  const rect = anchorEl.getBoundingClientRect();
  const margin = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.classList.remove('hidden');

  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  let top = rect.bottom + 8;

  if (left + menuRect.width > vw - margin) left = vw - menuRect.width - margin;
  if (left < margin) left = margin;

  if (top + menuRect.height > vh - margin) top = rect.top - menuRect.height - 8;
  if (top < margin) top = margin;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

async function openNotificationsMenu(anchorEl) {
  const menu = ensureNotificationsMenu();
  state.notificationMenuAnchorEl = anchorEl;
  menu.innerHTML = '<div class="day-menu-loading">Loading notifications…</div>';
  positionNotificationsMenu(anchorEl, menu);

  try {
    const payload = await api('/api/notifications');
    const summary = payload?.summary || {};
    const pending = Array.isArray(payload?.pending) ? payload.pending : [];

    const pendingItems = pending.length
      ? pending
        .map((item) => `
          <button type="button" class="notification-item" data-notification-open-date="${escapeHtml(item.date || '')}">
            <div class="notification-item-title">${escapeHtml(item.clientName || 'Client')} · ${escapeHtml(item.typeName || 'Appointment')}</div>
            <div class="notification-item-meta">${escapeHtml(item.date || '')} · ${escapeHtml(toTime12(item.time || '09:00'))}</div>
          </button>
        `)
        .join('')
      : `<div class="notification-empty">No pending ${getEntryWordPlural()} right now.</div>`;

    menu.innerHTML = `
      <div class="notifications-header">
        <h3>Notifications</h3>
        <button type="button" class="notifications-close" aria-label="Close notifications">×</button>
      </div>
      <div class="notifications-summary-grid">
        <div class="notification-summary-card">
          <span class="notification-summary-label">Pending</span>
          <strong>${Number(summary.pending || 0)}</strong>
        </div>
        <div class="notification-summary-card">
          <span class="notification-summary-label">Today</span>
          <strong>${Number(summary.today || 0)}</strong>
        </div>
        <div class="notification-summary-card">
          <span class="notification-summary-label">This Week</span>
          <strong>${Number(summary.week || 0)}</strong>
        </div>
      </div>
      <div class="notifications-section">
        <div class="notifications-section-title">Pending ${escapeHtml(getEntryWordPlural())}</div>
        <div class="notifications-list">${pendingItems}</div>
      </div>
      <div class="notifications-actions">
        <button type="button" class="btn-secondary" id="notifications-open-dashboard">Open Dashboard</button>
        <button type="button" class="btn-primary" id="notifications-open-appointments">Review ${escapeHtml(getEntryWordPluralTitle())}</button>
      </div>
    `;

    positionNotificationsMenu(anchorEl, menu);

    menu.querySelector('.notifications-close')?.addEventListener('click', closeNotificationsMenu);
    menu.querySelector('#notifications-open-dashboard')?.addEventListener('click', async () => {
      closeNotificationsMenu();
      setActiveView('dashboard');
      await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
    });
    menu.querySelector('#notifications-open-appointments')?.addEventListener('click', async () => {
      closeNotificationsMenu();
      setActiveView('appointments');
      await loadAppointmentsTable();
    });

    menu.querySelectorAll('[data-notification-open-date]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const date = String(btn.dataset.notificationOpenDate || '');
        if (!date) return;
        closeNotificationsMenu();
        state.selectedDate = date;
        const dt = new Date(`${date}T00:00:00`);
        if (!Number.isNaN(dt.getTime())) {
          const mode = normalizeCalendarViewMode(state.calendarViewMode);
          state.calendarDate = mode === 'month'
            ? new Date(dt.getFullYear(), dt.getMonth(), 1)
            : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
          const monthLabelNode = document.querySelector('.current-month');
          if (monthLabelNode) monthLabelNode.textContent = getCalendarHeaderLabel();
          renderCalendarGrid();
          await refreshCalendarDots();
        }
        setActiveView('dashboard');
        await loadDashboard(date, { refreshDots: false, showSkeleton: false });
      });
    });
  } catch (error) {
    menu.innerHTML = `
      <div class="notifications-header">
        <h3>Notifications</h3>
        <button type="button" class="notifications-close" aria-label="Close notifications">×</button>
      </div>
      <div class="notification-empty">${escapeHtml(error.message || 'Could not load notifications.')}</div>
    `;
    positionNotificationsMenu(anchorEl, menu);
    menu.querySelector('.notifications-close')?.addEventListener('click', closeNotificationsMenu);
  }
}

function ensureEmailComposerMenu() {
  let menu = document.getElementById('email-composer-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'email-composer-menu';
  menu.className = 'email-menu hidden';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'false');
  document.body.appendChild(menu);
  return menu;
}

function closeEmailComposerMenu() {
  const menu = document.getElementById('email-composer-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.innerHTML = '';
  state.emailMenuAppointmentId = null;
}

function ensureCancelReasonMenu() {
  let menu = document.getElementById('cancel-reason-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'cancel-reason-menu';
  menu.className = 'email-menu cancel-menu hidden';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'false');
  document.body.appendChild(menu);
  return menu;
}

function closeCancelReasonMenu() {
  const menu = document.getElementById('cancel-reason-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.innerHTML = '';
  state.cancelMenuAppointmentId = null;
  state.cancelMenuDate = '';
}

async function openCancelReasonMenu(appointmentId, date = '') {
  const menu = ensureCancelReasonMenu();
  state.cancelMenuAppointmentId = Number(appointmentId);
  state.cancelMenuDate = String(date || '');

  menu.innerHTML = `
    <div class="email-menu-header">
      <h3>Cancel ${escapeHtml(getEntryWordSingularTitle())}</h3>
      <button type="button" class="email-menu-close cancel-menu-close" aria-label="Close cancel menu">×</button>
    </div>
    <div class="cancel-menu-body">
      <p class="cancel-menu-help">Optionally add a reason to include in the cancellation email.</p>
      <label class="cancel-menu-toggle">
        <input type="checkbox" name="skipReason" />
        Cancel without reason
      </label>
      <div class="form-group">
        <label>Reason (optional)</label>
        <textarea name="cancelReason" rows="4" placeholder="Example: We're fully booked at this hour, please pick a new slot."></textarea>
      </div>
    </div>
    <div class="email-menu-actions">
      <button type="button" class="btn-secondary cancel-menu-back">Back</button>
      <button type="button" class="btn-primary cancel-menu-confirm">Confirm Cancellation</button>
    </div>
  `;

  menu.classList.remove('hidden');

  const skipReasonInput = menu.querySelector('input[name="skipReason"]');
  const reasonInput = menu.querySelector('textarea[name="cancelReason"]');
  const applySkipState = () => {
    if (!reasonInput || !skipReasonInput) return;
    reasonInput.disabled = skipReasonInput.checked;
    if (skipReasonInput.checked) reasonInput.value = '';
  };
  skipReasonInput?.addEventListener('change', applySkipState);
  applySkipState();

  menu.querySelector('.cancel-menu-close')?.addEventListener('click', closeCancelReasonMenu);
  menu.querySelector('.cancel-menu-back')?.addEventListener('click', closeCancelReasonMenu);
  menu.querySelector('.cancel-menu-confirm')?.addEventListener('click', async () => {
    const confirmBtn = menu.querySelector('.cancel-menu-confirm');
    if (!confirmBtn || !state.cancelMenuAppointmentId) return;
    const oldText = confirmBtn.textContent;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Cancelling...';
    const reason = skipReasonInput?.checked ? '' : String(reasonInput?.value || '').trim();
    await cancelAppointmentById(state.cancelMenuAppointmentId, state.cancelMenuDate, reason);
    closeCancelReasonMenu();
    confirmBtn.disabled = false;
    confirmBtn.textContent = oldText;
  });
}

function getEmailPayloadFromMenu(menu) {
  const selected = menu.querySelector('.email-template-btn.active')?.dataset.template || 'summary';
  if (selected !== 'custom') return { template: selected };

  const subjectInput = menu.querySelector('input[name="emailSubject"]');
  const messageInput = menu.querySelector('textarea[name="emailMessage"]');
  const subject = String(subjectInput?.value || '').trim();
  const message = String(messageInput?.value || '').trim();
  if (!message) throw new Error('Please enter a message.');
  return { template: 'custom', subject, message };
}

function toggleCustomEmailFields(menu) {
  const selected = menu.querySelector('.email-template-btn.active')?.dataset.template || 'summary';
  const customFields = menu.querySelector('.email-custom-fields');
  if (!customFields) return;
  customFields.classList.toggle('hidden', selected !== 'custom');
}

function bindEmailTemplateButtons(menu) {
  menu.querySelectorAll('.email-template-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      menu.querySelectorAll('.email-template-btn').forEach((n) => n.classList.remove('active'));
      btn.classList.add('active');
      toggleCustomEmailFields(menu);
    });
  });
}

async function openEmailComposerMenu(appointmentId) {
  const menu = ensureEmailComposerMenu();
  state.emailMenuAppointmentId = Number(appointmentId);

  menu.innerHTML = `
    <div class="email-menu-header">
      <h3>Send Email</h3>
      <button type="button" class="email-menu-close" aria-label="Close email menu">×</button>
    </div>
    <div class="email-template-group">
      <button type="button" class="email-template-btn active" data-template="summary">Summary</button>
      <button type="button" class="email-template-btn" data-template="reminder">Reminder</button>
      <button type="button" class="email-template-btn" data-template="custom">Custom</button>
    </div>
    <div class="email-custom-fields hidden">
      <div class="form-group">
        <label>Subject</label>
        <input name="emailSubject" type="text" placeholder="Message about your ${escapeHtml(getEntryWordSingularTitle().toLowerCase())}" />
      </div>
      <div class="form-group">
        <label>Message</label>
        <textarea name="emailMessage" rows="4" placeholder="Type your message..."></textarea>
      </div>
    </div>
    <div class="email-menu-actions">
      <button type="button" class="btn-secondary email-cancel-btn">Cancel</button>
      <button type="button" class="btn-primary email-send-btn">Send Email</button>
    </div>
  `;

  menu.classList.remove('hidden');
  bindEmailTemplateButtons(menu);

  menu.querySelector('.email-menu-close')?.addEventListener('click', closeEmailComposerMenu);
  menu.querySelector('.email-cancel-btn')?.addEventListener('click', closeEmailComposerMenu);
  menu.querySelector('.email-send-btn')?.addEventListener('click', async () => {
    const sendBtn = menu.querySelector('.email-send-btn');
    if (!sendBtn || !state.emailMenuAppointmentId) return;
    const oldText = sendBtn.textContent;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    try {
      const payload = getEmailPayloadFromMenu(menu);
      const result = await api(`/api/appointments/${state.emailMenuAppointmentId}/email`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(
        result.provider === 'simulation' ? 'Email simulated (provider not configured).' : 'Appointment email sent.',
        'success'
      );
      closeEmailComposerMenu();
    } catch (error) {
      showToast(error.message, 'error');
      sendBtn.disabled = false;
      sendBtn.textContent = oldText;
    }
  });
}

function positionDayMenu(anchorEl, menu) {
  const rect = anchorEl.getBoundingClientRect();
  const margin = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.classList.remove('hidden');

  const menuRect = menu.getBoundingClientRect();
  const isNarrowScreen = vw <= 768;

  if (isNarrowScreen) {
    const sideInset = 6;
    const bottomInset = 6;
    const safeTop = 8;
    const left = sideInset;
    const top = Math.max(safeTop, vh - menuRect.height - bottomInset);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    return;
  }

  let left = rect.left;
  let top = rect.bottom + 8;

  if (left + menuRect.width > vw - margin) left = vw - menuRect.width - margin;
  if (left < margin) left = margin;

  if (top + menuRect.height > vh - margin) top = rect.top - menuRect.height - 8;
  if (top < margin) top = margin;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openNewAppointmentModalForDate(date) {
  state.editingAppointmentId = null;
  updateAppointmentEditorUi(false);
  closeDayMenu();
  openModal('new-appointment');
  const form = document.getElementById('appointment-form');
  const dateInput = form?.querySelector('input[name="date"]');
  if (dateInput && date) dateInput.value = date;
  updateAppointmentPreview();
}

function openNewAppointmentModalForSlot(date, time) {
  openNewAppointmentModalForDate(date);
  const form = document.getElementById('appointment-form');
  const timeInput = form?.querySelector('input[name="time"]');
  if (timeInput && time) {
    timeInput.value = String(time).slice(0, 5);
    syncTimeBuilderFromInput(form);
  }
  updateAppointmentPreview();
}

async function openDayMenu(anchorEl, date, options = {}) {
  closeQuickCreateMenu();
  const menu = ensureDayMenu();
  state.dayMenuDate = date;
  state.dayMenuAnchorEl = anchorEl;
  const prefillTimeRaw = String(options?.prefillTime || '').slice(0, 5);
  const prefillTime = /^\d{2}:\d{2}$/.test(prefillTimeRaw) ? prefillTimeRaw : '';
  menu.innerHTML = '<div class="day-menu-loading">Loading...</div>';
  positionDayMenu(anchorEl, menu);

  try {
    const { appointments } = await api(`/api/appointments?date=${encodeURIComponent(date)}`);
    const visibleAppointments = (Array.isArray(appointments) ? appointments : []).filter((item) => {
      const status = String(item?.status || '').toLowerCase();
      const source = String(item?.source || '').toLowerCase();
      if (status === 'completed' || status === 'cancelled') return false;
      return status === 'confirmed' || source === 'reminder';
    });
    if (state.dayMenuDate !== date) return;
    const entryWord = getEntryWordSingularTitle();
    const entryWordLower = entryWord.toLowerCase();
    const statusClass = (s) => `day-menu-status-${String(s || 'pending').toLowerCase()}`;
    const statusLabel = (s) => {
      const st = String(s || 'pending').toLowerCase();
      return st.charAt(0).toUpperCase() + st.slice(1);
    };
    const isReminder = (a) => isReminderEntry(a) || Number(a.durationMinutes || 0) <= 0;
    const timeDisplay = (a) => isReminder(a)
      ? escapeHtml(toTime12(a.time))
      : `${escapeHtml(toTime12(a.time))} – ${escapeHtml(toTime12(addMinutesToTime(a.time, a.durationMinutes)))}`;
    const typeColor = (a) => a.color || a.typeColor || 'var(--gold)';

    const items = visibleAppointments
      .map(
        (a) => `
          <div class="day-menu-item" style="--type-color: ${escapeHtml(typeColor(a))}">
            <div class="day-menu-item-header">
              <div class="day-menu-item-time">${timeDisplay(a)}</div>
              <span class="day-menu-status ${statusClass(a.status)}">${statusLabel(a.status)}</span>
            </div>
            <div class="day-menu-item-body">
              <div class="day-menu-item-client">${escapeHtml(a.clientName)}</div>
              <div class="day-menu-item-type">${escapeHtml(a.typeName)}${!isReminder(a) ? ` · ${a.durationMinutes}min` : ''}</div>
            </div>
            <div class="day-menu-client-notes" data-client-notes-for="${a.id}">
              <div class="day-menu-client-notes-state">Open actions to view client notes.</div>
            </div>
            <div class="day-menu-item-actions-wrap">
              <div class="day-menu-top-actions">
                <button type="button" class="day-menu-open-client" data-appointment-id="${a.id}" aria-label="Open client info">Client</button>
                <button type="button" class="day-menu-edit" data-appointment-id="${a.id}" aria-label="Edit ${escapeHtml(entryWordLower)}">Edit</button>
                <button type="button" class="day-menu-show-actions" data-appointment-id="${a.id}" aria-expanded="false">More ▾</button>
              </div>
              <div class="day-menu-item-actions hidden" data-actions-for="${a.id}">
                ${a.clientEmail
            ? `<button type="button" class="day-menu-email" data-appointment-id="${a.id}" aria-label="Email ${escapeHtml(entryWordLower)} details">Email</button>`
            : ''
          }
                ${a.status === 'pending'
            ? `<button type="button" class="day-menu-confirm" data-appointment-id="${a.id}" aria-label="Confirm ${escapeHtml(entryWordLower)}">Confirm</button>`
            : ''
          }
                <button type="button" class="day-menu-note" data-appointment-id="${a.id}" aria-label="Add client note">Add note</button>
                <button type="button" class="day-menu-cancel" data-appointment-id="${a.id}" ${a.status === 'cancelled' ? 'disabled' : ''} aria-label="Cancel ${escapeHtml(entryWordLower)}">${a.status === 'cancelled' ? 'Cancelled' : 'Cancel'}</button>
                <button type="button" class="day-menu-delete" data-appointment-id="${a.id}" aria-label="Delete ${escapeHtml(entryWordLower)}">Delete</button>
              </div>
              <div class="day-menu-note-editor hidden" data-note-editor-for="${a.id}">
                <textarea class="day-menu-note-input" rows="3" placeholder="Add a progress note..."></textarea>
                <div class="day-menu-note-controls">
                  <select class="day-menu-note-stage">
                    <option value="">No stage change</option>
                    <option value="new">New</option>
                    <option value="in_progress">In Progress</option>
                    <option value="waiting">Waiting</option>
                    <option value="completed">Completed</option>
                    <option value="on_hold">On Hold</option>
                  </select>
                  <div class="day-menu-note-actions">
                    <button type="button" class="day-menu-note-cancel" data-appointment-id="${a.id}">Cancel</button>
                    <button type="button" class="day-menu-note-save" data-appointment-id="${a.id}">Save Note</button>
                  </div>
                </div>
              </div>
            </div>
          </div>`
      )
      .join('');

    const count = visibleAppointments.length;
    const countLabel = count === 1 ? `1 ${entryWordLower}` : `${count} ${getEntryWordPlural().toLowerCase()}`;

    menu.innerHTML = `
      <div class="day-menu-header">
        <div class="day-menu-header-info">
          <h3>${escapeHtml(formatMenuDate(date))}</h3>
          ${count > 0 ? `<span class="day-menu-count">${countLabel}</span>` : ''}
        </div>
        <button type="button" class="day-menu-close" aria-label="Close day menu">×</button>
      </div>
      <div class="day-menu-actions">
        <button type="button" class="btn-primary day-menu-add">Add ${escapeHtml(entryWord)}</button>
      </div>
      <div class="day-menu-list">
        ${items || `<div class="day-menu-empty">No ${escapeHtml(getEntryWordPlural())} scheduled</div>`}
      </div>
    `;

    positionDayMenu(anchorEl, menu);

    menu.querySelector('.day-menu-close')?.addEventListener('click', closeDayMenu);
    menu.querySelector('.day-menu-add')?.addEventListener('click', () => {
      if (prefillTime) {
        openNewAppointmentModalForSlot(date, prefillTime);
        return;
      }
      openNewAppointmentModalForDate(date);
    });

    menu.querySelectorAll('.day-menu-show-actions').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.appointmentId;
        if (!id) return;
        const target = menu.querySelector(`.day-menu-item-actions[data-actions-for="${id}"]`);
        if (!target) return;
        const opening = target.classList.contains('hidden');
        menu.querySelectorAll('.day-menu-item-actions').forEach((n) => n.classList.add('hidden'));
        menu.querySelectorAll('.day-menu-show-actions').forEach((n) => {
          n.setAttribute('aria-expanded', 'false');
          n.textContent = 'More ▾';
        });
        if (opening) {
          target.classList.remove('hidden');
          btn.setAttribute('aria-expanded', 'true');
          btn.textContent = 'Less ▴';
          const appointment = visibleAppointments.find((item) => Number(item.id) === Number(id));
          const notesRoot = menu.querySelector(`.day-menu-client-notes[data-client-notes-for="${id}"]`);
          if (appointment && notesRoot && !notesRoot.dataset.loaded) {
            notesRoot.innerHTML = '<div class="day-menu-client-notes-state">Loading client profile...</div>';
            void (async () => {
              try {
                const client = await findClientForAppointment(appointment);
                if (!client?.id) {
                  notesRoot.innerHTML = '<div class="day-menu-client-notes-state">No saved client profile yet for this appointment.</div>';
                  notesRoot.dataset.loaded = '1';
                  return;
                }
                const notesPayload = await api(`/api/clients/${Number(client.id)}/notes`);
                const notes = Array.isArray(notesPayload?.notes) ? notesPayload.notes.slice(0, 2) : [];
                if (!notes.length) {
                  notesRoot.innerHTML = `
                    <div class="day-menu-client-notes-head">
                      <strong>${escapeHtml(client.name || 'Client')}</strong>
                      <span>${escapeHtml(formatClientStage(client.stage || 'new'))}</span>
                    </div>
                    <div class="day-menu-client-notes-meta">${escapeHtml(client.email || 'No email')} • ${escapeHtml(client.phone || 'No phone')}</div>
                    <div class="day-menu-client-notes-state">No client notes yet.</div>
                  `;
                } else {
                  notesRoot.innerHTML = `
                    <div class="day-menu-client-notes-head">
                      <strong>${escapeHtml(client.name || 'Client')}</strong>
                      <span>${escapeHtml(formatClientStage(client.stage || 'new'))}</span>
                    </div>
                    <div class="day-menu-client-notes-meta">${escapeHtml(client.email || 'No email')} • ${escapeHtml(client.phone || 'No phone')}</div>
                    <div class="day-menu-client-notes-title">Recent notes</div>
                    <div class="day-menu-client-notes-list">
                      ${notes.map((item) => `
                        <article class="day-menu-client-note-item">
                          <p class="day-menu-client-note-text">${escapeHtml(String(item.note || ''))}</p>
                          <small class="day-menu-client-note-meta">${escapeHtml(formatNoteTimestamp(item.createdAt || item.updatedAt || ''))}</small>
                        </article>
                      `).join('')}
                    </div>
                  `;
                }
                notesRoot.dataset.loaded = '1';
              } catch (_error) {
                notesRoot.innerHTML = '<div class="day-menu-client-notes-state">Could not load client notes.</div>';
              }
            })();
          }
        }
      });
    });

    menu.querySelectorAll('.day-menu-edit').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.appointmentId);
        const appointment = visibleAppointments.find((a) => Number(a.id) === id);
        closeDayMenu();
        startEditAppointment(appointment);
      });
    });

    menu.querySelectorAll('.day-menu-open-client').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.appointmentId);
        const appointment = visibleAppointments.find((a) => Number(a.id) === id);
        closeDayMenu();
        try {
          await openClientFromAppointment(appointment);
        } catch (error) {
          showToast(error.message || 'Could not open client info.', 'error');
        }
      });
    });

    menu.querySelectorAll('.day-menu-note').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.appointmentId;
        if (!id) return;
        const editor = menu.querySelector(`.day-menu-note-editor[data-note-editor-for="${id}"]`);
        if (!editor) return;
        const opening = editor.classList.contains('hidden');
        menu.querySelectorAll('.day-menu-note-editor').forEach((node) => node.classList.add('hidden'));
        if (opening) {
          editor.classList.remove('hidden');
          editor.querySelector('.day-menu-note-input')?.focus();
        }
      });
    });

    menu.querySelectorAll('.day-menu-note-cancel').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.appointmentId;
        if (!id) return;
        const editor = menu.querySelector(`.day-menu-note-editor[data-note-editor-for="${id}"]`);
        if (!editor) return;
        editor.classList.add('hidden');
        const input = editor.querySelector('.day-menu-note-input');
        if (input) input.value = '';
        const stage = editor.querySelector('.day-menu-note-stage');
        if (stage) stage.value = '';
      });
    });

    menu.querySelectorAll('.day-menu-note-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.appointmentId);
        if (!Number.isFinite(id) || id <= 0) return;
        const appointment = visibleAppointments.find((item) => Number(item.id) === id);
        if (!appointment) return;
        const editor = menu.querySelector(`.day-menu-note-editor[data-note-editor-for="${id}"]`);
        const input = editor?.querySelector('.day-menu-note-input');
        const stage = editor?.querySelector('.day-menu-note-stage');
        const note = String(input?.value || '').trim();
        if (!note) {
          showToast('Enter a note first.', 'info');
          return;
        }

        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Saving...';
        try {
          const client = await ensureClientForAppointment(appointment);
          if (!client?.id) throw new Error('Could not resolve client for this appointment.');
          await api(`/api/clients/${Number(client.id)}/notes`, {
            method: 'POST',
            body: JSON.stringify({
              note,
              stage: String(stage?.value || '')
            })
          });
          if (input) input.value = '';
          if (stage) stage.value = '';
          editor?.classList.add('hidden');
          showToast('Client note added.', 'success');
          void loadClients().catch(swallowBackgroundAsyncError);
        } catch (error) {
          showToast(error.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = oldText;
        }
      });
    });

    menu.querySelectorAll('.day-menu-email').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.appointmentId;
        if (!id) return;
        closeDayMenu();
        await openEmailComposerMenu(id);
      });
    });

    menu.querySelectorAll('.day-menu-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.appointmentId;
        if (!id) return;
        try {
          const result = await queueAwareMutation(`/api/appointments/${id}`, { method: 'DELETE' }, {
            allowOfflineQueue: true,
            description: 'Appointment deletion'
          });
          if (result.queued) {
            closeDayMenu();
            return;
          }
          await loadDashboard();
          await loadAppointmentsTable();
          await refreshCalendarDots({ force: true });
          const selectedCell = document.querySelector(`.day-cell[data-day="${Number(date.slice(8, 10))}"]`);
          if (selectedCell && state.dayMenuDate === date) {
            await openDayMenu(selectedCell, date);
          } else {
            closeDayMenu();
          }
          showToast('Appointment removed.', 'success');
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    });

    menu.querySelectorAll('.day-menu-cancel').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.appointmentId;
        if (!id || btn.disabled) return;
        await openCancelReasonMenu(id, date);
      });
    });

    menu.querySelectorAll('.day-menu-confirm').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.appointmentId;
        if (!id || btn.disabled) return;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.classList.add('is-busy');
        btn.textContent = 'Confirming...';
        try {
          const result = await queueAwareMutation(`/api/appointments/${id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'confirmed' })
          }, {
            allowOfflineQueue: true,
            description: 'Appointment confirmation'
          });
          if (result.queued) {
            btn.classList.remove('is-busy');
            btn.textContent = 'Queued';
            return;
          }
          showToast('Appointment confirmed!', 'success');
          await loadDashboard();
          await loadAppointmentsTable();
          await refreshCalendarDots({ force: true });
          const selectedCell = document.querySelector(`.day-cell[data-day="${Number(date.slice(8, 10))}"]`);
          if (selectedCell && state.dayMenuDate === date) {
            await openDayMenu(selectedCell, date);
          }
        } catch (error) {
          showToast(error.message, 'error');
          btn.disabled = false;
          btn.classList.remove('is-busy');
          btn.textContent = originalText;
        }
      });
    });
  } catch (error) {
    menu.innerHTML = `
      <div class="day-menu-header">
        <h3>${escapeHtml(formatMenuDate(date))}</h3>
        <button type="button" class="day-menu-close" aria-label="Close day menu">×</button>
      </div>
      <div class="day-menu-actions">
        <button type="button" class="btn-primary day-menu-add-offline">Add ${escapeHtml(getEntryWordSingularTitle())}</button>
      </div>
      <div class="day-menu-empty">Could not load this day while offline. You can still add a ${escapeHtml(getEntryWordSingularTitle().toLowerCase())}.</div>
    `;
    menu.querySelector('.day-menu-close')?.addEventListener('click', closeDayMenu);
    menu.querySelector('.day-menu-add-offline')?.addEventListener('click', () => {
      openNewAppointmentModalForDate(date);
    });
  }
}

function repositionDayMenuIfOpen() {
  const menu = document.getElementById('calendar-day-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  const anchorEl = state.dayMenuAnchorEl;
  if (!anchorEl || !document.contains(anchorEl)) {
    closeDayMenu();
    return;
  }
  positionDayMenu(anchorEl, menu);
}

function repositionQuickCreateMenuIfOpen() {
  const menu = document.getElementById('calendar-quick-create-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  const anchorEl = state.quickCreateAnchorEl;
  if (!anchorEl || !document.contains(anchorEl)) {
    closeQuickCreateMenu();
    return;
  }
  positionDayMenu(anchorEl, menu);
}

function repositionNotificationsMenuIfOpen() {
  const menu = document.getElementById('notifications-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  const anchorEl = state.notificationMenuAnchorEl;
  if (!anchorEl || !document.contains(anchorEl)) {
    closeNotificationsMenu();
    return;
  }
  positionNotificationsMenu(anchorEl, menu);
}

function toMoney(cents = 0) {
  return cents > 0 ? `£${(cents / 100).toFixed(0)}` : 'Free';
}

function reminderNotificationKey(reminder = {}) {
  const id = Number(reminder.id || 0);
  const date = String(reminder.date || '').slice(0, 10);
  const time = String(reminder.time || '').slice(0, 5);
  return `${id}|${date}|${time}`;
}

async function checkUpcomingReminderDesktopNotifications() {
  if (!state.browserNotificationsEnabled) return;
  if (!state.currentUser) return;
  if (!canUseBrowserNotifications()) return;
  if (getNotificationPermission() !== 'granted') return;
  const reminderModeEnabled = isReminderModeEnabled();

  let appointments = [];
  try {
    const payload = await api('/api/appointments');
    appointments = Array.isArray(payload?.appointments) ? payload.appointments : [];
  } catch (_error) {
    return;
  }

  const now = Date.now();
  const upcoming = appointments
    .filter((a) => {
      const source = String(a.source || '').toLowerCase();
      if (reminderModeEnabled) {
        if (source !== 'reminder') return false;
      }
      const status = String(a.status || '').toLowerCase();
      if (status === 'completed' || status === 'cancelled') return false;
      const date = String(a.date || '').slice(0, 10);
      const time = String(a.time || '').slice(0, 5);
      const at = new Date(`${date}T${time}:00`).getTime();
      if (!Number.isFinite(at)) return false;
      const notifyOffsetMinutes = Number(a.reminderOffsetMinutes == null ? 10 : a.reminderOffsetMinutes);
      const notifyAt = at - (Math.max(0, notifyOffsetMinutes) * 60 * 1000);
      const diffMs = notifyAt - now;
      return diffMs >= -60 * 1000 && diffMs <= 5 * 60 * 1000;
    })
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  if (!upcoming.length) return;

  const existing = pruneNotifiedReminderKeys(loadNotifiedReminderKeys());
  let changed = false;
  upcoming.forEach((item) => {
    const key = reminderNotificationKey(item);
    if (existing[key]) return;
    const fallbackLabel = reminderModeEnabled ? 'Reminder' : 'Appointment';
    const titleText = String(item.clientName || item.title || item.typeName || fallbackLabel).trim();
    const title = titleText || 'Reminder';
    const body = `${formatMenuDate(String(item.date || '').slice(0, 10))} at ${toTime12(String(item.time || '09:00').slice(0, 5))}`;
    const n = new Notification(title, {
      body,
      tag: `reminder-${key}`,
      renotify: false
    });
    n.onclick = () => {
      try { window.focus(); } catch (_error) { }
      void focusCalendarOnDate(item.date, { time: item.time, openMenu: false });
      n.close();
    };
    existing[key] = Date.now();
    changed = true;
  });

  if (changed) saveNotifiedReminderKeys(existing);
}

function stopReminderNotificationPolling() {
  if (!state.reminderNotificationTimer) return;
  clearInterval(state.reminderNotificationTimer);
  state.reminderNotificationTimer = null;
}

function startReminderNotificationPolling() {
  stopReminderNotificationPolling();
  if (!state.browserNotificationsEnabled) return;
  if (!canUseBrowserNotifications()) return;
  state.reminderNotificationTimer = setInterval(() => {
    void checkUpcomingReminderDesktopNotifications().catch(swallowBackgroundAsyncError);
  }, 60 * 1000);
  void checkUpcomingReminderDesktopNotifications().catch(swallowBackgroundAsyncError);
}

function formatUpcomingRelative(dateYmd = '', time24 = '09:00') {
  const safeDate = String(dateYmd || '').slice(0, 10);
  const safeTime = String(time24 || '').slice(0, 5);
  const target = new Date(`${safeDate}T${safeTime}:00`);
  if (Number.isNaN(target.getTime())) return toTime12(safeTime);

  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin <= 1 && diffMin >= -1) return 'now';
  if (diffMin > 1 && diffMin < 60) return `in ${diffMin} min`;
  if (diffMin >= 60 && diffMin < 24 * 60) {
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return mins ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (safeDate === tomorrow.toISOString().slice(0, 10)) {
    return `tomorrow ${toTime12(safeTime)}`;
  }

  return toTime12(safeTime);
}

function isAtOrAfterNow(dateYmd = '', time24 = '09:00') {
  const safeDate = String(dateYmd || '').slice(0, 10);
  const safeTime = String(time24 || '').slice(0, 5);
  const target = new Date(`${safeDate}T${safeTime}:00`);
  if (Number.isNaN(target.getTime())) return false;
  return target.getTime() >= Date.now();
}

function getCalendarPreviewLabel(appointment = {}) {
  const fallback = getEntryWordSingularTitle();
  return appointment.clientName || appointment.typeName || appointment.title || fallback;
}

function normalizeAppointmentLocation(value = '') {
  const location = String(value || '').trim().toLowerCase();
  if (location === 'office' || location === 'on-premises' || location === 'virtual' || location === 'phone') {
    return location;
  }
  // "hybrid" (or any unknown) falls back to office for owner-side create/edit forms.
  return 'office';
}

function resolveDefaultLocationForType(type) {
  return normalizeAppointmentLocation(type?.locationMode);
}

function setAppointmentFormLocation(location = 'office') {
  const form = document.getElementById('appointment-form');
  if (!form) return;
  const normalized = normalizeAppointmentLocation(location);
  const radio = form.querySelector(`input[name="location"][value="${normalized}"]`);
  if (radio) radio.checked = true;
}

function addMinutesToTime(time24 = '09:00', durationMinutes = 0) {
  const [h, m] = String(time24).split(':').map(Number);
  const start = (Number(h) || 0) * 60 + (Number(m) || 0);
  const total = start + Number(durationMinutes || 0);
  const normalized = ((total % 1440) + 1440) % 1440;
  const hh = Math.floor(normalized / 60);
  const mm = normalized % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  const { response, body } = await requestJson(path, options);
  if (response.status === 401) {
    const error = new Error(body.error || 'Authentication required.');
    error.code = 401;
    error.details = body;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    // Service worker returns 503 + { error: 'Offline' } for API calls with no network.
    error.code = response.status === 503 && body?.error === 'Offline'
      ? 'OFFLINE'
      : response.status;
    error.details = body;
    throw error;
  }
  return body;
}

async function requestJson(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(options.headers || {})
      }
    });
  } catch (_error) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const error = new Error(
      offline
        ? 'You are offline. Reconnect to sync your latest appointments.'
        : 'Cannot reach the server right now. Please try again in a moment.'
    );
    error.code = offline ? 'OFFLINE' : 'NETWORK';
    throw error;
  }
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function loadOfflineMutationQueue() {
  try {
    const raw = localStorage.getItem(OFFLINE_MUTATION_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function saveOfflineMutationQueue(queue) {
  localStorage.setItem(OFFLINE_MUTATION_QUEUE_KEY, JSON.stringify(queue));
  renderConnectionIndicator();
}

function enqueueOfflineMutation(item) {
  const queue = loadOfflineMutationQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...item
  });
  saveOfflineMutationQueue(queue);
  return queue.length;
}

async function queueAwareMutation(path, options = {}, queueMeta = {}) {
  try {
    return { queued: false, body: await api(path, options) };
  } catch (error) {
    const queueable = queueMeta.allowOfflineQueue && (error?.code === 'OFFLINE' || error?.code === 'NETWORK');
    if (!queueable) throw error;
    const queuedCount = enqueueOfflineMutation({
      path,
      method: String(options.method || 'POST').toUpperCase(),
      body: typeof options.body === 'string' ? options.body : null,
      description: queueMeta.description || 'Pending update'
    });
    showToast(`${queueMeta.description || 'Change'} queued offline (${queuedCount} pending).`, 'info');
    return { queued: true, body: null };
  }
}

async function refreshAfterSync() {
  if (!state.currentUser) return;
  try {
    await loadTypes();
    await loadDashboard();
    await loadAppointmentsTable();
    await loadClients();
    await loadSettings();
  } catch (_error) {
    // Ignore refresh errors; queue replay already handled.
  }
}

function swallowBackgroundAsyncError(error) {
  if (!error) return;
  // Offline/network transitions are expected for background refresh calls.
  if (isConnectivityError(error)) return;
  console.error(error);
}

function isConnectivityError(error) {
  if (!error) return false;
  if (error.code === 'OFFLINE' || error.code === 'NETWORK') return true;
  const message = String(error.message || '');
  return message === 'Offline' || message.includes('offline');
}

function bindGlobalAsyncErrorGuards() {
  if (typeof window === 'undefined') return;
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    if (!isConnectivityError(reason)) return;
    event.preventDefault();
  });
}

async function flushOfflineMutationQueue() {
  if (state.queueSyncInProgress) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const queue = loadOfflineMutationQueue();
  if (!queue.length) return;

  state.queueSyncInProgress = true;
  let synced = 0;
  let dropped = 0;

  try {
    let pending = [...queue];
    while (pending.length) {
      const entry = pending[0];
      try {
        const { response } = await requestJson(entry.path, {
          method: entry.method || 'POST',
          body: entry.body || undefined
        });
        if (!response.ok) {
          if (response.status >= 500) break;
          if (response.status === 401) break;
          dropped += 1;
          pending = pending.slice(1);
          saveOfflineMutationQueue(pending);
          continue;
        }
        synced += 1;
        pending = pending.slice(1);
        saveOfflineMutationQueue(pending);
      } catch (error) {
        if (error?.code === 'OFFLINE' || error?.code === 'NETWORK') break;
        dropped += 1;
        pending = pending.slice(1);
        saveOfflineMutationQueue(pending);
      }
    }
  } finally {
    state.queueSyncInProgress = false;
  }

  if (synced > 0) {
    showToast(`Synced ${synced} offline change${synced === 1 ? '' : 's'}.`, 'success');
    await refreshAfterSync();
  }
  if (dropped > 0) {
    showToast(`${dropped} offline change${dropped === 1 ? '' : 's'} could not be applied.`, 'error');
  }
}

async function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!window.isSecureContext && !isLocalhost) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

function bindNetworkState() {
  if (typeof window === 'undefined') return;
  let initialized = false;
  const sync = () => {
    const isOnline = navigator.onLine;
    const changed = initialized && state.apiOnline !== isOnline;
    state.apiOnline = isOnline;
    renderConnectionIndicator();
    if (changed) {
      showToast(
        isOnline
          ? 'Connection restored. Syncing latest data.'
          : 'You are offline. Cached pages stay available until connection returns.',
        isOnline ? 'success' : 'info'
      );
      if (isOnline) void flushOfflineMutationQueue().catch(swallowBackgroundAsyncError);
    }
    initialized = true;
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  sync();
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 220);
  }, 2400);
}

function renderConnectionIndicator() {
  const root = document.getElementById('connection-indicator');
  if (!root) return;
  const label = document.getElementById('connection-label');
  const queue = document.getElementById('connection-queue');
  const pending = loadOfflineMutationQueue().length;
  const online = Boolean(state.apiOnline);

  root.classList.toggle('is-online', online);
  root.classList.toggle('is-offline', !online);
  root.classList.toggle('has-pending', pending > 0);

  if (label) label.textContent = online ? 'Online' : 'Offline';
  if (queue) {
    if (pending > 0) {
      queue.classList.remove('hidden');
      queue.textContent = `${pending} pending`;
    } else {
      queue.classList.add('hidden');
    }
  }

  const pendingSuffix = pending > 0 ? `, ${pending} pending` : '';
  root.setAttribute('aria-label', `Connection ${online ? 'online' : 'offline'}${pendingSuffix}`);
}

/**
 * Styled replacement for window.confirm(). Returns a Promise<boolean>.
 */
function showConfirm(title, body) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <div class="confirm-dialog-title" id="confirm-title">${escapeHtml(title)}</div>
        <div class="confirm-dialog-body" id="confirm-body">${escapeHtml(body)}</div>
        <div class="confirm-dialog-actions">
          <button type="button" class="btn-secondary" id="confirm-cancel">Cancel</button>
          <button type="button" class="btn-primary" id="confirm-ok">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const cleanup = (result) => {
      backdrop.remove();
      resolve(result);
    };

    backdrop.querySelector('#confirm-ok').addEventListener('click', () => cleanup(true));
    backdrop.querySelector('#confirm-cancel').addEventListener('click', () => cleanup(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(false); });
    backdrop.querySelector('#confirm-ok').focus();
  });
}

/** Render a skeleton placeholder inside an element while content is loading. */
function renderSkeleton(el, lines = 3) {
  if (!el) return;
  el.innerHTML = `<div class="skeleton-card">${Array.from({ length: lines }, () => '<div class="skeleton skeleton-line"></div>').join('')
    }</div>`;
}

async function cancelAppointmentById(appointmentId, date = '', cancellationReason = '') {
  if (!appointmentId) return;
  try {
    const payload = { status: 'cancelled' };
    const cleanReason = String(cancellationReason || '').trim();
    if (cleanReason) payload.cancellationReason = cleanReason;
    const result = await queueAwareMutation(`/api/appointments/${appointmentId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }, {
      allowOfflineQueue: true,
      description: 'Appointment cancellation'
    });
    if (result.queued) return;
    showToast('Appointment cancelled.', 'success');
    await loadDashboard();
    await loadAppointmentsTable();
    await refreshCalendarDots({ force: true });
    if (date && state.dayMenuDate === date) {
      const selectedCell = document.querySelector(`.day-cell[data-day="${Number(date.slice(8, 10))}"]`);
      if (selectedCell) await openDayMenu(selectedCell, date);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function getStoredViewPreference() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const value = localStorage.getItem('currentView');
    return value ? String(value) : null;
  } catch (_error) {
    return null;
  }
}

function applyViewSelection(activeView) {
  const visibleView = activeView;
  const views = [...document.querySelectorAll('.app-view')];
  views.forEach((section) => {
    section.classList.toggle('active', section.dataset.view === visibleView);
  });

  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === activeView);
  });

  document.querySelectorAll('.mobile-nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === activeView);
  });
}

function resolveView(view) {
  const views = [...document.querySelectorAll('.app-view')];
  const availableViews = new Set(views.map((section) => section.dataset.view).filter(Boolean));
  if (isClientModeEnabled() && view !== 'clients' && view !== 'settings' && view !== 'dashboard') view = 'dashboard';
  if (isReminderModeEnabled() && view === 'ai') view = 'dashboard';
  if (isReminderModeEnabled() && view === 'types') view = 'dashboard';
  if (view === 'calendar') view = 'dashboard';
  const fallbackView = availableViews.has('dashboard') ? 'dashboard' : views[0]?.dataset.view;
  const activeView = availableViews.has(view) ? view : fallbackView;
  return activeView || null;
}

function applyInitialViewPreference(view) {
  const activeView = resolveView(view);
  if (!activeView) return null;
  applyViewSelection(activeView);
  return activeView;
}
