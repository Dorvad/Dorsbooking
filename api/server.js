'use strict';

const express        = require('express');
const crypto         = require('crypto');
const path           = require('path');
const { createClient } = require('@supabase/supabase-js');
const { google }     = require('googleapis');
const { Resend }     = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

/* ── Supabase client ─────────────────────────────────────────────────── */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
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
    const { name, email, date, start, end, duration, notes, platform, meetingLink, location } = req.body || {};
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
      id:           crypto.randomUUID(),
      name,
      email,
      notes:        notes || '',
      date,
      start,
      end,
      duration:     parseInt(duration, 10) || 30,
      bookedAt:     new Date().toISOString(),
      platform:     platform || 'google_meet',
      meeting_link: meetingLink || '',
      location:     location || '',
    };

    const { error } = await supabase.from('bookings').insert([booking]);
    if (error) throw error;

    // For Google Meet: await so we can return the Meet URL to the visitor
    let meetUrl = '';
    if (booking.platform === 'google_meet') {
      meetUrl = await addToGoogleCalendar(booking).catch(err => {
        console.error('Google Calendar insert failed:', err.message);
        return '';
      });
    } else {
      addToGoogleCalendar(booking).catch(err =>
        console.error('Google Calendar insert failed:', err.message)
      );
    }

    // Fire-and-forget email notification to the manager
    sendBookingNotification(booking, meetUrl).catch(err =>
      console.error('Email notification failed:', err.message)
    );

    res.status(201).json({ ok: true, id: booking.id, meetUrl });

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

/* ── Email notifications ─────────────────────────────────────────────── */
async function sendBookingNotification(booking, meetUrl = '') {
  const to = process.env.RESEND_EMAIL_TO;
  if (!to || !process.env.RESEND_API_KEY) return;

  const platformLabels = { google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Teams', in_person: 'In Person' };
  const platformName   = platformLabels[booking.platform] || booking.platform || '';

  const date = new Date(`${booking.date}T00:00:00`);
  const dateStr = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  let detailLine = '';
  if (meetUrl)                                              detailLine = `<b>Meet link:</b> <a href="${meetUrl}">${meetUrl}</a>`;
  else if (booking.meeting_link)                            detailLine = `<b>Meeting link:</b> <a href="${booking.meeting_link}">${booking.meeting_link}</a>`;
  else if (booking.location)                                detailLine = `<b>Location:</b> ${booking.location}`;

  await resend.emails.send({
    from:    'Dorsbooking <onboarding@resend.dev>',
    to,
    subject: `New booking — ${booking.name} on ${dateStr}`,
    html: `
      <p>Hey Dor, you have a new booking!</p>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:15px">
        <tr><td style="padding:4px 16px 4px 0;color:#888">Name</td>   <td><b>${booking.name}</b></td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#888">Email</td>  <td><a href="mailto:${booking.email}">${booking.email}</a></td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#888">Date</td>   <td>${dateStr}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#888">Time</td>   <td>${booking.start} – ${booking.end}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#888">Type</td>   <td>${booking.duration} min</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#888">Via</td>    <td>${platformName}</td></tr>
        ${detailLine ? `<tr><td style="padding:4px 16px 4px 0;color:#888">Detail</td><td>${detailLine}</td></tr>` : ''}
        ${booking.notes ? `<tr><td style="padding:4px 16px 4px 0;color:#888">Notes</td><td>${booking.notes}</td></tr>` : ''}
      </table>
    `,
  });
}

/* ── Google Calendar OAuth ───────────────────────────────────────────── */
function getOAuthClient() {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${base}/api/auth/google/callback`
  );
}

// Manager clicks "Connect Google Calendar" — redirects to Google consent screen
app.get('/api/auth/google', (req, res) => {
  const url = getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/calendar.events'],
  });
  res.redirect(url);
});

// Google redirects back here after the manager approves
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await getOAuthClient().getToken(req.query.code);
    await supabase.from('oauth_tokens').upsert({ provider: 'google', tokens });
    res.redirect('/?connected=1');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('/?connected=error');
  }
});

// Adds a Google Calendar event for a booking (called server-side after booking is saved)
async function addToGoogleCalendar(booking) {
  const { data } = await supabase
    .from('oauth_tokens')
    .select('tokens')
    .eq('provider', 'google')
    .single();
  if (!data?.tokens) return;

  const auth = getOAuthClient();
  auth.setCredentials(data.tokens);

  // Refresh and save updated tokens if they changed
  auth.on('tokens', async updated => {
    const merged = { ...data.tokens, ...updated };
    await supabase.from('oauth_tokens').upsert({ provider: 'google', tokens: merged });
  });

  const cal        = google.calendar({ version: 'v3', auth });
  const createMeet = booking.platform === 'google_meet';

  const requestBody = {
    summary:     `${booking.name} — ${booking.duration} min`,
    description: booking.notes || '',
    start: { dateTime: `${booking.date}T${booking.start}:00`, timeZone: 'Europe/Amsterdam' },
    end:   { dateTime: `${booking.date}T${booking.end}:00`,   timeZone: 'Europe/Amsterdam' },
  };

  if (createMeet) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: booking.id,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const { data: event } = await cal.events.insert({
    calendarId:            'primary',
    conferenceDataVersion: createMeet ? 1 : 0,
    requestBody,
  });

  return event.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri || '';
}

/* ── Local dev entry point ───────────────────────────────────────────── */
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Dorsbooking running at http://localhost:${PORT}`);
    console.log(`Manager login: ${MANAGER_EMAIL} / ${MANAGER_PASSWORD}`);
  });
}

module.exports = app;
