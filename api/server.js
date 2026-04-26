'use strict';

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();

/* ── Supabase client ─────────────────────────────────────────────────── */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ── Sessions (in-memory) ────────────────────────────────────────────── */
const sessions = new Map(); // token -> { email }

const MANAGER_EMAIL    = process.env.MANAGER_EMAIL    || 'manager@dorsbooking.com';
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || 'demo1234';

function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email });
  return token;
}

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function parseMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// Reads all rows from the settings table and returns them as a plain object.
// e.g. { weeklySchedule: {...}, slotDurationMinutes: 30, ... }
async function getSettings() {
  const { data, error } = await supabase.from('settings').select('key, value');
  if (error || !data) return {};
  return Object.fromEntries(data.map(row => [row.key, row.value]));
}

/* ── Middleware ──────────────────────────────────────────────────────── */
app.use(express.json());

// Serve static files (index.html, app.js, styles.css) from the project root.
// __dirname here is /api, so we go up one level.
app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html',
  extensions: ['html'],
}));

/* ── Auth routes ──────────────────────────────────────────────────────── */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === MANAGER_EMAIL && password === MANAGER_PASSWORD) {
    return res.json({ token: createSession(email) });
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
app.get('/api/availability', async (req, res) => {
  try {
    const { date, duration } = req.query;
    const dur = parseInt(duration, 10) || 30;

    const config   = await getSettings();
    const schedule = config.weeklySchedule || {};

    const minNoticeHours = config.minimumNoticeHours ?? 24;

    // If a date was given, return the available slots for that date
    if (date) {
      const dayKey   = DAY_NAMES[new Date(`${date}T00:00:00`).getDay()];
      const windows  = schedule[dayKey] || [];
      const cutoff   = new Date(Date.now() + minNoticeHours * 3600 * 1000);

      const { data: rows } = await supabase
        .from('bookings')
        .select('date, start, end')
        .eq('date', date);
      const bookings = rows || [];

      const slots = [];
      for (const win of windows) {
        let cur = parseMinutes(win.start);
        const end = parseMinutes(win.end);
        while (cur + dur <= end) {
          const startStr = minutesToHHMM(cur);
          const endStr   = minutesToHHMM(cur + dur);
          const slotTime = new Date(`${date}T${startStr}:00`);
          if (slotTime > cutoff) {
            const conflict = bookings.some(b =>
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

    // No date given — return all available dates within the booking window
    const windowDays = config.bookingWindowDays ?? 30;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dates = [];
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dayKey = DAY_NAMES[d.getDay()];
      if ((schedule[dayKey] || []).length) {
        dates.push(d.toISOString().slice(0, 10));
      }
    }
    res.json({ dates });

  } catch (err) {
    console.error('GET /api/availability error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    console.error('GET /api/settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/debug-settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('key, value');
  const url = process.env.SUPABASE_URL || '';
  res.json({ data, error, supabaseUrl: url.slice(0, 40) });
});

app.put('/api/availability', requireAuth, async (req, res) => {
  try {
    const fields = [
      'weeklySchedule',
      'slotDurationMinutes',
      'bufferMinutes',
      'minimumNoticeHours',
      'bookingWindowDays',
    ];
    for (const field of fields) {
      if (req.body[field] != null) {
        await supabase
          .from('settings')
          .upsert({ key: field, value: req.body[field] });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/availability error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── Booking routes ──────────────────────────────────────────────────── */
app.post('/api/book', async (req, res) => {
  try {
    const { name, email, date, start, end, duration, notes } = req.body || {};
    if (!name || !email || !date || !start || !end) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Fetch only bookings on the same date to check for conflicts
    const { data: rows } = await supabase
      .from('bookings')
      .select('start, end')
      .eq('date', date);
    const existing = rows || [];

    const conflict = existing.some(b =>
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

    const { error } = await supabase.from('bookings').insert([booking]);
    if (error) throw error;

    res.status(201).json({ ok: true, id: booking.id });

  } catch (err) {
    console.error('POST /api/book error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/book', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .gte('date', today)
      .order('date')
      .order('start');
    if (error) throw error;
    res.json({ bookings: data || [] });
  } catch (err) {
    console.error('GET /api/book error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/book/:id', requireAuth, async (req, res) => {
  try {
    const { error, count } = await supabase
      .from('bookings')
      .delete({ count: 'exact' })
      .eq('id', req.params.id);
    if (error) throw error;
    if (count === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/book error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── Local dev entry point ───────────────────────────────────────────── */
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Dorsbooking running at http://localhost:${PORT}`);
    console.log(`Manager login: ${MANAGER_EMAIL} / ${MANAGER_PASSWORD}`);
  });
}

module.exports = app;
