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
  const normalizedQuery = String(query || '').trim();
  const requestId = ++state.searchRequestId;
  if (!normalizedQuery) {
    await loadAppointmentsTable();
    return;
  }
  if (normalizedQuery.length < 2) {
    renderAppointmentsTable([]);
    setActiveView('appointments');
    return;
  }
  const { appointments } = await api(`/api/appointments?q=${encodeURIComponent(normalizedQuery)}`);
  if (requestId !== state.searchRequestId) return;
  renderAppointmentsTable(appointments);
  setActiveView('appointments', { skipAppointmentsReload: true });
}

function hideGlobalSearchSuggestions() {
  const suggestions = document.getElementById('global-search-suggestions');
  if (!suggestions) return;
  document.getElementById('global-search')?.setAttribute('aria-expanded', 'false');
  suggestions.innerHTML = '';
  suggestions.classList.add('hidden');
}

function findSettingsSearchMatches(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length < 2) return [];
  return GLOBAL_SEARCH_SETTINGS_OPTIONS
    .map((option) => {
      const haystack = `${option.label} ${Array.isArray(option.keywords) ? option.keywords.join(' ') : ''}`.toLowerCase();
      let score = 0;
      if (haystack.includes(q)) score += 3;
      if (option.label.toLowerCase().includes(q)) score += 2;
      if (Array.isArray(option.keywords) && option.keywords.some((kw) => kw.toLowerCase().includes(q))) score += 1;
      return { ...option, score };
    })
    .filter((option) => option.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function openSettingsSearchOption(option) {
  if (!option) return;
  state.searchRequestId += 1;
  state.searchActive = false;
  state.searchOriginView = null;
  setActiveView('settings');

  const sectionSelector = String(option.sectionSelector || '').trim();
  if (sectionSelector) {
    const section = document.querySelector(sectionSelector);
    const toggle = document.querySelector(`.collapse-toggle-btn[data-collapse-target="${sectionSelector}"]`);
    if (section && toggle) {
      applyCollapseState(toggle, section, false);
    } else {
      section?.classList.remove('is-collapsed');
    }
  }

  const target = document.getElementById(option.targetId);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function renderGlobalSearchSuggestions(query) {
  const suggestions = document.getElementById('global-search-suggestions');
  if (!suggestions) return;
  const matches = findSettingsSearchMatches(query);
  if (!matches.length) {
    hideGlobalSearchSuggestions();
    return;
  }

  suggestions.innerHTML = matches.map((option, idx) => `
    <button
      type="button"
      class="search-suggestion"
      data-settings-match-index="${idx}"
      aria-label="Open ${escapeHtml(option.label)} setting"
    >
      <span>${escapeHtml(option.label)}</span>
      <small>Settings</small>
    </button>
  `).join('');
  document.getElementById('global-search')?.setAttribute('aria-expanded', 'true');
  suggestions.classList.remove('hidden');

  suggestions.querySelectorAll('.search-suggestion[data-settings-match-index]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.settingsMatchIndex);
      const choice = matches[idx];
      const search = document.getElementById('global-search');
      if (search) search.value = '';
      hideGlobalSearchSuggestions();
      openSettingsSearchOption(choice);
    });
  });
}

async function clearSearchAndRestoreView(searchInput) {
  state.searchRequestId += 1;
  if (searchInput) searchInput.value = '';
  hideGlobalSearchSuggestions();
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
  const mobileAuthBtn = document.getElementById('btn-logout-mobile');

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

  if (mobileAuthBtn) {
    const isSignedIn = Boolean(state.currentUser);
    mobileAuthBtn.setAttribute('aria-label', isSignedIn ? 'Logout' : 'Sign In');
    mobileAuthBtn.setAttribute('title', isSignedIn ? 'Logout' : 'Sign In');
    mobileAuthBtn.innerHTML = (isSignedIn ? logoutSvg : loginSvg).trim();
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
    if (state.browserNotificationsEnabled) startReminderNotificationPolling();
    return true;
  } catch (error) {
    if (error?.code === 'OFFLINE' || error?.code === 'NETWORK') {
      const snapshot = loadAuthSnapshot();
      if (snapshot?.user && snapshot?.business) {
        state.currentUser = snapshot.user;
        state.currentBusiness = snapshot.business;
        updateAccountUi();
        hideAuthShell();
        if (state.browserNotificationsEnabled) startReminderNotificationPolling();
        return true;
      }
      // Offline without a cached auth snapshot: keep shell hidden so offline
      // queueing/creation UX is still usable until connectivity returns.
      state.currentUser = null;
      state.currentBusiness = null;
      stopReminderNotificationPolling();
      updateAccountUi();
      hideAuthShell();
      return false;
    }
    state.currentUser = null;
    state.currentBusiness = null;
    stopReminderNotificationPolling();
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
    document.getElementById('sidebar-backdrop')?.classList.remove('visible');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    if (sidebarBackdrop) sidebarBackdrop.hidden = true;
    document.body.classList.remove('sidebar-open');
    document.getElementById('btn-mobile-menu')?.setAttribute('aria-expanded', 'false');
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
    stopReminderNotificationPolling();
    saveAuthSnapshot(null, null);
    updateAccountUi();
    showAuthShell();
  };

  document.getElementById('btn-logout')?.addEventListener('click', handleAuthAction);
  document.getElementById('nav-logout-sidebar')?.addEventListener('click', handleAuthAction);
  document.getElementById('btn-logout-mobile')?.addEventListener('click', handleAuthAction);

  document.getElementById('btn-close-auth-shell')?.addEventListener('click', () => {
    hideAuthShell(true);
  });
}

async function configureDevLoginVisibility() {
  const devBtn = document.getElementById('btn-dev-login');
  const testNotificationBtn = document.getElementById('btn-test-browser-notification');
  if (devBtn) devBtn.classList.add('hidden');
  if (testNotificationBtn) testNotificationBtn.classList.add('hidden');
  if (!devBtn && !testNotificationBtn) return;
  try {
    const response = await fetch('/api/health', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json().catch(() => ({}));
    const showDevOnlyControls = Boolean(body.devLoginEnabled);
    if (devBtn) devBtn.classList.toggle('hidden', !showDevOnlyControls);
    if (testNotificationBtn) testNotificationBtn.classList.toggle('hidden', !showDevOnlyControls);
  } catch (_error) {
    if (devBtn) devBtn.classList.add('hidden');
    if (testNotificationBtn) testNotificationBtn.classList.add('hidden');
  }
}

function bindForms() {
  document.getElementById('appointment-form')?.addEventListener('submit', submitAppointment);
  document.getElementById('type-form')?.addEventListener('submit', submitType);
  document.getElementById('settings-form')?.addEventListener('submit', submitSettings);
  document.getElementById('client-form')?.addEventListener('submit', submitClient);
  document.getElementById('client-note-form')?.addEventListener('submit', submitClientNote);

  document.getElementById('btn-show-add-client')?.addEventListener('click', () => {
    showClientForm(null);
  });
  document.getElementById('btn-close-client-form')?.addEventListener('click', () => {
    closeClientForm();
  });

  document.getElementById('btn-cancel-type-edit')?.addEventListener('click', () => {
    resetTypeForm();
  });

  document.getElementById('btn-refresh-clients')?.addEventListener('click', () => {
    void loadClients().catch(swallowBackgroundAsyncError);
  });
  const queueClientSearch = () => {
    if (state.clientSearchTimer) clearTimeout(state.clientSearchTimer);
    state.clientSearchTimer = setTimeout(() => {
      void loadClients().catch(swallowBackgroundAsyncError);
    }, 220);
  };
  document.getElementById('clients-search')?.addEventListener('input', queueClientSearch);
  document.getElementById('clients-stage-filter')?.addEventListener('change', queueClientSearch);
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
  document.getElementById('btn-import-ai-data')?.addEventListener('click', () => {
    document.getElementById('import-ai-data-file')?.click();
  });
  document.getElementById('import-ai-data-file')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input?.files?.[0];
    await importAiAppointmentsFromFile(file);
    if (input) input.value = '';
  });
  document.getElementById('settings-calendar-show-client-names')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    state.calendarShowClientNames = checked;
    setStoredValue('calendarShowClientNames', checked);
    await refreshCalendarDots();
  });

  document.getElementById('settings-mobile-nav-bottom-tabs')?.addEventListener('change', (e) => {
    const nextMode = applyMobileNavMode(e.currentTarget?.checked ? 'bottom' : 'sidebar');
    showToast(nextMode === 'bottom' ? 'Bottom tabs enabled on mobile' : 'Sidebar menu enabled on mobile', 'success');
  });

  document.getElementById('settings-browser-notifications')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    if (!canUseBrowserNotifications()) {
      showToast('Browser notifications are not supported in this browser.', 'error');
      e.currentTarget.checked = false;
      return;
    }

    if (checked) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        state.browserNotificationsEnabled = false;
        setStoredValue(BROWSER_NOTIFICATIONS_KEY, false);
        e.currentTarget.checked = false;
        showToast('Browser notification permission was not granted.', 'info');
        stopReminderNotificationPolling();
        return;
      }
    }

    state.browserNotificationsEnabled = checked;
    setStoredValue(BROWSER_NOTIFICATIONS_KEY, checked);
    if (checked) {
      startReminderNotificationPolling();
      showToast('Desktop reminder notifications enabled.', 'success');
    } else {
      stopReminderNotificationPolling();
      showToast('Desktop reminder notifications disabled.', 'success');
    }
  });

  document.getElementById('btn-test-browser-notification')?.addEventListener('click', async () => {
    if (!canUseBrowserNotifications()) {
      showToast('Browser notifications are not supported in this browser.', 'error');
      return;
    }

    let permission = getNotificationPermission();
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      showToast('Browser notification permission was not granted.', 'info');
      return;
    }

    const notification = new Notification('Test notification', {
      body: 'Desktop notifications are working for this app.',
      tag: 'test-browser-notification',
      renotify: true
    });
    notification.onclick = () => {
      try { window.focus(); } catch (_error) { }
      notification.close();
    };
    showToast('Test notification sent.', 'success');
  });

  BUSINESS_HOURS_DAYS.forEach((day) => {
    document.getElementById(`settings-hours-${day}-closed`)?.addEventListener('change', (e) => {
      setBusinessHoursRowClosedState(day, Boolean(e.currentTarget?.checked));
    });
  });

  document.querySelectorAll('[data-hours-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.hoursAction;
      const hours = collectBusinessHoursFromForm({ validate: false });
      if (action === 'copy-mon-weekdays') {
        const source = hours.mon || { closed: false, openTime: '09:00', closeTime: '18:00' };
        ['tue', 'wed', 'thu', 'fri'].forEach((day) => setBusinessHoursDayValues(day, source));
      } else if (action === 'set-weekend-closed') {
        setBusinessHoursDayValues('sat', { ...hours.sat, closed: true });
        setBusinessHoursDayValues('sun', { ...hours.sun, closed: true });
      } else if (action === 'reset-default') {
        BUSINESS_HOURS_DAYS.forEach((day) => setBusinessHoursDayValues(day, { closed: false, openTime: '09:00', closeTime: '18:00' }));
      }
    });
  });

  document.getElementById('settings-open-time')?.addEventListener('change', (e) => {
    const value = String(e.currentTarget?.value || '').slice(0, 5);
    if (!value) return;
    BUSINESS_HOURS_DAYS.forEach((day) => {
      const openInput = document.getElementById(`settings-hours-${day}-open`);
      if (openInput && !document.getElementById(`settings-hours-${day}-closed`)?.checked) {
        openInput.value = value;
      }
    });
  });

  document.getElementById('settings-close-time')?.addEventListener('change', (e) => {
    const value = String(e.currentTarget?.value || '').slice(0, 5);
    if (!value) return;
    BUSINESS_HOURS_DAYS.forEach((day) => {
      const closeInput = document.getElementById(`settings-hours-${day}-close`);
      if (closeInput && !document.getElementById(`settings-hours-${day}-closed`)?.checked) {
        closeInput.value = value;
      }
    });
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

  document.getElementById('settings-reminder-mode')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.currentTarget?.checked);
    const previousMode = state.workspaceMode;
    const nextMode = checked ? 'reminders' : 'appointments';
    setWorkspaceMode(nextMode, { persist: true });
    try {
      const result = await queueAwareMutation('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ reminderMode: checked, workspaceMode: nextMode })
      }, {
        allowOfflineQueue: true,
        description: 'Reminder mode update'
      });
      if (!result.queued) {
        showToast(checked ? 'Reminder mode enabled' : 'Appointment mode enabled', 'success');
      }
      await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
      await refreshCalendarDots({ force: true });
    } catch (error) {
      setWorkspaceMode(previousMode, { persist: true });
      showToast(error.message, 'error');
    }
  });

  document.getElementById('settings-workspace-mode')?.addEventListener('change', async (e) => {
    const nextMode = normalizeWorkspaceMode(e.currentTarget?.value || 'appointments');
    const previousMode = state.workspaceMode;
    setWorkspaceMode(nextMode, { persist: true });
    try {
      const reminderEnabled = nextMode === 'reminders';
      const result = await queueAwareMutation('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ reminderMode: reminderEnabled, workspaceMode: nextMode })
      }, {
        allowOfflineQueue: true,
        description: 'Workspace mode update'
      });
      if (!result.queued) {
        showToast(
          nextMode === 'clients'
            ? 'Client mode enabled.'
            : (reminderEnabled ? 'Reminder mode enabled' : 'Appointment mode enabled'),
          'success'
        );
      }
      if (nextMode === 'clients') setActiveView('dashboard');
      await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
      await refreshCalendarDots({ force: true });
      if (nextMode === 'clients') await loadClients();
    } catch (error) {
      setWorkspaceMode(previousMode, { persist: true });
      showToast(error.message, 'error');
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
      renderGlobalSearchSuggestions(query);

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
      window.setTimeout(() => hideGlobalSearchSuggestions(), 120);
      if (!state.searchActive) return;
      const query = String(search.value || '').trim();
      if (query) return;
      await clearSearchAndRestoreView(search);
    });

    search.addEventListener('keydown', async (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      hideGlobalSearchSuggestions();
      await clearSearchAndRestoreView(search);
      search.blur();
    });

    document.addEventListener('click', (e) => {
      if (search.closest('.header-search')?.contains(e.target)) return;
      hideGlobalSearchSuggestions();
    });
  }
}

function applyCollapseState(button, target, collapsed) {
  if (!button || !target) return;
  const shouldCollapse = Boolean(collapsed);
  button.classList.toggle('is-collapsed', shouldCollapse);
  button.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');

  if (target.classList.contains('settings-section')) {
    target.classList.toggle('is-collapsed', shouldCollapse);
    return;
  }

  if (shouldCollapse) {
    target.hidden = true;
    target.classList.add('hidden');
    target.classList.add('is-collapsed');
  } else {
    target.hidden = false;
    target.classList.remove('hidden');
    target.classList.remove('is-collapsed');
  }

  const parentCard = button.closest('.card');
  if (parentCard) {
    parentCard.classList.toggle('is-collapsed', shouldCollapse);
  }
}

function bindCollapsiblePanels() {
  document.querySelectorAll('.collapse-toggle-btn[data-collapse-target]').forEach((button) => {
    const targetSelector = String(button.dataset.collapseTarget || '').trim();
    if (!targetSelector) return;
    const target = document.querySelector(targetSelector);
    if (!target) return;

    const storageKey = String(button.dataset.collapseStorage || '').trim();
    let collapsed = false;
    if (storageKey) {
      collapsed = getStoredBoolean(`panelCollapsed.${storageKey}`, false);
    }
    applyCollapseState(button, target, collapsed);
  });
}

function handleCollapseToggleClick(event) {
  const button = event.target?.closest?.('.collapse-toggle-btn[data-collapse-target]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  const targetSelector = String(button.dataset.collapseTarget || '').trim();
  if (!targetSelector) return;
  const target = document.querySelector(targetSelector);
  if (!target) return;

  const nextCollapsed = button.getAttribute('aria-expanded') === 'true';
  applyCollapseState(button, target, nextCollapsed);

  const storageKey = String(button.dataset.collapseStorage || '').trim();
  if (storageKey) setStoredValue(`panelCollapsed.${storageKey}`, nextCollapsed);
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
  state.calendarViewMode = getStoredCalendarViewMode();
  state.workspaceMode = getStoredWorkspaceMode(state.reminderMode ? 'reminders' : 'appointments');
  state.reminderMode = state.workspaceMode === 'reminders';
  const selectedDate = parseYmd(state.selectedDate);
  if (selectedDate) state.calendarDate = selectedDate;
  bindAuthUi();
  await configureDevLoginVisibility();
  bindNavigation();
  applyMobileNavMode(getStoredMobileNavMode(), { persist: false });
  applyInitialViewPreference(preferredView);
  bindHeaderButtons();
  bindDashboardStatsToggle();
  bindModalControls();
  bindCalendarNav();
  bindKeyboard();
  bindForms();
  bindCollapsiblePanels();
  document.addEventListener('click', handleCollapseToggleClick);
  applyInitialTheme();
  applyReminderModeUi();
  setupTimezoneSearch();
  setupTimezoneSearch('signup-timezone', 'signup-timezone-suggestions');

  const todayInput = document.querySelector('input[name="date"]');
  if (todayInput) todayInput.value = state.selectedDate;

  document.addEventListener('click', (event) => {
    const dayMenu = document.getElementById('calendar-day-menu');
    if (dayMenu && !dayMenu.classList.contains('hidden')) {
      const clickedInMenu = event.target.closest('#calendar-day-menu');
      const clickedOnDay = event.target.closest('.day-cell[data-day]');
      const clickedOnWeekHeader = event.target.closest('.week-day-header[data-week-date]');
      const clickedOnWeekSlot = event.target.closest('.week-slot[data-slot-date][data-slot-time]');
      const clickedOnWeekEvent = event.target.closest('.week-event-chip[data-appointment-id]');
      if (!clickedInMenu && !clickedOnDay && !clickedOnWeekHeader && !clickedOnWeekSlot && !clickedOnWeekEvent) closeDayMenu();
    }

    const quickCreateMenu = document.getElementById('calendar-quick-create-menu');
    if (quickCreateMenu && !quickCreateMenu.classList.contains('hidden')) {
      const clickedInQuickCreate = event.target.closest('#calendar-quick-create-menu');
      const clickedOnSlot = event.target.closest('.week-slot[data-slot-date][data-slot-time]');
      if (!clickedInQuickCreate && !clickedOnSlot) closeQuickCreateMenu();
    }

    const notificationsMenu = document.getElementById('notifications-menu');
    if (notificationsMenu && !notificationsMenu.classList.contains('hidden')) {
      const clickedInNotifications = event.target.closest('#notifications-menu');
      const clickedNotificationButton = event.target.closest('[data-notification-button]');
      if (!clickedInNotifications && !clickedNotificationButton) closeNotificationsMenu();
    }
  });

  window.addEventListener('resize', repositionDayMenuIfOpen);
  window.addEventListener('resize', repositionQuickCreateMenuIfOpen);
  window.addEventListener('resize', repositionNotificationsMenuIfOpen);
  window.addEventListener('scroll', repositionDayMenuIfOpen, true);
  window.addEventListener('scroll', repositionNotificationsMenuIfOpen, true);

  try {
    const authed = await ensureAuth();
    if (!authed) {
      state.apiOnline = true;
      return;
    }
    await Promise.all([
      loadTypes(),
      loadDashboard(state.selectedDate, { refreshDots: false }),
      loadAppointmentsTable(),
      loadSettings()
    ]);
    await refreshCalendarDots({ force: true });
    await flushOfflineMutationQueue();
    state.apiOnline = true;

    if (preferredView) setActiveView(preferredView);
  } catch (error) {
    if (error?.code === 'OFFLINE') {
      state.apiOnline = false;
      showToast(`You are offline. Reconnect to load the latest ${getEntryWordPlural()} data.`, 'info');
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
