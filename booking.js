const typeSelect = document.getElementById('public-type-select');
const durationSelect = document.getElementById('public-duration');
const locationSelect = document.getElementById('public-location');
const form = document.getElementById('public-booking-form');

let types = [];

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

function syncTypeFields() {
  const typeId = Number(typeSelect.value);
  const selected = types.find((t) => t.id === typeId);
  if (!selected) return;

  durationSelect.innerHTML = `<option value="${selected.durationMinutes}">${selected.durationMinutes} minutes</option>`;
  locationSelect.value = selected.locationMode;
}

async function loadTypes() {
  const { types: remoteTypes } = await api('/api/types');
  types = remoteTypes;

  typeSelect.innerHTML = types
    .map((t) => `<option value="${t.id}">${t.name}</option>`)
    .join('');

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

    await api('/api/public/bookings', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    form.reset();
    showToast('Booked! Confirmation email sent.', 'success');
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
    await loadTypes();
    const dateInput = form.querySelector('input[name="date"]');
    dateInput.value = new Date().toISOString().slice(0, 10);
  } catch (error) {
    showToast('Could not load booking types. Start backend first.', 'error');
  }
});
