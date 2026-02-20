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
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function validatePasswordStrength(password = '') {
  const value = String(password || '');
  if (value.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-z]/.test(value)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(value)) return 'Password must include an uppercase letter.';
  if (!/\d/.test(value)) return 'Password must include a number.';
  if (!/[^A-Za-z0-9]/.test(value)) return 'Password must include a symbol.';
  if (/\s/.test(value)) return 'Password cannot contain spaces.';
  return '';
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('reset-password-form');
  const copy = document.getElementById('reset-copy');
  if (!form) return;

  const token = String(new URLSearchParams(window.location.search).get('token') || '').trim();
  if (!token) {
    if (copy) copy.textContent = 'Reset link is missing a token. Request a new link from sign in.';
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const password = String(data.password || '');
    const passwordConfirm = String(data.passwordConfirm || '');

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      showToast(passwordError, 'error');
      return;
    }
    if (password !== passwordConfirm) {
      showToast('Passwords do not match.', 'error');
      return;
    }

    const submit = form.querySelector('button[type="submit"]');
    const oldText = submit?.textContent || 'Update Password';
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Updating...';
    }

    try {
      await api('/api/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token, password })
      });
      showToast('Password updated. Redirecting to sign in...', 'success');
      setTimeout(() => {
        window.location.href = '/';
      }, 1200);
    } catch (error) {
      showToast(error.message || 'Could not reset password.', 'error');
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = oldText;
      }
    }
  });
});
