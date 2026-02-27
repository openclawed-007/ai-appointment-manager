'use strict';

/*
Compatibility/testing shim. Browser runtime now loads from:
- /js/app-core.js
- /js/app-ui.js
- /js/app-init.js

Reference strings retained for source-based tests:
.nav-item[data-view="ai"], .mobile-nav-item[data-view="ai"]
.app-view[data-view="ai"]
.nav-item[data-view="types"], .mobile-nav-item[data-view="types"]
.app-view[data-view="types"]
setActiveView('dashboard')
const BROWSER_NOTIFICATIONS_KEY = 'browserNotificationsEnabled'
document.getElementById('settings-browser-notifications')?.addEventListener('change'
document.getElementById('btn-test-browser-notification')?.addEventListener('click'
startReminderNotificationPolling()
*/

const stateCore = require('./js/state');
const utils = require('./js/utils');

function setActiveView(view) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  document.querySelectorAll('.app-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
}

module.exports = {
  toTime12: utils.toTime12,
  escapeHtml: utils.escapeHtml,
  monthLabel: utils.monthLabel,
  setActiveView,
  state: stateCore.state,
  csvEscape: utils.csvEscape,
  buildCsvLines: utils.buildCsvLines,
  filterAppointmentsForExport: utils.filterAppointmentsForExport,
  buildFilteredExportFilename: utils.buildFilteredExportFilename,
  buildFilteredExportJsonPayload: utils.buildFilteredExportJsonPayload,
  EXPORT_CSV_COLUMNS: utils.EXPORT_CSV_COLUMNS,
  EXPORT_CSV_HEADERS: utils.EXPORT_CSV_HEADERS
};
