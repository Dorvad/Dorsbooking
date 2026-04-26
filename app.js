/*
 * app.js
 * Client-side entry point for Dorsbooking.
 * Plain DOM APIs only – no frameworks.
 *
 * ── App state ───────────────────────────────────────────────────────
 *
 *  state.config                 In-memory copy of availability.json.
 *                               Mutated in-place when manager saves changes.
 *
 *  state.view                   Active top-level view:
 *                               'home' | 'booking' | 'manager'
 *
 *  state.booking.meetingType    Selected duration as string: '15'|'30'|'60'
 *  state.booking.selectedDate   Chosen date as 'YYYY-MM-DD' (local)
 *  state.booking.selectedSlot   Chosen start time as 'HH:MM' (local)
 *  state.booking.step           Wizard step 1–4
 *
 *  state.manager.authed         Whether the manager is logged in this session
 *
 * ─────────────────────────────────────────────────────────────────── */

/* ── State ─────────────────────────────────────────────────────────── */

const state = {
  config: null,
  view: 'home',
  booking: {
    meetingType: null,
    selectedDate: null,
    selectedSlot: null,
    step: 1,
  },
  manager: {
    authed: false,
  },
};

/* ── DOM helpers ────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ── Utilities ──────────────────────────────────────────────────────── */

const pad = n => String(n).padStart(2, '0');

function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const dayName = d => WEEKDAYS[d.getDay()];

function parseHHMM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const minsToHHMM = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

function fmtTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDateLong(date) {
  return date.toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

/* ── Config ─────────────────────────────────────────────────────────── */

async function loadConfig() {
  const res = await fetch('config/availability.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const FALLBACK_CONFIG = {
  timezone: 'UTC',
  slotDurationMinutes: 30,
  bufferMinutes: 0,
  maxMeetingsPerDay: 8,
  minimumNoticeHours: 24,
  bookingWindowDays: 30,
  auth: { email: 'manager@dorsbooking.com', password: 'demo1234' },
  weeklySchedule: {
    monday:    [{ start: '09:00', end: '17:00' }],
    tuesday:   [{ start: '09:00', end: '17:00' }],
    wednesday: [{ start: '09:00', end: '17:00' }],
    thursday:  [{ start: '09:00', end: '17:00' }],
    friday:    [{ start: '09:00', end: '17:00' }],
    saturday:  [],
    sunday:    [],
  },
};

/* ── View switching ─────────────────────────────────────────────────── */

function setView(view) {
  state.view = view;

  const isHome = view === 'home';
  const heroEl    = $('#hero');
  const featuresEl = $('#features');
  if (heroEl)     heroEl.hidden     = !isHome;
  if (featuresEl) featuresEl.hidden = !isHome;

  $$('[data-view-panel]').forEach(panel => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });

  $$('.nav-tab[data-view-target]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.viewTarget === view);
  });
}

/* ── Booking wizard – step navigation ───────────────────────────────── */

const STEP_SELECTORS = {
  1: '#meeting-type-picker',
  2: '#slot-picker',
  3: '#booking-details',
  4: '#booking-success',
};

function showStep(n) {
  state.booking.step = n;
  Object.entries(STEP_SELECTORS).forEach(([num, sel]) => {
    const el = $(sel);
    if (el) el.hidden = Number(num) !== n;
  });
}

function resetBooking() {
  state.booking.meetingType  = null;
  state.booking.selectedDate = null;
  state.booking.selectedSlot = null;
  $$('.meeting-type-card').forEach(b => b.setAttribute('aria-pressed', 'false'));
  showStep(1);
}

/* ── Date generation ────────────────────────────────────────────────── */

function getAvailableDates() {
  const windowDays = state.config.bookingWindowDays ?? 30;
  const now = new Date();
  const dates = [];

  for (let i = 0; i <= windowDays; i++) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);

    const schedule = state.config.weeklySchedule[dayName(d)];
    if (!schedule || schedule.length === 0) continue;

    if (getSlotsForDate(toISODate(d)).length > 0) dates.push(d);
  }
  return dates;
}

/* ── Slot generation ────────────────────────────────────────────────── */

function getSlotsForDate(dateStr) {
  const durationMins = Number(state.booking.meetingType);
  if (!durationMins) return [];

  const { config } = state;
  const bufferMins = config.bufferMinutes ?? 0;
  const noticeMs   = (config.minimumNoticeHours ?? 24) * 3_600_000;
  const now        = new Date();

  // Use local noon to get the correct day-of-week regardless of DST
  const localDate = new Date(`${dateStr}T12:00:00`);
  const windows   = config.weeklySchedule[dayName(localDate)] ?? [];

  const slots = [];
  for (const win of windows) {
    let cursor = parseHHMM(win.start);
    const end  = parseHHMM(win.end);

    while (cursor + durationMins <= end) {
      const slotDate = new Date(`${dateStr}T${minsToHHMM(cursor)}:00`);
      if (slotDate.getTime() >= now.getTime() + noticeMs) {
        slots.push(minsToHHMM(cursor));
      }
      cursor += durationMins + bufferMins;
    }
  }
  return slots;
}

/* ── Render date rail ───────────────────────────────────────────────── */

function renderDateRail() {
  const rail = $('[data-date-rail]');
  if (!rail) return;
  rail.innerHTML = '';

  getAvailableDates().forEach(d => {
    const dateStr = toISODate(d);

    const li  = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.dateBtn = dateStr;
    btn.setAttribute('aria-pressed', dateStr === state.booking.selectedDate ? 'true' : 'false');
    if (dateStr === state.booking.selectedDate) btn.classList.add('is-selected');

    const daySpan = document.createElement('span');
    daySpan.textContent = d.toLocaleDateString([], { weekday: 'short' });

    const dateNum = document.createElement('strong');
    dateNum.textContent = d.getDate();

    const monthSpan = document.createElement('span');
    monthSpan.textContent = d.toLocaleDateString([], { month: 'short' });

    btn.append(daySpan, dateNum, monthSpan);
    li.appendChild(btn);
    rail.appendChild(li);

    btn.addEventListener('click', () => selectDate(dateStr));
  });
}

/* ── Render slot grid ───────────────────────────────────────────────── */

function renderSlotGrid() {
  const grid     = $('[data-slot-grid]');
  const emptyMsg = $('[data-slot-empty]');
  if (!grid) return;
  grid.innerHTML = '';

  const { selectedDate, selectedSlot } = state.booking;
  if (!selectedDate) return;

  const slots = getSlotsForDate(selectedDate);

  if (slots.length === 0) {
    if (emptyMsg) emptyMsg.hidden = false;
    return;
  }
  if (emptyMsg) emptyMsg.hidden = true;

  slots.forEach(time => {
    const li  = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.slotBtn = time;
    btn.setAttribute('aria-pressed', time === selectedSlot ? 'true' : 'false');
    if (time === selectedSlot) btn.classList.add('is-selected');
    btn.textContent = fmtTime(new Date(`${selectedDate}T${time}:00`));
    li.appendChild(btn);
    grid.appendChild(li);
    btn.addEventListener('click', () => selectSlot(time));
  });
}

/* ── Select date ────────────────────────────────────────────────────── */

function selectDate(dateStr) {
  state.booking.selectedDate = dateStr;
  state.booking.selectedSlot = null;

  $$('[data-date-btn]').forEach(btn => {
    const on = btn.dataset.dateBtn === dateStr;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
  });

  renderSlotGrid();
}

/* ── Select slot ────────────────────────────────────────────────────── */

function selectSlot(time) {
  state.booking.selectedSlot = time;

  $$('[data-slot-btn]').forEach(btn => {
    const on = btn.dataset.slotBtn === time;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
  });

  // Brief pause so the user sees the selection before the view changes.
  setTimeout(() => {
    updateBookingSummary();
    showStep(3);
  }, 160);
}

/* ── Slot meta (timezone + chosen duration) ─────────────────────────── */

function updateSlotMeta() {
  const tzEl  = $('[data-timezone-label]');
  const durEl = $('[data-selected-duration]');
  if (tzEl)  tzEl.textContent  = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (durEl) durEl.textContent = state.booking.meetingType
    ? `${state.booking.meetingType} min`
    : '';
}

/* ── Booking summary card ───────────────────────────────────────────── */

function updateBookingSummary() {
  const el = $('[data-booking-summary]');
  if (!el) return;

  const { selectedDate, selectedSlot, meetingType } = state.booking;
  if (!selectedDate || !selectedSlot) return;

  const start = new Date(`${selectedDate}T${selectedSlot}:00`);
  const end   = new Date(start.getTime() + Number(meetingType) * 60_000);

  el.innerHTML = `
    <strong>${fmtDateLong(start)}</strong><br>
    ${fmtTime(start)}&thinsp;–&thinsp;${fmtTime(end)}&ensp;·&ensp;${meetingType}&thinsp;min
  `;
}

/* ── Booking panel init & form validation ───────────────────────────── */

function initBookingPanel() {
  // Meeting type selection
  $$('.meeting-type-card').forEach(btn => {
    btn.addEventListener('click', () => {
      state.booking.meetingType  = btn.dataset.meetingType;
      state.booking.selectedDate = null;
      state.booking.selectedSlot = null;

      $$('.meeting-type-card').forEach(b => {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });

      renderDateRail();
      updateSlotMeta();
      showStep(2);
    });
  });

  // Back button (step 3 → step 2)
  const backBtn = $('[data-back-to-slots]');
  if (backBtn) backBtn.addEventListener('click', () => showStep(2));

  // Booking form submit
  const bookingForm = $('[data-booking-form]');
  if (bookingForm) {
    bookingForm.addEventListener('submit', e => {
      e.preventDefault();
      if (validateBookingForm(bookingForm)) {
        bookingForm.reset();
        showStep(4);
      }
    });
  }
}

function validateBookingForm(form) {
  const nameInput  = form.elements['name'];
  const emailInput = form.elements['email'];

  // Clear any previous custom messages first so reportValidity re-runs cleanly.
  nameInput.setCustomValidity('');
  emailInput.setCustomValidity('');

  if (!nameInput.value.trim()) {
    nameInput.setCustomValidity('Please enter your full name.');
    nameInput.reportValidity();
    return false;
  }

  const emailVal = emailInput.value.trim();
  if (!emailVal) {
    emailInput.setCustomValidity('Please enter your email address.');
    emailInput.reportValidity();
    return false;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
    emailInput.setCustomValidity('Please enter a valid email address.');
    emailInput.reportValidity();
    return false;
  }

  return true;
}

/* ── Manager panel init ─────────────────────────────────────────────── */

function initManagerPanel() {
  const loginForm = $('[data-manager-login]');
  if (loginForm) {
    loginForm.addEventListener('submit', e => {
      e.preventDefault();
      handleManagerLogin(loginForm);
    });
  }

  const signoutBtn = $('[data-manager-signout]');
  if (signoutBtn) signoutBtn.addEventListener('click', managerSignOut);

  const googleBtn = $('[data-google-connect]');
  if (googleBtn) {
    googleBtn.addEventListener('click', () => {
      const statusEl = $('[data-google-status]');
      if (statusEl) statusEl.textContent = 'Google Calendar integration is not configured in this demo.';
    });
  }

  const availForm = $('#availability-form');
  if (availForm) {
    availForm.addEventListener('submit', e => {
      e.preventDefault();
      saveAvailability(availForm);
    });
  }
}

/* ── Manager login ──────────────────────────────────────────────────── */

function handleManagerLogin(form) {
  const email    = form.elements['email'].value.trim();
  const password = form.elements['password'].value;
  const auth     = state.config.auth;

  // Ensure a single error element exists below the form actions.
  let errEl = form.querySelector('.login-error');
  if (!errEl) {
    errEl = document.createElement('p');
    errEl.className = 'login-error';
    errEl.setAttribute('role', 'alert');
    errEl.style.cssText = 'color:#dc2626;font-size:.875rem;margin-top:.5rem;';
    form.querySelector('.form-actions').insertAdjacentElement('afterend', errEl);
  }
  errEl.textContent = '';

  if (!auth || email !== auth.email || password !== auth.password) {
    errEl.textContent = 'Incorrect email or password.';
    return;
  }

  state.manager.authed = true;

  const gate  = $('[data-manager-gate]');
  const shell = $('[data-manager-shell]');
  if (gate)  gate.hidden  = true;
  if (shell) {
    shell.hidden = false;
    hydrateAvailabilityForm();
  }
}

/* ── Manager sign-out ───────────────────────────────────────────────── */

function managerSignOut() {
  state.manager.authed = false;

  const gate  = $('[data-manager-gate]');
  const shell = $('[data-manager-shell]');
  if (gate)  gate.hidden  = false;
  if (shell) shell.hidden = true;

  const loginForm = $('[data-manager-login]');
  if (loginForm) {
    loginForm.reset();
    const errEl = loginForm.querySelector('.login-error');
    if (errEl) errEl.textContent = '';
  }
}

/* ── Manager form hydration ─────────────────────────────────────────── */

function hydrateAvailabilityForm() {
  const { config } = state;

  // Default hours: use the first enabled day as a reference
  const firstEnabled = Object.values(config.weeklySchedule).find(w => w.length > 0);
  const defStartEl = $('#availability-start');
  const defEndEl   = $('#availability-end');
  if (defStartEl) defStartEl.value = firstEnabled?.[0]?.start ?? '09:00';
  if (defEndEl)   defEndEl.value   = firstEnabled?.[0]?.end   ?? '17:00';

  // Per-day rows
  Object.entries(config.weeklySchedule).forEach(([day, windows]) => {
    const row = $(`[data-weekday="${day}"]`);
    if (!row) return;

    const cb     = row.querySelector(`input[name="day-${day}"]`);
    const startI = row.querySelector(`input[name="${day}-start"]`);
    const endI   = row.querySelector(`input[name="${day}-end"]`);

    if (cb)     cb.checked    = windows.length > 0;
    if (startI) startI.value  = windows[0]?.start ?? '09:00';
    if (endI)   endI.value    = windows[0]?.end   ?? '17:00';
  });

  // Booking rule inputs
  const rules = {
    'slot-duration':        config.slotDurationMinutes ?? 30,
    'buffer-minutes':       config.bufferMinutes       ?? 0,
    'max-meetings-per-day': config.maxMeetingsPerDay   ?? 8,
    'minimum-notice-hours': config.minimumNoticeHours  ?? 24,
    'booking-window-days':  config.bookingWindowDays   ?? 30,
  };
  Object.entries(rules).forEach(([id, val]) => {
    const el = $(`#${id}`);
    if (el) el.value = val;
  });
}

/* ── Manager save availability ──────────────────────────────────────── */

function saveAvailability(form) {
  const { config } = state;

  // Read per-day schedule from the form
  const schedule = {};
  Object.keys(config.weeklySchedule).forEach(day => {
    const row = $(`[data-weekday="${day}"]`);
    if (!row) { schedule[day] = config.weeklySchedule[day]; return; }

    const cb     = row.querySelector(`input[name="day-${day}"]`);
    const startI = row.querySelector(`input[name="${day}-start"]`);
    const endI   = row.querySelector(`input[name="${day}-end"]`);

    schedule[day] = (cb?.checked && startI && endI)
      ? [{ start: startI.value, end: endI.value }]
      : [];
  });

  // Mutate in-memory config so the booking wizard picks up the new values.
  config.weeklySchedule      = schedule;
  config.slotDurationMinutes = Number($('#slot-duration')?.value       ?? 30);
  config.bufferMinutes       = Number($('#buffer-minutes')?.value      ?? 0);
  config.maxMeetingsPerDay   = Number($('#max-meetings-per-day')?.value ?? 8);
  config.minimumNoticeHours  = Number($('#minimum-notice-hours')?.value ?? 24);
  config.bookingWindowDays   = Number($('#booking-window-days')?.value  ?? 30);

  // Transient save feedback
  const saveBtn = form.querySelector('[data-save-availability]');
  if (saveBtn) {
    const orig = saveBtn.textContent;
    saveBtn.textContent = 'Saved ✓';
    saveBtn.disabled = true;
    setTimeout(() => {
      saveBtn.textContent = orig;
      saveBtn.disabled = false;
    }, 2000);
  }
}

/* ── Global view-switch delegation ─────────────────────────────────── */

function initViewSwitching() {
  // A single listener at the document level handles every [data-view-target]
  // button including those that are added/removed from the DOM dynamically.
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-view-target]');
    if (!btn) return;
    const target = btn.dataset.viewTarget;
    setView(target);
    if (target === 'booking') resetBooking();
  });
}

/* ── Boot ───────────────────────────────────────────────────────────── */

async function init() {
  try {
    state.config = await loadConfig();
  } catch (err) {
    console.warn('Could not load availability.json – falling back to defaults.', err);
    state.config = structuredClone(FALLBACK_CONFIG);
  }

  initViewSwitching();
  initBookingPanel();
  initManagerPanel();
  setView('home');
}

document.addEventListener('DOMContentLoaded', init);
