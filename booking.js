const typeSelect = document.getElementById('public-type-select');
const durationSelect = document.getElementById('public-duration');
const locationInput = document.getElementById('public-location');
const locationReadonly = document.getElementById('public-location-readonly');
const dateInput = document.querySelector('#public-booking-form input[name="date"]');
const timeInput = document.getElementById('booking-time');
const slotsContainer = document.getElementById('booking-slots');
const slotsHint = document.getElementById('booking-slots-hint');
const slotPeriodsContainer = document.getElementById('booking-slot-periods');
const slotMoreButton = document.getElementById('booking-slots-more');
const dateReadable = document.getElementById('booking-date-readable');
const bookingHoursDisplay = document.getElementById('booking-hours-display');
const form = document.getElementById('public-booking-form');

let types = [];
const businessSlug = new URLSearchParams(window.location.search).get('business') || '';
const PUBLIC_QUEUE_KEY = 'intellischedule.publicOfflineBookingQueue.v1';
let publicQueueSyncInProgress = false;
let slotsRequestSeq = 0;
let availableSlotsState = [];
let activeSlotPeriod = 'morning';
let showAllSlotsInPeriod = false;
const VISIBLE_SLOTS_LIMIT = 8;
const SLOT_PERIODS = [
  { id: 'morning', label: 'Morning', startHour: 0, endHour: 12 },
  { id: 'afternoon', label: 'Afternoon', startHour: 12, endHour: 16 },
  { id: 'evening', label: 'Evening', startHour: 16, endHour: 24 }
];

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

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
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
        ? 'You are offline. Reconnect before creating a booking.'
        : 'Cannot reach the booking server right now.'
    );
    error.code = offline ? 'OFFLINE' : 'NETWORK';
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Request failed');
    // Service worker returns 503 + { error: 'Offline' } for API calls with no network.
    error.code = res.status === 503 && data?.error === 'Offline'
      ? 'OFFLINE'
      : res.status;
    throw error;
  }
  return data;
}

function loadPublicQueue() {
  try {
    const raw = localStorage.getItem(PUBLIC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function savePublicQueue(queue) {
  localStorage.setItem(PUBLIC_QUEUE_KEY, JSON.stringify(queue));
}

function enqueuePublicBooking(bookingPayload) {
  const queue = loadPublicQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    payload: bookingPayload
  });
  savePublicQueue(queue);
  return queue.length;
}

async function flushPublicQueue() {
  if (publicQueueSyncInProgress) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const queue = loadPublicQueue();
  if (!queue.length) return;

  publicQueueSyncInProgress = true;
  let synced = 0;
  let dropped = 0;

  try {
    let pending = [...queue];
    while (pending.length) {
      const entry = pending[0];
      try {
        await api('/api/public/bookings', {
          method: 'POST',
          body: JSON.stringify(entry.payload)
        });
        synced += 1;
        pending = pending.slice(1);
        savePublicQueue(pending);
      } catch (error) {
        if (error?.code === 'OFFLINE' || error?.code === 'NETWORK') break;
        dropped += 1;
        pending = pending.slice(1);
        savePublicQueue(pending);
      }
    }
  } finally {
    publicQueueSyncInProgress = false;
  }

  if (synced > 0) showToast(`Synced ${synced} offline booking${synced === 1 ? '' : 's'}.`, 'success');
  if (dropped > 0) showToast(`${dropped} queued booking${dropped === 1 ? '' : 's'} failed to sync.`, 'error');
}

async function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!window.isSecureContext && !isLocalhost) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (_error) {
    // Ignore registration failures on unsupported/degraded browsers.
  }
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function toIsoDateLocal(dateValue = new Date()) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function updateReadableDate() {
  if (!dateReadable) return;
  const value = String(dateInput?.value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    dateReadable.textContent = 'Select a date to view times.';
    return;
  }
  const parsed = new Date(`${value}T12:00:00`);
  const label = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parsed);
  dateReadable.textContent = label;
}

function setBookingDate(dateValue) {
  if (!dateInput) return;
  dateInput.value = toIsoDateLocal(dateValue);
  updateReadableDate();
  setSelectedSlot('');
  void loadAvailableSlots();
}

function resolveQuickDate(action = 'today') {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (action === 'tomorrow') {
    base.setDate(base.getDate() + 1);
    return base;
  }
  if (action === 'next-week') {
    base.setDate(base.getDate() + 7);
    return base;
  }
  if (action === 'weekend') {
    const day = base.getDay(); // 0=Sun, 6=Sat
    const deltaToSaturday = (6 - day + 7) % 7;
    base.setDate(base.getDate() + deltaToSaturday);
    return base;
  }
  return base;
}

function toTime12(time24 = '09:00') {
  const [hRaw, mRaw] = String(time24 || '').split(':');
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time24;
  const hour12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function dayLabelFromKey(dayKey = '') {
  const labels = {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday'
  };
  return labels[String(dayKey || '').toLowerCase()] || 'Selected day';
}

function setBookingHours({ openTime, closeTime, dayKey, closed = false }) {
  if (!bookingHoursDisplay) return;
  if (closed) {
    bookingHoursDisplay.textContent = `${dayLabelFromKey(dayKey)}: Closed`;
  } else {
    const openLabel = toTime12(String(openTime || '09:00').slice(0, 5));
    const closeLabel = toTime12(String(closeTime || '18:00').slice(0, 5));
    bookingHoursDisplay.textContent = `${dayLabelFromKey(dayKey)} hours: ${openLabel} - ${closeLabel}`;
  }
  bookingHoursDisplay.classList.remove('hidden');
}

function humanizeLocation(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'office') return 'In person';
  if (normalized === 'virtual') return 'Virtual';
  if (normalized === 'phone') return 'Phone call';
  if (normalized === 'hybrid') return 'Hybrid';
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Service defined';
}

function setSlotsHint(message = '') {
  if (!slotsHint) return;
  slotsHint.textContent = message;
}

function setSelectedSlot(timeValue = '') {
  if (!timeInput) return;
  const normalized = String(timeValue || '').trim().slice(0, 5);
  timeInput.value = normalized;
  slotsContainer?.querySelectorAll('.booking-slot-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.time === normalized);
  });
}

function slotPeriodForTime(timeValue = '') {
  const hour = Number(String(timeValue).split(':')[0]);
  if (!Number.isFinite(hour)) return 'morning';
  const match = SLOT_PERIODS.find((period) => hour >= period.startHour && hour < period.endHour);
  return match?.id || 'evening';
}

function periodLabel(periodId = '') {
  return SLOT_PERIODS.find((period) => period.id === periodId)?.label || 'Morning';
}

function slotsForActivePeriod() {
  return availableSlotsState.filter((slot) => slotPeriodForTime(slot) === activeSlotPeriod);
}

function ensureUsableSlotPeriod() {
  const hasCurrentPeriod = slotsForActivePeriod().length > 0;
  if (hasCurrentPeriod) return;
  const firstSlot = availableSlotsState[0];
  if (!firstSlot) {
    activeSlotPeriod = 'morning';
    return;
  }
  activeSlotPeriod = slotPeriodForTime(firstSlot);
}

function renderPeriodFilters() {
  if (!slotPeriodsContainer) return;
  clearChildren(slotPeriodsContainer);
  const withCounts = SLOT_PERIODS
    .map((period) => ({
      ...period,
      count: availableSlotsState.filter((slot) => slotPeriodForTime(slot) === period.id).length
    }))
    .filter((period) => period.count > 0);

  if (withCounts.length <= 1) {
    slotPeriodsContainer.classList.add('hidden');
    return;
  }

  slotPeriodsContainer.classList.remove('hidden');
  withCounts.forEach((period) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `booking-slot-period-btn${period.id === activeSlotPeriod ? ' active' : ''}`;
    button.dataset.period = period.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', period.id === activeSlotPeriod ? 'true' : 'false');
    button.textContent = `${period.label} (${period.count})`;
    button.addEventListener('click', () => {
      activeSlotPeriod = period.id;
      showAllSlotsInPeriod = false;
      renderAvailableSlotsView();
    });
    slotPeriodsContainer.appendChild(button);
  });
}

function renderSlotButtons(slots = [], emptyMessage = 'No open times for this date. Try another day.') {
  if (!slotsContainer) return;
  clearChildren(slotsContainer);
  if (!slots.length) {
    const empty = document.createElement('div');
    empty.className = 'booking-slots-empty';
    empty.textContent = emptyMessage;
    slotsContainer.appendChild(empty);
    return;
  }

  slots.forEach((timeValue) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'booking-slot-btn';
    btn.dataset.time = timeValue;
    btn.textContent = toTime12(timeValue);
    btn.addEventListener('click', () => setSelectedSlot(timeValue));
    slotsContainer.appendChild(btn);
  });
}

function renderAvailableSlotsView(emptyMessage = 'No open times for this date. Try another day.') {
  ensureUsableSlotPeriod();
  renderPeriodFilters();

  const periodSlots = slotsForActivePeriod();
  const hasOverflow = periodSlots.length > VISIBLE_SLOTS_LIMIT;
  let visibleSlots = showAllSlotsInPeriod ? periodSlots : periodSlots.slice(0, VISIBLE_SLOTS_LIMIT);

  const selected = String(timeInput?.value || '').slice(0, 5);
  if (selected && periodSlots.includes(selected) && !visibleSlots.includes(selected)) {
    visibleSlots = periodSlots;
    showAllSlotsInPeriod = true;
  }

  renderSlotButtons(visibleSlots, emptyMessage);

  if (slotMoreButton) {
    slotMoreButton.classList.toggle('hidden', !hasOverflow);
    slotMoreButton.textContent = showAllSlotsInPeriod ? 'Show fewer times' : `Show more ${periodLabel(activeSlotPeriod).toLowerCase()} times`;
  }
}

async function loadAvailableSlots() {
  if (!businessSlug) return;
  const selectedTypeId = Number(typeSelect.value);
  const selectedDate = String(dateInput?.value || '').trim();
  if (!selectedTypeId || !selectedDate) {
    setSelectedSlot('');
    availableSlotsState = [];
    showAllSlotsInPeriod = false;
    renderAvailableSlotsView('Select a date to view available times.');
    setSlotsHint('Choose a service and date to load slots.');
    return;
  }

  const requestId = ++slotsRequestSeq;
  slotsContainer?.classList.add('is-loading');
  setSlotsHint('Checking live availability...');
  try {
    const params = new URLSearchParams({
      businessSlug,
      typeId: String(selectedTypeId),
      date: selectedDate
    });
    const result = await api(`/api/public/available-slots?${params.toString()}`);
    if (requestId !== slotsRequestSeq) return;
    setBookingHours({
      openTime: result.openTime,
      closeTime: result.closeTime,
      dayKey: result.dayKey,
      closed: Boolean(result.closed)
    });

    const slots = Array.isArray(result.availableSlots) ? result.availableSlots : [];
    availableSlotsState = slots;
    showAllSlotsInPeriod = false;
    ensureUsableSlotPeriod();
    const previous = String(timeInput?.value || '').slice(0, 5);
    renderAvailableSlotsView(result.closed ? 'Business is closed on this day.' : 'No open times for this date. Try another day.');
    if (previous && slots.includes(previous)) setSelectedSlot(previous);
    else setSelectedSlot('');
    if (result.closed) {
      setSlotsHint('Business is closed on this day.');
    } else {
      setSlotsHint(slots.length ? 'Select a time slot.' : 'No slots left for this day.');
    }
  } catch (error) {
    if (requestId !== slotsRequestSeq) return;
    setSelectedSlot('');
    availableSlotsState = [];
    showAllSlotsInPeriod = false;
    renderAvailableSlotsView();
    if (error?.code === 'OFFLINE' || error?.code === 'NETWORK') {
      renderAvailableSlotsView('Connect to the internet to load available times.');
      setSlotsHint('You are offline. Reconnect to load live slots.');
    } else {
      renderAvailableSlotsView('Unable to load slots right now. Try again.');
      setSlotsHint('Could not load slots right now.');
      showToast(error.message || 'Could not load slots.', 'error');
    }
  } finally {
    if (requestId === slotsRequestSeq) {
      slotsContainer?.classList.remove('is-loading');
    }
  }
}

function syncTypeFields() {
  const typeId = Number(typeSelect.value);
  const selected = types.find((t) => t.id === typeId);
  if (!selected) return;

  clearChildren(durationSelect);
  const option = document.createElement('option');
  option.value = String(selected.durationMinutes);
  option.textContent = `${selected.durationMinutes} minutes`;
  durationSelect.appendChild(option);
  if (locationInput) locationInput.value = selected.locationMode;
  if (locationReadonly) locationReadonly.textContent = humanizeLocation(selected.locationMode);
  void loadAvailableSlots();
}

async function loadTypes() {
  const suffix = businessSlug ? `?businessSlug=${encodeURIComponent(businessSlug)}` : '';
  const { types: remoteTypes } = await api(`/api/types${suffix}`);
  types = remoteTypes;

  clearChildren(typeSelect);
  types.forEach((t) => {
    const option = document.createElement('option');
    option.value = String(t.id);
    option.textContent = t.name;
    typeSelect.appendChild(option);
  });

  syncTypeFields();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());

  const button = form.querySelector('button[type="submit"]');
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Booking...';

  try {
    payload.typeId = Number(payload.typeId);
    payload.durationMinutes = Number(payload.durationMinutes);
    const selectedType = types.find((t) => t.id === payload.typeId);
    payload.location = selectedType?.locationMode || payload.location || 'office';
    payload.time = String(timeInput?.value || '').trim();
    if (!payload.time) {
      showToast('Please select an available time slot.', 'error');
      return;
    }
    const bookingPayload = { ...payload, businessSlug };

    const result = await api('/api/public/bookings', {
      method: 'POST',
      body: JSON.stringify(bookingPayload)
    });

    form.reset();
    setSelectedSlot('');
    if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
    syncTypeFields();
    showToast(
      result?.notifications?.mode === 'simulation'
        ? 'Booked! Email simulation mode is active.'
        : 'Booked! Confirmation email sent.',
      'success'
    );
  } catch (error) {
    if (error?.code === 'OFFLINE' || error?.code === 'NETWORK') {
      const queued = enqueuePublicBooking({ ...payload, businessSlug });
      form.reset();
      setSelectedSlot('');
      if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
      syncTypeFields();
      showToast(`Offline: booking queued (${queued} pending).`, 'info');
    } else {
      showToast(error.message, 'error');
      if (/overlaps/i.test(String(error.message || ''))) {
        void loadAvailableSlots();
      }
    }
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
});

typeSelect.addEventListener('change', syncTypeFields);
dateInput?.addEventListener('change', () => {
  updateReadableDate();
  setSelectedSlot('');
  void loadAvailableSlots();
});
document.querySelectorAll('[data-booking-date-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.bookingDateAction || 'today';
    const nextDate = resolveQuickDate(action);
    setBookingDate(nextDate);
  });
});
slotMoreButton?.addEventListener('click', () => {
  showAllSlotsInPeriod = !showAllSlotsInPeriod;
  renderAvailableSlotsView();
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await registerServiceWorker();
    window.addEventListener('online', () => {
      showToast('Connection restored. Syncing queued bookings...', 'success');
      void flushPublicQueue();
    });
    if (!businessSlug) {
      showToast('Missing business link. Use /book?business=your-business-slug', 'error');
      return;
    }
    await loadTypes();
    await flushPublicQueue();
    if (dateInput) {
      const today = toIsoDateLocal(new Date());
      dateInput.value = today;
      dateInput.min = today;
      updateReadableDate();
    }
    await loadAvailableSlots();
  } catch (error) {
    showToast('Could not load booking types. Start backend first.', 'error');
  }
});
