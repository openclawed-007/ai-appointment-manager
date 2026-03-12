const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const { toTime12, escapeHtml, monthLabel, setActiveView } = require('../public/app.js');

describe('UI helpers and tab behavior', () => {
  it('formats 24h time correctly', () => {
    expect(toTime12('00:05')).toBe('12:05 AM');
    expect(toTime12('12:00')).toBe('12:00 PM');
    expect(toTime12('18:30')).toBe('6:30 PM');
  });

  it('escapes HTML safely', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('creates month label', () => {
    const label = monthLabel(new Date('2026-02-01'));
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('switches active tab and view sections', () => {
    const html = `
      <a class="nav-item active" data-view="dashboard"></a>
      <a class="nav-item" data-view="appointments"></a>
      <section class="app-view active" data-view="dashboard"></section>
      <section class="app-view" data-view="appointments"></section>
    `;

    const dom = new JSDOM(html);
    global.document = dom.window.document;

    setActiveView('appointments');

    const navItems = [...document.querySelectorAll('.nav-item')];
    const views = [...document.querySelectorAll('.app-view')];

    expect(navItems[0].classList.contains('active')).toBe(false);
    expect(navItems[1].classList.contains('active')).toBe(true);
    expect(views[0].classList.contains('active')).toBe(false);
    expect(views[1].classList.contains('active')).toBe(true);

    delete global.document;
  });

  it('index contains key interactive controls', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    expect(index.includes('id="btn-view-all"')).toBe(true);
    expect(index.includes('id="btn-manage-types"')).toBe(true);
    expect(index.includes('data-view="settings"')).toBe(true);
    expect(index.includes('id="calendar-prev"')).toBe(true);
    expect(index.includes('id="calendar-next"')).toBe(true);
  });

  it('index contains reminder mode and browser notification controls', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    expect(index.includes('id="settings-reminder-mode"')).toBe(true);
    expect(index.includes('id="settings-browser-notifications"')).toBe(true);
    expect(index.includes('id="btn-test-browser-notification"')).toBe(true);
    expect(index.includes('id="appt-reminder-offset"')).toBe(true);
  });

  it('index exposes an accessible global search field and popup wiring', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    expect(index.includes('for="global-search"')).toBe(true);
    expect(index.includes('aria-controls="global-search-suggestions"')).toBe(true);
    expect(index.includes('aria-expanded="false"')).toBe(true);
    expect(index.includes('id="global-search-suggestions" class="search-suggestions hidden"')).toBe(true);
    expect(index.includes('id="global-search-suggestions" class="search-suggestions hidden" role="listbox"')).toBe(false);
  });

  it('settings copy uses staff-friendly workspace wording', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    expect(index.includes('Workspace mode')).toBe(true);
    expect(index.includes('Appointments')).toBe(true);
    expect(index.includes('Reminders')).toBe(true);
    expect(index.includes('Reminder mode')).toBe(true);
  });

  it('main navigation uses consistent page naming across desktop and mobile', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const core = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-core.js'), 'utf8');
    expect(index.includes('<span>Dashboard</span>')).toBe(true);
    expect(index.includes('<h2>Dashboard</h2>')).toBe(true);
    expect(index.includes('<span>Appointments</span>')).toBe(true);
    expect(index.includes('<h2>Appointments</h2>')).toBe(true);
    expect(index.includes('<span>Clients</span>')).toBe(true);
    expect(index.includes('<h2>Clients</h2>')).toBe(true);
    expect(index.includes('<span>Services</span>')).toBe(true);
    expect(index.includes('<h2>Services</h2>')).toBe(true);
    expect(index.includes('<span>Insights</span>')).toBe(true);
    expect(index.includes('<h2>Insights</h2>')).toBe(true);
    expect(index.includes('<span>Settings</span>')).toBe(true);
    expect(index.includes('<h2>Settings</h2>')).toBe(true);
    expect(index.includes('aria-label="Services"')).toBe(true);
    expect(index.includes('aria-label="Insights"')).toBe(true);
    expect(core.includes("setText('.mobile-nav-item[data-view=\"appointments\"] span', reminderMode ? 'Reminders' : 'Appointments');")).toBe(true);
    expect(core.includes("setText('section[data-view=\"appointments\"] .page-header-main h2', entryPluralTitle);")).toBe(true);
  });

  it('app shell HTML links CSS partials directly instead of relying on styles.css imports', () => {
    const htmlFiles = ['index.html', 'booking.html', 'reset-password.html'];
    const expectedLinks = [
      'css/base.css',
      'css/sidebar.css',
      'css/header.css',
      'css/content.css',
      'css/calendar.css',
      'css/timeline.css',
      'css/types.css',
      'css/insights.css',
      'css/forms.css',
      'css/menus.css',
      'css/pages.css',
      'css/settings.css',
      'css/responsive.css',
      'css/theme-light.css'
    ];

    for (const file of htmlFiles) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
      expect(source.includes('href="styles.css"')).toBe(false);
      expectedLinks.forEach((href) => expect(source.includes(`href="${href}"`)).toBe(true));
    }
  });

  it('app source applies reminder-mode hiding for AI and types navigation/views', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    expect(source.includes('.nav-item[data-view="ai"], .mobile-nav-item[data-view="ai"]')).toBe(true);
    expect(source.includes('.app-view[data-view="ai"]')).toBe(true);
    expect(source.includes('.nav-item[data-view="types"], .mobile-nav-item[data-view="types"]')).toBe(true);
    expect(source.includes('.app-view[data-view="types"]')).toBe(true);
    expect(source.includes("setActiveView('dashboard')")).toBe(true);
  });

  it('app source wires browser notification toggle and test button', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    expect(source.includes("const BROWSER_NOTIFICATIONS_KEY = 'browserNotificationsEnabled'")).toBe(true);
    expect(source.includes("document.getElementById('settings-browser-notifications')?.addEventListener('change'")).toBe(true);
    expect(source.includes("document.getElementById('btn-test-browser-notification')?.addEventListener('click'")).toBe(true);
    expect(source.includes('startReminderNotificationPolling()')).toBe(true);
  });

  it('service worker precaches all directly linked CSS partials', () => {
    const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    [
      '/css/base.css',
      '/css/sidebar.css',
      '/css/header.css',
      '/css/content.css',
      '/css/calendar.css',
      '/css/timeline.css',
      '/css/types.css',
      '/css/insights.css',
      '/css/forms.css',
      '/css/menus.css',
      '/css/pages.css',
      '/css/settings.css',
      '/css/responsive.css',
      '/css/theme-light.css'
    ].forEach((href) => expect(sw.includes(`'${href}'`)).toBe(true));
  });

  it('search suggestions source updates aria-expanded and renders button labels', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-init.js'), 'utf8');
    expect(source.includes("document.getElementById('global-search')?.setAttribute('aria-expanded', 'false')")).toBe(true);
    expect(source.includes("document.getElementById('global-search')?.setAttribute('aria-expanded', 'true')")).toBe(true);
    expect(source.includes('aria-label="Open ${escapeHtml(option.label)} setting"')).toBe(true);
    expect(source.includes('Settings')).toBe(true);
  });
});
