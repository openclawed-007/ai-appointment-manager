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
  notificationMenuAnchorEl: null,
  currentUser: null,
  currentBusiness: null,
  calendarShowClientNames: getStoredBoolean('calendarShowClientNames'),
  authShellDismissed: false,
  queueSyncInProgress: false,
  calendarExpanded: getStoredBoolean('calendarExpanded'),
  unreadNotifications: 0,
  authLoginChallengeToken: '',
  authLoginEmail: '',
  authResendCooldownUntil: 0,
  calendarDotsRequestId: 0
};

const CALENDAR_MONTH_CACHE_TTL_MS = 120000;
const calendarMonthCache = new Map();
const calendarMonthInFlight = new Map();

const OFFLINE_MUTATION_QUEUE_KEY = 'intellischedule.offlineMutationQueue.v1';
const AUTH_SNAPSHOT_KEY = 'intellischedule.authSnapshot.v1';
const ACCENT_COLORS = ['green', 'blue', 'red', 'purple', 'amber'];

function normalizeAccentColor(value) {
  const color = String(value || '').trim();
  return ACCENT_COLORS.includes(color) ? color : 'green';
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
      : '<div class="notification-empty">No pending appointments right now.</div>';

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
        <div class="notifications-section-title">Pending appointments</div>
        <div class="notifications-list">${pendingItems}</div>
      </div>
      <div class="notifications-actions">
        <button type="button" class="btn-secondary" id="notifications-open-dashboard">Open Dashboard</button>
        <button type="button" class="btn-primary" id="notifications-open-appointments">Review Appointments</button>
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
          state.calendarDate = new Date(dt.getFullYear(), dt.getMonth(), 1);
          const monthLabelNode = document.querySelector('.current-month');
          if (monthLabelNode) monthLabelNode.textContent = monthLabel(state.calendarDate);
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
                ${a.status === 'pending'
            ? `<button type="button" class="day-menu-confirm" data-appointment-id="${a.id}" aria-label="Confirm appointment">Confirm</button>`
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
        <button type="button" class="btn-primary day-menu-add-offline">Add Appointment</button>
      </div>
      <div class="day-menu-empty">Could not load this day while offline. You can still add an appointment.</div>
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

function toTimeCompact(time24 = '09:00') {
  const [h, m] = String(time24).split(':').map(Number);
  const hh = Number.isFinite(h) ? String(h).padStart(2, '0') : '09';
  const mm = Number.isFinite(m) ? String(m).padStart(2, '0') : '00';
  return `${hh}:${mm}`;
}

function getCalendarPreviewLabel(appointment = {}) {
  if (state.calendarShowClientNames) {
    return appointment.clientName || appointment.typeName || appointment.title || 'Appointment';
  }
  return appointment.typeName || appointment.title || appointment.clientName || 'Appointment';
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
  const { response, body } = await requestJson(path, options);
  if (response.status === 401) {
    const error = new Error(body.error || 'Authentication required.');
    error.code = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    // Service worker returns 503 + { error: 'Offline' } for API calls with no network.
    error.code = response.status === 503 && body?.error === 'Offline'
      ? 'OFFLINE'
      : response.status;
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
  const isCalendarOnly = activeView === 'calendar';
  const visibleView = isCalendarOnly ? 'dashboard' : activeView;
  const views = [...document.querySelectorAll('.app-view')];
  views.forEach((section) => {
    section.classList.toggle('active', section.dataset.view === visibleView);
  });

  document.body.classList.toggle('calendar-view-only', isCalendarOnly);

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
  if (view === 'calendar' && availableViews.has('dashboard')) return 'calendar';
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

function setActiveView(view) {
  if (!view) return;
  const activeView = resolveView(view);
  if (!activeView) return;

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
  if (activeView === 'appointments' && canAutoLoadAppointments) {
    void loadAppointmentsTable().catch(swallowBackgroundAsyncError);
  }
}

function getActiveView() {
  if (document.body.classList.contains('calendar-view-only')) return 'calendar';
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
    await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
  });

  document.getElementById('btn-refresh-appointments')?.addEventListener('click', loadAppointmentsTable);
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

  grid.innerHTML = `${headers}${empties}${days}`;
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
    if (labelNode) labelNode.textContent = monthLabel(state.calendarDate);
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

    const prevSelected = document.querySelector('.day-cell.selected');
    if (prevSelected && prevSelected !== dayCell) prevSelected.classList.remove('selected');
    dayCell.classList.add('selected');

    const selectedCell = dayCell;
    const selectedDate = state.selectedDate;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      openNewAppointmentModalForDate(selectedDate);
      showToast('Offline mode: creating appointment for selected date.', 'info');
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

function renderStats(stats = {}) {
  document.getElementById('stat-today').textContent = stats.today ?? 0;
  document.getElementById('stat-week').textContent = stats.week ?? 0;
  document.getElementById('stat-pending').textContent = stats.pending ?? 0;
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

async function refreshCalendarDots(options = {}) {
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
  const emptyMessage = options.emptyMessage || 'No appointments for this day yet.';
  const includeDate = Boolean(options.includeDate);
  if (!appointments.length) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => {
        const statusClass = `status-${(a.status || 'pending').toLowerCase()}`;
        return `
      <div class="timeline-item" data-id="${a.id}">
        <div class="time-column">
          <div class="time-start">${toTime12(a.time)}</div>
          <div class="time-end">${toTime12(addMinutesToTime(a.time, a.durationMinutes))}</div>
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
              <span>⏱ ${a.durationMinutes} min</span>
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
    root.innerHTML = '<div class="empty-state">No completed appointments yet.</div>';
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => `
      <div class="completed-item">
        <div class="completed-item-main">
          <strong class="client-name">${escapeHtml(a.clientName || 'Client')}</strong>
          <span class="appointment-type-tag">${escapeHtml(a.typeName || a.title || 'Appointment')}</span>
        </div>
        <div class="completed-item-meta">
          <span>${escapeHtml(formatScheduleDate(a.date))}</span>
          <span class="time-range">${escapeHtml(toTime12(a.time))} - ${escapeHtml(toTime12(addMinutesToTime(a.time, a.durationMinutes)))}</span>
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
  if (!appointments.length) {
    root.innerHTML = '<div class="empty-state">No appointments found.</div>';
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => {
        const statusClass = `status-${(a.status || 'pending').toLowerCase()}`;
        return `
      <div class="data-row" data-id="${a.id}">
        <div>
          <strong class="client-name">${escapeHtml(a.clientName)}</strong>
          <div class="appointment-type-tag">${escapeHtml(a.typeName)}</div>
        </div>
        <div class="appointment-date-cell">${escapeHtml(formatScheduleDate(a.date))}</div>
        <div class="appointment-time-cell">${toTime12(a.time)}</div>
        <div><span class="status-badge ${statusClass}">${escapeHtml(a.status)}</span></div>
        <div class="row-actions">
          ${a.clientEmail
            ? '<button class="btn-secondary btn-email" type="button" title="Send Email">Email</button>'
            : '<button class="btn-secondary btn-email" type="button" disabled>No Email</button>'
          }
          ${a.status === 'pending'
            ? '<button class="btn-secondary btn-confirm-booking" type="button">Confirm</button>'
            : ''
          }
          <button class="btn-secondary btn-complete" type="button" ${a.status === 'completed' || a.status === 'cancelled' ? 'disabled' : ''}>Complete</button>
          <button class="btn-secondary btn-cancel" type="button" ${a.status === 'cancelled' ? 'disabled' : ''}>${a.status === 'cancelled' ? 'Cancelled' : 'Cancel'}</button>
          <button class="btn-secondary btn-delete" type="button">Delete</button>
        </div>
      </div>`;
      }
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
      try {
        const result = await queueAwareMutation(`/api/appointments/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed' })
        }, {
          allowOfflineQueue: true,
          description: 'Appointment completion'
        });
        if (result.queued) return;
        showToast('Appointment marked completed', 'success');
        await loadAppointmentsTable();
        await loadDashboard();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });

  root.querySelectorAll('.btn-confirm-booking').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const id = btn.closest('.data-row')?.dataset.id;
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
        await loadAppointmentsTable();
        await loadDashboard();
        await refreshCalendarDots({ force: true });
      } catch (error) {
        showToast(error.message, 'error');
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.textContent = originalText;
      }
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
      try {
        const result = await queueAwareMutation(`/api/appointments/${id}`, { method: 'DELETE' }, {
          allowOfflineQueue: true,
          description: 'Appointment deletion'
        });
        if (result.queued) return;
        showToast('Appointment deleted', 'success');
        await loadAppointmentsTable();
        await loadDashboard();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
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

  let activeAppointments = todayAppointments;
  if (state.viewAll) {
    activeAppointments = allActiveAppointments.filter((a) => typeof a.date === 'string' && a.date >= targetDate);
    if (scheduleTitle) scheduleTitle.textContent = `Upcoming from ${formatScheduleDate(targetDate)}`;
  } else if (scheduleTitle) {
    scheduleTitle.textContent = isTargetToday
      ? "Today's Schedule"
      : `Schedule: ${formatScheduleDate(targetDate)}`;
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
      scheduleTitle.textContent = "Today's Schedule";
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
  renderTimeline(activeAppointments, {
    emptyMessage: state.viewAll ? 'No upcoming appointments from this day onward.' : 'No appointments for this day yet.',
    includeDate: state.viewAll
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
  payload.typeId = state.selectedTypeId;
  payload.durationMinutes = Number(payload.durationMinutes || 45);

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
      const result = await queueAwareMutation('/api/appointments', { method: 'POST', body: JSON.stringify(payload) }, {
        allowOfflineQueue: true,
        description: 'Appointment creation'
      });
      if (result.queued) {
        form.reset();
        setAppointmentDefaults();
        closeModal('new-appointment');
        return;
      }
      const provider = result?.body?.notifications?.mode;
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
    await refreshCalendarDots({ force: true });
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
    const result = await queueAwareMutation('/api/types', {
      method: 'POST',
      body: JSON.stringify({
        name: data.name,
        durationMinutes: Number(data.durationMinutes || 30),
        priceCents: Number(data.priceGbp ?? data.priceUsd ?? 0) * 100,
        locationMode: data.locationMode
      })
    }, {
      allowOfflineQueue: true,
      description: 'Type creation'
    });
    if (result.queued) {
      form.reset();
      return;
    }
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

async function loadSettings() {
  const { settings } = await api('/api/settings');
  const form = document.getElementById('settings-form');
  if (!form) return;
  form.businessName.value = settings.business_name || '';
  form.ownerEmail.value = settings.owner_email || '';
  form.timezone.value = settings.timezone || 'America/Los_Angeles';

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

  // Populate the export type chips
  populateExportTypeFilters();
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
    return true;
  } catch (error) {
    if (error?.code === 'OFFLINE' || error?.code === 'NETWORK') {
      const snapshot = loadAuthSnapshot();
      if (snapshot?.user && snapshot?.business) {
        state.currentUser = snapshot.user;
        state.currentBusiness = snapshot.business;
        updateAccountUi();
        hideAuthShell();
        return true;
      }
      // Offline without a cached auth snapshot: keep shell hidden so offline
      // queueing/creation UX is still usable until connectivity returns.
      state.currentUser = null;
      state.currentBusiness = null;
      updateAccountUi();
      hideAuthShell();
      return false;
    }
    state.currentUser = null;
    state.currentBusiness = null;
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
    saveAuthSnapshot(null, null);
    updateAccountUi();
    showAuthShell();
  };

  document.getElementById('btn-logout')?.addEventListener('click', handleAuthAction);
  document.getElementById('nav-logout-sidebar')?.addEventListener('click', handleAuthAction);

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
  document.getElementById('settings-calendar-show-client-names')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    state.calendarShowClientNames = checked;
    setStoredValue('calendarShowClientNames', checked);
    await refreshCalendarDots();
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
  bindAuthUi();
  await configureDevLoginVisibility();
  bindNavigation();
  applyInitialViewPreference(preferredView);
  bindHeaderButtons();
  bindModalControls();
  bindCalendarNav();
  bindKeyboard();
  bindForms();
  applyInitialTheme();
  setupTimezoneSearch();
  setupTimezoneSearch('signup-timezone', 'signup-timezone-suggestions');

  const todayInput = document.querySelector('input[name="date"]');
  if (todayInput) todayInput.value = state.selectedDate;

  document.addEventListener('click', (event) => {
    const dayMenu = document.getElementById('calendar-day-menu');
    if (dayMenu && !dayMenu.classList.contains('hidden')) {
      const clickedInMenu = event.target.closest('#calendar-day-menu');
      const clickedOnDay = event.target.closest('.day-cell[data-day]');
      if (!clickedInMenu && !clickedOnDay) closeDayMenu();
    }

    const notificationsMenu = document.getElementById('notifications-menu');
    if (notificationsMenu && !notificationsMenu.classList.contains('hidden')) {
      const clickedInNotifications = event.target.closest('#notifications-menu');
      const clickedNotificationButton = event.target.closest('[data-notification-button]');
      if (!clickedInNotifications && !clickedNotificationButton) closeNotificationsMenu();
    }
  });

  window.addEventListener('resize', repositionDayMenuIfOpen);
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
    await flushOfflineMutationQueue();
    state.apiOnline = true;

    if (preferredView) setActiveView(preferredView);
  } catch (error) {
    if (error?.code === 'OFFLINE') {
      state.apiOnline = false;
      showToast('You are offline. Reconnect to load the latest appointment data.', 'info');
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
