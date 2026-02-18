const state = {
  types: [],
  selectedTypeId: null,
  selectedDate: new Date().toISOString().slice(0, 10),
  apiOnline: true,
  viewAll: false,
  calendarDate: new Date()
};

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (modalId === 'new-appointment') setAppointmentDefaults();
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove('active');
  document.body.style.overflow = '';
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

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function monthLabel(date) {
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
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

function setActiveView(view) {
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === view);
  });

  document.querySelectorAll('.mobile-nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === view);
  });

  document.querySelectorAll('.app-view').forEach((section) => {
    section.classList.toggle('active', section.dataset.view === view);
  });
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
    item.addEventListener('click', () => {
      const targetView = item.dataset.view || 'dashboard';
      setActiveView(targetView);
    });
  });

  document.getElementById('btn-manage-types')?.addEventListener('click', () => setActiveView('types'));
}

function bindHeaderButtons() {
  document.getElementById('btn-notifications')?.addEventListener('click', () => {
    showToast('No new notifications right now.', 'info');
  });

  document.getElementById('btn-view-all')?.addEventListener('click', async (e) => {
    state.viewAll = !state.viewAll;
    e.currentTarget.textContent = state.viewAll ? 'Show Day' : 'View All';
    await loadAppointmentsTable();
  });

  document.getElementById('btn-refresh-appointments')?.addEventListener('click', loadAppointmentsTable);
}

function renderCalendarGrid() {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;

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

    return `<div class="${classes.join(' ')}" data-day="${day}">${day}</div>`;
  }).join('');

  grid.innerHTML = `${headers}${empties}${days}`;
}

function bindCalendarNav() {
  const labelNode = document.querySelector('.current-month');
  const setMonth = () => {
    if (labelNode) labelNode.textContent = monthLabel(state.calendarDate);
    renderCalendarGrid();
  };
  setMonth();

  document.getElementById('calendar-prev')?.addEventListener('click', async () => {
    state.calendarDate.setMonth(state.calendarDate.getMonth() - 1);
    setMonth();
    await refreshCalendarDots();
    showToast(`Showing ${monthLabel(state.calendarDate)}`, 'info');
  });

  document.getElementById('calendar-next')?.addEventListener('click', async () => {
    state.calendarDate.setMonth(state.calendarDate.getMonth() + 1);
    setMonth();
    await refreshCalendarDots();
    showToast(`Showing ${monthLabel(state.calendarDate)}`, 'info');
  });

  document.getElementById('calendar-grid')?.addEventListener('click', async (event) => {
    const dayCell = event.target.closest('.day-cell[data-day]');
    if (!dayCell) return;

    const day = Number(dayCell.dataset.day);
    const yyyy = state.calendarDate.getFullYear();
    const mm = String(state.calendarDate.getMonth() + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    state.selectedDate = `${yyyy}-${mm}-${dd}`;

    state.viewAll = false;
    const btn = document.getElementById('btn-view-all');
    if (btn) btn.textContent = 'View All';

    renderCalendarGrid();
    await loadDashboard();
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.active').forEach((modal) => modal.classList.remove('active'));
      document.body.style.overflow = '';
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

function setupTimezoneSearch() {
  const input = document.getElementById('timezone-input');
  const suggestions = document.getElementById('timezone-suggestions');
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
      updateAppointmentPreview();
    });
  });

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

  typeNode.textContent = selectedType
    ? `${selectedType.name} • ${durationSelect?.value || selectedType.durationMinutes} min`
    : 'Pick a service type';

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

function setAppointmentDefaults() {
  const form = document.getElementById('appointment-form');
  if (!form) return;

  const dateInput = form.querySelector('input[name="date"]');
  const timeInput = form.querySelector('input[name="time"]');

  if (dateInput && !dateInput.value) {
    dateInput.value = state.selectedDate || new Date().toISOString().slice(0, 10);
  }

  if (timeInput && !timeInput.value) {
    const dt = roundToNextQuarterHour(new Date(Date.now() + 60 * 60 * 1000));
    timeInput.value = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }

  updateAppointmentPreview();
}

function bindAppointmentFormEnhancements() {
  const form = document.getElementById('appointment-form');
  if (!form) return;

  const dateInput = form.querySelector('input[name="date"]');
  const timeInput = form.querySelector('input[name="time"]');
  const durationSelect = form.querySelector('select[name="durationMinutes"]');

  [dateInput, timeInput, durationSelect].forEach((el) => {
    el?.addEventListener('input', updateAppointmentPreview);
    el?.addEventListener('change', updateAppointmentPreview);
  });

  form.querySelectorAll('.quick-pill[data-quick-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const now = new Date();
      if (btn.dataset.quickDate === 'tomorrow') now.setDate(now.getDate() + 1);
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      if (dateInput) dateInput.value = `${yyyy}-${mm}-${dd}`;
      updateAppointmentPreview();
    });
  });

  form.querySelectorAll('.quick-pill[data-quick-time]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.quickTime !== 'next-hour' || !timeInput) return;
      const dt = roundToNextQuarterHour(new Date(Date.now() + 60 * 60 * 1000));
      timeInput.value = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      updateAppointmentPreview();
    });
  });

  setAppointmentDefaults();
}

function renderStats(stats = {}) {
  document.getElementById('stat-today').textContent = stats.today ?? 0;
  document.getElementById('stat-week').textContent = stats.week ?? 0;
  document.getElementById('stat-pending').textContent = stats.pending ?? 0;
  document.getElementById('stat-ai').textContent = stats.aiOptimized ?? 0;

  const dot = document.getElementById('notification-dot');
  if (dot) dot.classList.toggle('hidden', Number(stats.pending || 0) <= 0);
}

async function refreshCalendarDots() {
  const { appointments } = await api('/api/appointments');
  const yyyy = state.calendarDate.getFullYear();
  const mm = String(state.calendarDate.getMonth() + 1).padStart(2, '0');

  const daysWithAppointments = new Set(
    appointments
      .filter((a) => typeof a.date === 'string' && a.date.startsWith(`${yyyy}-${mm}-`))
      .map((a) => Number(a.date.slice(8, 10)))
  );

  document.querySelectorAll('.day-cell:not(.empty)').forEach((cell) => {
    const day = Number(cell.textContent.trim());
    cell.classList.toggle('has-event', daysWithAppointments.has(day));
  });
}

function renderTimeline(appointments = []) {
  const root = document.getElementById('timeline-list');
  if (!root) return;
  if (!appointments.length) {
    root.innerHTML = '<div class="empty-state">No appointments for this day yet.</div>';
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => `
      <div class="timeline-item">
        <div class="time">${toTime12(a.time)}</div>
        <div class="appointment-card ${escapeHtml(a.typeClass)}">
          <div class="appointment-type">${escapeHtml(a.typeName)}</div>
          <h3>${escapeHtml(a.title || a.typeName)}</h3>
          <p>${escapeHtml(a.clientName)}</p>
          <div class="appointment-meta">
            <span>📍 ${escapeHtml(a.location)}</span>
            <span>⏱ ${a.durationMinutes} min</span>
            <span>• ${escapeHtml(a.status)}</span>
          </div>
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
                <p>${t.durationMinutes} min • ${toMoney(t.priceCents)} • ${escapeHtml(t.locationMode)}</p>
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
            <div class="data-row" data-type-id="${t.id}">
              <div>
                <strong>${escapeHtml(t.name)}</strong>
                <div class="pill">${t.durationMinutes} min • ${toMoney(t.priceCents)}</div>
              </div>
              <div>${escapeHtml(t.locationMode)}</div>
              <div>${t.bookingCount || 0} bookings</div>
              <div><span class="pill">Active</span></div>
              <div class="row-actions">
                <button class="btn-secondary btn-delete-type" type="button">Delete</button>
              </div>
            </div>`
          )
          .join('');

  if (root) root.innerHTML = html;
  if (adminRoot) {
    adminRoot.innerHTML = adminHtml;

    adminRoot.querySelectorAll('.btn-delete-type').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const typeId = btn.closest('.data-row')?.dataset.typeId;
        if (!typeId) return;

        const ok = window.confirm('Delete this appointment type? Existing bookings remain, but this type will no longer be selectable.');
        if (!ok) return;

        try {
          await api(`/api/types/${typeId}`, { method: 'DELETE' });
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
  if (!appointments.length) {
    root.innerHTML = '<div class="empty-state">No appointments found.</div>';
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => `
      <div class="data-row" data-id="${a.id}">
        <div><strong>${escapeHtml(a.clientName)}</strong><div class="pill">${escapeHtml(a.typeName)}</div></div>
        <div>${escapeHtml(a.date)}</div>
        <div>${toTime12(a.time)}</div>
        <div><span class="pill">${escapeHtml(a.status)}</span></div>
        <div class="row-actions">
          <button class="btn-secondary btn-complete" type="button">Complete</button>
          <button class="btn-secondary btn-delete" type="button">Delete</button>
        </div>
      </div>`
    )
    .join('');

  root.querySelectorAll('.btn-complete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.data-row')?.dataset.id;
      await api(`/api/appointments/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' })
      });
      showToast('Appointment marked completed', 'success');
      await loadAppointmentsTable();
      await loadDashboard();
    });
  });

  root.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.data-row')?.dataset.id;
      await api(`/api/appointments/${id}`, { method: 'DELETE' });
      showToast('Appointment deleted', 'success');
      await loadAppointmentsTable();
      await loadDashboard();
    });
  });
}

async function loadTypes() {
  const { types } = await api('/api/types');
  state.types = types;
  renderTypeSelector(types);
}

async function loadDashboard() {
  const { stats, appointments, types, insights } = await api(
    `/api/dashboard?date=${encodeURIComponent(state.selectedDate)}`
  );
  renderStats(stats);
  renderTimeline(appointments);
  renderTypes(types);
  renderInsights(insights);
  await refreshCalendarDots();
}

async function loadAppointmentsTable() {
  const query = state.viewAll ? '' : `?date=${encodeURIComponent(state.selectedDate)}`;
  const { appointments } = await api(`/api/appointments${query}`);
  renderAppointmentsTable(appointments);
}

async function submitAppointment(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.typeId = state.selectedTypeId;
  payload.durationMinutes = Number(payload.durationMinutes || 45);

  const submitButton = form.querySelector('button[type="submit"]');
  const oldText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Creating...';

  try {
    await api('/api/appointments', { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    setAppointmentDefaults();
    closeModal('new-appointment');
    await loadDashboard();
    await loadAppointmentsTable();
    showToast('Appointment created and notifications sent.', 'success');
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
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api('/api/types', {
      method: 'POST',
      body: JSON.stringify({
        name: data.name,
        durationMinutes: Number(data.durationMinutes || 30),
        priceCents: Number(data.priceGbp ?? data.priceUsd ?? 0) * 100,
        locationMode: data.locationMode
      })
    });
    form.reset();
    showToast('Type created', 'success');
    await loadTypes();
    await loadDashboard();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function submitSettings(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) });
    showToast('Settings saved', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function loadSettings() {
  const { settings } = await api('/api/settings');
  const form = document.getElementById('settings-form');
  if (!form) return;
  form.businessName.value = settings.business_name || '';
  form.ownerEmail.value = settings.owner_email || '';
  form.timezone.value = settings.timezone || 'America/Los_Angeles';
}

async function runSearch(query) {
  if (!query) {
    await loadAppointmentsTable();
    return;
  }
  const { appointments } = await api(`/api/appointments?q=${encodeURIComponent(query)}`);
  renderAppointmentsTable(appointments);
  setActiveView('appointments');
}

function bindForms() {
  document.getElementById('appointment-form')?.addEventListener('submit', submitAppointment);
  document.getElementById('type-form')?.addEventListener('submit', submitType);
  document.getElementById('settings-form')?.addEventListener('submit', submitSettings);
  bindAppointmentFormEnhancements();

  const search = document.getElementById('global-search');
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => runSearch(search.value.trim()), 250);
    });
  }
}

async function init() {
  bindNavigation();
  bindHeaderButtons();
  bindCalendarNav();
  bindKeyboard();
  bindForms();
  setupTimezoneSearch();

  const todayInput = document.querySelector('input[name="date"]');
  if (todayInput) todayInput.value = state.selectedDate;

  try {
    await loadTypes();
    await loadDashboard();
    await loadAppointmentsTable();
    await loadSettings();
    state.apiOnline = true;
  } catch (error) {
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
    state
  };
}
