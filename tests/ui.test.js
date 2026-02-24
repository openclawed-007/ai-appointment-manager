const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const { toTime12, escapeHtml, monthLabel, setActiveView } = require('../app.js');

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
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    expect(index.includes('id="btn-view-all"')).toBe(true);
    expect(index.includes('id="btn-manage-types"')).toBe(true);
    expect(index.includes('data-view="settings"')).toBe(true);
    expect(index.includes('id="calendar-prev"')).toBe(true);
    expect(index.includes('id="calendar-next"')).toBe(true);
  });

  it('index contains reminder mode and browser notification controls', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    expect(index.includes('id="settings-reminder-mode"')).toBe(true);
    expect(index.includes('id="settings-browser-notifications"')).toBe(true);
    expect(index.includes('id="btn-test-browser-notification"')).toBe(true);
    expect(index.includes('id="appt-reminder-offset"')).toBe(true);
  });

  it('app source applies reminder-mode hiding for AI and types navigation/views', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    expect(source.includes('.nav-item[data-view="ai"], .mobile-nav-item[data-view="ai"]')).toBe(true);
    expect(source.includes('.app-view[data-view="ai"]')).toBe(true);
    expect(source.includes('.nav-item[data-view="types"], .mobile-nav-item[data-view="types"]')).toBe(true);
    expect(source.includes('.app-view[data-view="types"]')).toBe(true);
    expect(source.includes("setActiveView('dashboard')")).toBe(true);
  });

  it('app source wires browser notification toggle and test button', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    expect(source.includes("const BROWSER_NOTIFICATIONS_KEY = 'browserNotificationsEnabled'")).toBe(true);
    expect(source.includes("document.getElementById('settings-browser-notifications')?.addEventListener('change'")).toBe(true);
    expect(source.includes("document.getElementById('btn-test-browser-notification')?.addEventListener('click'")).toBe(true);
    expect(source.includes('startReminderNotificationPolling()')).toBe(true);
  });
});
