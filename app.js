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
  editingAppointmentId: null,
  searchOriginView: null,
  searchActive: false,
  emailMenuAppointmentId: null,
  cancelMenuAppointmentId: null,
  cancelMenuDate: '',
  currentUser: null,
  currentBusiness: null,
  authShellDismissed: false
};

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
  if (title) title.textContent = isEditing ? 'Edit Appointment' : 'Create Appointment';
  if (subtitle) {
    subtitle.textContent = isEditing
      ? 'Update details for this booking.'
      : 'Add client details, lock a slot, and send confirmation.';
  }
  if (submit) submit.textContent = isEditing ? 'Save Changes' : 'Create Appointment';
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
  if (appointment.notes != null) form.notes.value = appointment.notes;
  const locationRadio = form.querySelector(`input[name="location"][value="${appointment.location || 'office'}"]`);
  if (locationRadio) locationRadio.checked = true;
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

function localYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
      <h3>Cancel Appointment</h3>
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
        <input name="emailSubject" type="text" placeholder="Message about your appointment" />
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
  let left = rect.left;
  let top = rect.bottom + 8;

  if (left + menuRect.width > vw - margin) left = vw - menuRect.width - margin;
  if (left < margin) left = margin;

  if (top + menuRect.height > vh - margin) top = rect.top - menuRect.height - 8;
  if (top < margin) top = margin;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

async function openDayMenu(anchorEl, date) {
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
            <div class="day-menu-item-actions-wrap">
              <button type="button" class="day-menu-show-actions" data-appointment-id="${a.id}" aria-expanded="false">Show actions</button>
              <div class="day-menu-item-actions hidden" data-actions-for="${a.id}">
                ${a.clientEmail
            ? `<button type="button" class="day-menu-email" data-appointment-id="${a.id}" aria-label="Email appointment details">Email</button>`
            : ''
          }
                <button type="button" class="day-menu-edit" data-appointment-id="${a.id}" aria-label="Edit appointment">Edit</button>
                <button type="button" class="day-menu-cancel" data-appointment-id="${a.id}" ${a.status === 'cancelled' ? 'disabled' : ''} aria-label="Cancel appointment">${a.status === 'cancelled' ? 'Cancelled' : 'Cancel'}</button>
                <button type="button" class="day-menu-delete" data-appointment-id="${a.id}" aria-label="Delete appointment">Delete</button>
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
        <button type="button" class="btn-primary day-menu-add">Add Appointment</button>
      </div>
      <div class="day-menu-list">
        ${items || '<div class="day-menu-empty">No appointments for this day.</div>'}
      </div>
    `;

    positionDayMenu(anchorEl, menu);

    menu.querySelector('.day-menu-close')?.addEventListener('click', closeDayMenu);
    menu.querySelector('.day-menu-add')?.addEventListener('click', () => {
      state.editingAppointmentId = null;
      updateAppointmentEditorUi(false);
      closeDayMenu();
      openModal('new-appointment');
      const form = document.getElementById('appointment-form');
      const dateInput = form?.querySelector('input[name="date"]');
      if (dateInput) dateInput.value = date;
      updateAppointmentPreview();
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
          await api(`/api/appointments/${id}`, { method: 'DELETE' });
          await loadDashboard();
          await loadAppointmentsTable();
          await refreshCalendarDots();
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
  } catch (error) {
    menu.innerHTML = `
      <div class="day-menu-header">
        <h3>${escapeHtml(formatMenuDate(date))}</h3>
        <button type="button" class="day-menu-close" aria-label="Close day menu">×</button>
      </div>
      <div class="day-menu-empty">Could not load this day. Try again.</div>
    `;
    menu.querySelector('.day-menu-close')?.addEventListener('click', closeDayMenu);
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

function toMoney(cents = 0) {
  return cents > 0 ? `£${(cents / 100).toFixed(0)}` : 'Free';
}

function toTime12(time24 = '09:00') {
  const [h, m] = time24.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, '0')} ${suffix}`;
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
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const error = new Error(body.error || 'Authentication required.');
    error.code = 401;
    throw error;
  }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
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

async function cancelAppointmentById(appointmentId, date = '', cancellationReason = '') {
  if (!appointmentId) return;
  try {
    const payload = { status: 'cancelled' };
    const cleanReason = String(cancellationReason || '').trim();
    if (cleanReason) payload.cancellationReason = cleanReason;
    await api(`/api/appointments/${appointmentId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    showToast('Appointment cancelled.', 'success');
    await loadDashboard();
    await loadAppointmentsTable();
    await refreshCalendarDots();
    if (date && state.dayMenuDate === date) {
      const selectedCell = document.querySelector(`.day-cell[data-day="${Number(date.slice(8, 10))}"]`);
      if (selectedCell) await openDayMenu(selectedCell, date);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
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

  const canAutoLoadAppointments =
    typeof window !== 'undefined' && /^https?:$/i.test(window.location?.protocol || '');
  if (view === 'appointments' && canAutoLoadAppointments) void loadAppointmentsTable();
}

function getActiveView() {
  return document.querySelector('.app-view.active')?.dataset.view || 'dashboard';
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
  document.getElementById('btn-new-appointment')?.addEventListener('click', () => {
    state.editingAppointmentId = null;
    updateAppointmentEditorUi(false);
    openModal('new-appointment');
  });
  document.querySelectorAll('[data-notification-button]').forEach((button) => {
    button.addEventListener('click', () => {
      showToast('No new notifications right now.', 'info');
    });
  });

  document.getElementById('btn-mobile-menu')?.addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
      sidebar.classList.toggle('mobile-open');
    }
  });

  document.addEventListener('click', (e) => {
    const sidebar = document.querySelector('.sidebar');
    const menuBtn = document.getElementById('btn-mobile-menu');
    if (sidebar?.classList.contains('mobile-open')) {
      if (!sidebar.contains(e.target) && !menuBtn?.contains(e.target)) {
        sidebar.classList.remove('mobile-open');
      }
    }
  });

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar?.classList.contains('mobile-open')) {
        sidebar.classList.remove('mobile-open');
      }
    });
  });

  document.getElementById('btn-view-all')?.addEventListener('click', async (e) => {
    state.viewAll = !state.viewAll;
    e.currentTarget.textContent = state.viewAll ? 'Show Day' : 'View All';
    await loadAppointmentsTable();
  });

  document.getElementById('btn-refresh-appointments')?.addEventListener('click', loadAppointmentsTable);
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
        <span class="day-booking-badge" aria-hidden="true"></span>
      </div>`;
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
    closeDayMenu();
    state.calendarDate.setMonth(state.calendarDate.getMonth() - 1);
    setMonth();
    await refreshCalendarDots();
  });

  document.getElementById('calendar-next')?.addEventListener('click', async () => {
    closeDayMenu();
    state.calendarDate.setMonth(state.calendarDate.getMonth() + 1);
    setMonth();
    await refreshCalendarDots();
  });

  document.getElementById('calendar-grid')?.addEventListener('click', (event) => {
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
    const selectedCell = document.querySelector(`.day-cell[data-day="${day}"]`);
    const selectedDate = state.selectedDate;
    if (selectedCell) void openDayMenu(selectedCell, selectedDate);
    void loadDashboard(selectedDate, { refreshDots: false });
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
        closeEmailComposerMenu();
        closeCancelReasonMenu();
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

  document.querySelectorAll('[data-notification-dot]').forEach((dot) => {
    dot.classList.toggle('hidden', Number(stats.pending || 0) <= 0);
  });
}

async function refreshCalendarDots() {
  const { appointments } = await api('/api/appointments');
  const yyyy = state.calendarDate.getFullYear();
  const mm = String(state.calendarDate.getMonth() + 1).padStart(2, '0');

  const monthAppointments = appointments.filter((a) => {
    const status = String(a.status || '').toLowerCase();
    return (
      typeof a.date === 'string' &&
      a.date.startsWith(`${yyyy}-${mm}-`) &&
      status !== 'completed'
    );
  });
  const dayCounts = new Map();
  const dayTypes = new Map();

  monthAppointments.forEach((a) => {
    const day = Number(a.date.slice(8, 10));
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    if (!dayTypes.has(day)) dayTypes.set(day, []);
    if (dayTypes.get(day).length < 2 && a.typeName) dayTypes.get(day).push(a.typeName);
  });

  document.querySelectorAll('.day-cell:not(.empty)').forEach((cell) => {
    const day = Number(cell.dataset.day);
    const count = dayCounts.get(day) || 0;
    const badge = cell.querySelector('.day-booking-badge');
    const typeList = dayTypes.get(day) || [];
    const labelParts = [`${count} booking${count === 1 ? '' : 's'}`];
    if (typeList.length) labelParts.push(typeList.join(', '));

    cell.classList.toggle('has-event', count > 0);
    cell.classList.toggle('event-low', count > 0 && count <= 2);
    cell.classList.toggle('event-med', count >= 3 && count <= 4);
    cell.classList.toggle('event-high', count >= 5);
    cell.setAttribute('aria-label', count > 0 ? `Day ${day}: ${labelParts.join(' • ')}` : `Day ${day}: No bookings`);
    cell.title = count > 0 ? `Day ${day}: ${labelParts.join(' • ')}` : `Day ${day}: No bookings`;

    if (badge) {
      badge.textContent = count > 0 ? String(count) : '';
    }
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
        <div class="time">${toTime12(a.time)} - ${toTime12(addMinutesToTime(a.time, a.durationMinutes))}</div>
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

function renderCompletedAppointments(appointments = []) {
  const root = document.getElementById('completed-list');
  if (!root) return;
  if (!appointments.length) {
    root.innerHTML = '<div class="empty-state">No completed appointments yet.</div>';
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => `
      <div class="completed-item">
        <div class="completed-item-main">
          <strong>${escapeHtml(a.typeName || a.title || 'Appointment')}</strong>
          <span>${escapeHtml(a.clientName || 'Client')}</span>
        </div>
        <div class="completed-item-meta">
          <span>${escapeHtml(a.date || '')}</span>
          <span>${escapeHtml(toTime12(a.time))} - ${escapeHtml(toTime12(addMinutesToTime(a.time, a.durationMinutes)))}</span>
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
  if (!appointments.length) {
    root.innerHTML = '<div class="empty-state">No appointments found.</div>';
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => `
      <div class="data-row" data-id="${a.id}">
        <div><strong>${escapeHtml(a.clientName)}</strong><div class="pill">${escapeHtml(a.typeName)}</div></div>
        <div>${escapeHtml(formatScheduleDate(a.date))}</div>
        <div>${toTime12(a.time)}</div>
        <div><span class="pill">${escapeHtml(a.status)}</span></div>
        <div class="row-actions">
          ${a.clientEmail
          ? '<button class="btn-secondary btn-email" type="button">Email</button>'
          : '<button class="btn-secondary btn-email" type="button" disabled>No Email</button>'
        }
          <button class="btn-secondary btn-complete" type="button" ${a.status === 'completed' || a.status === 'cancelled' ? 'disabled' : ''}>Complete</button>
          <button class="btn-secondary btn-cancel" type="button" ${a.status === 'cancelled' ? 'disabled' : ''}>${a.status === 'cancelled' ? 'Cancelled' : 'Cancel'}</button>
          <button class="btn-secondary btn-delete" type="button">Delete</button>
        </div>
      </div>`
    )
    .join('');

  root.querySelectorAll('.btn-email').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const id = btn.closest('.data-row')?.dataset.id;
      if (!id) return;
      await openEmailComposerMenu(id);
    });
  });

  root.querySelectorAll('.btn-complete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
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

  root.querySelectorAll('.btn-cancel').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const id = btn.closest('.data-row')?.dataset.id;
      await openCancelReasonMenu(id);
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

async function loadDashboard(targetDate = state.selectedDate, options = {}) {
  const { refreshDots = true } = options;
  const [dashboardResult, completedResult, allAppointmentsResult] = await Promise.all([
    api(`/api/dashboard?date=${encodeURIComponent(targetDate)}`),
    api('/api/appointments?status=completed'),
    api('/api/appointments')
  ]);
  const { stats, types, insights } = dashboardResult;
  if (targetDate !== state.selectedDate) return;
  const scheduleTitle = document.getElementById('schedule-title');
  const today = localYmd();
  const scheduleCandidates = (allAppointmentsResult?.appointments || [])
    .filter((a) => {
      const status = String(a.status || '').toLowerCase();
      return status !== 'completed' && status !== 'cancelled';
    })
    .slice()
    .sort((a, b) => {
      const aKey = `${a.date || ''} ${a.time || ''}`;
      const bKey = `${b.date || ''} ${b.time || ''}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  const todayAppointments = scheduleCandidates.filter((a) => a.date === today);
  let activeAppointments = todayAppointments;
  if (todayAppointments.length) {
    if (scheduleTitle) scheduleTitle.textContent = 'Today\'s Schedule';
  } else {
    const next = scheduleCandidates.find((a) => typeof a.date === 'string' && a.date >= today);
    if (next?.date) {
      activeAppointments = scheduleCandidates.filter((a) => a.date === next.date);
      if (scheduleTitle) scheduleTitle.textContent = `Next: ${formatScheduleDate(next.date)}`;
    } else if (scheduleTitle) {
      scheduleTitle.textContent = 'Today\'s Schedule';
    }
  }
  const completedAppointments = (completedResult?.appointments || [])
    .slice()
    .sort((a, b) => {
      const aKey = `${a.date || ''} ${a.time || ''}`;
      const bKey = `${b.date || ''} ${b.time || ''}`;
      return aKey < bKey ? 1 : -1;
    });
  renderStats(stats);
  renderTimeline(activeAppointments);
  renderCompletedAppointments(completedAppointments);
  renderTypes(types);
  renderInsights(insights);
  if (refreshDots) await refreshCalendarDots();
}

async function loadAppointmentsTable() {
  const activeView = getActiveView();
  const showAll = activeView === 'appointments' || state.viewAll;
  const query = showAll ? '' : `?date=${encodeURIComponent(state.selectedDate)}`;
  const { appointments } = await api(`/api/appointments${query}`);
  renderAppointmentsTable(appointments);
}

async function submitAppointment(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const wasEditing = Boolean(state.editingAppointmentId);
  payload.typeId = state.selectedTypeId;
  payload.durationMinutes = Number(payload.durationMinutes || 45);

  const submitButton = form.querySelector('button[type="submit"]');
  const oldText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = wasEditing ? 'Saving...' : 'Creating...';

  try {
    if (wasEditing) {
      await api(`/api/appointments/${state.editingAppointmentId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      const result = await api('/api/appointments', { method: 'POST', body: JSON.stringify(payload) });
      const provider = result?.notifications?.mode;
      showToast(
        provider === 'simulation'
          ? 'Appointment created. Email simulation mode is active.'
          : 'Appointment created and notifications sent.',
        'success'
      );
    }

    form.reset();
    setAppointmentDefaults();
    closeModal('new-appointment');
    await loadDashboard();
    await loadAppointmentsTable();
    await refreshCalendarDots();
    if (wasEditing) showToast('Appointment updated.', 'success');
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
    const ok = window.confirm('Load this backup and replace current appointments/types for this business?');
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

async function runSearch(query) {
  if (!query) {
    await loadAppointmentsTable();
    return;
  }
  const { appointments } = await api(`/api/appointments?q=${encodeURIComponent(query)}`);
  renderAppointmentsTable(appointments);
  setActiveView('appointments');
}

async function clearSearchAndRestoreView(searchInput) {
  if (searchInput) searchInput.value = '';
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
    } else {
      chip.textContent = '';
    }
  }
  const publicBookingLink = document.getElementById('btn-public-booking');
  if (publicBookingLink && state.currentBusiness?.slug) {
    publicBookingLink.href = `/book?business=${encodeURIComponent(state.currentBusiness.slug)}`;
  }
  const authButton = document.getElementById('btn-logout');
  if (authButton) {
    authButton.textContent = state.currentUser ? 'Logout' : 'Sign In';
  }
}

function setAuthTab(tab) {
  const loginForm = document.getElementById('auth-login-form');
  const signupForm = document.getElementById('auth-signup-form');
  document.querySelectorAll('.auth-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.authTab === tab);
  });
  if (loginForm) loginForm.classList.toggle('hidden', tab !== 'login');
  if (signupForm) signupForm.classList.toggle('hidden', tab !== 'signup');
}

function showAuthShell(force = false) {
  if (!force && state.authShellDismissed) return;
  document.getElementById('auth-shell')?.classList.remove('hidden');
}

function hideAuthShell(dismissed = false) {
  if (dismissed) state.authShellDismissed = true;
  document.getElementById('auth-shell')?.classList.add('hidden');
}

async function ensureAuth() {
  try {
    const me = await api('/api/auth/me');
    state.currentUser = me.user || null;
    state.currentBusiness = me.business || null;
    state.authShellDismissed = false;
    updateAccountUi();
    hideAuthShell();
    return true;
  } catch (_error) {
    state.currentUser = null;
    state.currentBusiness = null;
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
      state.authShellDismissed = false;
      updateAccountUi();
      hideAuthShell();
      await loadTypes();
      await loadDashboard();
      await loadAppointmentsTable();
      await loadSettings();
      showToast('Dev login successful.', 'success');
    } catch (error) {
      showToast(error.message || 'Dev login not available.', 'error');
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
      state.currentUser = result.user || null;
      state.currentBusiness = result.business || null;
      state.authShellDismissed = false;
      updateAccountUi();
      hideAuthShell();
      await loadTypes();
      await loadDashboard();
      await loadAppointmentsTable();
      await loadSettings();
      showToast('Signed in successfully.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('auth-signup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    const passwordCheck = validatePasswordStrength(data.password);
    if (!passwordCheck.ok) {
      showToast(passwordCheck.message, 'error');
      return;
    }
    try {
      const result = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify(data)
      });
      const debugToken = result.verificationToken ? ` (dev token: ${result.verificationToken})` : '';
      showToast(`Verification email sent. Open your inbox to activate account.${debugToken}`, 'success');
      setAuthTab('login');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
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
    updateAccountUi();
    showAuthShell();
  });

  document.getElementById('btn-close-auth-shell')?.addEventListener('click', () => {
    hideAuthShell(true);
  });
}

async function configureDevLoginVisibility() {
  const devBtn = document.getElementById('btn-dev-login');
  if (!devBtn) return;
  devBtn.classList.add('hidden');
  try {
    const response = await fetch('/api/health', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json().catch(() => ({}));
    devBtn.classList.toggle('hidden', !body.devLoginEnabled);
  } catch (_error) {
    devBtn.classList.add('hidden');
  }
}

function bindForms() {
  document.getElementById('appointment-form')?.addEventListener('submit', submitAppointment);
  document.getElementById('type-form')?.addEventListener('submit', submitType);
  document.getElementById('settings-form')?.addEventListener('submit', submitSettings);
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
  bindAppointmentFormEnhancements();
  updateAppointmentEditorUi(false);

  const search = document.getElementById('global-search');
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const query = search.value.trim();

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
      if (!state.searchActive) return;
      await clearSearchAndRestoreView(search);
    });

    search.addEventListener('keydown', async (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      await clearSearchAndRestoreView(search);
      search.blur();
    });
  }
}

function bindThemeToggle() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initial);

  const toggle = () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  };

  document.getElementById('theme-toggle-desktop')?.addEventListener('click', toggle);
  document.getElementById('theme-toggle-mobile')?.addEventListener('click', toggle);
}

async function init() {
  bindAuthUi();
  await configureDevLoginVisibility();
  bindNavigation();
  bindHeaderButtons();
  bindModalControls();
  bindCalendarNav();
  bindKeyboard();
  bindForms();
  bindThemeToggle();
  setupTimezoneSearch();
  setupTimezoneSearch('signup-timezone', 'signup-timezone-suggestions');

  const todayInput = document.querySelector('input[name="date"]');
  if (todayInput) todayInput.value = state.selectedDate;

  document.addEventListener('click', (event) => {
    const menu = document.getElementById('calendar-day-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    const clickedInMenu = event.target.closest('#calendar-day-menu');
    const clickedOnDay = event.target.closest('.day-cell[data-day]');
    if (!clickedInMenu && !clickedOnDay) closeDayMenu();
  });

  window.addEventListener('resize', repositionDayMenuIfOpen);
  window.addEventListener('scroll', repositionDayMenuIfOpen, true);

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
    state.apiOnline = true;
  } catch (error) {
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
    state
  };
}
