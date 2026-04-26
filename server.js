/*
 * server.js – Dorsbooking Express server.
 *
 * Serves static files and provides REST API:
 *   GET  /api/availability?date=YYYY-MM-DD&duration=30
 *   POST /api/book
 *   GET  /api/book           (manager, auth required)
 *   DELETE /api/book/:id     (manager, auth required)
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   PUT  /api/availability   (manager, auth required)
 *
 * Persistence: JSON files under ./data/
 * Auth: simple session token stored in memory (restart clears sessions).
 *
 * Demo credentials: manager@dorsbooking.com / demo1234
 */

'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Data paths ──────────────────────────────────────────────────────── */
const DATA_DIR       = path.join(__dirname, 'data');
const BOOKINGS_FILE  = path.join(DATA_DIR, 'bookings.json');
const SCHEDULE_FILE  = path.join(__dirname, 'config', 'availability.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ── Helpers ──────────────────────────────────────────────────────────── */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function parseMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/* ── Sessions (in-memory) ────────────────────────────────────────────── */
const sessions = new Map(); // token -> { email, createdAt }

const MANAGER_EMAIL    = process.env.MANAGER_EMAIL    || 'manager@dorsbooking.com';
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || 'demo1234';

function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email, createdAt: Date.now() });
  return token;
}

function requireAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim() ||
                req.cookies?.mgr_token;
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

/* ── Middleware ──────────────────────────────────────────────────────── */
app.use(express.json());
app.use(express.static(__dirname, {
  index: 'index.html',
  extensions: ['html'],
}));

/* ── Auth routes ──────────────────────────────────────────────────────── */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === MANAGER_EMAIL && password === MANAGER_PASSWORD) {
    const token = createSession(email);
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const sess  = sessions.get(token);
  if (sess) return res.json({ email: sess.email });
  res.status(401).json({ error: 'Not authenticated' });
});

/* ── Availability routes ─────────────────────────────────────────────── */
app.get('/api/availability', (req, res) => {
  const { date, duration } = req.query;
  const dur = parseInt(duration, 10) || 30;

  const config   = readJSON(SCHEDULE_FILE, {});
  const bookings = readJSON(BOOKINGS_FILE, []);
  const schedule = config.weeklySchedule || {};

  const MIN_NOTICE_HOURS = 24;

  // If date specified, return slots for that date
  if (date) {
    const d       = new Date(`${date}T00:00:00`);
    const dayKey  = DAY_NAMES[d.getDay()];
    const windows = schedule[dayKey] || [];
    const cutoff  = new Date(Date.now() + MIN_NOTICE_HOURS * 3600 * 1000);
    const slots   = [];

    for (const win of windows) {
      let cur      = parseMinutes(win.start);
      const end    = parseMinutes(win.end);
      while (cur + dur <= end) {
        const startStr = minutesToHHMM(cur);
        const endStr   = minutesToHHMM(cur + dur);
        const slotTime = new Date(`${date}T${startStr}:00`);
        if (slotTime > cutoff) {
          const conflict = bookings.some(b =>
            b.date === date &&
            parseMinutes(b.start) < cur + dur &&
            parseMinutes(b.end)   > cur
          );
          if (!conflict) slots.push({ start: startStr, end: endStr });
        }
        cur += dur;
      }
    }
    return res.json({ date, duration: dur, slots });
  }

  // No date → return available dates for next 30 days
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < 30; i++) {
    const d      = new Date(today);
    d.setDate(today.getDate() + i);
    const dayKey = DAY_NAMES[d.getDay()];
    if ((schedule[dayKey] || []).length) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  res.json({ dates });
});

app.put('/api/availability', requireAuth, (req, res) => {
  const config = readJSON(SCHEDULE_FILE, {});
  config.weeklySchedule = req.body.weeklySchedule || config.weeklySchedule;
  if (req.body.slotDurationMinutes) config.slotDurationMinutes = req.body.slotDurationMinutes;
  writeJSON(SCHEDULE_FILE, config);
  res.json({ ok: true });
});

/* ── Booking routes ──────────────────────────────────────────────────── */
app.post('/api/book', (req, res) => {
  const { name, email, date, start, end, duration, notes } = req.body || {};
  if (!name || !email || !date || !start || !end) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const bookings = readJSON(BOOKINGS_FILE, []);

  // Conflict check
  const conflict = bookings.some(b =>
    b.date === date &&
    parseMinutes(b.start) < parseMinutes(end) &&
    parseMinutes(b.end)   > parseMinutes(start)
  );
  if (conflict) return res.status(409).json({ error: 'Slot no longer available' });

  const booking = {
    id:       crypto.randomUUID(),
    name,
    email,
    notes:    notes || '',
    date,
    start,
    end,
    duration: parseInt(duration, 10) || 30,
    bookedAt: new Date().toISOString(),
  };

  bookings.push(booking);
  writeJSON(BOOKINGS_FILE, bookings);
  res.status(201).json({ ok: true, id: booking.id });
});

app.get('/api/book', requireAuth, (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE, []);
  const now      = new Date().toISOString().slice(0, 10);
  const upcoming = bookings
    .filter(b => b.date >= now)
    .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`));
  res.json({ bookings: upcoming });
});

app.delete('/api/book/:id', requireAuth, (req, res) => {
  let bookings = readJSON(BOOKINGS_FILE, []);
  const before = bookings.length;
  bookings = bookings.filter(b => b.id !== req.params.id);
  if (bookings.length === before) return res.status(404).json({ error: 'Not found' });
  writeJSON(BOOKINGS_FILE, bookings);
  res.json({ ok: true });
});

/* ── Start ───────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`Dorsbooking running at http://localhost:${PORT}`);
  console.log(`Manager login: ${MANAGER_EMAIL} / ${MANAGER_PASSWORD}`);
});
