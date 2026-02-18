const typeSelect = document.getElementById('public-type-select');
const durationSelect = document.getElementById('public-duration');
const locationSelect = document.getElementById('public-location');
const form = document.getElementById('public-booking-form');

let types = [];
const businessSlug = new URLSearchParams(window.location.search).get('business') || '';

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
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
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

    const result = await api('/api/public/bookings', {
      method: 'POST',
      body: JSON.stringify({ ...payload, businessSlug })
    });

    form.reset();
    showToast(
      result?.notifications?.mode === 'simulation'
        ? 'Booked! Email simulation mode is active.'
        : 'Booked! Confirmation email sent.',
      'success'
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
});

typeSelect.addEventListener('change', syncTypeFields);

document.addEventListener('DOMContentLoaded', async () => {
  try {
    if (!businessSlug) {
      showToast('Missing business link. Use /book?business=your-business-slug', 'error');
      return;
    }
    await loadTypes();
    const dateInput = form.querySelector('input[name="date"]');
    dateInput.value = new Date().toISOString().slice(0, 10);
  } catch (error) {
    showToast('Could not load booking types. Start backend first.', 'error');
  }
});
