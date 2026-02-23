'use strict';

const { dbAll, dbGet, getSettings } = require('./db');
const { fmtTime } = require('./email');
const { parseTimeToMinutes } = require('./appointments');

const BUSINESS_HOURS_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function toYmd(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toMinutes(value = '09:00', fallback = 9 * 60) {
  const minutes = parseTimeToMinutes(value);
  return Number.isFinite(minutes) ? minutes : fallback;
}

function uniqueDaysCount(rows = []) {
  return new Set(rows.map((row) => String(row.date || '')).filter(Boolean)).size;
}

function roundPercent(numerator = 0, denominator = 1) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function clampPercent(value = 0) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function averageDuration(rows = [], fallback = 45) {
  if (!rows.length) return fallback;
  const total = rows.reduce((sum, row) => sum + Number(row.duration_minutes || fallback), 0);
  return Math.max(15, Math.round(total / rows.length));
}

function parseBusinessHoursForDate(settings = {}, date = '') {
  const defaultOpen = String(settings.open_time || '09:00').slice(0, 5);
  const defaultClose = String(settings.close_time || '18:00').slice(0, 5);
  const fallback = { closed: false, openTime: defaultOpen, closeTime: defaultClose };
  if (!settings.business_hours_json) return fallback;

  try {
    const parsed = JSON.parse(settings.business_hours_json);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const focusDate = new Date(`${date}T00:00:00`);
    const dayIndex = Number.isFinite(focusDate.getTime()) ? focusDate.getDay() : 1;
    const dayKey = BUSINESS_HOURS_DAY_KEYS[dayIndex] || 'mon';
    const day = parsed[dayKey];
    if (!day || typeof day !== 'object') return fallback;
    return {
      closed: Boolean(day.closed),
      openTime: String(day.openTime || defaultOpen).slice(0, 5),
      closeTime: String(day.closeTime || defaultClose).slice(0, 5)
    };
  } catch (_error) {
    return fallback;
  }
}

function humanTime(minutesFromMidnight = 540) {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return fmtTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

async function createInsights(date, businessId) {
  const scopedBusinessId = Number(businessId);
  const focusDate = new Date(`${date}T00:00:00`);
  if (Number.isNaN(focusDate.getTime())) return [];

  const from30 = new Date(focusDate);
  from30.setDate(from30.getDate() - 29);
  const from14 = new Date(focusDate);
  from14.setDate(from14.getDate() - 13);
  const from28 = new Date(focusDate);
  from28.setDate(from28.getDate() - 27);
  const to7 = new Date(focusDate);
  to7.setDate(to7.getDate() + 6);

  const from30Str = toYmd(from30);
  const from14Str = toYmd(from14);
  const from28Str = toYmd(from28);
  const to14Str = date;
  const to7Str = toYmd(to7);

  const [recentAllRows, recentActiveRows, selectedDayRows, weekRows, pendingRow, settings] = await Promise.all([
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, a.source, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date >= ?
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, a.source, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date >= $2
       ORDER BY a.date ASC, a.time ASC`,
      [scopedBusinessId, from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, a.source, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date >= ? AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, a.source, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date >= $2 AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      [scopedBusinessId, from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, a.source, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date = ? AND a.status != 'cancelled'
       ORDER BY a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, a.source, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date = $2 AND a.status != 'cancelled'
       ORDER BY a.time ASC`,
      [scopedBusinessId, date]
    ),
    dbAll(
      `SELECT a.date
       FROM appointments a
       WHERE a.business_id = ? AND a.date BETWEEN ? AND ? AND a.status != 'cancelled'`,
      `SELECT a.date
       FROM appointments a
       WHERE a.business_id = $1 AND a.date BETWEEN $2 AND $3 AND a.status != 'cancelled'`,
      [scopedBusinessId, date, to7Str]
    ),
    dbGet(
      "SELECT COUNT(*) AS c FROM appointments WHERE business_id = ? AND status = 'pending'",
      "SELECT COUNT(*)::int AS c FROM appointments WHERE business_id = $1 AND status = 'pending'",
      [scopedBusinessId]
    ),
    getSettings(scopedBusinessId)
  ]);

  const businessSettings = settings || {
    business_name: 'IntelliBook',
    timezone: 'America/Los_Angeles'
  };

  const insights = [];

  if (!recentAllRows.length) {
    insights.push({
      icon: '💡',
      text: 'No historical bookings yet. Add a few appointments to unlock utilization and trend insights.',
      action: 'Create your first week of slots, then check insights again.',
      confidence: 'Low confidence (not enough data)',
      time: 'Now'
    });
    insights.push({
      icon: '🎯',
      text: `Current timezone is ${businessSettings.timezone}.`,
      action: 'Keep timezone synced for reminder accuracy.',
      confidence: 'High confidence',
      time: 'Now'
    });
    return insights;
  }

  const active14Rows = recentActiveRows.filter((row) => String(row.date || '') >= from14Str && String(row.date || '') <= to14Str);
  const prior14Rows = recentActiveRows.filter((row) => String(row.date || '') >= from28Str && String(row.date || '') < from14Str);
  const active14PerDay = active14Rows.length / Math.max(uniqueDaysCount(active14Rows), 1);
  const prior14PerDay = prior14Rows.length / Math.max(uniqueDaysCount(prior14Rows), 1);
  const trendDeltaPct = prior14PerDay > 0 ? Math.round(((active14PerDay - prior14PerDay) / prior14PerDay) * 100) : 0;

  if (prior14Rows.length >= 3 && active14Rows.length >= 3) {
    const direction = trendDeltaPct >= 8 ? 'up' : (trendDeltaPct <= -8 ? 'down' : 'flat');
    if (direction === 'up') {
      insights.push({
        icon: '🚀',
        text: `Booking velocity is up ${trendDeltaPct}% vs the prior 14-day window.`,
        action: 'Keep premium slots open in your busiest windows to capture momentum.',
        confidence: active14Rows.length >= 18 ? 'High confidence' : 'Medium confidence',
        time: 'Momentum'
      });
    } else if (direction === 'down') {
      insights.push({
        icon: '🧭',
        text: `Booking velocity is down ${Math.abs(trendDeltaPct)}% vs the prior 14-day window.`,
        action: 'Offer one follow-up campaign and open short-notice slots to recover demand.',
        confidence: active14Rows.length >= 18 ? 'High confidence' : 'Medium confidence',
        time: 'Momentum'
      });
    }
  }

  const typeCounts = new Map();
  const hourCounts = new Map();
  recentActiveRows.forEach((row) => {
    const typeName = String(row.type_name || 'Appointment');
    typeCounts.set(typeName, (typeCounts.get(typeName) || 0) + 1);
    const mins = parseTimeToMinutes(row.time);
    const hour = Math.floor(mins / 60);
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  });

  const busiestType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (busiestType) {
    const pct = Math.round((busiestType[1] / Math.max(recentActiveRows.length, 1)) * 100);
    insights.push({
      icon: '📈',
      text: `${busiestType[0]} is your top service in the last 30 days (${busiestType[1]} bookings, ${pct}% share).`,
      action: 'Prioritize this service in peak-time slots and booking page order.',
      confidence: recentActiveRows.length >= 20 ? 'High confidence' : 'Medium confidence',
      time: '30-day trend'
    });
    if (pct >= 60) {
      insights.push({
        icon: '🧱',
        text: `${busiestType[0]} now accounts for ${pct}% of active bookings.`,
        action: 'Consider a second high-margin offer nearby in the booking flow to reduce concentration risk.',
        confidence: recentActiveRows.length >= 25 ? 'High confidence' : 'Medium confidence',
        time: 'Service mix'
      });
    }
  }

  const peakHourEntry = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (peakHourEntry) {
    const peakStart = peakHourEntry[0] * 60;
    insights.push({
      icon: '🕒',
      text: `Peak demand window is around ${humanTime(peakStart)} (${peakHourEntry[1]} bookings).`,
      action: 'Protect this window for high-value services and avoid admin tasks here.',
      confidence: recentActiveRows.length >= 15 ? 'High confidence' : 'Medium confidence',
      time: 'Pattern'
    });
  }

  const openHours = parseBusinessHoursForDate(businessSettings, date);
  if (!openHours.closed) {
    const openMinutes = toMinutes(openHours.openTime, 9 * 60);
    const closeMinutes = toMinutes(openHours.closeTime, 18 * 60);
    const windowMinutes = Math.max(closeMinutes - openMinutes, 0);
    const dayBookedMinutes = selectedDayRows.reduce((sum, row) => sum + Number(row.duration_minutes || 45), 0);
    const utilizationPct = windowMinutes > 0 ? clampPercent((dayBookedMinutes / windowMinutes) * 100) : 0;
    const avgDuration = averageDuration(recentActiveRows, 45);
    const remainingMinutes = Math.max(windowMinutes - dayBookedMinutes, 0);
    const estExtraSlots = Math.floor(remainingMinutes / Math.max(avgDuration, 15));

    if (windowMinutes > 0) {
      insights.push({
        icon: utilizationPct >= 80 ? '🔥' : '📊',
        text: `${date} is ${utilizationPct}% utilized (${dayBookedMinutes} of ${windowMinutes} minutes booked).`,
        action: utilizationPct >= 80
          ? 'Keep a small buffer for overruns and waitlist requests.'
          : `You can likely fit ~${estExtraSlots} more booking${estExtraSlots === 1 ? '' : 's'} at current average duration.`,
        confidence: 'High confidence',
        time: 'Capacity'
      });
    }
  }

  const dayLoad = new Map();
  weekRows.forEach((r) => dayLoad.set(String(r.date), (dayLoad.get(String(r.date)) || 0) + 1));
  const weekValues = Array.from(dayLoad.values());
  const maxDayLoad = weekValues.length ? Math.max(...weekValues) : 0;
  if (maxDayLoad >= 7) {
    const overloadedDay = [...dayLoad.entries()].sort((a, b) => b[1] - a[1])[0];
    insights.push({
      icon: '⚠️',
      text: `Heaviest upcoming day is ${overloadedDay[0]} with ${overloadedDay[1]} bookings.`,
      action: 'Add buffers or move 1-2 low-priority bookings to a lighter day.',
      confidence: 'High confidence',
      time: 'Next 7 days'
    });
  } else {
    insights.push({
      icon: '✅',
      text: `Upcoming load looks balanced (max ${maxDayLoad} bookings on any day in next 7 days).`,
      action: 'Open one extra premium slot on your lightest day to lift revenue.',
      confidence: 'High confidence',
      time: 'Next 7 days'
    });
  }

  if (selectedDayRows.length >= 2) {
    const blocks = selectedDayRows.map((r) => {
      const start = parseTimeToMinutes(r.time);
      const duration = Number(r.duration_minutes || 45);
      return { start, end: start + duration };
    }).sort((a, b) => a.start - b.start);

    const workingHours = parseBusinessHoursForDate(businessSettings, date);
    const dayStart = workingHours.closed ? (8 * 60) : toMinutes(workingHours.openTime, 8 * 60);
    const dayEnd = workingHours.closed ? (18 * 60) : toMinutes(workingHours.closeTime, 18 * 60);
    let bestGap = 0;
    let bestGapStart = dayStart;
    let cursor = dayStart;

    blocks.forEach((block) => {
      const blockStart = Math.max(block.start, dayStart);
      const blockEnd = Math.min(block.end, dayEnd);
      if (blockStart > cursor) {
        const gap = blockStart - cursor;
        if (gap > bestGap) {
          bestGap = gap;
          bestGapStart = cursor;
        }
      }
      cursor = Math.max(cursor, blockEnd);
    });

    if (dayEnd > cursor) {
      const gap = dayEnd - cursor;
      if (gap > bestGap) {
        bestGap = gap;
        bestGapStart = cursor;
      }
    }

    if (bestGap >= 45 && bestGapStart != null) {
      insights.push({
        icon: '🧩',
        text: `There is a ${bestGap}-minute gap on ${date} starting around ${humanTime(bestGapStart)}.`,
        action: 'Good slot for a short consultation or same-day booking.',
        confidence: 'High confidence',
        time: 'Schedule optimization'
      });
    }
  }

  const totalRecent = recentAllRows.length;
  const cancelledRecent = recentAllRows.filter((r) => String(r.status) === 'cancelled').length;
  const cancelRate = totalRecent ? Math.round((cancelledRecent / totalRecent) * 100) : 0;
  if (cancelRate >= 15) {
    insights.push({
      icon: '📉',
      text: `Cancellation rate is ${cancelRate}% over the last 30 days.`,
      action: 'Use confirmation reminders 24 hours before start time to reduce churn.',
      confidence: totalRecent >= 20 ? 'High confidence' : 'Medium confidence',
      time: 'Reliability'
    });
  }

  const pendingCount = Number(pendingRow?.c || 0);
  if (pendingCount > 0) {
    insights.push({
      icon: '📬',
      text: `${pendingCount} booking${pendingCount === 1 ? '' : 's'} are pending confirmation.`,
      action: 'Clear pending items first to stabilize this week\'s schedule.',
      confidence: 'High confidence',
      time: 'Action now'
    });
  }

  const reminderCount = recentActiveRows.filter((row) => String(row.source || '') === 'reminder').length;
  if (recentActiveRows.length >= 8) {
    const reminderPct = roundPercent(reminderCount, recentActiveRows.length);
    insights.push({
      icon: '📝',
      text: `${reminderPct}% of active items are reminders in the last 30 days (${reminderCount}/${recentActiveRows.length}).`,
      action: reminderPct > 35
        ? 'Consider converting high-priority reminders into scheduled appointments with duration.'
        : 'Reminder mix looks healthy for lightweight follow-ups and admin prompts.',
      confidence: recentActiveRows.length >= 20 ? 'High confidence' : 'Medium confidence',
      time: 'Workflow mix'
    });
  }

  insights.push({
    icon: '🌍',
    text: `Timezone is set to ${businessSettings.timezone}.`,
    action: 'Keep timezone aligned with business hours and reminder rules.',
    confidence: 'High confidence',
    time: 'Configuration'
  });

  return insights.slice(0, 6);
}

module.exports = { createInsights };
