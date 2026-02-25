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

const state = {
  types: [],
  selectedTypeId: null,
  selectedDate: new Date().toISOString().slice(0, 10),
  apiOnline: true,
  viewAll: false,
  calendarDate: new Date(),
  lastFocusedElement: null,
  dayMenuDate: null,
  dayMenuAnchorEl: null,
  quickCreateDate: '',
  quickCreateTime: '',
  quickCreateAppointmentId: null,
  quickCreateAnchorEl: null,
  editingAppointmentId: null,
  searchOriginView: null,
  searchActive: false,
  emailMenuAppointmentId: null,
  cancelMenuAppointmentId: null,
  cancelMenuDate: '',
  notificationMenuAnchorEl: null,
  currentUser: null,
  currentBusiness: null,
  reminderMode: getStoredBoolean('reminderMode'),
  workspaceMode: 'appointments',
  browserNotificationsEnabled: getStoredBoolean('browserNotificationsEnabled'),
  calendarShowClientNames: getStoredBoolean('calendarShowClientNames'),
  dashboardStatsCollapsed: getStoredBoolean('dashboardStatsCollapsed'),
  calendarViewMode: 'month',
  authShellDismissed: false,
  queueSyncInProgress: false,
  calendarExpanded: getStoredBoolean('calendarExpanded'),
  unreadNotifications: 0,
  nextReminder: null,
  reminderNotificationTimer: null,
  authLoginChallengeToken: '',
  authLoginEmail: '',
  authResendCooldownUntil: 0,
  calendarDotsRequestId: 0,
  calendarWeekRequestId: 0,
  searchRequestId: 0,
  clients: [],
  selectedClientId: null,
  clientSearchTimer: null
};

const CALENDAR_MONTH_CACHE_TTL_MS = 120000;
const CALENDAR_VIEW_MODES = ['day', 'week', 'month'];
const calendarMonthCache = new Map();
const calendarMonthInFlight = new Map();

const OFFLINE_MUTATION_QUEUE_KEY = 'intellischedule.offlineMutationQueue.v1';
const AUTH_SNAPSHOT_KEY = 'intellischedule.authSnapshot.v1';
const ACCENT_COLORS = ['green', 'blue', 'red', 'purple', 'amber'];
const WORKSPACE_MODES = ['appointments', 'reminders', 'clients'];
const MOBILE_NAV_MODE_KEY = 'mobileNavMode';
const BROWSER_NOTIFICATIONS_KEY = 'browserNotificationsEnabled';
const REMINDER_NOTIFIED_KEYS_STORAGE = 'intellischedule.reminderNotifiedKeys.v1';
const BUSINESS_HOURS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const GLOBAL_SEARCH_SETTINGS_OPTIONS = [
  { label: 'Business Name', targetId: 'settings-business-name', sectionSelector: '#settings-section-profile', keywords: ['business', 'name', 'company'] },
  { label: 'Owner Email', targetId: 'settings-owner-email', sectionSelector: '#settings-section-profile', keywords: ['owner', 'email', 'contact'] },
  { label: 'Open Time', targetId: 'settings-open-time', sectionSelector: '#settings-section-profile', keywords: ['open', 'hours', 'time'] },
  { label: 'Close Time', targetId: 'settings-close-time', sectionSelector: '#settings-section-profile', keywords: ['close', 'hours', 'time'] },
  { label: 'Monday Hours', targetId: 'settings-hours-mon-open', sectionSelector: '#settings-section-profile', keywords: ['monday', 'mon', 'hours'] },
  { label: 'Tuesday Hours', targetId: 'settings-hours-tue-open', sectionSelector: '#settings-section-profile', keywords: ['tuesday', 'tue', 'hours'] },
  { label: 'Wednesday Hours', targetId: 'settings-hours-wed-open', sectionSelector: '#settings-section-profile', keywords: ['wednesday', 'wed', 'hours'] },
  { label: 'Thursday Hours', targetId: 'settings-hours-thu-open', sectionSelector: '#settings-section-profile', keywords: ['thursday', 'thu', 'hours'] },
  { label: 'Friday Hours', targetId: 'settings-hours-fri-open', sectionSelector: '#settings-section-profile', keywords: ['friday', 'fri', 'hours'] },
  { label: 'Saturday Hours', targetId: 'settings-hours-sat-open', sectionSelector: '#settings-section-profile', keywords: ['saturday', 'sat', 'hours'] },
  { label: 'Sunday Hours', targetId: 'settings-hours-sun-open', sectionSelector: '#settings-section-profile', keywords: ['sunday', 'sun', 'hours'] },
  { label: 'Theme', targetId: 'settings-theme-light', sectionSelector: '#settings-section-appearance', keywords: ['theme', 'dark', 'light'] },
  { label: 'Accent Color', targetId: 'settings-section-appearance', sectionSelector: '#settings-section-appearance', keywords: ['accent', 'color', 'green', 'blue', 'red', 'purple', 'amber'] },
  { label: 'Reminder Mode', targetId: 'settings-reminder-mode', sectionSelector: '#settings-section-appearance', keywords: ['reminder', 'mode', 'appointments'] },
  { label: 'Workspace Mode', targetId: 'settings-workspace-mode', sectionSelector: '#settings-section-appearance', keywords: ['workspace', 'mode', 'clients', 'reminders', 'appointments'] },
  { label: 'Mobile Navigation Mode', targetId: 'settings-mobile-nav-bottom-tabs', sectionSelector: '#settings-section-appearance', keywords: ['mobile', 'navigation', 'bottom', 'tabs', 'sidebar'] },
  { label: 'Calendar Client Names', targetId: 'settings-calendar-show-client-names', sectionSelector: '#settings-section-appearance', keywords: ['calendar', 'client', 'names', 'dots'] },
  { label: 'Owner Email Notifications', targetId: 'settings-notify-owner-email', sectionSelector: '#settings-section-appearance', keywords: ['notify', 'notification', 'owner', 'email'] },
  { label: 'Export Data', targetId: 'btn-export-data', sectionSelector: '#settings-section-data', keywords: ['export', 'backup', 'download'] },
  { label: 'Import Data', targetId: 'btn-import-data', sectionSelector: '#settings-section-data', keywords: ['import', 'restore', 'upload'] },
  { label: 'Import with AI', targetId: 'btn-import-ai-data', sectionSelector: '#settings-section-data', keywords: ['ai', 'import', 'text', 'paste'] },
  { label: 'Customer Booking Page', targetId: 'btn-public-booking-settings', sectionSelector: '#settings-section-data', keywords: ['booking', 'public', 'link', 'clients'] }
];

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
  setText('.mobile-nav-item[data-view="appointments"] span', reminderMode ? 'Reminders' : 'Appts');
  setText('section[data-view="appointments"] .page-header-main h2', `All ${entryPluralTitle}`);
  setText('#btn-new-appointment span', `New ${entrySingularTitle}`);
  setText('#stat-card-today .stat-hint', `${entryPlural} today`);
  setText('#stat-card-week .stat-hint', reminderMode ? 'scheduled this week' : 'booked this week');
  setText('#stat-card-pending .stat-hint', reminderMode ? 'awaiting completion' : 'awaiting confirmation');

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

  const dashboardAiInsightsCard = document.querySelector('section[data-view="dashboard"] .card.ai-insights');
  if (dashboardAiInsightsCard) {
    if (reminderMode || clientMode) {
      dashboardAiInsightsCard.setAttribute('hidden', 'hidden');
      dashboardAiInsightsCard.classList.add('hidden');
    } else {
      dashboardAiInsightsCard.removeAttribute('hidden');
      dashboardAiInsightsCard.classList.remove('hidden');
    }
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

function localYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYmd(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getWeekStart(dateValue = new Date()) {
  const dt = new Date(dateValue);
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() - dt.getDay());
  return dt;
}

function addDays(dateValue, days = 0) {
  const dt = new Date(dateValue);
  dt.setDate(dt.getDate() + Number(days || 0));
  return dt;
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
      const payload = await api(`/api/clients?q=${encodeURIComponent(name)}`);
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
  let left = isNarrowScreen ? (vw - menuRect.width) / 2 : rect.left;
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

async function openDayMenu(anchorEl, date) {
  closeQuickCreateMenu();
  const menu = ensureDayMenu();
  state.dayMenuDate = date;
  state.dayMenuAnchorEl = anchorEl;
  menu.innerHTML = '<div class="day-menu-loading">Loading...</div>';
  positionDayMenu(anchorEl, menu);

  try {
    const { appointments } = await api(`/api/appointments?date=${encodeURIComponent(date)}`);
    if (state.dayMenuDate !== date) return;
    const items = appointments
      .map(
        (a) => `
          <div class="day-menu-item">
            <div class="day-menu-item-copy">
              <strong>${escapeHtml(toTime12(a.time))} - ${escapeHtml(toTime12(addMinutesToTime(a.time, a.durationMinutes)))}</strong>
              <span>${escapeHtml(a.clientName)} • ${escapeHtml(a.typeName)} • ${escapeHtml(a.status)}</span>
            </div>
            <div class="day-menu-client-notes" data-client-notes-for="${a.id}">
              <div class="day-menu-client-notes-state">Open actions to view client notes.</div>
            </div>
            <div class="day-menu-item-actions-wrap">
              <div class="day-menu-top-actions">
                <button type="button" class="day-menu-show-actions" data-appointment-id="${a.id}" aria-expanded="false">Show actions</button>
                <button type="button" class="day-menu-open-client" data-appointment-id="${a.id}" aria-label="Open client info">Client info</button>
              </div>
              <div class="day-menu-item-actions hidden" data-actions-for="${a.id}">
                ${a.clientEmail
            ? `<button type="button" class="day-menu-email" data-appointment-id="${a.id}" aria-label="Email ${escapeHtml(getEntryWordSingularTitle().toLowerCase())} details">Email</button>`
            : ''
          }
                ${a.status === 'pending'
            ? `<button type="button" class="day-menu-confirm" data-appointment-id="${a.id}" aria-label="Confirm ${escapeHtml(getEntryWordSingularTitle().toLowerCase())}">Confirm</button>`
            : ''
          }
                <button type="button" class="day-menu-note" data-appointment-id="${a.id}" aria-label="Add client note">Add note</button>
                <button type="button" class="day-menu-edit" data-appointment-id="${a.id}" aria-label="Edit ${escapeHtml(getEntryWordSingularTitle().toLowerCase())}">Edit</button>
                <button type="button" class="day-menu-cancel" data-appointment-id="${a.id}" ${a.status === 'cancelled' ? 'disabled' : ''} aria-label="Cancel ${escapeHtml(getEntryWordSingularTitle().toLowerCase())}">${a.status === 'cancelled' ? 'Cancelled' : 'Cancel'}</button>
                <button type="button" class="day-menu-delete" data-appointment-id="${a.id}" aria-label="Delete ${escapeHtml(getEntryWordSingularTitle().toLowerCase())}">Delete</button>
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

    menu.innerHTML = `
      <div class="day-menu-header">
        <h3>${escapeHtml(formatMenuDate(date))}</h3>
        <button type="button" class="day-menu-close" aria-label="Close day menu">×</button>
      </div>
      <div class="day-menu-actions">
        <button type="button" class="btn-primary day-menu-add">Add ${escapeHtml(getEntryWordSingularTitle())}</button>
      </div>
      <div class="day-menu-list">
        ${items || `<div class="day-menu-empty">No ${escapeHtml(getEntryWordPlural())} for this day.</div>`}
      </div>
    `;

    positionDayMenu(anchorEl, menu);

    menu.querySelector('.day-menu-close')?.addEventListener('click', closeDayMenu);
    menu.querySelector('.day-menu-add')?.addEventListener('click', () => {
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
          n.textContent = 'Show actions';
        });
        if (opening) {
          target.classList.remove('hidden');
          btn.setAttribute('aria-expanded', 'true');
          btn.textContent = 'Hide actions';
          const appointment = appointments.find((item) => Number(item.id) === Number(id));
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
        const appointment = appointments.find((a) => Number(a.id) === id);
        closeDayMenu();
        startEditAppointment(appointment);
      });
    });

    menu.querySelectorAll('.day-menu-open-client').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.appointmentId);
        const appointment = appointments.find((a) => Number(a.id) === id);
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
        const appointment = appointments.find((item) => Number(item.id) === id);
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

function toTime12(time24 = '09:00') {
  const [h, m] = time24.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, '0')} ${suffix}`;
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

function toTimeCompact(time24 = '09:00') {
  const [h, m] = String(time24).split(':').map(Number);
  const hh = Number.isFinite(h) ? String(h).padStart(2, '0') : '09';
  const mm = Number.isFinite(m) ? String(m).padStart(2, '0') : '00';
  return `${hh}:${mm}`;
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

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function monthLabel(date) {
  return date.toLocaleString('en-US', { month: 'short' });
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

function setActiveView(view, options = {}) {
  if (!view) return;
  const { skipAppointmentsReload = false } = options || {};
  const activeView = resolveView(view);
  if (!activeView) return;
  closeQuickCreateMenu();

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('currentView', activeView);
    } catch (_error) {
      // Ignore storage write failures (private mode, disabled storage, etc.)
    }
  }

  applyViewSelection(activeView);

  const canAutoLoadAppointments =
    typeof window !== 'undefined' && /^https?:$/i.test(window.location?.protocol || '');
  if (activeView === 'appointments' && canAutoLoadAppointments && !skipAppointmentsReload) {
    void loadAppointmentsTable().catch(swallowBackgroundAsyncError);
  }
  if (activeView === 'clients' && canAutoLoadAppointments) {
    void loadClients().catch(swallowBackgroundAsyncError);
  }
}

function getActiveView() {
  return document.querySelector('.app-view.active')?.dataset.view || 'dashboard';
}

function toHalfHourSlot(time24 = '09:00') {
  const [hRaw, mRaw] = String(time24 || '09:00').split(':').map(Number);
  const h = Number.isFinite(hRaw) ? hRaw : 9;
  const m = Number.isFinite(mRaw) ? mRaw : 0;
  let totalMinutes = (h * 60) + m;
  // Snap to nearest 30-minute grid slot for calendar placement.
  totalMinutes = Math.round(totalMinutes / 30) * 30;
  if (totalMinutes < 0) totalMinutes = 0;
  if (totalMinutes > (23 * 60 + 30)) totalMinutes = 23 * 60 + 30;
  const slotHour = Math.floor(totalMinutes / 60);
  const slotMinute = totalMinutes % 60;
  return `${String(slotHour).padStart(2, '0')}:${String(slotMinute).padStart(2, '0')}`;
}

async function focusCalendarOnDate(date, { time = '', openMenu = true } = {}) {
  const safeDate = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) return;

  setActiveView('dashboard');
  state.selectedDate = safeDate;

  const dt = new Date(`${safeDate}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return;

  let mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode === 'month' && time) {
    mode = 'week';
    state.calendarViewMode = mode;
    setStoredValue('calendarViewMode', mode);
  }
  state.calendarDate = mode === 'month'
    ? new Date(dt.getFullYear(), dt.getMonth(), 1)
    : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());

  const monthLabelNode = document.querySelector('.current-month');
  if (monthLabelNode) monthLabelNode.textContent = getCalendarHeaderLabel();
  renderCalendarGrid();

  await loadDashboard(safeDate, { refreshDots: false, showSkeleton: false });
  await refreshCalendarDots({ force: true });

  const slot = time
    ? document.querySelector(`.week-slot[data-slot-date="${safeDate}"][data-slot-time="${toHalfHourSlot(time)}"]`)
    : null;
  if (slot) {
    slot.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } else {
    document.querySelector('.calendar-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (!openMenu) return;
  if (mode === 'month') {
    const day = Number(safeDate.slice(8, 10));
    const selectedCell = document.querySelector(`.day-cell[data-day="${day}"]:not(.empty)`);
    if (selectedCell) await openDayMenu(selectedCell, safeDate);
    return;
  }
  const selectedHeader = document.querySelector(`.week-day-header[data-week-date="${safeDate}"]`);
  if (selectedHeader) await openDayMenu(selectedHeader, safeDate);
}

function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetView = item.dataset.view || 'dashboard';
      setActiveView(targetView);
    });
  });

  document.querySelectorAll('.mobile-nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetView = item.dataset.view || 'dashboard';
      setActiveView(targetView);
    });
  });

  document.getElementById('btn-manage-types')?.addEventListener('click', () => setActiveView('types'));
}

function bindHeaderButtons() {
  const sidebar = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const menuBtn = document.getElementById('btn-mobile-menu');
  const mobileSidebarQuery = window.matchMedia('(max-width: 768px), (hover: none) and (pointer: coarse) and (max-width: 1024px)');

  const setSidebarOpen = (open) => {
    if (!sidebar) return;
    if (open && document.body.classList.contains('mobile-nav-mode-bottom')) return;
    const shouldOpen = Boolean(open);
    sidebar.classList.toggle('mobile-open', shouldOpen);
    document.body.classList.toggle('sidebar-open', shouldOpen);
    if (sidebarBackdrop) {
      sidebarBackdrop.classList.toggle('visible', shouldOpen);
      sidebarBackdrop.hidden = !shouldOpen;
    }
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    }
  };

  const closeSidebar = () => setSidebarOpen(false);

  document.getElementById('btn-new-appointment')?.addEventListener('click', () => {
    state.editingAppointmentId = null;
    updateAppointmentEditorUi(false);
    openModal('new-appointment');
  });
  document.querySelectorAll('[data-notification-button]').forEach((button) => {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.getElementById('notifications-menu');
      const isOpen = menu && !menu.classList.contains('hidden');
      if (isOpen && state.notificationMenuAnchorEl === button) {
        closeNotificationsMenu();
        return;
      }
      await openNotificationsMenu(button);
    });
  });

  menuBtn?.addEventListener('click', () => {
    if (!mobileSidebarQuery.matches) return;
    if (document.body.classList.contains('mobile-nav-mode-bottom')) return;
    setSidebarOpen(!sidebar?.classList.contains('mobile-open'));
  });

  sidebarBackdrop?.addEventListener('click', closeSidebar);

  document.addEventListener('click', (e) => {
    if (sidebar?.classList.contains('mobile-open')) {
      if (!sidebar.contains(e.target) && !menuBtn?.contains(e.target)) {
        closeSidebar();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar?.classList.contains('mobile-open')) {
      closeSidebar();
    }
  });

  const handleSidebarMediaChange = (event) => {
    if (!event.matches) closeSidebar();
  };
  if (typeof mobileSidebarQuery.addEventListener === 'function') {
    mobileSidebarQuery.addEventListener('change', handleSidebarMediaChange);
  } else if (typeof mobileSidebarQuery.addListener === 'function') {
    mobileSidebarQuery.addListener(handleSidebarMediaChange);
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (sidebar?.classList.contains('mobile-open')) closeSidebar();
    });
  });

  document.getElementById('btn-view-all')?.addEventListener('click', async (e) => {
    state.viewAll = !state.viewAll;
    e.currentTarget.textContent = state.viewAll ? 'Show Day' : 'View All';
    await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
  });

  document.getElementById('btn-refresh-appointments')?.addEventListener('click', loadAppointmentsTable);
}

function syncDashboardStatsUi() {
  const collapsed = Boolean(state.dashboardStatsCollapsed);
  document.body.classList.toggle('dashboard-stats-collapsed', collapsed);

  const btn = document.getElementById('btn-toggle-stats');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

  const label = document.querySelector('[data-stats-toggle-label]');
  if (label) label.textContent = collapsed ? 'Show overview' : 'Hide overview';
}

function bindDashboardStatsToggle() {
  syncDashboardStatsUi();
  const btn = document.getElementById('btn-toggle-stats');
  if (!btn) return;

  btn.addEventListener('click', () => {
    state.dashboardStatsCollapsed = !state.dashboardStatsCollapsed;
    setStoredValue('dashboardStatsCollapsed', state.dashboardStatsCollapsed);
    syncDashboardStatsUi();
  });

  document.getElementById('stat-card-pending')?.addEventListener('click', async () => {
    if (!isReminderModeEnabled()) return;
    const next = state.nextReminder;
    if (!next?.date) return;
    await focusCalendarOnDate(next.date, { time: next.time, openMenu: false });
  });
}

function renderNotificationDots(count = 0) {
  const hasNotifications = Number(count) > 0;
  document.querySelectorAll('[data-notification-dot]').forEach((dot) => {
    dot.classList.toggle('hidden', !hasNotifications);
  });
}

function bindModalControls() {
  document.getElementById('new-appointment-overlay')?.addEventListener('click', () => closeModal('new-appointment'));
  document
    .getElementById('btn-close-new-appointment')
    ?.addEventListener('click', () => closeModal('new-appointment'));
  document
    .getElementById('btn-cancel-new-appointment')
    ?.addEventListener('click', () => closeModal('new-appointment'));
}

function renderCalendarGrid() {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;

  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode === 'week' || mode === 'day') {
    renderCalendarTimeGrid();
    return;
  }

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const year = state.calendarDate.getFullYear();
  const month = state.calendarDate.getMonth();

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const today = new Date();
  const isTodayMonth = today.getFullYear() === year && today.getMonth() === month;

  const selected = state.selectedDate ? new Date(`${state.selectedDate}T00:00:00`) : null;
  const isSelectedMonth = selected && selected.getFullYear() === year && selected.getMonth() === month;

  const headers = weekdays.map((d) => `<div class="day-header">${d}</div>`).join('');
  const empties = Array.from({ length: firstWeekday }, () => '<div class="day-cell empty"></div>').join('');

  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const classes = ['day-cell'];

    if (isTodayMonth && day === today.getDate()) classes.push('today');
    if (isSelectedMonth && day === selected.getDate()) classes.push('selected');

    return `
      <div class="${classes.join(' ')}" data-day="${day}" aria-label="${day}">
        <span class="day-number">${day}</span>
        <div class="day-events-preview" aria-hidden="true"></div>
      </div>`;
  }).join('');

  grid.classList.remove('google-like');
  grid.classList.remove('google-like-day');
  grid.innerHTML = `${headers}${empties}${days}`;
}

function getCalendarDisplayRangeMinutes() {
  if (isReminderModeEnabled() || isClientModeEnabled()) {
    return { start: 0, end: 24 * 60 };
  }
  const defaultOpen = '08:00';
  const defaultClose = '18:00';
  const openRaw = document.getElementById('settings-open-time')?.value || defaultOpen;
  const closeRaw = document.getElementById('settings-close-time')?.value || defaultClose;
  const openMinutes = timeToMinutes(openRaw);
  const closeMinutes = timeToMinutes(closeRaw);
  if (!Number.isFinite(openMinutes) || !Number.isFinite(closeMinutes) || closeMinutes <= openMinutes) {
    return { start: 8 * 60, end: 18 * 60 };
  }
  return { start: openMinutes, end: closeMinutes };
}

function renderCalendarTimeGrid(timeGridAppointments = [], { loading = false } = {}) {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;

  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  const visibleDates = getVisibleCalendarDates(state.calendarDate, mode);
  const todayYmd = localYmd();
  const selectedDate = state.selectedDate;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const { start, end } = getCalendarDisplayRangeMinutes();
  const slotMinutes = [];
  for (let mins = start; mins < end; mins += 30) slotMinutes.push(mins);

  const apptMap = new Map();
  timeGridAppointments.forEach((appointment) => {
    const date = String(appointment?.date || '');
    const time = String(appointment?.time || '').slice(0, 5);
    if (!date || !time) return;
    const key = `${date} ${toHalfHourSlot(time)}`;
    if (!apptMap.has(key)) apptMap.set(key, []);
    apptMap.get(key).push(appointment);
  });
  apptMap.forEach((items) => {
    items.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  });

  const headerCells = visibleDates.map((date, idx) => {
    const parsed = parseYmd(date);
    const dayIndex = parsed ? parsed.getDay() : idx;
    const isToday = date === todayYmd;
    const isSelected = date === selectedDate;
    const dayNum = Number(String(date).slice(8, 10));
    const classes = ['week-day-header'];
    if (isToday) classes.push('today');
    if (isSelected) classes.push('selected');
    return `
      <button type="button" class="${classes.join(' ')}" data-week-date="${date}" aria-label="Open ${escapeHtml(formatMenuDate(date))}">
        <span class="week-day-name">${dayNames[dayIndex] || ''}</span>
        <span class="week-day-num">${dayNum}</span>
      </button>`;
  }).join('');

  const rows = slotMinutes.map((mins) => {
    const time24 = minutesToTime(mins);
    const rowCells = visibleDates.map((date) => {
      const key = `${date} ${time24}`;
      const appointments = apptMap.get(key) || [];
      const isToday = date === todayYmd;
      const isSelectedDate = date === selectedDate;
      const classes = ['week-slot'];
      if (isToday) classes.push('today');
      if (isSelectedDate) classes.push('selected-day');
      if (appointments.length) classes.push('has-event');
      const chips = loading
        ? '<div class="week-slot-skeleton"></div>'
        : appointments.map((a) => `
            <div
              class="week-event-chip"
              data-appointment-id="${Number(a.id)}"
              data-appointment-type-id="${a.typeId != null ? Number(a.typeId) : ''}"
              data-appointment-client-name="${escapeHtml(a.clientName || '')}"
              data-appointment-date="${escapeHtml(a.date || date)}"
              data-appointment-time="${escapeHtml(a.time || time24)}"
              data-appointment-duration="${Number(a.durationMinutes || 45)}"
              data-appointment-reminder-offset="${Number(a.reminderOffsetMinutes == null ? 10 : a.reminderOffsetMinutes)}"
              data-appointment-location="${escapeHtml(a.location || 'office')}"
              data-appointment-source="${escapeHtml(a.source || 'owner')}">
              <span class="week-event-name">${escapeHtml(getCalendarPreviewLabel(a))}</span>
              <span class="week-event-time">${escapeHtml(
                isReminderEntry(a) || Number(a.durationMinutes || 0) <= 0
                  ? toTimeCompact(a.time)
                  : `${toTimeCompact(a.time)} - ${toTimeCompact(addMinutesToTime(a.time, a.durationMinutes))}`
              )}</span>
            </div>
          `).join('');
      return `
        <button type="button" class="${classes.join(' ')}" data-slot-date="${date}" data-slot-time="${time24}" aria-label="Add ${escapeHtml(getEntryWordSingularTitle().toLowerCase())} on ${escapeHtml(formatMenuDate(date))} at ${escapeHtml(toTime12(time24))}">
          <div class="week-slot-content">${chips}</div>
        </button>`;
    }).join('');

    return `
      <div class="week-time-label">${escapeHtml(toTime12(time24))}</div>
      ${rowCells}`;
  }).join('');

  grid.classList.add('google-like');
  grid.classList.toggle('google-like-day', mode === 'day');
  grid.innerHTML = `
    <div class="week-grid-corner"></div>
    ${headerCells}
    ${rows}
  `;
}

function syncCalendarViewSelector() {
  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  document.querySelectorAll('.calendar-view-btn[data-calendar-view]').forEach((btn) => {
    const active = btn.dataset.calendarView === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateTimeGridSelectionUi() {
  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode !== 'week' && mode !== 'day') return;
  const selectedDate = state.selectedDate;
  document.querySelectorAll('.week-day-header[data-week-date]').forEach((node) => {
    node.classList.toggle('selected', node.dataset.weekDate === selectedDate);
  });
  document.querySelectorAll('.week-slot[data-slot-date]').forEach((node) => {
    node.classList.toggle('selected-day', node.dataset.slotDate === selectedDate);
  });
}

function updateCalendarExpandedState() {
  const calendarCard = document.querySelector('.calendar-card');
  const grid = calendarCard?.closest('.dashboard-grid');
  const btn = document.getElementById('btn-calendar-expand');
  if (!grid || !btn) return;

  grid.classList.toggle('calendar-expanded', state.calendarExpanded);
  btn.querySelector('.expand-icon')?.classList.toggle('hidden', state.calendarExpanded);
  btn.querySelector('.collapse-icon')?.classList.toggle('hidden', !state.calendarExpanded);
  setStoredValue('calendarExpanded', state.calendarExpanded);
}

function bindCalendarNav() {
  const labelNode = document.querySelector('.current-month');
  const setMonth = () => {
    if (labelNode) labelNode.textContent = getCalendarHeaderLabel();
    syncCalendarViewSelector();
    renderCalendarGrid();
  };
  setMonth();

  document.getElementById('btn-calendar-expand')?.addEventListener('click', () => {
    state.calendarExpanded = !state.calendarExpanded;
    updateCalendarExpandedState();
  });

  updateCalendarExpandedState();

  document.getElementById('calendar-prev')?.addEventListener('click', async () => {
    closeDayMenu();
    closeQuickCreateMenu();
    const mode = normalizeCalendarViewMode(state.calendarViewMode);
    if (mode === 'week') {
      state.calendarDate = addDays(state.calendarDate, -7);
    } else if (mode === 'day') {
      state.calendarDate = addDays(state.calendarDate, -1);
    } else {
      state.calendarDate.setMonth(state.calendarDate.getMonth() - 1);
    }
    setMonth();
    await refreshCalendarDots();
  });

  document.getElementById('calendar-next')?.addEventListener('click', async () => {
    closeDayMenu();
    closeQuickCreateMenu();
    const mode = normalizeCalendarViewMode(state.calendarViewMode);
    if (mode === 'week') {
      state.calendarDate = addDays(state.calendarDate, 7);
    } else if (mode === 'day') {
      state.calendarDate = addDays(state.calendarDate, 1);
    } else {
      state.calendarDate.setMonth(state.calendarDate.getMonth() + 1);
    }
    setMonth();
    await refreshCalendarDots();
  });

  document.querySelectorAll('.calendar-view-btn[data-calendar-view]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nextMode = normalizeCalendarViewMode(btn.dataset.calendarView);
      if (state.calendarViewMode === nextMode) return;
      state.calendarViewMode = nextMode;
      setStoredValue('calendarViewMode', nextMode);
      const selectedDate = parseYmd(state.selectedDate);
      if (selectedDate) state.calendarDate = selectedDate;
      closeDayMenu();
      closeQuickCreateMenu();
      setMonth();
      await refreshCalendarDots();
    });
  });

  document.getElementById('calendar-grid')?.addEventListener('click', (event) => {
    const mode = normalizeCalendarViewMode(state.calendarViewMode);
    if (mode === 'week' || mode === 'day') {
      const dayHeader = event.target.closest('.week-day-header[data-week-date]');
      if (dayHeader) {
        const date = dayHeader.dataset.weekDate;
        if (!date) return;
        state.selectedDate = date;
        closeQuickCreateMenu();
        state.viewAll = false;
        const btn = document.getElementById('btn-view-all');
        if (btn) btn.textContent = 'View All';
        void loadDashboard(date, { refreshDots: false }).catch(swallowBackgroundAsyncError);
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          showToast(`Offline mode: open a time slot to create a ${getEntryWordSingularTitle().toLowerCase()}.`, 'info');
          return;
        }
        void openDayMenu(dayHeader, date).catch(swallowBackgroundAsyncError);
        updateTimeGridSelectionUi();
        return;
      }

      const eventCard = event.target.closest('.week-event-chip[data-appointment-id]');
      if (eventCard) {
        const appointmentId = Number(eventCard.dataset.appointmentId);
        if (!Number.isFinite(appointmentId) || appointmentId <= 0) return;
        const appointment = {
          id: appointmentId,
          typeId: eventCard.dataset.appointmentTypeId ? Number(eventCard.dataset.appointmentTypeId) : null,
          clientName: String(eventCard.dataset.appointmentClientName || ''),
          date: String(eventCard.dataset.appointmentDate || ''),
          time: String(eventCard.dataset.appointmentTime || '').slice(0, 5),
          durationMinutes: Number(eventCard.dataset.appointmentDuration || 45),
          reminderOffsetMinutes: Number(eventCard.dataset.appointmentReminderOffset == null ? 10 : eventCard.dataset.appointmentReminderOffset),
          location: String(eventCard.dataset.appointmentLocation || 'office'),
          source: String(eventCard.dataset.appointmentSource || 'owner')
        };
        if (!appointment.date || !appointment.time) return;
        state.selectedDate = appointment.date;
        state.viewAll = false;
        const btn = document.getElementById('btn-view-all');
        if (btn) btn.textContent = 'View All';
        closeDayMenu();
        void loadDashboard(appointment.date, { refreshDots: false }).catch(swallowBackgroundAsyncError);
        void openQuickCreateMenu(eventCard, appointment.date, appointment.time, appointment).catch(swallowBackgroundAsyncError);
        updateTimeGridSelectionUi();
        return;
      }

      const slot = event.target.closest('.week-slot[data-slot-date][data-slot-time]');
      if (!slot) return;
      const date = slot.dataset.slotDate;
      const time = slot.dataset.slotTime;
      if (!date || !time) return;
      state.selectedDate = date;
      state.viewAll = false;
      const btn = document.getElementById('btn-view-all');
      if (btn) btn.textContent = 'View All';
      closeDayMenu();
      void loadDashboard(date, { refreshDots: false }).catch(swallowBackgroundAsyncError);
      void openQuickCreateMenu(slot, date, time).catch(swallowBackgroundAsyncError);
      updateTimeGridSelectionUi();
      return;
    }

    const dayCell = event.target.closest('.day-cell[data-day]');
    if (!dayCell) return;
    closeQuickCreateMenu();

    const day = Number(dayCell.dataset.day);
    const yyyy = state.calendarDate.getFullYear();
    const mm = String(state.calendarDate.getMonth() + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    state.selectedDate = `${yyyy}-${mm}-${dd}`;

    state.viewAll = false;
    const btn = document.getElementById('btn-view-all');
    if (btn) btn.textContent = 'View All';

    const prevSelected = document.querySelector('.day-cell.selected');
    if (prevSelected && prevSelected !== dayCell) prevSelected.classList.remove('selected');
    dayCell.classList.add('selected');

    const selectedCell = dayCell;
    const selectedDate = state.selectedDate;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      openNewAppointmentModalForDate(selectedDate);
      showToast(`Offline mode: creating ${getEntryWordSingularTitle().toLowerCase()} for selected date.`, 'info');
      return;
    }
    if (selectedCell) void openDayMenu(selectedCell, selectedDate).catch(swallowBackgroundAsyncError);
    void loadDashboard(selectedDate, { refreshDots: false }).catch(swallowBackgroundAsyncError);
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const activeModal = document.querySelector('.modal.active');

    if (activeModal && e.key === 'Tab') {
      const focusables = getFocusableElements(activeModal);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;

      if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    }

    if (e.key === 'Escape') {
      if (activeModal?.id) closeModal(activeModal.id);
      else {
        closeDayMenu();
        closeQuickCreateMenu();
        closeEmailComposerMenu();
        closeCancelReasonMenu();
        closeNotificationsMenu();
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      document.getElementById('global-search')?.focus();
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openModal('new-appointment');
    }
  });
}

function getTimezoneValues() {
  const fallback = [
    'Europe/London',
    'America/New_York',
    'America/Los_Angeles',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Dubai',
    'Asia/Singapore',
    'Australia/Sydney'
  ];

  return typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : fallback;
}

function setupTimezoneSearch(inputId = 'timezone-input', suggestionsId = 'timezone-suggestions') {
  const input = document.getElementById(inputId);
  const suggestions = document.getElementById(suggestionsId);
  if (!input || !suggestions) return;

  const allZones = getTimezoneValues();

  const render = (query = '') => {
    const q = query.trim().toLowerCase();
    const filtered = allZones
      .filter((tz) => !q || tz.toLowerCase().includes(q))
      .slice(0, 40);

    if (!filtered.length) {
      suggestions.innerHTML = '<div class="timezone-option muted">No matches</div>';
      suggestions.classList.remove('hidden');
      return;
    }

    suggestions.innerHTML = filtered
      .map((tz) => `<button type="button" class="timezone-option" data-timezone="${tz}">${tz}</button>`)
      .join('');

    suggestions.classList.remove('hidden');

    suggestions.querySelectorAll('.timezone-option[data-timezone]').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.timezone;
        suggestions.classList.add('hidden');
      });
    });
  };

  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('input', () => render(input.value));

  input.addEventListener('blur', () => {
    setTimeout(() => suggestions.classList.add('hidden'), 120);
  });
}

function renderTypeSelector(types) {
  const root = document.getElementById('type-selector');
  if (!root) return;

  if (!types.length) {
    root.innerHTML = '<div class="empty-state">Add a type first</div>';
    return;
  }

  if (!state.selectedTypeId) state.selectedTypeId = types[0].id;

  root.innerHTML = types
    .map(
      (t) => `
      <div class="type-option ${state.selectedTypeId === t.id ? 'active' : ''}" data-type-id="${t.id}">
        <div class="type-dot" style="background:${escapeHtml(t.color)}"></div>
        <div class="type-copy">
          <span>${escapeHtml(t.name)}</span>
          <small>${t.durationMinutes} min${t.priceCents > 0 ? ` • ${toMoney(t.priceCents)}` : ''}</small>
        </div>
      </div>`
    )
    .join('');

  root.querySelectorAll('.type-option').forEach((node) => {
    node.addEventListener('click', () => {
      root.querySelectorAll('.type-option').forEach((n) => n.classList.remove('active'));
      node.classList.add('active');
      state.selectedTypeId = Number(node.dataset.typeId);
      const selected = state.types.find((t) => t.id === state.selectedTypeId);
      const durationSelect = document.querySelector('select[name="durationMinutes"]');
      if (selected && durationSelect) durationSelect.value = String(selected.durationMinutes);
      if (!state.editingAppointmentId) {
        setAppointmentFormLocation(resolveDefaultLocationForType(selected));
      }
      updateAppointmentPreview();
    });
  });

  if (!state.editingAppointmentId) {
    const selected = state.types.find((t) => t.id === state.selectedTypeId);
    setAppointmentFormLocation(resolveDefaultLocationForType(selected));
  }

  updateAppointmentPreview();
}

function formatPreviewDate(dateValue) {
  if (!dateValue) return '';
  const dt = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return dateValue;
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function updateAppointmentPreview() {
  const typeNode = document.getElementById('appointment-preview-type');
  const timeNode = document.getElementById('appointment-preview-time');
  if (!typeNode || !timeNode) return;

  const selectedType = state.types.find((t) => t.id === state.selectedTypeId);
  const dateInput = document.querySelector('#appointment-form input[name="date"]');
  const timeInput = document.querySelector('#appointment-form input[name="time"]');
  const durationSelect = document.querySelector('#appointment-form select[name="durationMinutes"]');
  const form = document.getElementById('appointment-form');
  const isReminder = isReminderModeEnabled() || String(form?.dataset?.entrySource || '').toLowerCase() === 'reminder';

  if (isReminder) {
    typeNode.textContent = 'Reminder';
  } else {
    typeNode.textContent = selectedType
      ? `${selectedType.name} • ${durationSelect?.value || selectedType.durationMinutes} min`
      : 'Pick a service type';
  }

  if (dateInput?.value && timeInput?.value) {
    timeNode.textContent = `${formatPreviewDate(dateInput.value)} at ${toTime12(timeInput.value)}`;
  } else {
    timeNode.textContent = 'Choose date and time';
  }
}

function roundToNextQuarterHour(now = new Date()) {
  const dt = new Date(now);
  dt.setSeconds(0, 0);
  const mins = dt.getMinutes();
  const rounded = mins === 0 ? 0 : Math.ceil(mins / 15) * 15;
  if (rounded >= 60) {
    dt.setHours(dt.getHours() + 1);
    dt.setMinutes(0);
  } else {
    dt.setMinutes(rounded);
  }
  return dt;
}

function timeToMinutes(value = '') {
  if (!/^\d{2}:\d{2}$/.test(String(value))) return null;
  const [h, m] = String(value).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function syncTimeBuilderFromInput(form) {
  const timeInput = form.querySelector('input[name="time"]');
  const hourInput = form.querySelector('#appt-time-hour');
  const minuteInput = form.querySelector('#appt-time-minute');
  if (!timeInput || !hourInput || !minuteInput) return;

  const mins = timeToMinutes(timeInput.value);
  const safe = mins == null ? (9 * 60) : mins;
  const hour24 = Math.floor(safe / 60);
  const minute = safe % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;

  hourInput.value = String(hour12);
  minuteInput.value = String(minute).padStart(2, '0');

  form.querySelectorAll('.time-meridiem-btn[data-meridiem]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.meridiem === meridiem);
  });
}

function syncInputFromTimeBuilder(form) {
  const timeInput = form.querySelector('input[name="time"]');
  const hourInput = form.querySelector('#appt-time-hour');
  const minuteInput = form.querySelector('#appt-time-minute');
  const activeMeridiem = form.querySelector('.time-meridiem-btn.active')?.dataset.meridiem || 'AM';
  if (!timeInput || !hourInput || !minuteInput) return;

  const hour12 = clampInt(hourInput.value, 1, 12, 9);
  const minute = clampInt(minuteInput.value, 0, 59, 0);
  let hour24 = hour12 % 12;
  if (activeMeridiem === 'PM') hour24 += 12;
  timeInput.value = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function nextWeekendDate(from = new Date()) {
  const dt = new Date(from);
  dt.setHours(0, 0, 0, 0);
  const day = dt.getDay();
  const offset = day === 6 ? 0 : (6 - day + 7) % 7;
  dt.setDate(dt.getDate() + offset);
  return dt;
}

function setAppointmentDefaults() {
  const form = document.getElementById('appointment-form');
  if (!form) return;

  const dateInput = form.querySelector('input[name="date"]');
  const timeInput = form.querySelector('input[name="time"]');
  const today = localYmd(new Date());

  if (dateInput) dateInput.min = today;
  if (timeInput) timeInput.step = 60;

  if (dateInput && !dateInput.value) {
    dateInput.value = state.selectedDate || today;
  }

  if (timeInput && !timeInput.value) {
    const dt = roundToNextQuarterHour(new Date(Date.now() + 60 * 60 * 1000));
    timeInput.value = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }

  if (!state.editingAppointmentId) {
    const selectedType = state.types.find((t) => Number(t.id) === Number(state.selectedTypeId));
    setAppointmentFormLocation(resolveDefaultLocationForType(selectedType));
    if (form.reminderOffsetMinutes && !form.reminderOffsetMinutes.value) {
      form.reminderOffsetMinutes.value = '10';
    }
    form.dataset.entrySource = isReminderModeEnabled() ? 'reminder' : 'owner';
  }

  syncAppointmentDurationFieldVisibility();
  syncTimeBuilderFromInput(form);
  updateAppointmentPreview();
}

function bindAppointmentFormEnhancements() {
  const form = document.getElementById('appointment-form');
  if (!form) return;

  const dateInput = form.querySelector('input[name="date"]');
  const timeInput = form.querySelector('input[name="time"]');
  const durationSelect = form.querySelector('select[name="durationMinutes"]');
  const timeHourInput = form.querySelector('#appt-time-hour');
  const timeMinuteInput = form.querySelector('#appt-time-minute');
  const today = localYmd(new Date());

  if (dateInput) dateInput.min = today;
  if (timeInput) timeInput.step = 60;

  [dateInput, timeInput, durationSelect].forEach((el) => {
    el?.addEventListener('input', () => {
      if (el === timeInput) syncTimeBuilderFromInput(form);
      updateAppointmentPreview();
    });
    el?.addEventListener('change', () => {
      if (el === timeInput) syncTimeBuilderFromInput(form);
      updateAppointmentPreview();
    });
  });

  [timeHourInput, timeMinuteInput].forEach((input) => {
    input?.addEventListener('input', () => {
      syncInputFromTimeBuilder(form);
      updateAppointmentPreview();
    });
    input?.addEventListener('change', () => {
      syncInputFromTimeBuilder(form);
      syncTimeBuilderFromInput(form);
      updateAppointmentPreview();
    });
  });

  form.querySelectorAll('.time-meridiem-btn[data-meridiem]').forEach((btn) => {
    btn.addEventListener('click', () => {
      form.querySelectorAll('.time-meridiem-btn[data-meridiem]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      syncInputFromTimeBuilder(form);
      updateAppointmentPreview();
    });
  });

  form.querySelectorAll('.quick-pill[data-quick-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!dateInput) return;
      const now = new Date();
      const action = btn.dataset.quickDate;
      if (action === 'tomorrow') now.setDate(now.getDate() + 1);
      else if (action === 'next-week') now.setDate(now.getDate() + 7);
      else if (action === 'weekend') {
        const weekend = nextWeekendDate(now);
        dateInput.value = localYmd(weekend);
        syncTimeBuilderFromInput(form);
        updateAppointmentPreview();
        return;
      }
      dateInput.value = localYmd(now);
      syncTimeBuilderFromInput(form);
      updateAppointmentPreview();
    });
  });

  form.querySelectorAll('.quick-pill[data-open-picker]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const picker = dateInput;
      if (!picker) return;
      if (typeof picker.showPicker === 'function') {
        picker.showPicker();
      } else {
        picker.focus();
        picker.click();
      }
    });
  });

  dateInput?.addEventListener('change', () => {
    if (!timeInput || !dateInput?.value) return;
    const selectedDate = dateInput.value;
      if (selectedDate !== localYmd(new Date())) return;
      if (!timeInput.value) return;
      const now = roundToNextQuarterHour(new Date());
      const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (timeInput.value < current) {
        timeInput.value = current;
      }
      syncTimeBuilderFromInput(form);
      updateAppointmentPreview();
  });

  setAppointmentDefaults();
  syncTimeBuilderFromInput(form);
}

function renderStats(stats = {}, options = {}) {
  const reminderModeEnabled = isReminderModeEnabled();
  const nextReminder = options.nextReminder || null;
  state.nextReminder = reminderModeEnabled ? nextReminder : null;
  document.getElementById('stat-today').textContent = stats.today ?? 0;
  document.getElementById('stat-week').textContent = stats.week ?? 0;

  const pendingLabel = document.querySelector('#stat-card-pending .stat-label');
  const pendingValue = document.getElementById('stat-pending');
  const pendingHint = document.querySelector('#stat-card-pending .stat-hint');
  if (reminderModeEnabled) {
    if (pendingLabel) pendingLabel.textContent = 'Upcoming';
    pendingValue?.classList.add('is-reminder-title');
    document.getElementById('stat-card-pending')?.classList.toggle('is-clickable', Boolean(nextReminder?.date));
    if (nextReminder?.date && nextReminder?.time) {
      const reminderText = String(
        nextReminder.clientName || nextReminder.title || nextReminder.typeName || 'Reminder'
      ).trim();
      const shortReminderText = reminderText.length > 72 ? `${reminderText.slice(0, 69)}...` : reminderText;
      const relative = formatUpcomingRelative(nextReminder.date, nextReminder.time);
      if (pendingValue) pendingValue.textContent = `${relative} • ${shortReminderText}`;
      if (pendingHint) {
        if (String(nextReminder.date).slice(0, 10) === localYmd()) {
          pendingHint.textContent = 'Today';
        } else {
          const dt = new Date(`${String(nextReminder.date).slice(0, 10)}T00:00:00`);
          const dayLabel = Number.isNaN(dt.getTime())
            ? String(nextReminder.date).slice(0, 10)
            : dt.toLocaleDateString('en-US', { weekday: 'long' });
          pendingHint.textContent = dayLabel;
        }
      }
    } else {
      if (pendingValue) pendingValue.textContent = '--';
      if (pendingHint) pendingHint.textContent = 'No upcoming reminder';
    }
  } else {
    if (pendingLabel) pendingLabel.textContent = 'Pending';
    pendingValue?.classList.remove('is-reminder-title');
    document.getElementById('stat-card-pending')?.classList.remove('is-clickable');
    if (pendingValue) pendingValue.textContent = stats.pending ?? 0;
  }

  state.unreadNotifications = Number(stats.pending || 0);
  renderNotificationDots(state.unreadNotifications);
}

function toMonthParam(dateValue = new Date()) {
  const yyyy = dateValue.getFullYear();
  const mm = String(dateValue.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function monthParamFromOffset(baseMonthParam, delta = 0) {
  const [y, m] = String(baseMonthParam || '').split('-').map(Number);
  const dt = new Date(Number(y), Number(m || 1) - 1, 1);
  dt.setMonth(dt.getMonth() + Number(delta || 0));
  return toMonthParam(dt);
}

function showCalendarDotsLoadingState() {
  document.querySelectorAll('.day-cell:not(.empty)').forEach((cell) => {
    const preview = cell.querySelector('.day-events-preview');
    cell.classList.add('calendar-loading');
    if (preview) {
      preview.innerHTML = `
        <div class="cal-event-skeleton"></div>
        <div class="cal-event-skeleton"></div>
      `;
    }
  });
}

function renderCalendarDotsForMonth(monthAppointments = []) {
  const dayAppointments = new Map();
  monthAppointments.forEach((a) => {
    const day = Number(String(a.date || '').slice(8, 10));
    if (!day) return;
    if (!dayAppointments.has(day)) dayAppointments.set(day, []);
    dayAppointments.get(day).push(a);
  });

  document.querySelectorAll('.day-cell:not(.empty)').forEach((cell) => {
    const day = Number(cell.dataset.day);
    const appts = dayAppointments.get(day) || [];
    const count = appts.length;
    const preview = cell.querySelector('.day-events-preview');
    cell.classList.remove('calendar-loading');
    const labelParts = [`${count} booking${count === 1 ? '' : 's'}`];

    if (appts.length) {
      labelParts.push(appts.map((a) => a.typeName).filter(Boolean).join(', '));
    }

    cell.classList.toggle('has-event', count > 0);
    cell.classList.toggle('event-low', count > 0 && count <= 2);
    cell.classList.toggle('event-med', count >= 3 && count <= 4);
    cell.classList.toggle('event-high', count >= 5);
    cell.setAttribute('aria-label', count > 0 ? `Day ${day}: ${labelParts.join(' • ')}` : `Day ${day}: No bookings`);
    cell.title = count > 0 ? `Day ${day}: ${labelParts.join(' • ')}` : `Day ${day}: No bookings`;

    if (preview) {
      preview.innerHTML = appts.slice(0, 3).map((a) =>
        `<div class="cal-event" style="--event-color: ${escapeHtml(a.color || 'var(--gold)')}">
           <span class="cal-event-time">${toTimeCompact(a.time)}</span>
           <span class="cal-event-name">${escapeHtml(getCalendarPreviewLabel(a))}</span>
         </div>`
      ).join('');
      if (count > 3) {
        preview.innerHTML += `<div class="cal-event-more">+${count - 3} more</div>`;
      }
    }
  });
}

async function fetchCalendarMonth(monthParam, { force = false } = {}) {
  const cached = calendarMonthCache.get(monthParam);
  const isFresh = cached && (Date.now() - cached.fetchedAt < CALENDAR_MONTH_CACHE_TTL_MS);
  if (!force && isFresh) return cached.appointments;

  if (!force && calendarMonthInFlight.has(monthParam)) {
    return calendarMonthInFlight.get(monthParam);
  }

  const req = (async () => {
    const { appointments } = await api(`/api/calendar/month?month=${encodeURIComponent(monthParam)}`);
    const safe = Array.isArray(appointments) ? appointments : [];
    calendarMonthCache.set(monthParam, { appointments: safe, fetchedAt: Date.now() });
    return safe;
  })();

  calendarMonthInFlight.set(monthParam, req);
  try {
    return await req;
  } finally {
    calendarMonthInFlight.delete(monthParam);
  }
}

function prefetchAdjacentCalendarMonths(monthParam) {
  const adjacent = [monthParamFromOffset(monthParam, -1), monthParamFromOffset(monthParam, 1)];
  adjacent.forEach((m) => {
    if (calendarMonthCache.has(m) || calendarMonthInFlight.has(m)) return;
    void fetchCalendarMonth(m).catch(swallowBackgroundAsyncError);
  });
}

async function refreshCalendarTimeGrid(options = {}) {
  const { force = false } = options;
  const requestId = ++state.calendarWeekRequestId;
  renderCalendarTimeGrid([], { loading: true });

  const visibleDates = getVisibleCalendarDates(state.calendarDate, state.calendarViewMode);
  const months = Array.from(new Set(
    visibleDates
      .map((date) => parseYmd(date))
      .filter(Boolean)
      .map((dt) => toMonthParam(dt))
  ));

  try {
    const monthResults = await Promise.all(months.map((month) => fetchCalendarMonth(month, { force })));
    if (requestId !== state.calendarWeekRequestId) return;
    const weekSet = new Set(visibleDates);
    const appointments = monthResults
      .flat()
      .filter((a) => weekSet.has(String(a?.date || '')));
    renderCalendarTimeGrid(appointments, { loading: false });
  } catch (_error) {
    if (requestId !== state.calendarWeekRequestId) return;
    renderCalendarTimeGrid([], { loading: false });
  }
}

async function refreshCalendarDots(options = {}) {
  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode === 'week' || mode === 'day') {
    await refreshCalendarTimeGrid(options);
    return;
  }
  const { force = false } = options;
  const monthParam = toMonthParam(state.calendarDate);
  const requestId = ++state.calendarDotsRequestId;

  const cached = calendarMonthCache.get(monthParam);
  if (!force && cached?.appointments) {
    renderCalendarDotsForMonth(cached.appointments);
  } else {
    showCalendarDotsLoadingState();
  }

  try {
    const monthAppointments = await fetchCalendarMonth(monthParam, { force });
    if (requestId !== state.calendarDotsRequestId) return;

    renderCalendarDotsForMonth(monthAppointments);
    prefetchAdjacentCalendarMonths(monthParam);
  } catch (error) {
    if (requestId !== state.calendarDotsRequestId) return;
    renderCalendarDotsForMonth([]);
    throw error;
  }
}

function renderTimeline(appointments = [], options = {}) {
  const root = document.getElementById('timeline-list');
  if (!root) return;
  const emptyMessage = options.emptyMessage || `No ${getEntryWordPlural()} for this day yet.`;
  const includeDate = Boolean(options.includeDate);
  if (!appointments.length) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => {
        const statusClass = `status-${(a.status || 'pending').toLowerCase()}`;
        const isReminder = isReminderEntry(a) || Number(a.durationMinutes || 0) <= 0;
        return `
      <div class="timeline-item" data-id="${a.id}">
        <div class="time-column">
          <div class="time-start">${toTime12(a.time)}</div>
          <div class="time-end">${isReminder ? '' : toTime12(addMinutesToTime(a.time, a.durationMinutes))}</div>
        </div>
        <div class="appointment-card ${escapeHtml(a.typeClass || '')}" data-id="${a.id}">
          <div class="appointment-card-header">
            <div class="appointment-header-meta">
              <span class="appointment-type-tag">${escapeHtml(a.typeName)}</span>
              ${includeDate ? `<span class="appointment-day-label">${escapeHtml(formatTimelineDayLabel(a.date))}</span>` : ''}
            </div>
            <span class="status-badge ${statusClass}">${escapeHtml(a.status)}</span>
          </div>
          <div class="appointment-card-body">
            <h3 class="client-name">${escapeHtml(a.clientName)}</h3>
            <p class="appointment-title">${escapeHtml(a.title || a.typeName)}</p>
          </div>
          <div class="appointment-card-footer">
            <div class="appointment-meta">
              <span>📍 ${escapeHtml(a.location)}</span>
              ${isReminder ? '' : `<span>⏱ ${a.durationMinutes} min</span>`}
            </div>
            <div class="appointment-actions">
              ${a.clientEmail ? `<button type="button" class="action-btn email-btn" title="Send Email">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
              </button>` : ''}
              <button type="button" class="action-btn edit-btn" title="Edit">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>`;
      }
    )
    .join('');

  root.querySelectorAll('.email-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.closest('.timeline-item').dataset.id;
      openEmailComposerMenu(id);
    });
  });

  root.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.closest('.timeline-item').dataset.id;
      const appointment = appointments.find(appt => String(appt.id) === String(id));
      if (appointment) startEditAppointment(appointment);
    });
  });

  root.querySelectorAll('.appointment-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      const appointment = appointments.find(appt => String(appt.id) === String(id));
      if (appointment) startEditAppointment(appointment);
    });
  });
}

function renderCompletedAppointments(appointments = []) {
  const root = document.getElementById('completed-list');
  if (!root) return;
  if (!appointments.length) {
    root.innerHTML = `<div class="empty-state">No completed ${getEntryWordPlural()} yet.</div>`;
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => `
      <div class="completed-item">
        <div class="completed-item-main">
          <strong class="client-name">${escapeHtml(a.clientName || 'Client')}</strong>
          <span class="appointment-type-tag">${escapeHtml(a.typeName || a.title || getEntryWordSingularTitle())}</span>
        </div>
        <div class="completed-item-meta">
          <span>${escapeHtml(formatScheduleDate(a.date))}</span>
          <span class="time-range">${escapeHtml(formatEntryTimeRange(a))}</span>
        </div>
      </div>`
    )
    .join('');
}

function renderTypes(types = []) {
  const root = document.getElementById('type-list');
  const adminRoot = document.getElementById('type-admin-list');

  const html =
    types.length === 0
      ? '<div class="empty-state">No appointment types yet.</div>'
      : types
        .map(
          (t) => `
            <div class="type-item">
              <div class="type-color" style="background:${escapeHtml(t.color)}"></div>
              <div class="type-info">
                <h4>${escapeHtml(t.name)}</h4>
                <p>
                  <span>${t.durationMinutes} min</span>
                  <span class="divider">•</span>
                  <span>${toMoney(t.priceCents)}</span>
                  <span class="divider">•</span>
                  <span>${escapeHtml(t.locationMode)}</span>
                </p>
              </div>
              <span class="type-count">${t.bookingCount || 0}</span>
            </div>`
        )
        .join('');

  const adminHtml =
    types.length === 0
      ? '<div class="empty-state">No appointment types yet.</div>'
      : types
        .map(
          (t) => `
            <div class="type-admin-card" data-type-id="${t.id}">
              <div class="type-admin-card__head">
                <div class="type-admin-card__identity">
                  <span class="type-color" style="background:${escapeHtml(t.color)}"></span>
                  <div>
                    <strong>${escapeHtml(t.name)}</strong>
                    <div class="pill">${t.durationMinutes} min • ${toMoney(t.priceCents)}</div>
                  </div>
                </div>
                <span class="pill">Active</span>
              </div>
              <div class="type-admin-card__meta">
                <span class="type-meta-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  ${escapeHtml(t.locationMode)}
                </span>
                <span class="type-meta-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  ${t.bookingCount || 0} booking${(t.bookingCount || 0) === 1 ? '' : 's'}
                </span>
              </div>
              <div class="type-admin-card__actions">
                <button class="btn-edit-type" type="button" aria-label="Edit Type" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; border-radius: var(--radius-sm); transition: all var(--transition-fast);">
                  <svg viewBox="0 0 24 24" style="width:16px;height:16px;" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"/></svg>
                </button>
                <button class="btn-delete-type" type="button" aria-label="Delete Type">
                  <svg viewBox="0 0 24 24" style="width:16px;height:16px;" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                </button>
              </div>
            </div>`
        )
        .join('');

  if (root) root.innerHTML = html;
  if (adminRoot) {
    adminRoot.innerHTML = adminHtml;
    
    adminRoot.querySelectorAll('.btn-edit-type').forEach((btn) => {
      btn.addEventListener('click', () => {
        const typeId = btn.closest('.type-admin-card')?.dataset.typeId;
        if (typeId) setTypeFormForEditing(typeId);
      });
    });

    adminRoot.querySelectorAll('.btn-delete-type').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const typeId = btn.closest('.type-admin-card')?.dataset.typeId;
        if (!typeId) return;

        const ok = await showConfirm('Delete Appointment Type', 'Existing bookings remain, but this type will no longer be selectable.');
        if (!ok) return;

        try {
          const result = await queueAwareMutation(`/api/types/${typeId}`, { method: 'DELETE' }, {
            allowOfflineQueue: true,
            description: 'Type deletion'
          });
          if (result.queued) return;
          showToast('Appointment type deleted', 'success');
          await loadTypes();
          await loadDashboard();
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    });
  }
}

function renderInsights(insights = []) {
  const html =
    insights.length === 0
      ? '<div class="empty-state">AI insights will appear as bookings are created.</div>'
      : insights
        .map(
          (i) => `
          <div class="insight-item">
            <div class="insight-icon">${escapeHtml(i.icon || '💡')}</div>
            <div class="insight-content">
              <p>${escapeHtml(i.text)}</p>
              ${i.action ? `<div class="insight-action">${escapeHtml(i.action)}</div>` : ''}
              ${i.confidence ? `<div class="insight-confidence">${escapeHtml(i.confidence)}</div>` : ''}
              <span class="insight-time">${escapeHtml(i.time || 'Live')}</span>
            </div>
          </div>`
        )
        .join('');

  const root = document.getElementById('insights-list');
  const fullRoot = document.getElementById('ai-full-list');
  if (root) root.innerHTML = html;
  if (fullRoot) fullRoot.innerHTML = html;
}

function renderAppointmentsTable(appointments = []) {
  const root = document.getElementById('appointments-table');
  if (!root) return;
  
  // Store appointments in state so detail view can access them
  state.appointments = appointments;

  if (!appointments.length) {
    root.innerHTML = `<div class="empty-state">No ${getEntryWordPlural()} found.</div>`;
    renderAppointmentDetail(null);
    return;
  }

  root.innerHTML = appointments
    .map((a) => {
      const statusClass = `status-${(a.status || 'pending').toLowerCase()}`;
      const isActive = Number(a.id) === Number(state.selectedAppointmentId) ? 'active' : '';
      return `
        <div class="data-row ${isActive}" data-id="${a.id}">
          <div>
            <strong class="client-name">${escapeHtml(a.clientName)}</strong>
            <div class="appointment-type-tag" style="margin-top: 4px;">${escapeHtml(a.typeName)}</div>
          </div>
          <div style="text-align: right;">
            <span class="status-badge ${statusClass}" style="margin-bottom: 4px; display: inline-block;">${escapeHtml(a.status)}</span>
            <div class="client-note-preview">
                ${escapeHtml(formatScheduleDate(a.date))} • ${toTime12(a.time)}
            </div>
          </div>
        </div>`;
    })
    .join('');

  root.querySelectorAll('.data-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.id);
      if (!Number.isFinite(id) || id <= 0) return;
      state.selectedAppointmentId = id;
      
      // Update active state in UI immediately
      root.querySelectorAll('.data-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      
      const appointment = state.appointments.find(a => Number(a.id) === id);
      renderAppointmentDetail(appointment);
      
      // Auto-scroll to detail panel on narrow screens
      if (window.innerWidth <= 1024) {
        document.getElementById('appointment-detail-panel-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  
  // Render first item's details if nothing selected or selection is invalid
  if (!state.selectedAppointmentId || !appointments.some(a => Number(a.id) === Number(state.selectedAppointmentId))) {
    state.selectedAppointmentId = appointments[0]?.id || null;
    if (state.selectedAppointmentId) {
       const firstRow = root.querySelector('.data-row');
       if (firstRow) firstRow.classList.add('active');
       renderAppointmentDetail(appointments[0]);
    } else {
       renderAppointmentDetail(null);
    }
  } else {
    const appointment = appointments.find(a => Number(a.id) === Number(state.selectedAppointmentId));
    renderAppointmentDetail(appointment);
  }
}

function renderAppointmentDetail(appointment = null) {
  const root = document.getElementById('appointment-detail-panel-wrapper');
  if (!root) return;
  if (!appointment) {
    root.innerHTML = `<div class="card empty-detail-card"><div class="empty-state">Select an appointment to view details.</div></div>`;
    return;
  }

  const reminderModeEnabled = isReminderModeEnabled();
  const statusClass = `status-${(appointment.status || 'pending').toLowerCase()}`;
  
  let actionsHtml = `
    <button class="btn-secondary btn-sm btn-edit" data-id="${appointment.id}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"></path></svg>
      Edit
    </button>
  `;
  
  if (!reminderModeEnabled) {
      if (appointment.clientEmail) {
          actionsHtml += `
            <button class="btn-secondary btn-sm btn-email" data-id="${appointment.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
              Email
            </button>
          `;
      }
      if (appointment.status === 'pending') {
          actionsHtml += `
            <button class="btn-secondary btn-sm btn-confirm-booking" data-id="${appointment.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
              Confirm
            </button>
          `;
      }
  }

  if (appointment.status !== 'completed' && appointment.status !== 'cancelled') {
      actionsHtml += `
        <button class="btn-secondary btn-sm btn-complete" data-id="${appointment.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
          ${reminderModeEnabled ? 'Done' : 'Complete'}
        </button>
      `;
  }

  if (!reminderModeEnabled && appointment.status !== 'cancelled') {
      actionsHtml += `
        <button class="btn-secondary btn-sm btn-cancel" data-id="${appointment.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
          Cancel
        </button>
      `;
  }

  actionsHtml += `
    <button class="btn-secondary btn-sm btn-danger btn-delete" data-id="${appointment.id}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      Delete
    </button>
  `;

  root.innerHTML = `
    <div class="card detail-panel-header-card">
      <div class="detail-panel-top-actions" style="flex-wrap: wrap; justify-content: flex-end;">
        ${actionsHtml}
      </div>

      <div class="detail-panel-summary">
        <div class="detail-panel-head">
          <strong>${escapeHtml(appointment.clientName || 'Unnamed Client')}</strong>
          <span class="status-badge ${statusClass}">${escapeHtml(appointment.status)}</span>
        </div>
        <div class="detail-panel-progress">${escapeHtml(appointment.typeName || 'General Appointment')}</div>
        <div class="detail-panel-stats">
          <div class="detail-panel-stat">
            <span>Date</span>
            <strong>${escapeHtml(formatScheduleDate(appointment.date))}</strong>
          </div>
          <div class="detail-panel-stat">
            <span>Time</span>
            <strong>${escapeHtml(formatEntryTimeRange(appointment))}</strong>
          </div>
          ${!reminderModeEnabled && appointment.clientEmail ? `
          <div class="detail-panel-stat">
            <span>Email</span>
            <strong>${escapeHtml(appointment.clientEmail)}</strong>
          </div>` : ''}
        </div>
      </div>
    </div>
    
    ${appointment.notes ? `
    <div class="card" style="margin-top: 16px;">
        <div class="card-header">
            <h2>Notes</h2>
        </div>
        <div style="padding: 16px;">
            <p style="white-space: pre-wrap; margin: 0; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5;">${escapeHtml(appointment.notes)}</p>
        </div>
    </div>` : ''}
  `;

  // Attach listeners
  root.querySelector('.btn-edit')?.addEventListener('click', () => startEditAppointment(appointment));
  
  root.querySelector('.btn-email')?.addEventListener('click', async () => {
      await openEmailComposerMenu(appointment.id);
  });
  
  root.querySelector('.btn-complete')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      try {
        const result = await queueAwareMutation(`/api/appointments/${appointment.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed' })
        }, { allowOfflineQueue: true });
        if (result.queued) return;
        showToast('Marked as completed', 'success');
        await loadAppointmentsTable();
        await loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
  });

  root.querySelector('.btn-confirm-booking')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.innerHTML = 'Confirming...';
      try {
        const result = await queueAwareMutation(`/api/appointments/${appointment.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'confirmed' })
        }, { allowOfflineQueue: true });
        if (result.queued) {
          btn.classList.remove('is-busy');
          btn.innerHTML = 'Queued';
          return;
        }
        showToast('Appointment confirmed!', 'success');
        await loadAppointmentsTable();
        await loadDashboard();
        await refreshCalendarDots({ force: true });
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.innerHTML = originalText;
      }
  });

  root.querySelector('.btn-cancel')?.addEventListener('click', async () => {
      await openCancelReasonMenu(appointment.id);
  });

  root.querySelector('.btn-delete')?.addEventListener('click', async () => {
      if (await confirmDialog('Delete', `Are you sure you want to delete this ${reminderModeEnabled ? 'reminder' : 'appointment'}?`)) {
          try {
            const result = await queueAwareMutation(`/api/appointments/${appointment.id}`, { method: 'DELETE' }, { allowOfflineQueue: true });
            if (result.queued) return;
            showToast('Deleted successfully', 'success');
            state.selectedAppointmentId = null;
            await loadAppointmentsTable();
            await loadDashboard();
          } catch (err) {
            showToast(err.message, 'error');
          }
      }
  });
}

function formatClientStage(stage = '') {
  const normalized = String(stage || '').trim().toLowerCase();
  if (normalized === 'in_progress') return 'In Progress';
  if (normalized === 'on_hold') return 'On Hold';
  if (!normalized) return 'New';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function renderClientDetail(client = null, notes = [], appointments = []) {
  const root = document.getElementById('client-detail-panel-wrapper');
  if (!root) return;
  if (!client) {
    root.innerHTML = `<div class="card empty-detail-card"><div class="empty-state">Select a client to view details.</div></div>`;
    return;
  }

  const upcoming = appointments
    .filter((item) => isAtOrAfterNow(item.date || '', item.time || '09:00'))
    .sort((a, b) => {
      const aKey = `${String(a.date || '')} ${String(a.time || '')}`;
      const bKey = `${String(b.date || '')} ${String(b.time || '')}`;
      return aKey.localeCompare(bKey);
    })[0] || null;

  const nextAppointmentLabel = upcoming
    ? `${formatScheduleDate(upcoming.date || '')} • ${toTime12(upcoming.time || '09:00')}`
    : 'No upcoming appointment';

  const notesHtml = notes.length
    ? `<div class="client-note-list">${notes.map((item) => `
      <article class="client-note-item">
        <p>${escapeHtml(item.note || '')}</p>
        <small>${escapeHtml(formatScheduleDate(String(item.createdAt || '').slice(0, 10)))}</small>
      </article>
    `).join('')}</div>`
    : '<div class="empty-state">No notes yet.</div>';

  const appointmentsHtml = appointments.length
    ? `<div class="client-note-list">${appointments.slice(0, 5).map((item) => `
      <article class="client-note-item client-appointment-item">
        <p><strong>${escapeHtml(item.typeName || 'Appointment')}</strong></p>
        <small>${escapeHtml(formatScheduleDate(item.date || ''))} • ${escapeHtml(toTime12(item.time || '09:00'))} • ${escapeHtml(formatClientStage(item.status || 'pending'))}</small>
      </article>
    `).join('')}</div>`
    : '<div class="empty-state">No related appointments yet.</div>';

  root.innerHTML = `
    <div class="card detail-panel-header-card">
      <div class="detail-panel-top-actions">
        <button class="btn-secondary btn-sm" id="btn-edit-client" data-id="${client.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"></path></svg>
          Edit
        </button>
        <button class="btn-secondary btn-sm" id="btn-book-for-client" data-name="${escapeHtml(client.name)}" data-email="${escapeHtml(client.email || '')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
          Book
        </button>
        <button class="btn-secondary btn-sm btn-danger" id="btn-delete-client" data-id="${client.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          Delete
        </button>
      </div>

      <div class="detail-panel-summary">
        <div class="detail-panel-head">
          <strong>${escapeHtml(client.name || '')}</strong>
          <span class="client-stage-pill">${escapeHtml(formatClientStage(client.stage))}</span>
        </div>
        <div class="detail-panel-progress">${escapeHtml(client.progressSummary || 'No progress summary yet.')}</div>
        <div class="detail-panel-stats">
          <div class="detail-panel-stat">
            <span>Email</span>
            <strong>${escapeHtml(client.email || 'No email')}</strong>
          </div>
          <div class="detail-panel-stat">
            <span>Phone</span>
            <strong>${escapeHtml(client.phone || 'No phone')}</strong>
          </div>
          <div class="detail-panel-stat">
            <span>Next Appointment</span>
            <strong>${escapeHtml(nextAppointmentLabel)}</strong>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
        <div class="card-header">
            <h2>Activity & Notes</h2>
        </div>
        
        <form class="modal-form" id="client-note-form" data-client-id="${client.id}" style="border-bottom: 1px solid var(--border); border-bottom-left-radius: 0; border-bottom-right-radius: 0; margin-bottom: 0;">
            <div class="form-group" style="margin-bottom: 12px;">
                <textarea id="client-note-text" name="note" rows="2" placeholder="Write a new progress note..." maxlength="5000" required></textarea>
            </div>
            <div class="form-row" style="margin-bottom: 12px;">
                <div class="form-group" style="margin-bottom: 0;">
                    <label for="client-note-stage" style="font-size: 0.65rem;">Update Stage (Optional)</label>
                    <select id="client-note-stage" name="stage">
                        <option value="">No change</option>
                        <option value="new">New</option>
                        <option value="in_progress">In Progress</option>
                        <option value="waiting">Waiting</option>
                        <option value="completed">Completed</option>
                        <option value="on_hold">On Hold</option>
                    </select>
                </div>
                <div class="form-actions" style="border-top: none; padding-top: 0; align-items: flex-end;">
                    <button type="submit" class="btn-primary">Post Note</button>
                </div>
            </div>
        </form>

        <div style="padding: var(--spacing-lg); background: var(--bg-base); border-bottom-left-radius: var(--radius-xl); border-bottom-right-radius: var(--radius-xl);">
            <h3 style="font-size: 0.85rem; margin-bottom: 10px; color: var(--text-secondary);">Recent Notes</h3>
            ${notesHtml}
            <h3 style="font-size: 0.85rem; margin-top: 20px; margin-bottom: 10px; color: var(--text-secondary);">Recent Appointments</h3>
            ${appointmentsHtml}
        </div>
    </div>
  `;

  // Attach listeners to the newly rendered detail actions
  document.getElementById('btn-edit-client')?.addEventListener('click', () => {
    showClientForm(client);
  });

  document.getElementById('btn-delete-client')?.addEventListener('click', async () => {
    if (await confirmDialog('Archive Client', `Are you sure you want to archive ${client.name}? This will hide them from active lists.`)) {
      try {
        await api(`/api/clients/${client.id}`, { method: 'DELETE' });
        showToast('Client archived.', 'success');
        state.selectedClientId = null;
        await loadClients();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });

  document.getElementById('btn-book-for-client')?.addEventListener('click', () => {
    openNewAppointmentModalForDate(localYmd());
    const form = document.getElementById('appointment-form');
    if (form) {
      form.clientName.value = client.name || '';
      form.clientEmail.value = client.email || '';
      updateAppointmentPreview();
    }
  });

  document.getElementById('client-note-form')?.addEventListener('submit', submitClientNote);
}

function renderClientsTable(clients = []) {
  const root = document.getElementById('clients-table');
  if (!root) return;
  if (!clients.length) {
    root.innerHTML = '<div class="empty-state">No clients found.</div>';
    renderClientDetail(null, [], []);
    return;
  }

  root.innerHTML = clients.map((client) => `
    <div class="data-row ${Number(client.id) === Number(state.selectedClientId) ? 'active' : ''}" data-client-id="${Number(client.id)}">
      <div>
        <strong class="client-name">${escapeHtml(client.name || '')}</strong>
        <span class="client-note-preview">${escapeHtml(client.lastNote || client.progressSummary || 'No notes yet')}</span>
      </div>
      <div style="text-align: right;">
        <span class="client-stage-pill" style="font-size: 0.6rem; padding: 2px 8px;">${escapeHtml(formatClientStage(client.stage))}</span>
        <div class="client-note-preview" style="margin-top: 4px;">
            ${client.nextAppointmentDate ? formatScheduleDate(client.nextAppointmentDate) : 'No upcoming'}
        </div>
      </div>
    </div>
  `).join('');

  root.querySelectorAll('.data-row[data-client-id]').forEach((row) => {
    row.addEventListener('click', async () => {
      const clientId = Number(row.dataset.clientId);
      if (!Number.isFinite(clientId) || clientId <= 0) return;
      state.selectedClientId = clientId;
      
      // Hide form if it was open
      document.getElementById('client-form-container').style.display = 'none';
      document.getElementById('client-detail-panel-wrapper').style.display = 'flex';

      renderClientsTable(state.clients);
      await loadClientDetail(clientId);
      
      // Auto-scroll to detail panel on narrow screens
      if (window.innerWidth <= 1024) {
        document.getElementById('client-detail-panel-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

function showClientForm(client = null) {
  const container = document.getElementById('client-form-container');
  const detailWrapper = document.getElementById('client-detail-panel-wrapper');
  const form = document.getElementById('client-form');
  const title = document.getElementById('client-form-title');
  const saveBtn = document.getElementById('btn-save-client');

  if (!container || !detailWrapper || !form) return;

  form.reset();
  if (client) {
    title.textContent = 'Edit Client';
    saveBtn.textContent = 'Update Client';
    document.getElementById('client-id').value = client.id;
    document.getElementById('client-name').value = client.name || '';
    document.getElementById('client-email').value = client.email || '';
    document.getElementById('client-phone').value = client.phone || '';
    document.getElementById('client-stage').value = client.stage || 'new';
    document.getElementById('client-progress-summary').value = client.progressSummary || '';
  } else {
    title.textContent = 'Add Client';
    saveBtn.textContent = 'Save Client';
    document.getElementById('client-id').value = '';
    document.getElementById('client-stage').value = 'new';
  }

  detailWrapper.style.display = 'none';
  container.style.display = 'block';

  // Auto-scroll to the form on narrow screens
  if (window.innerWidth <= 1024) {
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function loadClientDetail(clientId = state.selectedClientId) {
  const selectedId = Number(clientId);
  if (!Number.isFinite(selectedId) || selectedId <= 0) {
    renderClientDetail(null, [], []);
    return;
  }

  const client = state.clients.find((item) => Number(item.id) === selectedId) || null;
  if (!client) {
    renderClientDetail(null, [], []);
    return;
  }

  const [notesPayload, appointmentsPayload] = await Promise.all([
    api(`/api/clients/${selectedId}/notes`),
    api(`/api/clients/${selectedId}/appointments`)
  ]);
  renderClientDetail(client, notesPayload?.notes || [], appointmentsPayload?.appointments || []);
}

async function loadClients() {
  const q = String(document.getElementById('clients-search')?.value || '').trim();
  const stage = String(document.getElementById('clients-stage-filter')?.value || '').trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (stage) params.set('stage', stage);
  const query = params.toString();

  renderSkeleton(document.getElementById('clients-table'), 5);
  const payload = await api(`/api/clients${query ? `?${query}` : ''}`);
  state.clients = Array.isArray(payload?.clients) ? payload.clients : [];

  if (!state.clients.some((item) => Number(item.id) === Number(state.selectedClientId))) {
    state.selectedClientId = state.clients[0]?.id || null;
  }
  document.getElementById('client-note-form')?.setAttribute('data-client-id', state.selectedClientId ? String(state.selectedClientId) : '');

  renderClientsTable(state.clients);
  if (state.selectedClientId) {
    await loadClientDetail(state.selectedClientId);
  } else {
    renderClientDetail(null, [], []);
  }
}

async function ensureClientForAppointment(appointment = {}) {
  const name = String(appointment.clientName || appointment.title || '').trim() || 'Client';
  const email = String(appointment.clientEmail || '').trim();
  const queryTerm = email || name;
  if (queryTerm && queryTerm.length >= 2) {
    const payload = await api(`/api/clients?q=${encodeURIComponent(queryTerm)}`);
    const clients = Array.isArray(payload?.clients) ? payload.clients : [];
    const exact = clients.find((item) => {
      const itemName = String(item.name || '').trim().toLowerCase();
      const itemEmail = String(item.email || '').trim().toLowerCase();
      if (email && itemEmail === email.toLowerCase()) return true;
      return itemName === name.toLowerCase();
    });
    if (exact) return exact;
  }

  const created = await api('/api/clients', {
    method: 'POST',
    body: JSON.stringify({
      name,
      email: email || '',
      stage: 'in_progress'
    })
  });
  return created?.client || null;
}

async function findClientForAppointment(appointment = {}) {
  const name = String(appointment.clientName || appointment.title || '').trim();
  const email = String(appointment.clientEmail || '').trim();
  const queryTerm = email || name;
  if (!queryTerm || queryTerm.length < 2) return null;

  const payload = await api(`/api/clients?q=${encodeURIComponent(queryTerm)}`);
  const clients = Array.isArray(payload?.clients) ? payload.clients : [];
  return clients.find((item) => {
    const itemName = String(item.name || '').trim().toLowerCase();
    const itemEmail = String(item.email || '').trim().toLowerCase();
    if (email && itemEmail === email.toLowerCase()) return true;
    return itemName === name.toLowerCase();
  }) || null;
}

async function openClientFromAppointment(appointment = null) {
  if (!appointment) return;
  const client = await findClientForAppointment(appointment);
  if (!client?.id) {
    showToast('No saved client profile found for this appointment yet.', 'info');
    return;
  }

  const clientId = Number(client.id);
  if (!Number.isFinite(clientId) || clientId <= 0) return;

  const searchInput = document.getElementById('clients-search');
  if (searchInput) {
    searchInput.value = String(client.name || client.email || '').trim();
  }
  const stageFilter = document.getElementById('clients-stage-filter');
  if (stageFilter) stageFilter.value = '';

  state.selectedClientId = clientId;
  document.getElementById('client-note-form')?.setAttribute('data-client-id', String(clientId));

  setActiveView('clients');
  await loadClients();

  if (!state.clients.some((item) => Number(item.id) === clientId)) {
    state.clients = [client, ...state.clients.filter((item) => Number(item.id) !== clientId)];
    renderClientsTable(state.clients);
    await loadClientDetail(clientId);
  }

  const row = document.querySelector(`#clients-table .data-row[data-client-id="${clientId}"]`);
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  showToast('Client info opened.', 'success');
}

async function loadTypes() {
  const { types } = await api('/api/types');
  state.types = types;
  renderTypeSelector(types);
}

async function loadDashboard(targetDate = state.selectedDate, options = {}) {
  const { refreshDots = true, showSkeleton = true } = options;
  const today = localYmd();
  const isTargetToday = targetDate === today;
  const reminderModeEnabled = isReminderModeEnabled();

  if (showSkeleton) {
    // Show skeleton placeholders while data is loading
    renderSkeleton(document.getElementById('timeline-list'), 3);
    renderSkeleton(document.getElementById('insights-list'), 4);
  }

  // Fetch dashboard data + completed appointments in parallel.
  // The /api/dashboard endpoint already returns today's appointments.
  // We still fetch the appointments list to calculate the true next upcoming day.
  const [dashboardResult, completedResult, upcomingResult] = await Promise.all([
    api(`/api/dashboard?date=${encodeURIComponent(targetDate)}`),
    api('/api/appointments?status=completed'),
    api('/api/appointments')
  ]);

  const { stats, types, insights, appointments: todayFromDashboard } = dashboardResult;
  if (targetDate !== state.selectedDate) return;

  const scheduleTitle = document.getElementById('schedule-title');

  // Use today's appointments from the dashboard response (already scoped to today).
  const todayAppointments = (todayFromDashboard || []).filter((a) => {
    const status = String(a.status || '').toLowerCase();
    return status !== 'completed' && status !== 'cancelled';
  });
  const allActiveAppointments = (upcomingResult?.appointments || [])
    .filter((a) => {
      const status = String(a.status || '').toLowerCase();
      return status !== 'completed' && status !== 'cancelled';
    })
    .sort((a, b) => {
      const aKey = `${a.date || ''} ${a.time || ''}`;
      const bKey = `${b.date || ''} ${b.time || ''}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  const reminderQueue = (upcomingResult?.appointments || [])
    .filter((a) => {
      if (String(a.source || '').toLowerCase() !== 'reminder') return false;
      const status = String(a.status || '').toLowerCase();
      if (status === 'completed' || status === 'cancelled') return false;
      if (!isAtOrAfterNow(a.date, a.time)) return false;
      return true;
    })
    .sort((a, b) => {
      const aKey = `${a.date || ''} ${a.time || ''}`;
      const bKey = `${b.date || ''} ${b.time || ''}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  const nextReminder = reminderQueue[0] || null;

  const effectiveStats = reminderModeEnabled
    ? (() => {
      const reminders = (upcomingResult?.appointments || []).filter((a) => String(a.source || '').toLowerCase() === 'reminder');
      const weekEnd = addDays(parseYmd(targetDate) || new Date(`${targetDate}T00:00:00`), 6).toISOString().slice(0, 10);
      return {
        today: reminders.filter((a) => String(a.date || '').slice(0, 10) === targetDate).length,
        week: reminders.filter((a) => {
          const d = String(a.date || '').slice(0, 10);
          return d >= targetDate && d <= weekEnd;
        }).length,
        pending: reminders.filter((a) => String(a.status || '').toLowerCase() === 'pending').length
      };
    })()
    : stats;

  let activeAppointments = todayAppointments;
  if (reminderModeEnabled) {
    const fromDate = state.viewAll ? targetDate : today;
    activeAppointments = reminderQueue.filter((a) => typeof a.date === 'string' && a.date >= fromDate);
    if (scheduleTitle) {
      scheduleTitle.textContent = state.viewAll
        ? `Upcoming Reminders from ${formatScheduleDate(fromDate)}`
        : 'Upcoming Reminders';
    }
  } else {
    if (state.viewAll) {
      activeAppointments = allActiveAppointments.filter((a) => typeof a.date === 'string' && a.date >= targetDate);
      if (scheduleTitle) scheduleTitle.textContent = `Upcoming from ${formatScheduleDate(targetDate)}`;
    } else if (scheduleTitle) {
      scheduleTitle.textContent = isTargetToday
        ? `Today's ${getEntryWordPluralTitle()}`
        : `${getEntryWordPluralTitle()}: ${formatScheduleDate(targetDate)}`;
    }

    if (!state.viewAll && !todayAppointments.length && isTargetToday) {
      // Fall back to the next upcoming day from all appointments.
      const upcomingFiltered = allActiveAppointments.filter((a) => typeof a.date === 'string' && a.date >= today);

      const next = upcomingFiltered[0];
      if (next?.date && next.date > today) {
        // next upcoming day — need to fetch that day specifically
        const nextDayResult = await api(`/api/appointments?date=${encodeURIComponent(next.date)}`);
        activeAppointments = (nextDayResult?.appointments || []).filter((a) => {
          const status = String(a.status || '').toLowerCase();
          return status !== 'completed' && status !== 'cancelled';
        });
        if (scheduleTitle) scheduleTitle.textContent = `Next: ${formatScheduleDate(next.date)}`;
      } else if (scheduleTitle) {
        scheduleTitle.textContent = `Today's ${getEntryWordPluralTitle()}`;
      }
    }
  }

  const completedAppointments = (completedResult?.appointments || [])
    .slice()
    .sort((a, b) => {
      const aKey = `${a.date || ''} ${a.time || ''}`;
      const bKey = `${b.date || ''} ${b.time || ''}`;
      return aKey < bKey ? 1 : -1;
    });

  renderStats(effectiveStats, { nextReminder });
  renderTimeline(activeAppointments, {
    emptyMessage: reminderModeEnabled
      ? 'No upcoming reminders.'
      : (state.viewAll
        ? `No upcoming ${getEntryWordPlural()} from this day onward.`
        : `No ${getEntryWordPlural()} for this day yet.`),
    includeDate: state.viewAll || reminderModeEnabled
  });
  renderCompletedAppointments(completedAppointments);
  renderTypes(types);
  renderInsights(insights);
  if (refreshDots) await refreshCalendarDots();
}

async function loadAppointmentsTable() {
  const activeView = getActiveView();
  const showAll = activeView === 'appointments' || state.viewAll;
  const query = showAll ? '' : `?date=${encodeURIComponent(state.selectedDate)}`;
  renderSkeleton(document.getElementById('appointments-table'), 5);
  const { appointments } = await api(`/api/appointments${query}`);
  renderAppointmentsTable(appointments);
}

async function submitAppointment(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const wasEditing = Boolean(state.editingAppointmentId);
  if (isReminderModeEnabled()) {
    payload.source = 'reminder';
    payload.title = String(payload.clientName || '').trim();
    payload.typeId = null;
    payload.location = 'office';
  } else {
    if (String(form.dataset.entrySource || '').toLowerCase() === 'reminder') payload.source = 'reminder';
    payload.typeId = state.selectedTypeId;
  }
  payload.durationMinutes = String(payload.source || '').toLowerCase() === 'reminder'
    ? 0
    : Number(payload.durationMinutes || 45);
  payload.reminderOffsetMinutes = Number(payload.reminderOffsetMinutes == null ? 10 : payload.reminderOffsetMinutes);

  const submitButton = form.querySelector('button[type="submit"]');
  const oldText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = wasEditing ? 'Saving...' : 'Creating...';

  try {
    if (wasEditing) {
      const result = await queueAwareMutation(`/api/appointments/${state.editingAppointmentId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      }, {
        allowOfflineQueue: true,
        description: 'Appointment update'
      });
      if (result.queued) {
        form.reset();
        closeModal('new-appointment');
        return;
      }
    } else {
      const sourceMode = String(payload.source || '').toLowerCase();
      const isReminder = isReminderModeEnabled() || sourceMode === 'reminder';
      const result = await queueAwareMutation('/api/appointments', { method: 'POST', body: JSON.stringify(payload) }, {
        allowOfflineQueue: true,
        description: isReminder ? 'Reminder creation' : 'Appointment creation'
      });
      if (result.queued) {
        form.reset();
        setAppointmentDefaults();
        closeModal('new-appointment');
        return;
      }
      const provider = result?.body?.notifications?.mode;
      showToast(
        isReminder
          ? 'Reminder created.'
          : (
            provider === 'simulation'
              ? 'Appointment created. Email simulation mode is active.'
              : 'Appointment created and notifications sent.'
          ),
        'success'
      );
    }

    form.reset();
    setAppointmentDefaults();
    closeModal('new-appointment');
    await loadDashboard();
    await loadAppointmentsTable();
    await refreshCalendarDots({ force: true });
    if (wasEditing) showToast(`${getEntryWordSingularTitle()} updated.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = oldText;
  }
}

async function submitType(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const formData = new FormData(form);
  const id = formData.get('id');
  const data = Object.fromEntries(formData.entries());
  
  const isEditing = id && Number(id) > 0;
  const url = isEditing ? `/api/types/${id}` : '/api/types';
  const method = isEditing ? 'PUT' : 'POST';

  try {
    const result = await queueAwareMutation(url, {
      method,
      body: JSON.stringify({
        name: data.name,
        durationMinutes: Number(data.durationMinutes || 30),
        priceCents: Number(data.priceGbp ?? data.priceUsd ?? 0) * 100,
        locationMode: data.locationMode
      })
    }, {
      allowOfflineQueue: true,
      description: isEditing ? 'Type update' : 'Type creation'
    });
    if (result.queued) {
      resetTypeForm();
      return;
    }
    resetTypeForm();
    showToast(isEditing ? 'Type updated' : 'Type created', 'success');
    await loadTypes();
    await loadDashboard();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function resetTypeForm() {
  const form = document.getElementById('type-form');
  const title = document.getElementById('type-form-title');
  const cancelBtn = document.getElementById('btn-cancel-type-edit');
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (form) {
      form.reset();
      document.getElementById('type-id').value = '';
  }
  if (title) title.textContent = 'Create Appointment Type';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (submitBtn) submitBtn.textContent = 'Create Type';
}

function setTypeFormForEditing(typeId) {
  const type = state.types.find(t => Number(t.id) === Number(typeId));
  if (!type) return;

  const form = document.getElementById('type-form');
  const title = document.getElementById('type-form-title');
  const cancelBtn = document.getElementById('btn-cancel-type-edit');
  const submitBtn = form?.querySelector('button[type="submit"]');

  if (form) {
      document.getElementById('type-id').value = type.id;
      document.getElementById('type-name').value = type.name || '';
      document.getElementById('type-duration').value = type.durationMinutes || 30;
      document.getElementById('type-price').value = (Number(type.priceCents) || 0) / 100;
      document.getElementById('type-location').value = type.locationMode || 'hybrid';
  }
  
  if (title) title.textContent = 'Edit Appointment Type';
  if (cancelBtn) cancelBtn.style.display = 'flex';
  if (submitBtn) submitBtn.textContent = 'Update Type';

  // Scroll to form on narrow screens
  if (window.innerWidth <= 1024) {
    form?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function submitSettings(e) {
  e.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    data.businessHours = collectBusinessHoursFromForm();
    data.reminderMode = isReminderModeEnabled();
    data.workspaceMode = normalizeWorkspaceMode(state.workspaceMode);
    const result = await queueAwareMutation('/api/settings', { method: 'PUT', body: JSON.stringify(data) }, {
      allowOfflineQueue: true,
      description: 'Settings update'
    });
    if (result.queued) return;
    showToast('Settings saved', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function submitClient(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const formData = new FormData(form);
  const id = formData.get('id');
  const payload = Object.fromEntries(formData.entries());
  
  const isEditing = id && Number(id) > 0;
  const url = isEditing ? `/api/clients/${id}` : '/api/clients';
  const method = isEditing ? 'PUT' : 'POST';

  try {
    const result = await api(url, { method, body: JSON.stringify(payload) });
    form.reset();
    showToast(isEditing ? 'Client updated.' : 'Client saved.', 'success');
    closeClientForm();
    
    if (!isEditing && result?.client?.id) {
        state.selectedClientId = result.client.id;
    }
    await loadClients();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function closeClientForm() {
    document.getElementById('client-form-container').style.display = 'none';
    document.getElementById('client-detail-panel-wrapper').style.display = 'flex';
}

async function submitClientNote(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const clientId = Number(form.dataset.clientId || state.selectedClientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    showToast('Select a client first.', 'info');
    return;
  }

  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await api(`/api/clients/${clientId}/notes`, { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    showToast('Note added.', 'success');
    // Reload details to show the new note
    await loadClientDetail(clientId);
    // Also reload the list to update the "last note" preview
    void loadClients().catch(swallowBackgroundAsyncError);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderAiImportQuotaIndicator(quota) {
  const indicator = document.getElementById('ai-import-quota-indicator');
  const valueNode = document.getElementById('ai-import-quota-value');
  const importBtn = document.getElementById('btn-import-ai-data');
  if (!indicator) return;
  const remaining = Number(quota?.remaining);
  const limit = Number(quota?.limit || 3);
  if (importBtn) {
    importBtn.disabled = false;
    importBtn.removeAttribute('title');
  }
  if (!Number.isFinite(remaining)) {
    if (valueNode) valueNode.textContent = `Remaining today: -- / ${limit}`;
    indicator.classList.remove('is-empty');
    return;
  }
  const safeRemaining = Math.max(0, remaining);
  if (valueNode) valueNode.textContent = `Remaining today: ${safeRemaining} / ${limit}`;
  const noQuotaLeft = safeRemaining <= 0;
  indicator.classList.toggle('is-empty', noQuotaLeft);
  if (importBtn && noQuotaLeft) {
    importBtn.disabled = true;
    importBtn.title = 'Daily AI import limit reached.';
  }
}

async function loadAiImportQuotaIndicator() {
  try {
    const payload = await api('/api/data/import-ai/quota');
    renderAiImportQuotaIndicator(payload?.quota);
  } catch (_error) {
    renderAiImportQuotaIndicator(null);
  }
}

async function loadSettings() {
  const { settings } = await api('/api/settings');
  const form = document.getElementById('settings-form');
  if (!form) return;
  const fallbackServerMode = settings.reminder_mode === true || settings.reminder_mode === 1 ? 'reminders' : 'appointments';
  const serverWorkspaceMode = normalizeWorkspaceMode(settings.workspace_mode || fallbackServerMode);
  setWorkspaceMode(serverWorkspaceMode, { persist: true });
  form.businessName.value = settings.business_name || '';
  form.ownerEmail.value = settings.owner_email || '';
  form.timezone.value = settings.timezone || 'America/Los_Angeles';
  if (form.openTime) form.openTime.value = String(settings.open_time || '09:00').slice(0, 5);
  if (form.closeTime) form.closeTime.value = String(settings.close_time || '18:00').slice(0, 5);
  applyBusinessHoursToForm(settings.businessHours, form.openTime?.value || '09:00', form.closeTime?.value || '18:00');

  // Apply theme from server; fall back to stored local preference
  const resolvedTheme = settings.theme === 'dark' || settings.theme === 'light'
    ? settings.theme
    : (localStorage.getItem('theme') || 'dark');
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  setStoredValue('theme', resolvedTheme);

  // Apply accent color from server; fall back to stored local preference
  const resolvedAccent = normalizeAccentColor(settings.accentColor || localStorage.getItem('accentColor'));
  applyAccentColor(resolvedAccent);
  setStoredValue('accentColor', resolvedAccent);

  syncSettingsThemeSelector();

  // Calendar preview toggle
  const previewToggle = document.getElementById('settings-calendar-show-client-names');
  if (previewToggle) previewToggle.checked = Boolean(state.calendarShowClientNames);

  // Owner email notification toggle (server setting)
  const notifyToggle = document.getElementById('settings-notify-owner-email');
  if (notifyToggle) {
    const val = settings.notify_owner_email;
    notifyToggle.checked = (val === false || val === 0) ? false : true;
  }

  const reminderToggle = document.getElementById('settings-reminder-mode');
  if (reminderToggle) {
    reminderToggle.checked = state.reminderMode;
    reminderToggle.disabled = isClientModeEnabled();
  }
  const workspaceModeSelect = document.getElementById('settings-workspace-mode');
  if (workspaceModeSelect) workspaceModeSelect.value = normalizeWorkspaceMode(state.workspaceMode);
  const browserNotifToggle = document.getElementById('settings-browser-notifications');
  if (browserNotifToggle) {
    browserNotifToggle.checked = Boolean(state.browserNotificationsEnabled);
    if (!canUseBrowserNotifications()) {
      browserNotifToggle.checked = false;
      browserNotifToggle.disabled = true;
      browserNotifToggle.title = 'Browser notifications are not supported in this browser.';
    }
  }
  applyReminderModeUi();

  // Populate the export type chips
  populateExportTypeFilters();

  const navModeToggle = document.getElementById('settings-mobile-nav-bottom-tabs');
  if (navModeToggle) {
    navModeToggle.checked = getStoredMobileNavMode() === 'bottom';
  }

  await loadAiImportQuotaIndicator();
  if (state.browserNotificationsEnabled) startReminderNotificationPolling();
}

function triggerJsonDownload(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportBusinessData() {
  try {
    const payload = await api('/api/data/export');
    const slug = state.currentBusiness?.slug || 'business';
    const date = new Date().toISOString().slice(0, 10);
    triggerJsonDownload(`${slug}-backup-${date}.json`, payload);
    showToast('Backup exported.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function importBusinessDataFromFile(file) {
  if (!file) return;
  try {
    const raw = await file.text();
    const payload = JSON.parse(raw);
    const ok = await showConfirm('Load Backup', 'This will replace all current appointments and types for this business. This cannot be undone.');
    if (!ok) return;

    const result = await api('/api/data/import', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    showToast(
      `Backup loaded (${result.importedTypes || 0} types, ${result.importedAppointments || 0} appointments).`,
      'success'
    );
    await loadTypes();
    await loadDashboard();
    await loadAppointmentsTable();
    await loadSettings();
  } catch (error) {
    showToast(error.message || 'Invalid backup file.', 'error');
  }
}

async function importAiAppointmentsFromFile(file) {
  if (!file) return;
  try {
    const raw = await file.text();
    if (!String(raw || '').trim()) throw new Error('Selected file is empty.');
    const ok = await showConfirm(
      'AI Import Appointments',
      'AI will convert this file and import only non-overlapping appointments. Continue?'
    );
    if (!ok) return;

    showToast('AI import started. Parsing file and converting appointments…', 'info');

    const result = await api('/api/data/import-ai', {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        fileContent: raw
      })
    });
    renderAiImportQuotaIndicator(result?.quota);

    showToast(
      `AI import complete (${result.model || 'model'}): ${result.importedAppointments || 0} imported, ${result.skippedOverlaps || 0} overlap skipped, ${result.skippedInvalid || 0} invalid skipped.`,
      'success'
    );
    if ((result.skippedOverlaps || 0) > 0) {
      const samples = Array.isArray(result.overlapSamples) ? result.overlapSamples.slice(0, 4) : [];
      if (samples.length) {
        const summary = samples
          .map((s) => `${s.clientName || 'Appointment'} ${s.date || ''} ${s.time || ''}`.trim())
          .join(' | ');
        showToast(
          `Skipped overlaps (${result.skippedOverlaps}): ${summary}${result.skippedOverlaps > samples.length ? ' | ...' : ''}`,
          'info'
        );
      } else {
        showToast('Some appointments were skipped because they overlapped existing bookings.', 'info');
      }
    }
    if ((result.skippedInvalid || 0) > 0) {
      const invalidSamples = Array.isArray(result.invalidSamples) ? result.invalidSamples.slice(0, 3) : [];
      showToast(
        invalidSamples.length
          ? `Skipped invalid rows (${result.skippedInvalid}): ${invalidSamples.map((r) => `row ${Number(r.index) + 1}`).join(', ')}.`
          : 'Some rows were skipped because required date/time fields were invalid.',
        'info'
      );
    }

    await loadDashboard();
    await loadAppointmentsTable();
    await refreshCalendarDots({ force: true });
  } catch (error) {
    if (error?.details?.quota) renderAiImportQuotaIndicator(error.details.quota);
    showToast(error.message || 'AI import failed.', 'error');
  }
}

// ── Settings: theme selector sync ────────────────────────────────────────────

function syncSettingsThemeSelector() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const themeRadios = document.querySelectorAll('input[name="settings-theme"]');
  themeRadios.forEach((r) => {
    r.checked = r.value === currentTheme;
    const parent = r.closest('.theme-option');
    if (parent) {
      if (r.checked) parent.classList.add('active');
      else parent.classList.remove('active');
    }
  });

  const savedColor = normalizeAccentColor(localStorage.getItem('accentColor'));
  const colorRadios = document.querySelectorAll('input[name="settings-accent"]');
  colorRadios.forEach((r) => {
    r.checked = r.value === savedColor;
  });
}

// ── Settings: export type chips ───────────────────────────────────────────────

function populateExportTypeFilters() {
  const grid = document.getElementById('export-types-grid');
  if (!grid) return;
  const types = state.types || [];
  if (types.length === 0) {
    grid.innerHTML = '<span class="export-types-empty">No appointment types found.</span>';
    return;
  }
  grid.innerHTML = types.map((t) => {
    // Extract a displayable solid colour from the gradient string stored in t.color
    const swatchColour = extractSwatchColour(t.color);
    return `
      <label class="export-type-chip selected" data-type-id="${t.id}">
        <input type="checkbox" value="${t.id}" checked aria-label="${escapeHtml(t.name)}" />
        <span class="export-type-swatch" style="background:${swatchColour};"></span>
        <span class="export-type-name">${escapeHtml(t.name)}</span>
      </label>
    `.trim();
  }).join('');

  // Toggle .selected class on click
  grid.querySelectorAll('.export-type-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cb = chip.querySelector('input[type="checkbox"]');
      if (!cb) return;
      cb.checked = !cb.checked;
      chip.classList.toggle('selected', cb.checked);
      updateExportSummary();
    });
  });

  updateExportSummary();
}

function extractSwatchColour(colorStr) {
  if (!colorStr) return 'var(--text-muted)';
  // Handle css gradient strings — pull the first hex or rgb colour
  const hexMatch = colorStr.match(/#[0-9a-fA-F]{3,6}/);
  if (hexMatch) return hexMatch[0];
  const rgbMatch = colorStr.match(/rgba?\([^)]+\)/);
  if (rgbMatch) return rgbMatch[0];
  // Plain named colour or custom property fallback
  return colorStr;
}

// ── Settings: export summary preview ─────────────────────────────────────────

function updateExportSummary() {
  const summary = document.getElementById('export-summary');
  if (!summary) return;
  const from = (document.getElementById('export-date-from'))?.value || '';
  const to = (document.getElementById('export-date-to'))?.value || '';
  const statusFilter = (document.getElementById('export-status-filter'))?.value || '';
  const selectedTypeIds = getSelectedExportTypeIds();
  const format = getSelectedExportFormat();

  const parts = [];
  if (from && to) {
    parts.push(`<strong>${from}</strong> to <strong>${to}</strong>`);
  } else if (from) {
    parts.push(`from <strong>${from}</strong>`);
  } else if (to) {
    parts.push(`up to <strong>${to}</strong>`);
  } else {
    parts.push('all dates');
  }

  const totalTypes = (state.types || []).length;
  if (totalTypes > 0) {
    if (selectedTypeIds.length === 0) {
      parts.push('<strong>no types selected</strong>');
    } else if (selectedTypeIds.length === totalTypes) {
      parts.push('all types');
    } else {
      parts.push(`<strong>${selectedTypeIds.length}</strong> type${selectedTypeIds.length !== 1 ? 's' : ''}`);
    }
  }

  if (statusFilter) {
    parts.push(`status: <strong>${statusFilter}</strong>`);
  }

  parts.push(`format: <strong>${format.toUpperCase()}</strong>`);

  summary.innerHTML = parts.join(' &middot; ');
}

function getSelectedExportTypeIds() {
  const grid = document.getElementById('export-types-grid');
  if (!grid) return [];
  return Array.from(grid.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => Number(cb.value));
}

function getSelectedExportFormat() {
  const active = document.querySelector('.format-toggle-btn.active');
  return active?.dataset.format || 'json';
}

// ── CSV download helper ───────────────────────────────────────────────────────

const EXPORT_CSV_COLUMNS = [
  'id', 'typeName', 'clientName', 'clientEmail',
  'date', 'time', 'durationMinutes', 'location',
  'status', 'notes', 'source', 'createdAt'
];

const EXPORT_CSV_HEADERS = [
  'ID', 'Type', 'Client Name', 'Client Email',
  'Date', 'Time', 'Duration (min)', 'Location',
  'Status', 'Notes', 'Source', 'Created At'
];

function csvEscape(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvLines(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return [
    EXPORT_CSV_HEADERS.map(csvEscape).join(','),
    ...safeRows.map((row) => EXPORT_CSV_COLUMNS.map((col) => csvEscape(row?.[col])).join(','))
  ].join('\r\n');
}

function filterAppointmentsForExport(appointments = [], options = {}) {
  const safeAppointments = Array.isArray(appointments) ? appointments : [];
  const from = options.from || '';
  const to = options.to || '';
  const statusFilter = options.statusFilter || '';
  const selectedTypeIds = Array.isArray(options.selectedTypeIds) ? options.selectedTypeIds.map(Number) : [];
  const totalTypes = Number(options.totalTypes) || 0;

  let filtered = safeAppointments;
  if (from) filtered = filtered.filter((a) => a.date >= from);
  if (to) filtered = filtered.filter((a) => a.date <= to);
  if (statusFilter) filtered = filtered.filter((a) => a.status === statusFilter);
  if (totalTypes > 0 && selectedTypeIds.length < totalTypes) {
    filtered = filtered.filter((a) => a.typeId != null && selectedTypeIds.includes(Number(a.typeId)));
  }
  return filtered;
}

function buildFilteredExportFilename(slug, now = new Date()) {
  const base = slug || 'business';
  const date = now.toISOString().slice(0, 10);
  return `${base}-export-${date}`;
}

function buildFilteredExportJsonPayload(filteredAppointments, filters, now = new Date()) {
  const safeFilters = filters || {};
  return {
    exportedAt: now.toISOString(),
    filters: {
      from: safeFilters.from || null,
      to: safeFilters.to || null,
      status: safeFilters.status || null,
      typeIds: Array.isArray(safeFilters.typeIds) ? safeFilters.typeIds : []
    },
    count: filteredAppointments.length,
    appointments: filteredAppointments
  };
}

function triggerCsvDownload(filename, rows) {
  if (!rows || rows.length === 0) {
    showToast('No appointments matched your filters.', 'info');
    return;
  }
  const blob = new Blob([buildCsvLines(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ── Filtered export ───────────────────────────────────────────────────────────

async function runFilteredExport() {
  const from = (document.getElementById('export-date-from'))?.value || '';
  const to = (document.getElementById('export-date-to'))?.value || '';
  const statusFilter = (document.getElementById('export-status-filter'))?.value || '';
  const selectedTypeIds = getSelectedExportTypeIds();
  const format = getSelectedExportFormat();

  const btn = document.getElementById('btn-export-filtered');
  if (btn) btn.disabled = true;

  try {
    // Fetch all appointments from the server
    const { appointments: all } = await api('/api/appointments');

    const filtered = filterAppointmentsForExport(all, {
      from,
      to,
      statusFilter,
      selectedTypeIds,
      totalTypes: (state.types || []).length
    });

    if (filtered.length === 0) {
      showToast('No appointments matched the selected filters.', 'info');
      return;
    }

    const now = new Date();
    const filename = buildFilteredExportFilename(state.currentBusiness?.slug, now);

    if (format === 'csv') {
      triggerCsvDownload(`${filename}.csv`, filtered);
    } else {
      const payload = buildFilteredExportJsonPayload(
        filtered,
        { from, to, status: statusFilter, typeIds: selectedTypeIds },
        now
      );
      triggerJsonDownload(`${filename}.json`, payload);
    }

    showToast(`Exported ${filtered.length} appointment${filtered.length !== 1 ? 's' : ''}.`, 'success');
  } catch (error) {
    showToast(error.message || 'Export failed.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runSearch(query) {
  const normalizedQuery = String(query || '').trim();
  const requestId = ++state.searchRequestId;
  if (!normalizedQuery) {
    await loadAppointmentsTable();
    return;
  }
  if (normalizedQuery.length < 2) {
    renderAppointmentsTable([]);
    setActiveView('appointments');
    return;
  }
  const { appointments } = await api(`/api/appointments?q=${encodeURIComponent(normalizedQuery)}`);
  if (requestId !== state.searchRequestId) return;
  renderAppointmentsTable(appointments);
  setActiveView('appointments', { skipAppointmentsReload: true });
}

function hideGlobalSearchSuggestions() {
  const suggestions = document.getElementById('global-search-suggestions');
  if (!suggestions) return;
  suggestions.innerHTML = '';
  suggestions.classList.add('hidden');
}

function findSettingsSearchMatches(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length < 2) return [];
  return GLOBAL_SEARCH_SETTINGS_OPTIONS
    .map((option) => {
      const haystack = `${option.label} ${Array.isArray(option.keywords) ? option.keywords.join(' ') : ''}`.toLowerCase();
      let score = 0;
      if (haystack.includes(q)) score += 3;
      if (option.label.toLowerCase().includes(q)) score += 2;
      if (Array.isArray(option.keywords) && option.keywords.some((kw) => kw.toLowerCase().includes(q))) score += 1;
      return { ...option, score };
    })
    .filter((option) => option.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function openSettingsSearchOption(option) {
  if (!option) return;
  state.searchRequestId += 1;
  state.searchActive = false;
  state.searchOriginView = null;
  setActiveView('settings');

  const sectionSelector = String(option.sectionSelector || '').trim();
  if (sectionSelector) {
    const section = document.querySelector(sectionSelector);
    const toggle = document.querySelector(`.collapse-toggle-btn[data-collapse-target="${sectionSelector}"]`);
    if (section && toggle) {
      applyCollapseState(toggle, section, false);
    } else {
      section?.classList.remove('is-collapsed');
    }
  }

  const target = document.getElementById(option.targetId);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function renderGlobalSearchSuggestions(query) {
  const suggestions = document.getElementById('global-search-suggestions');
  if (!suggestions) return;
  const matches = findSettingsSearchMatches(query);
  if (!matches.length) {
    hideGlobalSearchSuggestions();
    return;
  }

  suggestions.innerHTML = matches.map((option, idx) => `
    <button type="button" class="search-suggestion" data-settings-match-index="${idx}">
      <span>${escapeHtml(option.label)}</span>
      <small>Settings</small>
    </button>
  `).join('');
  suggestions.classList.remove('hidden');

  suggestions.querySelectorAll('.search-suggestion[data-settings-match-index]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.settingsMatchIndex);
      const choice = matches[idx];
      const search = document.getElementById('global-search');
      if (search) search.value = '';
      hideGlobalSearchSuggestions();
      openSettingsSearchOption(choice);
    });
  });
}

async function clearSearchAndRestoreView(searchInput) {
  state.searchRequestId += 1;
  if (searchInput) searchInput.value = '';
  hideGlobalSearchSuggestions();
  await loadAppointmentsTable();
  if (state.searchActive && state.searchOriginView) {
    setActiveView(state.searchOriginView);
  }
  state.searchActive = false;
  state.searchOriginView = null;
}

function validatePasswordStrength(password = '') {
  const value = String(password || '');
  const checks = [
    { ok: value.length >= 12, text: '12+ chars' },
    { ok: /[a-z]/.test(value), text: 'lowercase' },
    { ok: /[A-Z]/.test(value), text: 'uppercase' },
    { ok: /\d/.test(value), text: 'number' },
    { ok: /[^A-Za-z0-9]/.test(value), text: 'symbol' },
    { ok: !/\s/.test(value), text: 'no spaces' }
  ];
  const failed = checks.filter((c) => !c.ok).map((c) => c.text);
  return {
    ok: failed.length === 0,
    message: failed.length === 0 ? '' : `Password is too weak. Missing: ${failed.join(', ')}.`
  };
}

function updateAccountUi() {
  const chip = document.getElementById('account-chip');
  if (chip) {
    if (state.currentUser && state.currentBusiness) {
      chip.textContent = `${state.currentBusiness.name} • ${state.currentUser.email}`;
      chip.classList.remove('hidden');
    } else {
      chip.textContent = '';
      chip.classList.add('hidden');
    }
  }
  const liveSlug = state.currentBusiness?.slug ? String(state.currentBusiness.slug) : '';
  if (liveSlug) localStorage.setItem('lastBusinessSlug', liveSlug);
  const slug = liveSlug || localStorage.getItem('lastBusinessSlug') || '';

  document.querySelectorAll('[data-public-booking-link]').forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) return;
    if (slug) {
      link.href = `/book?business=${encodeURIComponent(slug)}`;
      link.classList.remove('is-disabled');
      link.removeAttribute('aria-disabled');
      link.removeAttribute('title');
    } else {
      link.href = '/book';
      link.classList.add('is-disabled');
      link.setAttribute('aria-disabled', 'true');
      link.setAttribute('title', 'Sign in first to open your business booking page.');
    }
  });
  const sidebarAuth = document.getElementById('nav-logout-sidebar');
  const mobileAuthBtn = document.getElementById('btn-logout-mobile');

  const logoutSvg = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  `;
  const loginSvg = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 5 12 10 7" />
      <line x1="15" y1="12" x2="5" y2="12" />
    </svg>
  `;

  // Sidebar button: toggle between Sign In / Logout
  if (sidebarAuth) {
    const text = state.currentUser ? 'Logout' : 'Sign In';
    const svg = state.currentUser ? logoutSvg : loginSvg;
    const span = sidebarAuth.querySelector('span');
    if (span) span.textContent = text;
    const existingSvg = sidebarAuth.querySelector('svg');
    if (existingSvg) {
      existingSvg.outerHTML = svg.trim();
    } else {
      sidebarAuth.insertAdjacentHTML('afterbegin', svg.trim());
    }
  }

  if (mobileAuthBtn) {
    const isSignedIn = Boolean(state.currentUser);
    mobileAuthBtn.setAttribute('aria-label', isSignedIn ? 'Logout' : 'Sign In');
    mobileAuthBtn.setAttribute('title', isSignedIn ? 'Logout' : 'Sign In');
    mobileAuthBtn.innerHTML = (isSignedIn ? logoutSvg : loginSvg).trim();
  }
}

function setAuthTab(tab) {
  const loginForm = document.getElementById('auth-login-form');
  const codeForm = document.getElementById('auth-code-form');
  const signupForm = document.getElementById('auth-signup-form');
  document.querySelectorAll('.auth-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.authTab === tab);
  });
  if (loginForm) loginForm.classList.toggle('hidden', tab !== 'login');
  if (codeForm) codeForm.classList.add('hidden');
  if (signupForm) signupForm.classList.toggle('hidden', tab !== 'signup');
  resetAuthCodeFlow();
}

function showAuthShell(force = false) {
  if (!force && state.authShellDismissed) return;
  document.getElementById('auth-shell')?.classList.remove('hidden');
}

function hideAuthShell(dismissed = false) {
  if (dismissed) state.authShellDismissed = true;
  document.getElementById('auth-shell')?.classList.add('hidden');
  resetAuthCodeFlow();
}

let authResendTimer = null;

function resetAuthCodeFlow() {
  state.authLoginChallengeToken = '';
  state.authLoginEmail = '';
  state.authResendCooldownUntil = 0;
  if (authResendTimer) {
    clearInterval(authResendTimer);
    authResendTimer = null;
  }
  const codeForm = document.getElementById('auth-code-form');
  const codeInput = document.getElementById('auth-login-code');
  const codeCopy = document.getElementById('auth-code-copy');
  const resendBtn = document.getElementById('btn-auth-resend-code');
  if (codeForm) codeForm.classList.add('hidden');
  if (codeInput) codeInput.value = '';
  if (codeCopy) codeCopy.textContent = 'Enter the 6-digit code sent to your email.';
  if (resendBtn) {
    resendBtn.disabled = false;
    resendBtn.textContent = 'Resend Code';
  }
}

function updateAuthResendButton() {
  const resendBtn = document.getElementById('btn-auth-resend-code');
  if (!resendBtn) return;
  const remainingMs = state.authResendCooldownUntil - Date.now();
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  resendBtn.disabled = remainingSeconds > 0;
  resendBtn.textContent = remainingSeconds > 0 ? `Resend (${remainingSeconds}s)` : 'Resend Code';
  if (remainingSeconds <= 0 && authResendTimer) {
    clearInterval(authResendTimer);
    authResendTimer = null;
  }
}

function startAuthResendCooldown(seconds = 30) {
  state.authResendCooldownUntil = Date.now() + Number(seconds || 0) * 1000;
  updateAuthResendButton();
  if (authResendTimer) clearInterval(authResendTimer);
  authResendTimer = setInterval(updateAuthResendButton, 1000);
}

function showAuthCodeStep({ challengeToken, email }) {
  const loginForm = document.getElementById('auth-login-form');
  const codeForm = document.getElementById('auth-code-form');
  const codeInput = document.getElementById('auth-login-code');
  const codeCopy = document.getElementById('auth-code-copy');
  state.authLoginChallengeToken = String(challengeToken || '');
  state.authLoginEmail = String(email || '');
  if (loginForm) loginForm.classList.add('hidden');
  if (codeForm) codeForm.classList.remove('hidden');
  if (codeCopy) {
    codeCopy.textContent = state.authLoginEmail
      ? `Enter the 6-digit code sent to ${state.authLoginEmail}.`
      : 'Enter the 6-digit code sent to your email.';
  }
  startAuthResendCooldown(30);
  codeInput?.focus();
}

async function ensureAuth() {
  try {
    const me = await api('/api/auth/me');
    state.currentUser = me.user || null;
    state.currentBusiness = me.business || null;
    saveAuthSnapshot(state.currentUser, state.currentBusiness);
    state.authShellDismissed = false;
    updateAccountUi();
    hideAuthShell();
    if (state.browserNotificationsEnabled) startReminderNotificationPolling();
    return true;
  } catch (error) {
    if (error?.code === 'OFFLINE' || error?.code === 'NETWORK') {
      const snapshot = loadAuthSnapshot();
      if (snapshot?.user && snapshot?.business) {
        state.currentUser = snapshot.user;
        state.currentBusiness = snapshot.business;
        updateAccountUi();
        hideAuthShell();
        if (state.browserNotificationsEnabled) startReminderNotificationPolling();
        return true;
      }
      // Offline without a cached auth snapshot: keep shell hidden so offline
      // queueing/creation UX is still usable until connectivity returns.
      state.currentUser = null;
      state.currentBusiness = null;
      stopReminderNotificationPolling();
      updateAccountUi();
      hideAuthShell();
      return false;
    }
    state.currentUser = null;
    state.currentBusiness = null;
    stopReminderNotificationPolling();
    saveAuthSnapshot(null, null);
    updateAccountUi();
    showAuthShell();
    return false;
  }
}

function bindAuthUi() {
  document.querySelectorAll('.auth-tab').forEach((btn) => {
    btn.addEventListener('click', () => setAuthTab(btn.dataset.authTab));
  });

  document.getElementById('btn-dev-login')?.addEventListener('click', async () => {
    try {
      const result = await api('/api/auth/dev-login', { method: 'POST' });
      state.currentUser = result.user || null;
      state.currentBusiness = result.business || null;
      saveAuthSnapshot(state.currentUser, state.currentBusiness);
      state.authShellDismissed = false;
      updateAccountUi();
      hideAuthShell();
      await loadTypes();
      await loadDashboard();
      await loadAppointmentsTable();
      await loadSettings();
      await flushOfflineMutationQueue();
      showToast('Dev login successful.', 'success');
    } catch (error) {
      showToast(error.message || 'Dev login not available.', 'error');
    }
  });

  document.getElementById('btn-forgot-password')?.addEventListener('click', async () => {
    const emailInput = document.getElementById('auth-email');
    const email = String(emailInput?.value || '').trim();
    if (!email) {
      showToast('Enter your email first, then click Forgot password.', 'info');
      emailInput?.focus();
      return;
    }
    try {
      const result = await api('/api/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      const debugToken = result?.resetToken ? ` (dev token: ${result.resetToken})` : '';
      showToast(`If your account exists, a reset link has been sent.${debugToken}`, 'success');
    } catch (error) {
      showToast(error.message || 'Could not send reset link right now.', 'error');
    }
  });

  document.getElementById('auth-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(data)
      });
      if (!result?.codeRequired || !result?.challengeToken) {
        throw new Error('Login verification challenge was not created.');
      }
      showAuthCodeStep({ challengeToken: result.challengeToken, email: data.email });
      const debugCode = result.loginCode ? ` (dev code: ${result.loginCode})` : '';
      showToast(`Verification code sent. Check your email.${debugCode}`, 'info');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('auth-code-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') || '').trim();
    if (!code) {
      showToast('Enter your login code to continue.', 'error');
      return;
    }
    if (!state.authLoginChallengeToken) {
      showToast('Login challenge expired. Sign in again.', 'error');
      resetAuthCodeFlow();
      return;
    }
    try {
      const verified = await api('/api/auth/login/verify-code', {
        method: 'POST',
        body: JSON.stringify({
          challengeToken: state.authLoginChallengeToken,
          code
        })
      });
      state.currentUser = verified.user || null;
      state.currentBusiness = verified.business || null;
      saveAuthSnapshot(state.currentUser, state.currentBusiness);
      state.authShellDismissed = false;
      updateAccountUi();
      hideAuthShell();
      await loadTypes();
      await loadDashboard();
      await loadAppointmentsTable();
      await loadSettings();
      await flushOfflineMutationQueue();
      showToast('Signed in successfully.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('btn-auth-resend-code')?.addEventListener('click', async () => {
    if (!state.authLoginChallengeToken) {
      showToast('Login challenge expired. Sign in again.', 'error');
      resetAuthCodeFlow();
      return;
    }
    try {
      const result = await api('/api/auth/login/resend-code', {
        method: 'POST',
        body: JSON.stringify({ challengeToken: state.authLoginChallengeToken })
      });
      if (!result?.challengeToken) throw new Error('Could not resend login code.');
      state.authLoginChallengeToken = result.challengeToken;
      startAuthResendCooldown(30);
      const debugCode = result.loginCode ? ` (dev code: ${result.loginCode})` : '';
      showToast(`A new verification code was sent.${debugCode}`, 'success');
    } catch (error) {
      if (Number(error?.code) === 429) {
        const retryMatch = String(error.message || '').match(/(\d+)s/);
        const retrySeconds = retryMatch ? Number(retryMatch[1]) : 0;
        if (retrySeconds > 0) startAuthResendCooldown(retrySeconds);
      }
      showToast(error.message, 'error');
    }
  });

  document.getElementById('btn-auth-back-to-login')?.addEventListener('click', () => {
    const loginForm = document.getElementById('auth-login-form');
    resetAuthCodeFlow();
    if (loginForm) loginForm.classList.remove('hidden');
    document.getElementById('auth-password')?.focus();
  });

  document.getElementById('auth-signup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    const password = String(data.password || '');
    const passwordConfirm = String(data.passwordConfirm || '');

    const passwordCheck = validatePasswordStrength(password);
    if (!passwordCheck.ok) {
      showToast(passwordCheck.message, 'error');
      return;
    }

    if (password !== passwordConfirm) {
      showToast('Passwords do not match. Please verify and try again.', 'error');
      return;
    }

    const { passwordConfirm: _passwordConfirm, ...signupPayload } = data;

    try {
      const result = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify(signupPayload)
      });
      const debugToken = result.verificationToken ? ` (dev token: ${result.verificationToken})` : '';
      showToast(`Verification email sent. Open your inbox to activate account.${debugToken}`, 'success');
      setAuthTab('login');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  const handleAuthAction = async (e) => {
    if (e) e.preventDefault();
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebar-backdrop')?.classList.remove('visible');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    if (sidebarBackdrop) sidebarBackdrop.hidden = true;
    document.body.classList.remove('sidebar-open');
    document.getElementById('btn-mobile-menu')?.setAttribute('aria-expanded', 'false');
    if (!state.currentUser) {
      state.authShellDismissed = false;
      setAuthTab('login');
      showAuthShell(true);
      return;
    }
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (_error) {
      // ignore logout API errors and continue local sign-out UX
    }
    state.currentUser = null;
    state.currentBusiness = null;
    stopReminderNotificationPolling();
    saveAuthSnapshot(null, null);
    updateAccountUi();
    showAuthShell();
  };

  document.getElementById('btn-logout')?.addEventListener('click', handleAuthAction);
  document.getElementById('nav-logout-sidebar')?.addEventListener('click', handleAuthAction);
  document.getElementById('btn-logout-mobile')?.addEventListener('click', handleAuthAction);

  document.getElementById('btn-close-auth-shell')?.addEventListener('click', () => {
    hideAuthShell(true);
  });
}

async function configureDevLoginVisibility() {
  const devBtn = document.getElementById('btn-dev-login');
  const testNotificationBtn = document.getElementById('btn-test-browser-notification');
  if (devBtn) devBtn.classList.add('hidden');
  if (testNotificationBtn) testNotificationBtn.classList.add('hidden');
  if (!devBtn && !testNotificationBtn) return;
  try {
    const response = await fetch('/api/health', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json().catch(() => ({}));
    const showDevOnlyControls = Boolean(body.devLoginEnabled);
    if (devBtn) devBtn.classList.toggle('hidden', !showDevOnlyControls);
    if (testNotificationBtn) testNotificationBtn.classList.toggle('hidden', !showDevOnlyControls);
  } catch (_error) {
    if (devBtn) devBtn.classList.add('hidden');
    if (testNotificationBtn) testNotificationBtn.classList.add('hidden');
  }
}

function bindForms() {
  document.getElementById('appointment-form')?.addEventListener('submit', submitAppointment);
  document.getElementById('type-form')?.addEventListener('submit', submitType);
  document.getElementById('settings-form')?.addEventListener('submit', submitSettings);
  document.getElementById('client-form')?.addEventListener('submit', submitClient);
  document.getElementById('client-note-form')?.addEventListener('submit', submitClientNote);

  document.getElementById('btn-show-add-client')?.addEventListener('click', () => {
    showClientForm(null);
  });
  document.getElementById('btn-close-client-form')?.addEventListener('click', () => {
    closeClientForm();
  });
  
  document.getElementById('btn-cancel-type-edit')?.addEventListener('click', () => {
    resetTypeForm();
  });

  document.getElementById('btn-refresh-clients')?.addEventListener('click', () => {
    void loadClients().catch(swallowBackgroundAsyncError);
  });
  const queueClientSearch = () => {
    if (state.clientSearchTimer) clearTimeout(state.clientSearchTimer);
    state.clientSearchTimer = setTimeout(() => {
      void loadClients().catch(swallowBackgroundAsyncError);
    }, 220);
  };
  document.getElementById('clients-search')?.addEventListener('input', queueClientSearch);
  document.getElementById('clients-stage-filter')?.addEventListener('change', queueClientSearch);
  document.getElementById('btn-export-data')?.addEventListener('click', exportBusinessData);
  document.getElementById('btn-import-data')?.addEventListener('click', () => {
    document.getElementById('import-data-file')?.click();
  });
  document.getElementById('import-data-file')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input?.files?.[0];
    await importBusinessDataFromFile(file);
    if (input) input.value = '';
  });
  document.getElementById('btn-import-ai-data')?.addEventListener('click', () => {
    document.getElementById('import-ai-data-file')?.click();
  });
  document.getElementById('import-ai-data-file')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input?.files?.[0];
    await importAiAppointmentsFromFile(file);
    if (input) input.value = '';
  });
  document.getElementById('settings-calendar-show-client-names')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    state.calendarShowClientNames = checked;
    setStoredValue('calendarShowClientNames', checked);
    await refreshCalendarDots();
  });

  document.getElementById('settings-mobile-nav-bottom-tabs')?.addEventListener('change', (e) => {
    const nextMode = applyMobileNavMode(e.currentTarget?.checked ? 'bottom' : 'sidebar');
    showToast(nextMode === 'bottom' ? 'Bottom tabs enabled on mobile' : 'Sidebar menu enabled on mobile', 'success');
  });

  document.getElementById('settings-browser-notifications')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    if (!canUseBrowserNotifications()) {
      showToast('Browser notifications are not supported in this browser.', 'error');
      e.currentTarget.checked = false;
      return;
    }

    if (checked) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        state.browserNotificationsEnabled = false;
        setStoredValue(BROWSER_NOTIFICATIONS_KEY, false);
        e.currentTarget.checked = false;
        showToast('Browser notification permission was not granted.', 'info');
        stopReminderNotificationPolling();
        return;
      }
    }

    state.browserNotificationsEnabled = checked;
    setStoredValue(BROWSER_NOTIFICATIONS_KEY, checked);
    if (checked) {
      startReminderNotificationPolling();
      showToast('Desktop reminder notifications enabled.', 'success');
    } else {
      stopReminderNotificationPolling();
      showToast('Desktop reminder notifications disabled.', 'success');
    }
  });

  document.getElementById('btn-test-browser-notification')?.addEventListener('click', async () => {
    if (!canUseBrowserNotifications()) {
      showToast('Browser notifications are not supported in this browser.', 'error');
      return;
    }

    let permission = getNotificationPermission();
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      showToast('Browser notification permission was not granted.', 'info');
      return;
    }

    const notification = new Notification('Test notification', {
      body: 'Desktop notifications are working for this app.',
      tag: 'test-browser-notification',
      renotify: true
    });
    notification.onclick = () => {
      try { window.focus(); } catch (_error) { }
      notification.close();
    };
    showToast('Test notification sent.', 'success');
  });

  BUSINESS_HOURS_DAYS.forEach((day) => {
    document.getElementById(`settings-hours-${day}-closed`)?.addEventListener('change', (e) => {
      setBusinessHoursRowClosedState(day, Boolean(e.currentTarget?.checked));
    });
  });

  document.querySelectorAll('[data-hours-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.hoursAction;
      const hours = collectBusinessHoursFromForm({ validate: false });
      if (action === 'copy-mon-weekdays') {
        const source = hours.mon || { closed: false, openTime: '09:00', closeTime: '18:00' };
        ['tue', 'wed', 'thu', 'fri'].forEach((day) => setBusinessHoursDayValues(day, source));
      } else if (action === 'set-weekend-closed') {
        setBusinessHoursDayValues('sat', { ...hours.sat, closed: true });
        setBusinessHoursDayValues('sun', { ...hours.sun, closed: true });
      } else if (action === 'reset-default') {
        BUSINESS_HOURS_DAYS.forEach((day) => setBusinessHoursDayValues(day, { closed: false, openTime: '09:00', closeTime: '18:00' }));
      }
    });
  });

  document.getElementById('settings-open-time')?.addEventListener('change', (e) => {
    const value = String(e.currentTarget?.value || '').slice(0, 5);
    if (!value) return;
    BUSINESS_HOURS_DAYS.forEach((day) => {
      const openInput = document.getElementById(`settings-hours-${day}-open`);
      if (openInput && !document.getElementById(`settings-hours-${day}-closed`)?.checked) {
        openInput.value = value;
      }
    });
  });

  document.getElementById('settings-close-time')?.addEventListener('change', (e) => {
    const value = String(e.currentTarget?.value || '').slice(0, 5);
    if (!value) return;
    BUSINESS_HOURS_DAYS.forEach((day) => {
      const closeInput = document.getElementById(`settings-hours-${day}-close`);
      if (closeInput && !document.getElementById(`settings-hours-${day}-closed`)?.checked) {
        closeInput.value = value;
      }
    });
  });

  // ── Settings: owner email notification toggle ─────────────────────────────
  document.getElementById('settings-notify-owner-email')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    try {
      const result = await queueAwareMutation('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ notifyOwnerEmail: checked })
      }, {
        allowOfflineQueue: true,
        description: 'Owner notification preference update'
      });
      if (result.queued) return;
      showToast(checked ? 'Owner booking notifications enabled' : 'Owner booking notifications disabled', 'success');
    } catch (error) {
      showToast(error.message, 'error');
      // Revert the toggle on error
      e.currentTarget.checked = !checked;
    }
  });

  document.getElementById('settings-reminder-mode')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    const previousMode = state.workspaceMode;
    const nextMode = checked ? 'reminders' : 'appointments';
    setWorkspaceMode(nextMode, { persist: true });
    try {
      const result = await queueAwareMutation('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ reminderMode: checked, workspaceMode: nextMode })
      }, {
        allowOfflineQueue: true,
        description: 'Reminder mode update'
      });
      if (!result.queued) {
        showToast(checked ? 'Reminder mode enabled' : 'Appointment mode enabled', 'success');
      }
      await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
      await refreshCalendarDots({ force: true });
    } catch (error) {
      setWorkspaceMode(previousMode, { persist: true });
      showToast(error.message, 'error');
    }
  });

  document.getElementById('settings-workspace-mode')?.addEventListener('change', async (e) => {
    const nextMode = normalizeWorkspaceMode(e.currentTarget?.value || 'appointments');
    const previousMode = state.workspaceMode;
    setWorkspaceMode(nextMode, { persist: true });
    try {
      const reminderEnabled = nextMode === 'reminders';
      const result = await queueAwareMutation('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ reminderMode: reminderEnabled, workspaceMode: nextMode })
      }, {
        allowOfflineQueue: true,
        description: 'Workspace mode update'
      });
      if (!result.queued) {
        showToast(
          nextMode === 'clients'
            ? 'Client mode enabled.'
            : (reminderEnabled ? 'Reminder mode enabled' : 'Appointment mode enabled'),
          'success'
        );
      }
      if (nextMode === 'clients') setActiveView('dashboard');
      await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
      await refreshCalendarDots({ force: true });
      if (nextMode === 'clients') await loadClients();
    } catch (error) {
      setWorkspaceMode(previousMode, { persist: true });
      showToast(error.message, 'error');
    }
  });

  // ── Settings: theme selector ──────────────────────────────────────────────
  // Handle clicks on the card labels directly so the theme applies
  // immediately — before the radio `change` event fires.
  document.querySelectorAll('.theme-option').forEach((option) => {
    option.addEventListener('click', async (e) => {
      const radio = option.querySelector('input[type="radio"]');
      if (!radio) return;
      const chosen = radio.value;
      if (chosen !== 'dark' && chosen !== 'light') return;

      // Apply theme immediately, in the same synchronous frame as the click
      document.documentElement.setAttribute('data-theme', chosen);
      localStorage.setItem('theme', chosen);
      syncSettingsThemeSelector();

      if (!state.currentUser) return;
      try {
        await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: chosen }) });
      } catch (_error) {
        // Local preference already applied; server update is best-effort.
      }
    });
  });

  // ── Settings: accent color selector ───────────────────────────────────────
  document.querySelectorAll('.accent-option').forEach((option) => {
    option.addEventListener('click', async () => {
      const radio = option.querySelector('input[type="radio"]');
      if (!radio) return;
      const chosenColor = normalizeAccentColor(radio.value);
      applyAccentColor(chosenColor);

      localStorage.setItem('accentColor', chosenColor);
      syncSettingsThemeSelector();

      if (!state.currentUser) return;
      try {
        await api('/api/settings', { method: 'PUT', body: JSON.stringify({ accentColor: chosenColor }) });
      } catch (_error) {
        // Local preference already applied; server update is best-effort.
      }
    });
  });

  // ── Settings: filtered export ─────────────────────────────────────────────
  document.getElementById('btn-export-filtered')?.addEventListener('click', () => {
    void runFilteredExport();
  });

  // Live summary updates
  ['export-date-from', 'export-date-to', 'export-status-filter'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', updateExportSummary);
  });

  // Format toggle buttons
  document.querySelectorAll('.format-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.format-toggle-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateExportSummary();
    });
  });

  // Select all / none type chips
  document.getElementById('export-types-select-all')?.addEventListener('click', () => {
    const grid = document.getElementById('export-types-grid');
    if (!grid) return;
    grid.querySelectorAll('.export-type-chip').forEach((chip) => {
      const cb = chip.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = true;
      chip.classList.add('selected');
    });
    updateExportSummary();
  });

  document.getElementById('export-types-select-none')?.addEventListener('click', () => {
    const grid = document.getElementById('export-types-grid');
    if (!grid) return;
    grid.querySelectorAll('.export-type-chip').forEach((chip) => {
      const cb = chip.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = false;
      chip.classList.remove('selected');
    });
    updateExportSummary();
  });

  bindAppointmentFormEnhancements();
  updateAppointmentEditorUi(false);

  const search = document.getElementById('global-search');
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const query = search.value.trim();
      renderGlobalSearchSuggestions(query);

      if (query && !state.searchActive) {
        state.searchOriginView = getActiveView();
        state.searchActive = true;
      }

      timer = setTimeout(async () => {
        if (!query) {
          await clearSearchAndRestoreView(search);
          return;
        }
        await runSearch(query);
      }, 250);
    });

    search.addEventListener('blur', async () => {
      window.setTimeout(() => hideGlobalSearchSuggestions(), 120);
      if (!state.searchActive) return;
      const query = String(search.value || '').trim();
      if (query) return;
      await clearSearchAndRestoreView(search);
    });

    search.addEventListener('keydown', async (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      hideGlobalSearchSuggestions();
      await clearSearchAndRestoreView(search);
      search.blur();
    });

    document.addEventListener('click', (e) => {
      if (search.closest('.header-search')?.contains(e.target)) return;
      hideGlobalSearchSuggestions();
    });
  }
}

function applyCollapseState(button, target, collapsed) {
  if (!button || !target) return;
  const shouldCollapse = Boolean(collapsed);
  button.classList.toggle('is-collapsed', shouldCollapse);
  button.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');

  if (target.classList.contains('settings-section')) {
    target.classList.toggle('is-collapsed', shouldCollapse);
    return;
  }

  if (shouldCollapse) {
    target.hidden = true;
    target.classList.add('hidden');
    target.classList.add('is-collapsed');
  } else {
    target.hidden = false;
    target.classList.remove('hidden');
    target.classList.remove('is-collapsed');
  }

  const parentCard = button.closest('.card');
  if (parentCard) {
    parentCard.classList.toggle('is-collapsed', shouldCollapse);
  }
}

function bindCollapsiblePanels() {
  document.querySelectorAll('.collapse-toggle-btn[data-collapse-target]').forEach((button) => {
    const targetSelector = String(button.dataset.collapseTarget || '').trim();
    if (!targetSelector) return;
    const target = document.querySelector(targetSelector);
    if (!target) return;

    const storageKey = String(button.dataset.collapseStorage || '').trim();
    let collapsed = false;
    if (storageKey) {
      collapsed = getStoredBoolean(`panelCollapsed.${storageKey}`, false);
    }
    applyCollapseState(button, target, collapsed);
  });
}

function handleCollapseToggleClick(event) {
  const button = event.target?.closest?.('.collapse-toggle-btn[data-collapse-target]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  const targetSelector = String(button.dataset.collapseTarget || '').trim();
  if (!targetSelector) return;
  const target = document.querySelector(targetSelector);
  if (!target) return;

  const nextCollapsed = button.getAttribute('aria-expanded') === 'true';
  applyCollapseState(button, target, nextCollapsed);

  const storageKey = String(button.dataset.collapseStorage || '').trim();
  if (storageKey) setStoredValue(`panelCollapsed.${storageKey}`, nextCollapsed);
}

function applyInitialTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initial);

  applyAccentColor(localStorage.getItem('accentColor'));
}

async function init() {
  bindGlobalAsyncErrorGuards();
  await registerServiceWorker();
  bindNetworkState();
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    void flushOfflineMutationQueue().catch(swallowBackgroundAsyncError);
  }
  const preferredView = getStoredViewPreference();
  state.calendarViewMode = getStoredCalendarViewMode();
  state.workspaceMode = getStoredWorkspaceMode(state.reminderMode ? 'reminders' : 'appointments');
  state.reminderMode = state.workspaceMode === 'reminders';
  const selectedDate = parseYmd(state.selectedDate);
  if (selectedDate) state.calendarDate = selectedDate;
  bindAuthUi();
  await configureDevLoginVisibility();
  bindNavigation();
  applyMobileNavMode(getStoredMobileNavMode(), { persist: false });
  applyInitialViewPreference(preferredView);
  bindHeaderButtons();
  bindDashboardStatsToggle();
  bindModalControls();
  bindCalendarNav();
  bindKeyboard();
  bindForms();
  bindCollapsiblePanels();
  document.addEventListener('click', handleCollapseToggleClick);
  applyInitialTheme();
  applyReminderModeUi();
  setupTimezoneSearch();
  setupTimezoneSearch('signup-timezone', 'signup-timezone-suggestions');

  const todayInput = document.querySelector('input[name="date"]');
  if (todayInput) todayInput.value = state.selectedDate;

  document.addEventListener('click', (event) => {
    const dayMenu = document.getElementById('calendar-day-menu');
    if (dayMenu && !dayMenu.classList.contains('hidden')) {
      const clickedInMenu = event.target.closest('#calendar-day-menu');
      const clickedOnDay = event.target.closest('.day-cell[data-day]');
      const clickedOnWeekHeader = event.target.closest('.week-day-header[data-week-date]');
      if (!clickedInMenu && !clickedOnDay && !clickedOnWeekHeader) closeDayMenu();
    }

    const quickCreateMenu = document.getElementById('calendar-quick-create-menu');
    if (quickCreateMenu && !quickCreateMenu.classList.contains('hidden')) {
      const clickedInQuickCreate = event.target.closest('#calendar-quick-create-menu');
      const clickedOnSlot = event.target.closest('.week-slot[data-slot-date][data-slot-time]');
      if (!clickedInQuickCreate && !clickedOnSlot) closeQuickCreateMenu();
    }

    const notificationsMenu = document.getElementById('notifications-menu');
    if (notificationsMenu && !notificationsMenu.classList.contains('hidden')) {
      const clickedInNotifications = event.target.closest('#notifications-menu');
      const clickedNotificationButton = event.target.closest('[data-notification-button]');
      if (!clickedInNotifications && !clickedNotificationButton) closeNotificationsMenu();
    }
  });

  window.addEventListener('resize', repositionDayMenuIfOpen);
  window.addEventListener('resize', repositionQuickCreateMenuIfOpen);
  window.addEventListener('resize', repositionNotificationsMenuIfOpen);
  window.addEventListener('scroll', repositionDayMenuIfOpen, true);
  window.addEventListener('scroll', repositionNotificationsMenuIfOpen, true);

  try {
    const authed = await ensureAuth();
    if (!authed) {
      state.apiOnline = true;
      return;
    }
    await loadTypes();
    await loadDashboard();
    await loadAppointmentsTable();
    await loadSettings();
    await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
    await refreshCalendarDots({ force: true });
    await flushOfflineMutationQueue();
    state.apiOnline = true;

    if (preferredView) setActiveView(preferredView);
  } catch (error) {
    if (error?.code === 'OFFLINE') {
      state.apiOnline = false;
      showToast(`You are offline. Reconnect to load the latest ${getEntryWordPlural()} data.`, 'info');
      return;
    }
    if (error?.code === 'NETWORK') {
      state.apiOnline = false;
      showToast('Backend API is unreachable. Start server with: npm run dev', 'error');
      console.error(error);
      return;
    }
    if (error?.code === 401) {
      showAuthShell();
      return;
    }
    state.apiOnline = false;
    showToast('Backend API not running. Start with: npm install && npm run dev', 'error');
    console.error(error);
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.openModal = openModal;
  window.closeModal = closeModal;
  document.addEventListener('DOMContentLoaded', init);
}

if (typeof module !== 'undefined') {
  module.exports = {
    toTime12,
    escapeHtml,
    monthLabel,
    setActiveView,
    state,
    csvEscape,
    buildCsvLines,
    filterAppointmentsForExport,
    buildFilteredExportFilename,
    buildFilteredExportJsonPayload,
    EXPORT_CSV_COLUMNS,
    EXPORT_CSV_HEADERS,
    OFFLINE_MUTATION_QUEUE_KEY,
    loadOfflineMutationQueue,
    saveOfflineMutationQueue,
    enqueueOfflineMutation,
    queueAwareMutation,
    flushOfflineMutationQueue
  };
}
