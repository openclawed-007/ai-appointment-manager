const state = {
  types: [],
  selectedTypeId: null,
  selectedDate: new Date().toISOString().slice(0, 10),
  apiOnline: true
};

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove('active');
  document.body.style.overflow = '';
}

function toMoney(cents = 0) {
  return cents > 0 ? `$${(cents / 100).toFixed(0)}` : 'Free';
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || 'Request failed');
  }
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
  }, 2600);
}

function bindStaticEvents() {
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

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
    });
  });

  const search = document.getElementById('global-search');
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => runSearch(search.value.trim()), 260);
    });
  }

  document.querySelectorAll('.day-cell:not(.empty)').forEach((dayCell) => {
    dayCell.addEventListener('click', async () => {
      document.querySelectorAll('.day-cell.selected').forEach((n) => n.classList.remove('selected'));
      dayCell.classList.add('selected');

      const day = Number(dayCell.textContent.trim());
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      state.selectedDate = `${yyyy}-${mm}-${dd}`;
      await loadDashboard();
    });
  });

  document.getElementById('appointment-form')?.addEventListener('submit', submitAppointment);
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
        <span>${escapeHtml(t.name)}</span>
      </div>
    `
    )
    .join('');

  root.querySelectorAll('.type-option').forEach((node) => {
    node.addEventListener('click', () => {
      root.querySelectorAll('.type-option').forEach((n) => n.classList.remove('active'));
      node.classList.add('active');
      state.selectedTypeId = Number(node.dataset.typeId);

      const selected = state.types.find((t) => t.id === state.selectedTypeId);
      const durationSelect = document.querySelector('select[name="durationMinutes"]');
      if (selected && durationSelect) {
        const exists = Array.from(durationSelect.options).some(
          (o) => Number(o.value) === Number(selected.durationMinutes)
        );
        if (!exists) {
          const option = document.createElement('option');
          option.value = String(selected.durationMinutes);
          option.textContent = `${selected.durationMinutes} minutes`;
          durationSelect.appendChild(option);
        }
        durationSelect.value = String(selected.durationMinutes);
      }
    });
  });
}

function renderStats(stats = {}) {
  document.getElementById('stat-today').textContent = stats.today ?? 0;
  document.getElementById('stat-week').textContent = stats.week ?? 0;
  document.getElementById('stat-pending').textContent = stats.pending ?? 0;
  document.getElementById('stat-ai').textContent = stats.aiOptimized ?? 0;
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
      </div>
    `
    )
    .join('');
}

function renderTypes(types = []) {
  const root = document.getElementById('type-list');
  if (!root) return;

  if (!types.length) {
    root.innerHTML = '<div class="empty-state">No appointment types yet.</div>';
    return;
  }

  root.innerHTML = types
    .map(
      (t) => `
      <div class="type-item">
        <div class="type-color" style="background:${escapeHtml(t.color)}"></div>
        <div class="type-info">
          <h4>${escapeHtml(t.name)}</h4>
          <p>${t.durationMinutes} min • ${toMoney(t.priceCents)} • ${escapeHtml(t.locationMode)}</p>
        </div>
        <span class="type-count">${t.bookingCount || 0}</span>
      </div>
    `
    )
    .join('');
}

function renderInsights(insights = []) {
  const root = document.getElementById('insights-list');
  if (!root) return;

  if (!insights.length) {
    root.innerHTML = '<div class="empty-state">AI insights will appear as bookings are created.</div>';
    return;
  }

  root.innerHTML = insights
    .map(
      (i) => `
      <div class="insight-item">
        <div class="insight-icon">${escapeHtml(i.icon || '💡')}</div>
        <div class="insight-content">
          <p>${escapeHtml(i.text)}</p>
          <span class="insight-time">${escapeHtml(i.time || 'Live')}</span>
        </div>
      </div>
    `
    )
    .join('');
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
}

async function submitAppointment(e) {
  e.preventDefault();

  const form = e.currentTarget;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  payload.typeId = state.selectedTypeId;
  payload.durationMinutes = Number(payload.durationMinutes || 45);

  const submitButton = form.querySelector('button[type="submit"]');
  const oldText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Creating...';

  try {
    await api('/api/appointments', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    form.reset();
    closeModal('new-appointment');
    await loadDashboard();
    showToast('Appointment created and notifications sent.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = oldText;
  }
}

async function runSearch(query) {
  if (!query) {
    await loadDashboard();
    return;
  }

  try {
    const { appointments } = await api(`/api/appointments?q=${encodeURIComponent(query)}`);
    renderTimeline(appointments.slice(0, 20));
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function init() {
  bindStaticEvents();

  const todayInput = document.querySelector('input[name="date"]');
  if (todayInput) todayInput.value = state.selectedDate;

  try {
    await loadTypes();
    await loadDashboard();
    state.apiOnline = true;
  } catch (error) {
    state.apiOnline = false;
    showToast('Backend API not running. Start with: npm install && npm run dev', 'error');
    console.error(error);
  }
}

window.openModal = openModal;
window.closeModal = closeModal;

document.addEventListener('DOMContentLoaded', init);
