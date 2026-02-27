'use strict';

(() => {

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

function toTime12(time24 = '09:00') {
  const [h, m] = String(time24).split(':').map(Number);
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hh = ((hour + 11) % 12) + 1;
  return `${hh}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function toTimeCompact(time24 = '09:00') {
  const [h, m] = String(time24).split(':').map(Number);
  const hh = Number.isFinite(h) ? String(h).padStart(2, '0') : '09';
  const mm = Number.isFinite(m) ? String(m).padStart(2, '0') : '00';
  return `${hh}:${mm}`;
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

const appUtils = {
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
};

if (typeof window !== 'undefined') {
  window.AppUtils = appUtils;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = appUtils;
}
})();
