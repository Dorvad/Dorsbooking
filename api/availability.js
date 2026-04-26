/*
 * api/availability.js
 * Returns available booking slots for a given meeting duration and date range.
 *
 * GET /api/availability?duration=30
 * GET /api/availability?duration=30&from=2026-04-28&to=2026-05-10
 *
 * Query parameters:
 *   duration   Required. Meeting length in minutes: 15 | 30 | 60
 *   from       Optional. First date to include, YYYY-MM-DD (defaults to today)
 *   to         Optional. Last date to include, YYYY-MM-DD
 *              (defaults to today + bookingWindowDays from config)
 *
 * Booking constraints applied (all sourced from config/availability.json):
 *   weeklySchedule     Which days and hours are available
 *   minimumNoticeHours Slots within this window from now are excluded
 *   bufferMinutes      Gap added after each meeting before the next slot starts
 *   maxMeetingsPerDay  Maximum slots surfaced per day
 *   bookingWindowDays  How far ahead the calendar is open
 *
 * Google Calendar integration (when connected):
 *   If a valid g_access_token cookie is present, the handler fetches the
 *   manager's free/busy data from the Google Calendar API and removes any
 *   slot that overlaps a busy period. If the token is absent or the request
 *   fails, the handler falls back gracefully to config-only availability.
 *
 * Deployment: Vercel Serverless Function (Node.js 18+).
 *
 * Sample response:
 * {
 *   "timezone": "Europe/Amsterdam",
 *   "duration": 30,
 *   "calendarConnected": false,
 *   "days": [
 *     { "date": "2026-04-28", "slots": ["09:00","09:30","10:00","10:30"] },
 *     { "date": "2026-04-29", "slots": ["09:00","09:30"] }
 *   ]
 * }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/* ── Constants ──────────────────────────────────────────────────────── */

const GCAL_FREEBUSY_URL  = 'https://www.googleapis.com/calendar/v3/freeBusy';
const COOKIE_ACCESS_TOKEN = 'g_access_token'; // set by api/auth.js
const VALID_DURATIONS     = new Set([15, 30, 60]);
const MAX_WINDOW_DAYS     = 90; // hard ceiling regardless of config

/* ── Handler ────────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  const q = req.query ?? parseQueryString(req.url ?? '');

  // Validate required duration param.
  const durationMins = parseInt(q.duration, 10);
  if (!VALID_DURATIONS.has(durationMins)) {
    return sendJson(res, 400, { error: 'Query param "duration" must be 15, 30, or 60.' });
  }

  // Validate optional date params.
  if (q.from && !/^\d{4}-\d{2}-\d{2}$/.test(q.from)) {
    return sendJson(res, 400, { error: 'Query param "from" must be YYYY-MM-DD.' });
  }
  if (q.to && !/^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
    return sendJson(res, 400, { error: 'Query param "to" must be YYYY-MM-DD.' });
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[availability] Config load failed:', err.message);
    return sendJson(res, 500, { error: 'Failed to load availability configuration.' });
  }

  const tz         = config.timezone ?? 'UTC';
  const windowDays = Math.min(config.bookingWindowDays ?? 30, MAX_WINDOW_DAYS);
  const today      = getLocalDateStr(new Date(), tz);

  // Clamp the range: no earlier than today, no later than the booking window.
  const maxToStr = addDays(today, windowDays);
  const fromStr  = latestDate(q.from  ?? today,     today);
  const toStr    = earliestDate(q.to  ?? maxToStr,  maxToStr);

  if (fromStr > toStr) {
    return sendJson(res, 200, {
      timezone: tz, duration: durationMins, calendarConnected: false, days: [],
    });
  }

  // Try to read the Google OAuth access token from the request cookies.
  const cookies     = parseCookies(req);
  const accessToken = cookies[COOKIE_ACCESS_TOKEN];
  const calendarId  = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

  let busyPeriods       = [];
  let calendarConnected = false;

  if (accessToken) {
    try {
      busyPeriods       = await fetchBusyPeriods(accessToken, calendarId, fromStr, toStr, tz);
      calendarConnected = true;
    } catch (err) {
      // Non-fatal: log and fall back to config-only slots.
      console.warn(
        '[availability] Google Calendar unavailable — serving config-only slots.',
        err.message,
      );
    }
  }

  const days = generateDays(config, durationMins, fromStr, toStr, busyPeriods);

  return sendJson(res, 200, { timezone: tz, duration: durationMins, calendarConnected, days });
};

/* ── Config ─────────────────────────────────────────────────────────── */

function loadConfig() {
  const filePath = path.join(process.cwd(), 'config', 'availability.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/* ── Google Calendar free/busy ──────────────────────────────────────── */

/**
 * Fetch the busy intervals for calendarId between fromStr and toStr.
 * Returns an array of { start: number, end: number } UTC millisecond pairs.
 */
async function fetchBusyPeriods(accessToken, calendarId, fromStr, toStr, tz) {
  // Request the full span in the manager's timezone so we don't clip a working
  // day that starts before UTC midnight (e.g. UTC-5 timezone, 09:00 local =
  // 14:00 UTC — entirely within the same UTC date, but worth being explicit).
  const timeMin = zonedToUtc(fromStr,          '00:00', tz).toISOString();
  const timeMax = zonedToUtc(addDays(toStr, 1), '00:00', tz).toISOString();

  const r = await fetch(GCAL_FREEBUSY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: [{ id: calendarId }],
    }),
  });

  if (r.status === 401) throw new Error('Access token expired or invalid');
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${r.status}`);
  }

  const data = await r.json();
  const busy = data.calendars?.[calendarId]?.busy ?? [];

  // Convert ISO strings to UTC millisecond numbers for fast numeric comparisons.
  return busy.map(b => ({
    start: new Date(b.start).getTime(),
    end:   new Date(b.end).getTime(),
  }));
}

/* ── Slot generation ────────────────────────────────────────────────── */

/**
 * Walk every date from fromStr to toStr (inclusive) and build a list of days
 * with their available slots. Days with zero available slots are omitted.
 */
function generateDays(config, durationMins, fromStr, toStr, busyPeriods) {
  const tz         = config.timezone ?? 'UTC';
  const bufferMins = config.bufferMinutes       ?? 0;
  const maxPerDay  = config.maxMeetingsPerDay   ?? 8;
  const noticeMs   = (config.minimumNoticeHours ?? 24) * 3_600_000;
  const cutoffMs   = Date.now() + noticeMs; // earliest bookable UTC moment

  const days    = [];
  let   current = fromStr;

  while (current <= toStr) {
    const dayName = getDayName(current, tz);
    const windows = config.weeklySchedule?.[dayName] ?? [];

    if (windows.length > 0) {
      const slots = generateSlotsForDay(
        current, windows, durationMins, bufferMins, maxPerDay, cutoffMs, tz, busyPeriods,
      );
      if (slots.length > 0) {
        days.push({ date: current, slots });
      }
    }

    current = addDays(current, 1);
  }

  return days;
}

/**
 * Produce available 'HH:MM' slot strings for a single date.
 *
 * A slot is available when:
 *   1. Its start time is at or after (now + minimumNoticeHours).
 *   2. It does not overlap any busy period from Google Calendar.
 *
 * Slots are generated by stepping through each working-hours window at
 * (durationMins + bufferMins) intervals.
 */
function generateSlotsForDay(
  dateStr, windows, durationMins, bufferMins, maxPerDay, cutoffMs, tz, busyPeriods,
) {
  const slots    = [];
  const stepMins = durationMins + bufferMins;

  for (const win of windows) {
    let cursor  = parseHHMM(win.start);
    const winEnd = parseHHMM(win.end);

    while (cursor + durationMins <= winEnd) {
      const timeStr    = minsToHHMM(cursor);
      const slotStartMs = zonedToUtcMs(dateStr, timeStr, tz);
      const slotEndMs   = slotStartMs + durationMins * 60_000;

      const meetsNotice = slotStartMs >= cutoffMs;
      // Standard interval overlap test: A overlaps B iff A.start < B.end && A.end > B.start
      const isFree      = !busyPeriods.some(b => slotStartMs < b.end && slotEndMs > b.start);

      if (meetsNotice && isFree) {
        slots.push(timeStr);
      }

      cursor += stepMins;
    }
  }

  // Without a database we cannot know how many meetings are already confirmed,
  // so we cap the number of slots we surface rather than the total booked count.
  return slots.slice(0, maxPerDay);
}

/* ── Timezone utilities ─────────────────────────────────────────────── */

/**
 * Convert a local date ('YYYY-MM-DD') and time ('HH:MM') in the given IANA
 * timezone to a UTC Date object.
 *
 * Algorithm (no external packages required):
 *   1. Treat the target local time as if it were UTC — call this "provisional".
 *   2. Format that provisional UTC instant back through Intl in the target tz
 *      to find what the clock would show — call this "apparent".
 *   3. The offset is (provisional − apparent).
 *   4. The true UTC instant is (provisional + offset).
 *
 * One iteration is exact for all timezones that have a fixed offset within a
 * single day. Across DST transitions the result may be off by ±1 hour on the
 * transition day, which is acceptable for a scheduling UI (the manager sets
 * hours in their own clock time).
 */
function zonedToUtc(dateStr, timeStr, tz) {
  const provisionalMs = new Date(`${dateStr}T${timeStr}:00Z`).getTime();

  // Render the provisional UTC instant in the target timezone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  }).formatToParts(new Date(provisionalMs));

  const p = {};
  parts.forEach(({ type, value }) => { if (type !== 'literal') p[type] = value; });

  // Some environments return '24' for midnight with hour12:false; normalise it.
  const hour = p.hour === '24' ? '00' : p.hour;
  const apparentMs = new Date(
    `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}Z`,
  ).getTime();

  const offsetMs = provisionalMs - apparentMs;
  return new Date(provisionalMs + offsetMs);
}

function zonedToUtcMs(dateStr, timeStr, tz) {
  return zonedToUtc(dateStr, timeStr, tz).getTime();
}

/** Format a Date as 'YYYY-MM-DD' in the given IANA timezone (uses en-CA locale for ISO order). */
function getLocalDateStr(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  }).format(date);
}

/**
 * Return the lowercase weekday name ('monday' … 'sunday') for a date string
 * as seen in the given IANA timezone.
 * Noon UTC is used to avoid edge-cases near midnight across ±14 h offsets.
 */
function getDayName(dateStr, tz) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday:  'long',
  }).format(d).toLowerCase();
}

/** Add n days to a 'YYYY-MM-DD' string and return a new 'YYYY-MM-DD' string. */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Return the later of two 'YYYY-MM-DD' strings. */
const latestDate   = (a, b) => (a >= b ? a : b);

/** Return the earlier of two 'YYYY-MM-DD' strings. */
const earliestDate = (a, b) => (a <= b ? a : b);

/* ── String / time utilities ────────────────────────────────────────── */

const pad = n => String(n).padStart(2, '0');

/** Parse 'HH:MM' to total minutes since midnight. */
function parseHHMM(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

/** Convert total minutes since midnight to 'HH:MM'. */
function minsToHHMM(mins) {
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

/* ── HTTP utilities ─────────────────────────────────────────────────── */

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseQueryString(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

/** Parse the Cookie request header into a plain { name: value } map. */
function parseCookies(req) {
  const header = req.headers?.cookie ?? '';
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap(pair => {
      const idx = pair.indexOf('=');
      if (idx === -1) return [];
      const name  = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      return name ? [[name, decodeURIComponent(value)]] : [];
    }),
  );
}
