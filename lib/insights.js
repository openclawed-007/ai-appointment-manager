'use strict';

const { dbAll, dbGet, getSettings } = require('./db');
const { fmtTime } = require('./email');
const { parseTimeToMinutes } = require('./appointments');

function toYmd(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
  const to7 = new Date(focusDate);
  to7.setDate(to7.getDate() + 6);

  const from30Str = toYmd(from30);
  const to7Str = toYmd(to7);

  const [recentAllRows, recentActiveRows, selectedDayRows, weekRows, pendingRow, settings] = await Promise.all([
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date >= ?
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date >= $2
       ORDER BY a.date ASC, a.time ASC`,
      [scopedBusinessId, from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date >= ? AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = $1 AND a.date >= $2 AND a.status != 'cancelled'
       ORDER BY a.date ASC, a.time ASC`,
      [scopedBusinessId, from30Str]
    ),
    dbAll(
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
       FROM appointments a
       LEFT JOIN appointment_types t ON t.id = a.type_id
       WHERE a.business_id = ? AND a.date = ? AND a.status != 'cancelled'
       ORDER BY a.time ASC`,
      `SELECT a.date, a.time, a.duration_minutes, a.status, COALESCE(t.name, a.title, 'Appointment') AS type_name
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
    });
    let bestGap = 0;
    let bestGapStart = null;
    for (let i = 0; i < blocks.length - 1; i += 1) {
      const gap = blocks[i + 1].start - blocks[i].end;
      if (gap > bestGap) {
        bestGap = gap;
        bestGapStart = blocks[i].end;
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
