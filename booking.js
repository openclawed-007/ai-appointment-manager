const typeSelect = document.getElementById('public-type-select');
const durationSelect = document.getElementById('public-duration');
const locationSelect = document.getElementById('public-location');
const form = document.getElementById('public-booking-form');

let types = [];
const businessSlug = new URLSearchParams(window.location.search).get('business') || '';
const PUBLIC_QUEUE_KEY = 'intellischedule.publicOfflineBookingQueue.v1';
let publicQueueSyncInProgress = false;

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
    error.code = res.status;
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

function syncTypeFields() {
  const typeId = Number(typeSelect.value);
  const selected = types.find((t) => t.id === typeId);
  if (!selected) return;

  clearChildren(durationSelect);
  const option = document.createElement('option');
  option.value = String(selected.durationMinutes);
  option.textContent = `${selected.durationMinutes} minutes`;
  durationSelect.appendChild(option);
  locationSelect.value = selected.locationMode;
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
    const bookingPayload = { ...payload, businessSlug };

    const result = await api('/api/public/bookings', {
      method: 'POST',
      body: JSON.stringify(bookingPayload)
    });

    form.reset();
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
      showToast(`Offline: booking queued (${queued} pending).`, 'info');
    } else {
      showToast(error.message, 'error');
    }
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
});

typeSelect.addEventListener('change', syncTypeFields);

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
    const dateInput = form.querySelector('input[name="date"]');
    dateInput.value = new Date().toISOString().slice(0, 10);
  } catch (error) {
    showToast('Could not load booking types. Start backend first.', 'error');
  }
});
