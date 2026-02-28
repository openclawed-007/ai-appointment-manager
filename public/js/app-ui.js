function setActiveView(view, options = {}) {
  if (!view) return;
  const { skipAppointmentsReload = false, skipClientsReload = false } = options || {};
  const activeView = resolveView(view);
  if (!activeView) return;
  closeQuickCreateMenu();

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
  if (activeView === 'appointments' && canAutoLoadAppointments && !skipAppointmentsReload) {
    void loadAppointmentsTable().catch(swallowBackgroundAsyncError);
  }
  if (activeView === 'clients' && canAutoLoadAppointments && !skipClientsReload) {
    void loadClients().catch(swallowBackgroundAsyncError);
  }
}

function getActiveView() {
  return document.querySelector('.app-view.active')?.dataset.view || 'dashboard';
}

function toHalfHourSlot(time24 = '09:00') {
  const [hRaw, mRaw] = String(time24 || '09:00').split(':').map(Number);
  const h = Number.isFinite(hRaw) ? hRaw : 9;
  const m = Number.isFinite(mRaw) ? mRaw : 0;
  let totalMinutes = (h * 60) + m;
  // Snap to nearest 30-minute grid slot for calendar placement.
  totalMinutes = Math.round(totalMinutes / 30) * 30;
  if (totalMinutes < 0) totalMinutes = 0;
  if (totalMinutes > (23 * 60 + 30)) totalMinutes = 23 * 60 + 30;
  const slotHour = Math.floor(totalMinutes / 60);
  const slotMinute = totalMinutes % 60;
  return `${String(slotHour).padStart(2, '0')}:${String(slotMinute).padStart(2, '0')}`;
}

async function focusCalendarOnDate(date, { time = '', openMenu = true } = {}) {
  const safeDate = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) return;

  setActiveView('dashboard');
  state.selectedDate = safeDate;

  const dt = new Date(`${safeDate}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return;

  let mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode === 'month' && time) {
    mode = 'week';
    state.calendarViewMode = mode;
    setStoredValue('calendarViewMode', mode);
  }
  state.calendarDate = mode === 'month'
    ? new Date(dt.getFullYear(), dt.getMonth(), 1)
    : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());

  const monthLabelNode = document.querySelector('.current-month');
  if (monthLabelNode) monthLabelNode.textContent = getCalendarHeaderLabel();
  renderCalendarGrid();

  await loadDashboard(safeDate, { refreshDots: false, showSkeleton: false });
  await refreshCalendarDots({ force: true });

  const slot = time
    ? document.querySelector(`.week-slot[data-slot-date="${safeDate}"][data-slot-time="${toHalfHourSlot(time)}"]`)
    : null;
  if (slot) {
    slot.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } else {
    document.querySelector('.calendar-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (!openMenu) return;
  if (mode === 'month') {
    const day = Number(safeDate.slice(8, 10));
    const selectedCell = document.querySelector(`.day-cell[data-day="${day}"]:not(.empty)`);
    if (selectedCell) await openDayMenu(selectedCell, safeDate);
    return;
  }
  const selectedHeader = document.querySelector(`.week-day-header[data-week-date="${safeDate}"]`);
  if (selectedHeader) await openDayMenu(selectedHeader, safeDate);
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
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetView = item.dataset.view || 'dashboard';
      setActiveView(targetView);
    });
  });

  document.getElementById('btn-manage-types')?.addEventListener('click', () => setActiveView('types'));
}

function bindHeaderButtons() {
  const sidebar = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const menuBtn = document.getElementById('btn-mobile-menu');
  const mobileSidebarQuery = window.matchMedia('(max-width: 768px), (hover: none) and (pointer: coarse) and (max-width: 1024px)');

  const setSidebarOpen = (open) => {
    if (!sidebar) return;
    if (open && document.body.classList.contains('mobile-nav-mode-bottom')) return;
    const shouldOpen = Boolean(open);
    sidebar.classList.toggle('mobile-open', shouldOpen);
    document.body.classList.toggle('sidebar-open', shouldOpen);
    if (sidebarBackdrop) {
      sidebarBackdrop.classList.toggle('visible', shouldOpen);
      sidebarBackdrop.hidden = !shouldOpen;
    }
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    }
  };

  const closeSidebar = () => setSidebarOpen(false);

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

  menuBtn?.addEventListener('click', () => {
    if (!mobileSidebarQuery.matches) return;
    if (document.body.classList.contains('mobile-nav-mode-bottom')) return;
    setSidebarOpen(!sidebar?.classList.contains('mobile-open'));
  });

  sidebarBackdrop?.addEventListener('click', closeSidebar);

  document.addEventListener('click', (e) => {
    if (sidebar?.classList.contains('mobile-open')) {
      if (!sidebar.contains(e.target) && !menuBtn?.contains(e.target)) {
        closeSidebar();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar?.classList.contains('mobile-open')) {
      closeSidebar();
    }
  });

  const handleSidebarMediaChange = (event) => {
    if (!event.matches) closeSidebar();
  };
  if (typeof mobileSidebarQuery.addEventListener === 'function') {
    mobileSidebarQuery.addEventListener('change', handleSidebarMediaChange);
  } else if (typeof mobileSidebarQuery.addListener === 'function') {
    mobileSidebarQuery.addListener(handleSidebarMediaChange);
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (sidebar?.classList.contains('mobile-open')) closeSidebar();
    });
  });

  document.getElementById('btn-view-all')?.addEventListener('click', async (e) => {
    state.viewAll = !state.viewAll;
    e.currentTarget.textContent = state.viewAll ? 'Show Day' : 'View All';
    await loadDashboard(state.selectedDate, { refreshDots: false, showSkeleton: false });
  });

  document.getElementById('btn-refresh-appointments')?.addEventListener('click', loadAppointmentsTable);
}

function syncDashboardStatsUi() {
  const collapsed = Boolean(state.dashboardStatsCollapsed);
  document.body.classList.toggle('dashboard-stats-collapsed', collapsed);

  const btn = document.getElementById('btn-toggle-stats');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

  const label = document.querySelector('[data-stats-toggle-label]');
  if (label) label.textContent = collapsed ? 'Show overview' : 'Hide overview';
}

function bindDashboardStatsToggle() {
  syncDashboardStatsUi();
  const btn = document.getElementById('btn-toggle-stats');
  if (!btn) return;

  btn.addEventListener('click', () => {
    state.dashboardStatsCollapsed = !state.dashboardStatsCollapsed;
    setStoredValue('dashboardStatsCollapsed', state.dashboardStatsCollapsed);
    syncDashboardStatsUi();
  });

  document.getElementById('stat-card-pending')?.addEventListener('click', async () => {
    const next = state.nextReminder;
    if (!next?.date) return;
    await focusCalendarOnDate(next.date, { time: next.time, openMenu: false });
  });
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

  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode === 'week' || mode === 'day') {
    renderCalendarTimeGrid();
    return;
  }

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

  grid.classList.remove('google-like');
  grid.classList.remove('google-like-day');
  grid.innerHTML = `${headers}${empties}${days}`;
}

function getCalendarDisplayRangeMinutes() {
  if (isReminderModeEnabled() || isClientModeEnabled()) {
    return { start: 0, end: 24 * 60 };
  }
  const defaultOpen = '08:00';
  const defaultClose = '18:00';
  const openRaw = document.getElementById('settings-open-time')?.value || defaultOpen;
  const closeRaw = document.getElementById('settings-close-time')?.value || defaultClose;
  const openMinutes = timeToMinutes(openRaw);
  const closeMinutes = timeToMinutes(closeRaw);
  if (!Number.isFinite(openMinutes) || !Number.isFinite(closeMinutes) || closeMinutes <= openMinutes) {
    return { start: 8 * 60, end: 18 * 60 };
  }
  return { start: openMinutes, end: closeMinutes };
}

function renderCalendarTimeGrid(timeGridAppointments = [], { loading = false } = {}) {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;

  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  const visibleDates = getVisibleCalendarDates(state.calendarDate, mode);
  const todayYmd = localYmd();
  const selectedDate = state.selectedDate;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const { start, end } = getCalendarDisplayRangeMinutes();
  const slotMinutes = [];
  for (let mins = start; mins < end; mins += 30) slotMinutes.push(mins);

  const apptMap = new Map();
  timeGridAppointments.forEach((appointment) => {
    const date = String(appointment?.date || '');
    const time = String(appointment?.time || '').slice(0, 5);
    if (!date || !time) return;
    const key = `${date} ${toHalfHourSlot(time)}`;
    if (!apptMap.has(key)) apptMap.set(key, []);
    apptMap.get(key).push(appointment);
  });
  apptMap.forEach((items) => {
    items.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  });

  const headerCells = visibleDates.map((date, idx) => {
    const parsed = parseYmd(date);
    const dayIndex = parsed ? parsed.getDay() : idx;
    const isToday = date === todayYmd;
    const isSelected = date === selectedDate;
    const dayNum = Number(String(date).slice(8, 10));
    const classes = ['week-day-header'];
    if (isToday) classes.push('today');
    if (isSelected) classes.push('selected');
    return `
      <button type="button" class="${classes.join(' ')}" data-week-date="${date}" aria-label="Open ${escapeHtml(formatMenuDate(date))}">
        <span class="week-day-name">${dayNames[dayIndex] || ''}</span>
        <span class="week-day-num">${dayNum}</span>
      </button>`;
  }).join('');

  const rows = slotMinutes.map((mins) => {
    const time24 = minutesToTime(mins);
    const rowCells = visibleDates.map((date) => {
      const key = `${date} ${time24}`;
      const appointments = apptMap.get(key) || [];
      const isToday = date === todayYmd;
      const isSelectedDate = date === selectedDate;
      const classes = ['week-slot'];
      if (isToday) classes.push('today');
      if (isSelectedDate) classes.push('selected-day');
      if (appointments.length) classes.push('has-event');
      if (appointments.length === 1) classes.push('has-single-event');
      if (appointments.length > 1) classes.push('has-multiple-events');
      const chips = loading
        ? '<div class="week-slot-skeleton"></div>'
        : appointments.map((a) => `
            <div
              class="week-event-chip"
              data-appointment-id="${Number(a.id)}"
              data-appointment-type-id="${a.typeId != null ? Number(a.typeId) : ''}"
              data-appointment-client-name="${escapeHtml(a.clientName || '')}"
              data-appointment-date="${escapeHtml(a.date || date)}"
              data-appointment-time="${escapeHtml(a.time || time24)}"
              data-appointment-duration="${Number(a.durationMinutes || 45)}"
              data-appointment-reminder-offset="${Number(a.reminderOffsetMinutes == null ? 10 : a.reminderOffsetMinutes)}"
              data-appointment-location="${escapeHtml(a.location || 'office')}"
              data-appointment-source="${escapeHtml(a.source || 'owner')}">
              <span class="week-event-time">${escapeHtml(toTimeCompact(a.time))}</span>
              <span class="week-event-name">${escapeHtml(getCalendarPreviewLabel(a))}</span>
            </div>
          `).join('');
      return `
        <button type="button" class="${classes.join(' ')}" data-slot-date="${date}" data-slot-time="${time24}" aria-label="Add ${escapeHtml(getEntryWordSingularTitle().toLowerCase())} on ${escapeHtml(formatMenuDate(date))} at ${escapeHtml(toTime12(time24))}">
          <div class="week-slot-content">${chips}</div>
        </button>`;
    }).join('');

    return `
      <div class="week-time-label">${escapeHtml(toTime12(time24))}</div>
      ${rowCells}`;
  }).join('');

  grid.classList.add('google-like');
  grid.classList.toggle('google-like-day', mode === 'day');
  grid.innerHTML = `
    <div class="week-grid-corner"></div>
    ${headerCells}
    ${rows}
  `;
}

function syncCalendarViewSelector() {
  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  document.querySelectorAll('.calendar-view-btn[data-calendar-view]').forEach((btn) => {
    const active = btn.dataset.calendarView === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateTimeGridSelectionUi() {
  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode !== 'week' && mode !== 'day') return;
  const selectedDate = state.selectedDate;
  document.querySelectorAll('.week-day-header[data-week-date]').forEach((node) => {
    node.classList.toggle('selected', node.dataset.weekDate === selectedDate);
  });
  document.querySelectorAll('.week-slot[data-slot-date]').forEach((node) => {
    node.classList.toggle('selected-day', node.dataset.slotDate === selectedDate);
  });
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
    if (labelNode) labelNode.textContent = getCalendarHeaderLabel();
    syncCalendarViewSelector();
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
    closeQuickCreateMenu();
    const mode = normalizeCalendarViewMode(state.calendarViewMode);
    if (mode === 'week') {
      state.calendarDate = addDays(state.calendarDate, -7);
    } else if (mode === 'day') {
      state.calendarDate = addDays(state.calendarDate, -1);
    } else {
      state.calendarDate.setMonth(state.calendarDate.getMonth() - 1);
    }
    setMonth();
    await refreshCalendarDots();
  });

  document.getElementById('calendar-next')?.addEventListener('click', async () => {
    closeDayMenu();
    closeQuickCreateMenu();
    const mode = normalizeCalendarViewMode(state.calendarViewMode);
    if (mode === 'week') {
      state.calendarDate = addDays(state.calendarDate, 7);
    } else if (mode === 'day') {
      state.calendarDate = addDays(state.calendarDate, 1);
    } else {
      state.calendarDate.setMonth(state.calendarDate.getMonth() + 1);
    }
    setMonth();
    await refreshCalendarDots();
  });

  document.querySelectorAll('.calendar-view-btn[data-calendar-view]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nextMode = normalizeCalendarViewMode(btn.dataset.calendarView);
      if (state.calendarViewMode === nextMode) return;
      state.calendarViewMode = nextMode;
      setStoredValue('calendarViewMode', nextMode);
      const selectedDate = parseYmd(state.selectedDate);
      if (selectedDate) state.calendarDate = selectedDate;
      closeDayMenu();
      closeQuickCreateMenu();
      setMonth();
      await refreshCalendarDots();
    });
  });

  document.getElementById('calendar-grid')?.addEventListener('click', (event) => {
    const mode = normalizeCalendarViewMode(state.calendarViewMode);
    if (mode === 'week' || mode === 'day') {
      const dayHeader = event.target.closest('.week-day-header[data-week-date]');
      if (dayHeader) {
        const date = dayHeader.dataset.weekDate;
        if (!date) return;
        state.selectedDate = date;
        closeQuickCreateMenu();
        state.viewAll = false;
        const btn = document.getElementById('btn-view-all');
        if (btn) btn.textContent = 'View All';
        void loadDashboard(date, { refreshDots: false }).catch(swallowBackgroundAsyncError);
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          showToast(`Offline mode: open a time slot to create a ${getEntryWordSingularTitle().toLowerCase()}.`, 'info');
          return;
        }
        void openDayMenu(dayHeader, date).catch(swallowBackgroundAsyncError);
        updateTimeGridSelectionUi();
        return;
      }

      const eventCard = event.target.closest('.week-event-chip[data-appointment-id]');
      if (eventCard) {
        const date = String(eventCard.dataset.appointmentDate || '');
        const time = String(eventCard.dataset.appointmentTime || '').slice(0, 5);
        if (!date) return;
        state.selectedDate = date;
        state.viewAll = false;
        const btn = document.getElementById('btn-view-all');
        if (btn) btn.textContent = 'View All';
        closeQuickCreateMenu();
        void loadDashboard(date, { refreshDots: false }).catch(swallowBackgroundAsyncError);
        void openDayMenu(eventCard, date, { prefillTime: /^\d{2}:\d{2}$/.test(time) ? time : '' }).catch(swallowBackgroundAsyncError);
        updateTimeGridSelectionUi();
        return;
      }

      const slot = event.target.closest('.week-slot[data-slot-date][data-slot-time]');
      if (!slot) return;
      const date = slot.dataset.slotDate;
      const time = slot.dataset.slotTime;
      if (!date || !time) return;
      state.selectedDate = date;
      state.viewAll = false;
      const btn = document.getElementById('btn-view-all');
      if (btn) btn.textContent = 'View All';
      closeQuickCreateMenu();
      void loadDashboard(date, { refreshDots: false }).catch(swallowBackgroundAsyncError);
      void openDayMenu(slot, date, { prefillTime: time }).catch(swallowBackgroundAsyncError);
      updateTimeGridSelectionUi();
      return;
    }

    const dayCell = event.target.closest('.day-cell[data-day]');
    if (!dayCell) return;
    closeQuickCreateMenu();

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
      showToast(`Offline mode: creating ${getEntryWordSingularTitle().toLowerCase()} for selected date.`, 'info');
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
        closeQuickCreateMenu();
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
      if (!state.editingAppointmentId) {
        setAppointmentFormLocation(resolveDefaultLocationForType(selected));
      }
      updateAppointmentPreview();
    });
  });

  if (!state.editingAppointmentId) {
    const selected = state.types.find((t) => t.id === state.selectedTypeId);
    setAppointmentFormLocation(resolveDefaultLocationForType(selected));
  }

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
  const form = document.getElementById('appointment-form');
  const isReminder = isReminderModeEnabled() || String(form?.dataset?.entrySource || '').toLowerCase() === 'reminder';

  if (isReminder) {
    typeNode.textContent = 'Reminder';
  } else {
    typeNode.textContent = selectedType
      ? `${selectedType.name} • ${durationSelect?.value || selectedType.durationMinutes} min`
      : 'Pick a service type';
  }

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

  if (!state.editingAppointmentId) {
    const selectedType = state.types.find((t) => Number(t.id) === Number(state.selectedTypeId));
    setAppointmentFormLocation(resolveDefaultLocationForType(selectedType));
    if (form.reminderOffsetMinutes && !form.reminderOffsetMinutes.value) {
      form.reminderOffsetMinutes.value = '10';
    }
    form.dataset.entrySource = isReminderModeEnabled() ? 'reminder' : 'owner';
  }

  syncAppointmentDurationFieldVisibility();
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

function renderStats(stats = {}, options = {}) {
  const reminderModeEnabled = isReminderModeEnabled();
  const nextUpcoming = options.nextUpcoming || options.nextReminder || null;
  const pendingCount = Number(stats.pending || 0);
  const hasPending = pendingCount > 0;
  state.nextReminder = hasPending ? null : nextUpcoming;
  document.getElementById('stat-today').textContent = stats.today ?? 0;
  document.getElementById('stat-week').textContent = stats.week ?? 0;

  const pendingLabel = document.querySelector('#stat-card-pending .stat-label');
  const pendingValue = document.getElementById('stat-pending');
  const pendingHint = document.querySelector('#stat-card-pending .stat-hint');
  const pendingCard = document.getElementById('stat-card-pending');
  if (hasPending) {
    if (pendingLabel) pendingLabel.textContent = 'Pending';
    pendingValue?.classList.remove('is-reminder-title');
    if (pendingValue) pendingValue.textContent = pendingCount;
    pendingCard?.classList.remove('is-clickable');
    if (pendingHint) pendingHint.textContent = reminderModeEnabled ? 'awaiting completion' : 'awaiting confirmation';
  } else {
    if (pendingLabel) pendingLabel.textContent = 'Upcoming';
    pendingValue?.classList.add('is-reminder-title');
    pendingCard?.classList.toggle('is-clickable', Boolean(nextUpcoming?.date));
    if (nextUpcoming?.date && nextUpcoming?.time) {
      const upcomingText = String(
        nextUpcoming.clientName || nextUpcoming.title || nextUpcoming.typeName || (reminderModeEnabled ? 'Reminder' : 'Appointment')
      ).trim();
      const shortUpcomingText = upcomingText.length > 52 ? `${upcomingText.slice(0, 49)}...` : upcomingText;
      const relative = formatUpcomingRelative(nextUpcoming.date, nextUpcoming.time);
      if (pendingValue) pendingValue.textContent = `${relative} • ${shortUpcomingText}`;
      if (pendingHint) {
        if (String(nextUpcoming.date).slice(0, 10) === localYmd()) {
          pendingHint.textContent = 'Today';
        } else {
          const dt = new Date(`${String(nextUpcoming.date).slice(0, 10)}T00:00:00`);
          pendingHint.textContent = Number.isNaN(dt.getTime())
            ? String(nextUpcoming.date).slice(0, 10)
            : dt.toLocaleDateString('en-US', { weekday: 'long' });
        }
      }
    } else {
      if (pendingValue) pendingValue.textContent = '--';
      if (pendingHint) pendingHint.textContent = 'No upcoming scheduled.';
    }
  }

  state.unreadNotifications = pendingCount;
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

async function refreshCalendarTimeGrid(options = {}) {
  const { force = false } = options;
  const requestId = ++state.calendarWeekRequestId;
  renderCalendarTimeGrid([], { loading: true });

  const visibleDates = getVisibleCalendarDates(state.calendarDate, state.calendarViewMode);
  const months = Array.from(new Set(
    visibleDates
      .map((date) => parseYmd(date))
      .filter(Boolean)
      .map((dt) => toMonthParam(dt))
  ));

  try {
    const monthResults = await Promise.all(months.map((month) => fetchCalendarMonth(month, { force })));
    if (requestId !== state.calendarWeekRequestId) return;
    const weekSet = new Set(visibleDates);
    const appointments = monthResults
      .flat()
      .filter((a) => weekSet.has(String(a?.date || '')));
    renderCalendarTimeGrid(appointments, { loading: false });
  } catch (_error) {
    if (requestId !== state.calendarWeekRequestId) return;
    renderCalendarTimeGrid([], { loading: false });
  }
}

async function refreshCalendarDots(options = {}) {
  const mode = normalizeCalendarViewMode(state.calendarViewMode);
  if (mode === 'week' || mode === 'day') {
    await refreshCalendarTimeGrid(options);
    return;
  }
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
  const emptyMessage = options.emptyMessage || `No ${getEntryWordPlural()} for this day yet.`;
  const includeDate = Boolean(options.includeDate);
  if (!appointments.length) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => {
        const statusClass = `status-${(a.status || 'pending').toLowerCase()}`;
        const isReminder = isReminderEntry(a) || Number(a.durationMinutes || 0) <= 0;
        return `
      <div class="timeline-item" data-id="${a.id}">
        <div class="time-column">
          <div class="time-start">${toTime12(a.time)}</div>
          <div class="time-end">${isReminder ? '' : toTime12(addMinutesToTime(a.time, a.durationMinutes))}</div>
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
              ${isReminder ? '' : `<span>⏱ ${a.durationMinutes} min</span>`}
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
    root.innerHTML = `<div class="empty-state">No completed ${getEntryWordPlural()} yet.</div>`;
    return;
  }

  root.innerHTML = appointments
    .map(
      (a) => `
      <div class="completed-item">
        <div class="completed-item-main">
          <strong class="client-name">${escapeHtml(a.clientName || 'Client')}</strong>
          <span class="appointment-type-tag">${escapeHtml(a.typeName || a.title || getEntryWordSingularTitle())}</span>
        </div>
        <div class="completed-item-meta">
          <span>${escapeHtml(formatScheduleDate(a.date))}</span>
          <span class="time-range">${escapeHtml(formatEntryTimeRange(a))}</span>
        </div>
      </div>`
    )
    .join('');
}

function renderTypes(types = []) {
  const root = document.getElementById('type-list');
  const adminRoot = document.getElementById('type-admin-list');
  const countPill = document.getElementById('types-count-pill');
  if (countPill) countPill.textContent = String(Array.isArray(types) ? types.length : 0);

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
            <article class="service-type-card" data-type-id="${t.id}">
              <div class="service-type-main">
                <span class="service-type-color" style="background:${escapeHtml(t.color)}"></span>
                <div class="service-type-copy">
                  <strong>${escapeHtml(t.name)}</strong>
                  <div class="service-type-meta">
                    <span class="service-chip">${t.durationMinutes} min</span>
                    <span class="service-chip">${toMoney(t.priceCents)}</span>
                    <span class="service-chip">${escapeHtml(t.locationMode)}</span>
                    <span class="service-chip service-chip-count">${t.bookingCount || 0} booking${(t.bookingCount || 0) === 1 ? '' : 's'}</span>
                  </div>
                </div>
              </div>
              <div class="service-type-actions">
                <button class="btn-secondary btn-sm btn-edit-type" type="button" aria-label="Edit Type">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"/></svg>
                  Edit
                </button>
                <div class="service-type-more-wrap">
                  <button class="btn-secondary btn-sm btn-type-more" type="button" aria-expanded="false">More</button>
                  <div class="service-type-more-menu hidden">
                    <button class="btn-secondary btn-sm btn-delete-type" type="button" aria-label="Delete Type">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                      Archive
                    </button>
                  </div>
                </div>
              </div>
            </article>`
        )
        .join('');

  if (root) root.innerHTML = html;
  if (adminRoot) {
    adminRoot.innerHTML = adminHtml;

    adminRoot.querySelectorAll('.service-type-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        const typeId = card.dataset.typeId;
        if (typeId) setTypeFormForEditing(typeId);
      });
    });

    adminRoot.querySelectorAll('.btn-type-more').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const wrap = btn.closest('.service-type-more-wrap');
        const menu = wrap?.querySelector('.service-type-more-menu');
        if (!menu) return;
        const opening = menu.classList.contains('hidden');
        adminRoot.querySelectorAll('.service-type-more-menu').forEach((node) => node.classList.add('hidden'));
        adminRoot.querySelectorAll('.btn-type-more').forEach((node) => node.setAttribute('aria-expanded', 'false'));
        if (opening) {
          menu.classList.remove('hidden');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });

    adminRoot.querySelectorAll('.btn-edit-type').forEach((btn) => {
      btn.addEventListener('click', () => {
        const typeId = btn.closest('.service-type-card')?.dataset.typeId;
        if (typeId) setTypeFormForEditing(typeId);
      });
    });

    adminRoot.querySelectorAll('.btn-delete-type').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const typeId = btn.closest('.service-type-card')?.dataset.typeId;
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

function getInsightPriority(insight = {}) {
  const icon = String(insight.icon || '');
  const text = String(insight.text || '').toLowerCase();
  const action = String(insight.action || '').toLowerCase();
  const time = String(insight.time || '').toLowerCase();
  const combined = `${text} ${action} ${time}`;

  if (time.includes('action now')) return 'high';
  if (/⚠️|📉|📬|🧱|🧭|🔥/.test(icon)) return 'high';
  if (/pending|cancel|down|risk|overload|heaviest|declin|churn|recover/.test(combined)) return 'high';
  if (/optimiz|protect|prioritize|fit|slot|buffer|momentum|utili/.test(combined)) return 'medium';
  return 'low';
}

function cleanInsightTitle(text = '') {
  const safe = String(text || '').trim();
  if (!safe) return 'Insight';
  const sentence = safe.split('. ')[0] || safe;
  return sentence.replace(/\.$/, '');
}

function isLowValueInsight(insight = {}) {
  const text = String(insight.text || '').toLowerCase();
  const action = String(insight.action || '').toLowerCase();
  return /timezone/.test(text) || /timezone/.test(action) || /configuration/.test(String(insight.time || '').toLowerCase());
}

function renderInsightSection(title, subtitle, priority, items = []) {
  if (!items.length) return '';
  const cards = items
    .map((i) => `
      <article class="insight-card insight-card-${escapeHtml(priority)}">
        <div class="insight-card-head">
          <span class="insight-card-icon">${escapeHtml(i.icon || '•')}</span>
          ${i.time ? `<span class="insight-card-time">${escapeHtml(i.time)}</span>` : ''}
        </div>
        <p class="insight-card-title">${escapeHtml(cleanInsightTitle(i.text || ''))}</p>
        ${i.action ? `<p class="insight-card-action">${escapeHtml(i.action)}</p>` : ''}
      </article>
    `)
    .join('');

  return `
    <section class="insight-section insight-section-${escapeHtml(priority)}">
      <header class="insight-section-head">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(subtitle)}</p>
      </header>
      <div class="insight-card-list">
        ${cards}
      </div>
    </section>
  `;
}

function renderInsights(insights = []) {
  const prioritized = (Array.isArray(insights) ? insights : [])
    .map((i) => ({ ...i, priority: getInsightPriority(i) }))
    .filter((i) => !isLowValueInsight(i))
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3);
    });

  const useful = prioritized.length ? prioritized.slice(0, 9) : [];
  const groups = {
    high: useful.filter((i) => i.priority === 'high').slice(0, 3),
    medium: useful.filter((i) => i.priority === 'medium').slice(0, 3),
    low: useful.filter((i) => i.priority === 'low').slice(0, 3)
  };
  const sections = [
    renderInsightSection('Needs Attention', 'Resolve these first', 'high', groups.high),
    renderInsightSection('Opportunities', 'Actions that can improve results', 'medium', groups.medium),
    renderInsightSection('Watchlist', 'Useful context while planning', 'low', groups.low)
  ].filter(Boolean).join('');
  const summaryLabel = groups.high.length > 0
    ? `${groups.high.length} priority item${groups.high.length === 1 ? '' : 's'} to handle now`
    : 'No urgent issues detected today';

  const html =
    useful.length === 0
      ? '<div class="empty-state">No urgent insights right now. You are on track.</div>'
      : `
        <div class="insights-layout">
          <div class="insights-overview">
            <div class="insights-overview-main">
              <h3>Daily Focus</h3>
              <p>${escapeHtml(summaryLabel)}</p>
            </div>
            <div class="insights-overview-metrics">
              <div class="insight-metric metric-high"><strong>${groups.high.length}</strong><span>High</span></div>
              <div class="insight-metric metric-medium"><strong>${groups.medium.length}</strong><span>Medium</span></div>
              <div class="insight-metric metric-low"><strong>${groups.low.length}</strong><span>Low</span></div>
            </div>
          </div>
          <div class="insights-sections">
            ${sections}
          </div>
        </div>`;

  const fullRoot = document.getElementById('ai-full-list');
  if (fullRoot) fullRoot.innerHTML = html;
}

function renderAppointmentsTable(appointments = []) {
  const root = document.getElementById('appointments-table');
  if (!root) return;
  const countPill = document.getElementById('appointments-count-pill');
  if (countPill) countPill.textContent = String(Array.isArray(appointments) ? appointments.length : 0);

  // Store appointments in state so detail view can access them
  state.appointments = appointments;

  if (!appointments.length) {
    root.innerHTML = `<div class="empty-state">No ${getEntryWordPlural()} found.</div>`;
    renderAppointmentDetail(null);
    return;
  }

  root.innerHTML = appointments
    .map((a) => {
      const statusClass = `status-${(a.status || 'pending').toLowerCase()}`;
      const isActive = Number(a.id) === Number(state.selectedAppointmentId) ? 'active' : '';
      return `
        <div class="data-row ${isActive}" data-id="${a.id}">
          <div class="appointment-row-main">
            <strong class="client-name appointment-row-title">${escapeHtml(a.clientName)}</strong>
            <div class="appointment-row-meta">
              <span class="appointment-type-tag">${escapeHtml(a.typeName)}</span>
              <span class="appointment-row-location">${escapeHtml(a.location || 'Office')}</span>
            </div>
          </div>
          <div class="appointment-row-side">
            <span class="status-badge ${statusClass} appointment-row-status">${escapeHtml(a.status)}</span>
            <div class="client-note-preview appointment-row-when">
                ${escapeHtml(formatScheduleDate(a.date))}
            </div>
            <div class="appointment-row-time">${escapeHtml(formatEntryTimeRange(a))}</div>
          </div>
          <div class="appointment-row-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </div>
        </div>`;
    })
    .join('');

  root.querySelectorAll('.data-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.id);
      if (!Number.isFinite(id) || id <= 0) return;
      state.selectedAppointmentId = id;

      // Update active state in UI immediately
      root.querySelectorAll('.data-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');

      const appointment = state.appointments.find(a => Number(a.id) === id);
      renderAppointmentDetail(appointment);

      // Auto-scroll to detail panel on narrow screens
      if (window.innerWidth <= 1024) {
        document.getElementById('appointment-detail-panel-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Render first item's details if nothing selected or selection is invalid
  if (!state.selectedAppointmentId || !appointments.some(a => Number(a.id) === Number(state.selectedAppointmentId))) {
    state.selectedAppointmentId = appointments[0]?.id || null;
    if (state.selectedAppointmentId) {
      const firstRow = root.querySelector('.data-row');
      if (firstRow) firstRow.classList.add('active');
      renderAppointmentDetail(appointments[0]);
    } else {
      renderAppointmentDetail(null);
    }
  } else {
    const appointment = appointments.find(a => Number(a.id) === Number(state.selectedAppointmentId));
    renderAppointmentDetail(appointment);
  }
}

function renderAppointmentDetail(appointment = null) {
  const root = document.getElementById('appointment-detail-panel-wrapper');
  if (!root) return;
  if (!appointment) {
    root.innerHTML = `<div class="card empty-detail-card"><div class="empty-state">Select an appointment to view details.</div></div>`;
    return;
  }

  const reminderModeEnabled = isReminderModeEnabled();
  const statusClass = `status-${(appointment.status || 'pending').toLowerCase()}`;

  let actionsHtml = `
    <button class="btn-secondary btn-sm btn-edit" data-id="${appointment.id}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"></path></svg>
      Edit
    </button>
  `;

  if (!reminderModeEnabled) {
    if (appointment.clientEmail) {
      actionsHtml += `
            <button class="btn-secondary btn-sm btn-email" data-id="${appointment.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
              Email
            </button>
          `;
    }
    if (appointment.status === 'pending') {
      actionsHtml += `
            <button class="btn-secondary btn-sm btn-confirm-booking" data-id="${appointment.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
              Confirm
            </button>
          `;
    }
  }

  if (appointment.status !== 'completed' && appointment.status !== 'cancelled') {
    actionsHtml += `
        <button class="btn-secondary btn-sm btn-complete" data-id="${appointment.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
          ${reminderModeEnabled ? 'Done' : 'Complete'}
        </button>
      `;
  }

  if (!reminderModeEnabled && appointment.status !== 'cancelled') {
    actionsHtml += `
        <button class="btn-secondary btn-sm btn-cancel" data-id="${appointment.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
          Cancel
        </button>
      `;
  }

  actionsHtml += `
    <button class="btn-secondary btn-sm btn-danger btn-delete" data-id="${appointment.id}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      Delete
    </button>
  `;

  root.innerHTML = `
    <div class="card detail-panel-header-card appointment-detail-card">
      <div class="detail-panel-top-actions appointment-detail-actions">
        ${actionsHtml}
      </div>

      <div class="detail-panel-summary">
        <div class="detail-panel-head">
          <strong>${escapeHtml(appointment.clientName || 'Unnamed Client')}</strong>
          <span class="status-badge ${statusClass}">${escapeHtml(appointment.status)}</span>
        </div>
        <div class="detail-panel-progress">${escapeHtml(appointment.typeName || 'General Appointment')}</div>
        <div class="detail-panel-stats">
          <div class="detail-panel-stat">
            <span>Date</span>
            <strong>${escapeHtml(formatScheduleDate(appointment.date))}</strong>
          </div>
          <div class="detail-panel-stat">
            <span>Time</span>
            <strong>${escapeHtml(formatEntryTimeRange(appointment))}</strong>
          </div>
          <div class="detail-panel-stat">
            <span>Location</span>
            <strong>${escapeHtml(appointment.location || 'office')}</strong>
          </div>
          ${!reminderModeEnabled && appointment.clientEmail ? `
          <div class="detail-panel-stat">
            <span>Email</span>
            <strong>${escapeHtml(appointment.clientEmail)}</strong>
          </div>` : ''}
        </div>
      </div>
    </div>

    ${appointment.notes ? `
    <div class="card appointment-notes-card">
        <div class="card-header">
            <h2>Notes</h2>
        </div>
        <div class="appointment-notes-body">
            <p class="appointment-notes-copy">${escapeHtml(appointment.notes)}</p>
        </div>
    </div>` : ''}
  `;

  // Attach listeners
  root.querySelector('.btn-edit')?.addEventListener('click', () => startEditAppointment(appointment));

  root.querySelector('.btn-email')?.addEventListener('click', async () => {
    await openEmailComposerMenu(appointment.id);
  });

  root.querySelector('.btn-complete')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    try {
      const result = await queueAwareMutation(`/api/appointments/${appointment.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' })
      }, { allowOfflineQueue: true });
      if (result.queued) return;
      showToast('Marked as completed', 'success');
      await loadAppointmentsTable();
      await loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  root.querySelector('.btn-confirm-booking')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.innerHTML = 'Confirming...';
    try {
      const result = await queueAwareMutation(`/api/appointments/${appointment.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'confirmed' })
      }, { allowOfflineQueue: true });
      if (result.queued) {
        btn.classList.remove('is-busy');
        btn.innerHTML = 'Queued';
        return;
      }
      showToast('Appointment confirmed!', 'success');
      await loadAppointmentsTable();
      await loadDashboard();
      await refreshCalendarDots({ force: true });
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.innerHTML = originalText;
    }
  });

  root.querySelector('.btn-cancel')?.addEventListener('click', async () => {
    await openCancelReasonMenu(appointment.id);
  });

  root.querySelector('.btn-delete')?.addEventListener('click', async () => {
    if (await showConfirm('Delete', `Are you sure you want to delete this ${reminderModeEnabled ? 'reminder' : 'appointment'}?`)) {
      try {
        const result = await queueAwareMutation(`/api/appointments/${appointment.id}`, { method: 'DELETE' }, { allowOfflineQueue: true });
        if (result.queued) return;
        showToast('Deleted successfully', 'success');
        state.selectedAppointmentId = null;
        await loadAppointmentsTable();
        await loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });
}

function formatClientStage(stage = '') {
  const normalized = String(stage || '').trim().toLowerCase();
  if (normalized === 'in_progress') return 'In Progress';
  if (normalized === 'on_hold') return 'On Hold';
  if (!normalized) return 'New';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function renderClientDetail(client = null, notes = [], appointments = []) {
  const root = document.getElementById('client-detail-panel-wrapper');
  if (!root) return;
  if (!client) {
    root.innerHTML = `<div class="card empty-detail-card"><div class="empty-state">Select a client to view details.</div></div>`;
    return;
  }

  const upcoming = appointments
    .filter((item) => isAtOrAfterNow(item.date || '', item.time || '09:00'))
    .sort((a, b) => {
      const aKey = `${String(a.date || '')} ${String(a.time || '')}`;
      const bKey = `${String(b.date || '')} ${String(b.time || '')}`;
      return aKey.localeCompare(bKey);
    })[0] || null;

  const nextAppointmentLabel = upcoming
    ? `${formatScheduleDate(upcoming.date || '')} • ${toTime12(upcoming.time || '09:00')}`
    : 'No upcoming appointment';

  const notesHtml = notes.length
    ? `<div class="client-note-list">${notes.slice(0, 3).map((item) => `
      <article class="client-note-item">
        <p>${escapeHtml(item.note || '')}</p>
        <small>${escapeHtml(formatScheduleDate(String(item.createdAt || '').slice(0, 10)))}</small>
      </article>
    `).join('')}</div>`
    : '<div class="empty-state">No notes yet.</div>';

  const appointmentsHtml = appointments.length
    ? `<div class="client-note-list">${appointments.slice(0, 3).map((item) => `
      <article class="client-note-item client-appointment-item">
        <p><strong>${escapeHtml(item.typeName || 'Appointment')}</strong></p>
        <small>${escapeHtml(formatScheduleDate(item.date || ''))} • ${escapeHtml(toTime12(item.time || '09:00'))} • ${escapeHtml(formatClientStage(item.status || 'pending'))}</small>
      </article>
    `).join('')}</div>`
    : '<div class="empty-state">No related appointments yet.</div>';

  root.innerHTML = `
    <div class="card detail-panel-header-card client-detail-card">
      <div class="detail-panel-top-actions client-detail-actions">
        <button class="btn-secondary btn-sm" id="btn-book-for-client" data-name="${escapeHtml(client.name)}" data-email="${escapeHtml(client.email || '')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
          Book
        </button>
        <button class="btn-secondary btn-sm" id="btn-focus-client-note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
          Add Note
        </button>
        <div class="client-more-wrap">
          <button class="btn-secondary btn-sm" id="btn-client-more" aria-expanded="false">More</button>
          <div class="client-more-menu hidden" id="client-more-menu">
            <button class="btn-secondary btn-sm" id="btn-edit-client" data-id="${client.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"></path></svg>
              Edit
            </button>
            <button class="btn-secondary btn-sm btn-danger" id="btn-delete-client" data-id="${client.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              Archive
            </button>
          </div>
        </div>
      </div>

      <div class="detail-panel-summary">
        <div class="detail-panel-head">
          <strong>${escapeHtml(client.name || '')}</strong>
          <span class="client-stage-pill">${escapeHtml(formatClientStage(client.stage))}</span>
        </div>
        <div class="detail-panel-progress">${escapeHtml(client.progressSummary || 'No progress summary yet.')}</div>
        <div class="detail-panel-stats">
          <div class="detail-panel-stat">
            <span>Email</span>
            <strong>${escapeHtml(client.email || 'No email')}</strong>
          </div>
          <div class="detail-panel-stat">
            <span>Phone</span>
            <strong>${escapeHtml(client.phone || 'No phone')}</strong>
          </div>
          <div class="detail-panel-stat">
            <span>Next Appointment</span>
            <strong>${escapeHtml(nextAppointmentLabel)}</strong>
          </div>
        </div>
      </div>
    </div>

    <div class="card client-activity-card">
        <div class="card-header">
            <h2>Activity & Notes</h2>
        </div>

        <form class="modal-form client-note-form" id="client-note-form" data-client-id="${client.id}">
            <div class="form-group client-note-text-group">
                <textarea id="client-note-text" name="note" rows="2" placeholder="Write a new progress note..." maxlength="5000" required></textarea>
            </div>
            <div class="client-note-toolbar">
                <button type="button" class="btn-text client-note-stage-toggle" id="btn-toggle-client-stage">Update stage</button>
            </div>
            <div class="form-row client-note-controls hidden" id="client-note-controls-advanced">
                <div class="form-group client-note-stage-group">
                    <label for="client-note-stage" class="client-note-stage-label">Update Stage (Optional)</label>
                    <select id="client-note-stage" name="stage">
                        <option value="">No change</option>
                        <option value="new">New</option>
                        <option value="in_progress">In Progress</option>
                        <option value="waiting">Waiting</option>
                        <option value="completed">Completed</option>
                        <option value="on_hold">On Hold</option>
                    </select>
                </div>
                <div class="form-actions client-note-actions">
                    <button type="button" class="btn-secondary btn-sm" id="btn-cancel-client-stage">Close</button>
                </div>
            </div>
            <div class="form-actions client-note-submit-row">
                <button type="submit" class="btn-primary">Post Note</button>
            </div>
        </form>

        <div class="client-activity-body">
            <h3 class="client-activity-heading">Recent Notes</h3>
            ${notesHtml}
            <details class="client-appointments-collapse">
              <summary>Recent Appointments</summary>
              ${appointmentsHtml}
            </details>
        </div>
    </div>
  `;

  // Attach listeners to the newly rendered detail actions
  document.getElementById('btn-edit-client')?.addEventListener('click', () => {
    showClientForm(client);
  });

  document.getElementById('btn-delete-client')?.addEventListener('click', async () => {
    if (await showConfirm('Archive Client', `Are you sure you want to archive ${client.name}? This will hide them from active lists.`)) {
      try {
        await api(`/api/clients/${client.id}`, { method: 'DELETE' });
        showToast('Client archived.', 'success');
        state.selectedClientId = null;
        await loadClients();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });

  document.getElementById('btn-book-for-client')?.addEventListener('click', () => {
    openNewAppointmentModalForDate(localYmd());
    const form = document.getElementById('appointment-form');
    if (form) {
      form.clientName.value = client.name || '';
      form.clientEmail.value = client.email || '';
      updateAppointmentPreview();
    }
  });

  document.getElementById('btn-focus-client-note')?.addEventListener('click', () => {
    document.getElementById('client-note-text')?.focus();
  });

  const moreBtn = document.getElementById('btn-client-more');
  const moreMenu = document.getElementById('client-more-menu');
  moreBtn?.addEventListener('click', () => {
    if (!moreMenu) return;
    const opening = moreMenu.classList.contains('hidden');
    moreMenu.classList.toggle('hidden', !opening);
    moreBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });

  const stageToggle = document.getElementById('btn-toggle-client-stage');
  const stageControls = document.getElementById('client-note-controls-advanced');
  const cancelStage = document.getElementById('btn-cancel-client-stage');
  const closeStageControls = () => stageControls?.classList.add('hidden');
  stageToggle?.addEventListener('click', () => stageControls?.classList.remove('hidden'));
  cancelStage?.addEventListener('click', closeStageControls);

  document.getElementById('client-note-form')?.addEventListener('submit', submitClientNote);
}

function renderClientsTable(clients = []) {
  const root = document.getElementById('clients-table');
  if (!root) return;
  const countPill = document.getElementById('clients-count-pill');
  if (countPill) countPill.textContent = String(Array.isArray(clients) ? clients.length : 0);
  if (!clients.length) {
    root.innerHTML = '<div class="empty-state">No clients found.</div>';
    renderClientDetail(null, [], []);
    return;
  }

  root.innerHTML = clients.map((client) => `
    <div class="data-row ${Number(client.id) === Number(state.selectedClientId) ? 'active' : ''}" data-client-id="${Number(client.id)}">
      <div class="client-row-main">
        <strong class="client-name client-row-title">${escapeHtml(client.name || '')}</strong>
        <span class="client-note-preview client-row-note">${escapeHtml(client.lastNote || client.progressSummary || 'No notes yet')}</span>
      </div>
      <div class="client-row-side">
        <span class="client-stage-pill client-row-stage">${escapeHtml(formatClientStage(client.stage))}</span>
        <div class="client-note-preview client-row-next">
            ${client.nextAppointmentDate ? formatScheduleDate(client.nextAppointmentDate) : 'No upcoming appointment'}
        </div>
      </div>
      <div class="client-row-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </div>
    </div>
  `).join('');

  root.querySelectorAll('.data-row[data-client-id]').forEach((row) => {
    row.addEventListener('click', async () => {
      const clientId = Number(row.dataset.clientId);
      if (!Number.isFinite(clientId) || clientId <= 0) return;
      state.selectedClientId = clientId;

      // Hide form if it was open
      document.getElementById('client-form-container').style.display = 'none';
      document.getElementById('client-detail-panel-wrapper').style.display = 'flex';

      renderClientsTable(state.clients);
      await loadClientDetail(clientId);

      // Auto-scroll to detail panel on narrow screens
      if (window.innerWidth <= 1024) {
        document.getElementById('client-detail-panel-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

function showClientForm(client = null) {
  const container = document.getElementById('client-form-container');
  const detailWrapper = document.getElementById('client-detail-panel-wrapper');
  const form = document.getElementById('client-form');
  const title = document.getElementById('client-form-title');
  const saveBtn = document.getElementById('btn-save-client');

  if (!container || !detailWrapper || !form) return;

  form.reset();
  if (client) {
    title.textContent = 'Edit Client';
    saveBtn.textContent = 'Update Client';
    document.getElementById('client-id').value = client.id;
    document.getElementById('client-name').value = client.name || '';
    document.getElementById('client-email').value = client.email || '';
    document.getElementById('client-phone').value = client.phone || '';
    document.getElementById('client-stage').value = client.stage || 'new';
    document.getElementById('client-progress-summary').value = client.progressSummary || '';
  } else {
    title.textContent = 'Add Client';
    saveBtn.textContent = 'Save Client';
    document.getElementById('client-id').value = '';
    document.getElementById('client-stage').value = 'new';
  }

  detailWrapper.style.display = 'none';
  container.style.display = 'block';

  // Auto-scroll to the form on narrow screens
  if (window.innerWidth <= 1024) {
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function loadClientDetail(clientId = state.selectedClientId) {
  const selectedId = Number(clientId);
  if (!Number.isFinite(selectedId) || selectedId <= 0) {
    renderClientDetail(null, [], []);
    return;
  }

  const client = state.clients.find((item) => Number(item.id) === selectedId) || null;
  if (!client) {
    renderClientDetail(null, [], []);
    return;
  }

  const [notesPayload, appointmentsPayload] = await Promise.all([
    api(`/api/clients/${selectedId}/notes`),
    api(`/api/clients/${selectedId}/appointments`)
  ]);
  renderClientDetail(client, notesPayload?.notes || [], appointmentsPayload?.appointments || []);
}

async function loadClients() {
  const q = String(document.getElementById('clients-search')?.value || '').trim();
  const stage = String(document.getElementById('clients-stage-filter')?.value || '').trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (stage) params.set('stage', stage);
  const query = params.toString();

  renderSkeleton(document.getElementById('clients-table'), 5);
  const payload = await api(`/api/clients${query ? `?${query}` : ''}`);
  state.clients = Array.isArray(payload?.clients) ? payload.clients : [];

  if (!state.clients.some((item) => Number(item.id) === Number(state.selectedClientId))) {
    state.selectedClientId = state.clients[0]?.id || null;
  }
  document.getElementById('client-note-form')?.setAttribute('data-client-id', state.selectedClientId ? String(state.selectedClientId) : '');

  renderClientsTable(state.clients);
  if (state.selectedClientId) {
    await loadClientDetail(state.selectedClientId);
  } else {
    renderClientDetail(null, [], []);
  }
}

async function ensureClientForAppointment(appointment = {}) {
  const name = String(appointment.clientName || appointment.title || '').trim() || 'Client';
  const email = String(appointment.clientEmail || '').trim();
  const queryTerm = email || name;
  if (queryTerm && queryTerm.length >= 2) {
    const payload = await api(`/api/clients?q=${encodeURIComponent(queryTerm)}&lite=1&limit=25`);
    const clients = Array.isArray(payload?.clients) ? payload.clients : [];
    const exact = clients.find((item) => {
      const itemName = String(item.name || '').trim().toLowerCase();
      const itemEmail = String(item.email || '').trim().toLowerCase();
      if (email && itemEmail === email.toLowerCase()) return true;
      return itemName === name.toLowerCase();
    });
    if (exact) return exact;
  }

  const created = await api('/api/clients', {
    method: 'POST',
    body: JSON.stringify({
      name,
      email: email || '',
      stage: 'in_progress'
    })
  });
  return created?.client || null;
}

async function findClientForAppointment(appointment = {}) {
  const directClientId = Number(appointment.clientId);
  if (Number.isFinite(directClientId) && directClientId > 0) {
    const byId = state.clients.find((item) => Number(item.id) === directClientId);
    if (byId) return byId;
    try {
      const payload = await api(`/api/clients/${directClientId}`);
      const direct = payload?.client || null;
      if (direct?.id) return direct;
    } catch (_error) {
      // Fall back to name/email lookup when direct ID fetch is unavailable.
    }
  }

  const name = String(appointment.clientName || appointment.title || '').trim();
  const email = String(appointment.clientEmail || '').trim();
  const queryTerm = email || name;
  if (!queryTerm || queryTerm.length < 2) return null;

  const localExact = state.clients.find((item) => {
    const itemName = String(item.name || '').trim().toLowerCase();
    const itemEmail = String(item.email || '').trim().toLowerCase();
    if (email && itemEmail === email.toLowerCase()) return true;
    return itemName === name.toLowerCase();
  });
  if (localExact) return localExact;

  const payload = await api(`/api/clients?q=${encodeURIComponent(queryTerm)}&lite=1&limit=25`);
  const clients = Array.isArray(payload?.clients) ? payload.clients : [];
  return clients.find((item) => {
    const itemName = String(item.name || '').trim().toLowerCase();
    const itemEmail = String(item.email || '').trim().toLowerCase();
    if (email && itemEmail === email.toLowerCase()) return true;
    return itemName === name.toLowerCase();
  }) || null;
}

async function openClientFromAppointment(appointment = null) {
  if (!appointment) return;

  // Switch immediately so mobile users see progress without waiting on network.
  setActiveView('clients', { skipClientsReload: true });
  const clientFormContainer = document.getElementById('client-form-container');
  if (clientFormContainer) clientFormContainer.style.display = 'none';
  const detailWrapper = document.getElementById('client-detail-panel-wrapper');
  if (detailWrapper) {
    detailWrapper.style.display = 'flex';
    detailWrapper.innerHTML = '<div class="card empty-detail-card"><div class="empty-state">Loading client profile...</div></div>';
  }

  const client = await findClientForAppointment(appointment);
  if (!client?.id) {
    showToast('No saved client profile found for this appointment yet.', 'info');
    void loadClients().catch(swallowBackgroundAsyncError);
    return;
  }

  const clientId = Number(client.id);
  if (!Number.isFinite(clientId) || clientId <= 0) return;

  const searchInput = document.getElementById('clients-search');
  if (searchInput) {
    searchInput.value = String(client.name || client.email || '').trim();
  }
  const stageFilter = document.getElementById('clients-stage-filter');
  if (stageFilter) stageFilter.value = '';

  state.selectedClientId = clientId;
  document.getElementById('client-note-form')?.setAttribute('data-client-id', String(clientId));

  if (!state.clients.some((item) => Number(item.id) === clientId)) {
    state.clients = [client, ...state.clients.filter((item) => Number(item.id) !== clientId)];
  }
  renderClientsTable(state.clients);
  await loadClientDetail(clientId);

  const row = document.querySelector(`#clients-table .data-row[data-client-id="${clientId}"]`);
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  showToast('Client info opened.', 'success');
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
  const reminderModeEnabled = isReminderModeEnabled();
  const upcomingLimit = state.viewAll || reminderModeEnabled ? 500 : 160;

  if (showSkeleton) {
    // Show skeleton placeholders while data is loading
    renderSkeleton(document.getElementById('timeline-list'), 3);
  }

  // Fetch dashboard data + completed appointments in parallel.
  // The /api/dashboard endpoint already returns today's appointments.
  // We still fetch the appointments list to calculate the true next upcoming day.
  const [dashboardResult, completedResult, upcomingResult] = await Promise.all([
    api(`/api/dashboard?date=${encodeURIComponent(targetDate)}`),
    api('/api/appointments?status=completed&limit=60'),
    api(`/api/appointments?from=${encodeURIComponent(today)}&limit=${upcomingLimit}`)
  ]);

  const { stats, types, insights, appointments: todayFromDashboard } = dashboardResult;
  if (targetDate !== state.selectedDate) return;

  const scheduleTitle = document.getElementById('schedule-title');

  // Use today's appointments from the dashboard response (already scoped to today).
  const todayAppointments = (todayFromDashboard || []).filter((a) => {
    const status = String(a.status || '').toLowerCase();
    return status !== 'completed' && status !== 'cancelled';
  });
  const weekEnd = addDays(parseYmd(targetDate) || new Date(`${targetDate}T00:00:00`), 6).toISOString().slice(0, 10);
  const upcomingAppointments = Array.isArray(upcomingResult?.appointments) ? upcomingResult.appointments : [];
  const allActiveAppointments = [];
  const reminderQueue = [];
  let reminderTodayCount = 0;
  let reminderWeekCount = 0;
  let reminderPendingCount = 0;

  for (const appointment of upcomingAppointments) {
    const source = String(appointment?.source || '').toLowerCase();
    const status = String(appointment?.status || '').toLowerCase();
    const dateValue = String(appointment?.date || '').slice(0, 10);
    const isReminder = source === 'reminder';

    if (isReminder) {
      if (dateValue === targetDate) reminderTodayCount += 1;
      if (dateValue >= targetDate && dateValue <= weekEnd) reminderWeekCount += 1;
      if (status === 'pending') reminderPendingCount += 1;
    }

    if (status === 'completed' || status === 'cancelled') continue;
    allActiveAppointments.push(appointment);

    if (isReminder && isAtOrAfterNow(appointment.date, appointment.time)) {
      reminderQueue.push(appointment);
    }
  }
  const upcomingQueue = allActiveAppointments.filter((item) => isAtOrAfterNow(item?.date, item?.time));
  const nextUpcoming = upcomingQueue[0] || allActiveAppointments[0] || null;
  const nextReminder = reminderQueue[0] || null;

  const effectiveStats = reminderModeEnabled
    ? {
      today: reminderTodayCount,
      week: reminderWeekCount,
      pending: reminderPendingCount
    }
    : stats;

  let activeAppointments = todayAppointments;
  if (reminderModeEnabled) {
    const fromDate = state.viewAll ? targetDate : today;
    activeAppointments = reminderQueue.filter((a) => typeof a.date === 'string' && a.date >= fromDate);
    if (scheduleTitle) {
      scheduleTitle.textContent = state.viewAll
        ? `Upcoming Reminders from ${formatScheduleDate(fromDate)}`
        : 'Upcoming Reminders';
    }
  } else {
    if (state.viewAll) {
      activeAppointments = allActiveAppointments.filter((a) => typeof a.date === 'string' && a.date >= targetDate);
      if (scheduleTitle) scheduleTitle.textContent = `Upcoming from ${formatScheduleDate(targetDate)}`;
    } else if (scheduleTitle) {
      scheduleTitle.textContent = isTargetToday
        ? `Today's ${getEntryWordPluralTitle()}`
        : `${getEntryWordPluralTitle()}: ${formatScheduleDate(targetDate)}`;
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
        scheduleTitle.textContent = `Today's ${getEntryWordPluralTitle()}`;
      }
    }
  }

  const completedAppointments = (completedResult?.appointments || [])
    .slice()
    .sort((a, b) => {
      const aKey = `${a.date || ''} ${a.time || ''}`;
      const bKey = `${b.date || ''} ${b.time || ''}`;
      return aKey < bKey ? 1 : -1;
    });

  renderStats(effectiveStats, { nextReminder, nextUpcoming });
  renderTimeline(activeAppointments, {
    emptyMessage: reminderModeEnabled
      ? 'No upcoming reminders.'
      : (state.viewAll
        ? `No upcoming ${getEntryWordPlural()} from this day onward.`
        : `No ${getEntryWordPlural()} for this day yet.`),
    includeDate: state.viewAll || reminderModeEnabled
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
  if (isReminderModeEnabled()) {
    payload.source = 'reminder';
    payload.title = String(payload.clientName || '').trim();
    payload.typeId = null;
    payload.location = 'office';
  } else {
    if (String(form.dataset.entrySource || '').toLowerCase() === 'reminder') payload.source = 'reminder';
    payload.typeId = state.selectedTypeId;
  }
  payload.durationMinutes = String(payload.source || '').toLowerCase() === 'reminder'
    ? 0
    : Number(payload.durationMinutes || 45);
  payload.reminderOffsetMinutes = Number(payload.reminderOffsetMinutes == null ? 10 : payload.reminderOffsetMinutes);

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
      const sourceMode = String(payload.source || '').toLowerCase();
      const isReminder = isReminderModeEnabled() || sourceMode === 'reminder';
      const result = await queueAwareMutation('/api/appointments', { method: 'POST', body: JSON.stringify(payload) }, {
        allowOfflineQueue: true,
        description: isReminder ? 'Reminder creation' : 'Appointment creation'
      });
      if (result.queued) {
        form.reset();
        setAppointmentDefaults();
        closeModal('new-appointment');
        return;
      }
      const provider = result?.body?.notifications?.mode;
      showToast(
        isReminder
          ? 'Reminder created.'
          : (
            provider === 'simulation'
              ? 'Appointment created. Email simulation mode is active.'
              : 'Appointment created and notifications sent.'
          ),
        'success'
      );
    }

    form.reset();
    setAppointmentDefaults();
    closeModal('new-appointment');
    await loadDashboard();
    await loadAppointmentsTable();
    await refreshCalendarDots({ force: true });
    if (wasEditing) showToast(`${getEntryWordSingularTitle()} updated.`, 'success');
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
  const formData = new FormData(form);
  const id = formData.get('id');
  const data = Object.fromEntries(formData.entries());

  const isEditing = id && Number(id) > 0;
  const url = isEditing ? `/api/types/${id}` : '/api/types';
  const method = isEditing ? 'PUT' : 'POST';

  try {
    const result = await queueAwareMutation(url, {
      method,
      body: JSON.stringify({
        name: data.name,
        durationMinutes: Number(data.durationMinutes || 30),
        priceCents: Number(data.priceGbp ?? data.priceUsd ?? 0) * 100,
        locationMode: data.locationMode
      })
    }, {
      allowOfflineQueue: true,
      description: isEditing ? 'Type update' : 'Type creation'
    });
    if (result.queued) {
      resetTypeForm();
      return;
    }
    resetTypeForm();
    showToast(isEditing ? 'Type updated' : 'Type created', 'success');
    await loadTypes();
    await loadDashboard();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function resetTypeForm() {
  const form = document.getElementById('type-form');
  const title = document.getElementById('type-form-title');
  const cancelBtn = document.getElementById('btn-cancel-type-edit');
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (form) {
    form.reset();
    document.getElementById('type-id').value = '';
  }
  if (title) title.textContent = 'Create Appointment Type';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (submitBtn) submitBtn.textContent = 'Create Type';
}

function setTypeFormForEditing(typeId) {
  const type = state.types.find(t => Number(t.id) === Number(typeId));
  if (!type) return;

  const form = document.getElementById('type-form');
  const title = document.getElementById('type-form-title');
  const cancelBtn = document.getElementById('btn-cancel-type-edit');
  const submitBtn = form?.querySelector('button[type="submit"]');

  if (form) {
    document.getElementById('type-id').value = type.id;
    document.getElementById('type-name').value = type.name || '';
    document.getElementById('type-duration').value = type.durationMinutes || 30;
    document.getElementById('type-price').value = (Number(type.priceCents) || 0) / 100;
    document.getElementById('type-location').value = type.locationMode || 'hybrid';
  }

  if (title) title.textContent = 'Edit Appointment Type';
  if (cancelBtn) cancelBtn.style.display = 'flex';
  if (submitBtn) submitBtn.textContent = 'Update Type';

  // Scroll to form on narrow screens
  if (window.innerWidth <= 1024) {
    form?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function submitSettings(e) {
  e.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    data.businessHours = collectBusinessHoursFromForm();
    data.reminderMode = isReminderModeEnabled();
    data.workspaceMode = normalizeWorkspaceMode(state.workspaceMode);
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

async function submitClient(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const formData = new FormData(form);
  const id = formData.get('id');
  const payload = Object.fromEntries(formData.entries());

  const isEditing = id && Number(id) > 0;
  const url = isEditing ? `/api/clients/${id}` : '/api/clients';
  const method = isEditing ? 'PUT' : 'POST';

  try {
    const result = await api(url, { method, body: JSON.stringify(payload) });
    form.reset();
    showToast(isEditing ? 'Client updated.' : 'Client saved.', 'success');
    closeClientForm();

    if (!isEditing && result?.client?.id) {
      state.selectedClientId = result.client.id;
    }
    await loadClients();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function closeClientForm() {
  document.getElementById('client-form-container').style.display = 'none';
  document.getElementById('client-detail-panel-wrapper').style.display = 'flex';
}

async function submitClientNote(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const clientId = Number(form.dataset.clientId || state.selectedClientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    showToast('Select a client first.', 'info');
    return;
  }

  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await api(`/api/clients/${clientId}/notes`, { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    showToast('Note added.', 'success');
    // Reload details to show the new note
    await loadClientDetail(clientId);
    // Also reload the list to update the "last note" preview
    void loadClients().catch(swallowBackgroundAsyncError);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderAiImportQuotaIndicator(quota) {
  const indicator = document.getElementById('ai-import-quota-indicator');
  const valueNode = document.getElementById('ai-import-quota-value');
  const importBtn = document.getElementById('btn-import-ai-data');
  if (!indicator) return;
  const remaining = Number(quota?.remaining);
  const limit = Number(quota?.limit || 3);
  if (importBtn) {
    importBtn.disabled = false;
    importBtn.removeAttribute('title');
  }
  if (!Number.isFinite(remaining)) {
    if (valueNode) valueNode.textContent = `Remaining today: -- / ${limit}`;
    indicator.classList.remove('is-empty');
    return;
  }
  const safeRemaining = Math.max(0, remaining);
  if (valueNode) valueNode.textContent = `Remaining today: ${safeRemaining} / ${limit}`;
  const noQuotaLeft = safeRemaining <= 0;
  indicator.classList.toggle('is-empty', noQuotaLeft);
  if (importBtn && noQuotaLeft) {
    importBtn.disabled = true;
    importBtn.title = 'Daily AI import limit reached.';
  }
}

async function loadAiImportQuotaIndicator() {
  try {
    const payload = await api('/api/data/import-ai/quota');
    renderAiImportQuotaIndicator(payload?.quota);
  } catch (_error) {
    renderAiImportQuotaIndicator(null);
  }
}

async function loadSettings() {
  const { settings } = await api('/api/settings');
  const form = document.getElementById('settings-form');
  if (!form) return;
  const fallbackServerMode = settings.reminder_mode === true || settings.reminder_mode === 1 ? 'reminders' : 'appointments';
  const serverWorkspaceMode = normalizeWorkspaceMode(settings.workspace_mode || fallbackServerMode);
  setWorkspaceMode(serverWorkspaceMode, { persist: true });
  form.businessName.value = settings.business_name || '';
  form.ownerEmail.value = settings.owner_email || '';
  form.timezone.value = settings.timezone || 'America/Los_Angeles';
  if (form.openTime) form.openTime.value = String(settings.open_time || '09:00').slice(0, 5);
  if (form.closeTime) form.closeTime.value = String(settings.close_time || '18:00').slice(0, 5);
  applyBusinessHoursToForm(settings.businessHours, form.openTime?.value || '09:00', form.closeTime?.value || '18:00');

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

  const reminderToggle = document.getElementById('settings-reminder-mode');
  if (reminderToggle) {
    reminderToggle.checked = state.reminderMode;
    reminderToggle.disabled = isClientModeEnabled();
  }
  const workspaceModeSelect = document.getElementById('settings-workspace-mode');
  if (workspaceModeSelect) workspaceModeSelect.value = normalizeWorkspaceMode(state.workspaceMode);
  const browserNotifToggle = document.getElementById('settings-browser-notifications');
  if (browserNotifToggle) {
    browserNotifToggle.checked = Boolean(state.browserNotificationsEnabled);
    if (!canUseBrowserNotifications()) {
      browserNotifToggle.checked = false;
      browserNotifToggle.disabled = true;
      browserNotifToggle.title = 'Browser notifications are not supported in this browser.';
    }
  }
  applyReminderModeUi();

  // Populate the export type chips
  populateExportTypeFilters();

  const navModeToggle = document.getElementById('settings-mobile-nav-bottom-tabs');
  if (navModeToggle) {
    navModeToggle.checked = getStoredMobileNavMode() === 'bottom';
  }

  await loadAiImportQuotaIndicator();
  if (state.browserNotificationsEnabled) startReminderNotificationPolling();
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

async function importAiAppointmentsFromFile(file) {
  if (!file) return;
  try {
    const raw = await file.text();
    if (!String(raw || '').trim()) throw new Error('Selected file is empty.');
    const ok = await showConfirm(
      'AI Import Appointments',
      'AI will convert this file and import only non-overlapping appointments. Continue?'
    );
    if (!ok) return;

    showToast('AI import started. Parsing file and converting appointments…', 'info');

    const result = await api('/api/data/import-ai', {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        fileContent: raw
      })
    });
    renderAiImportQuotaIndicator(result?.quota);

    showToast(
      `AI import complete (${result.model || 'model'}): ${result.importedAppointments || 0} imported, ${result.skippedOverlaps || 0} overlap skipped, ${result.skippedInvalid || 0} invalid skipped.`,
      'success'
    );
    if ((result.skippedOverlaps || 0) > 0) {
      const samples = Array.isArray(result.overlapSamples) ? result.overlapSamples.slice(0, 4) : [];
      if (samples.length) {
        const summary = samples
          .map((s) => `${s.clientName || 'Appointment'} ${s.date || ''} ${s.time || ''}`.trim())
          .join(' | ');
        showToast(
          `Skipped overlaps (${result.skippedOverlaps}): ${summary}${result.skippedOverlaps > samples.length ? ' | ...' : ''}`,
          'info'
        );
      } else {
        showToast('Some appointments were skipped because they overlapped existing bookings.', 'info');
      }
    }
    if ((result.skippedInvalid || 0) > 0) {
      const invalidSamples = Array.isArray(result.invalidSamples) ? result.invalidSamples.slice(0, 3) : [];
      showToast(
        invalidSamples.length
          ? `Skipped invalid rows (${result.skippedInvalid}): ${invalidSamples.map((r) => `row ${Number(r.index) + 1}`).join(', ')}.`
          : 'Some rows were skipped because required date/time fields were invalid.',
        'info'
      );
    }

    await loadDashboard();
    await loadAppointmentsTable();
    await refreshCalendarDots({ force: true });
  } catch (error) {
    if (error?.details?.quota) renderAiImportQuotaIndicator(error.details.quota);
    showToast(error.message || 'AI import failed.', 'error');
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
