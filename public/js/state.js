'use strict';

(() => {

function getStoredBoolean(key, fallback = false) {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    return localStorage.getItem(key) === 'true';
  } catch (_error) {
    return fallback;
  }
}

function createAppStateCore() {
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

  return {
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
    BROWSER_NOTIFICATIONS_KEY,
    REMINDER_NOTIFIED_KEYS_STORAGE,
    BUSINESS_HOURS_DAYS,
    GLOBAL_SEARCH_SETTINGS_OPTIONS
  };
}

const appStateCore = createAppStateCore();

if (typeof window !== 'undefined') {
  window.AppStateCore = appStateCore;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = appStateCore;
}
})();
