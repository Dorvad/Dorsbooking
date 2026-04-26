/*
 * app.js – Dorsbooking client-side logic.
 * No framework. Pure DOM APIs + localStorage for demo persistence.
 *
 * Demo manager credentials: manager@dorsbooking.com / demo1234
 */

/* ── Constants ──────────────────────────────────────────────────────── */
const DEMO_EMAIL    = 'manager@dorsbooking.com';
const DEMO_PASSWORD = 'demo1234';
const BOOKING_WINDOW_DAYS = 30;
const MIN_NOTICE_HOURS    = 24;

/* Weekly schedule (mirrors config/availability.json, used client-side for demo) */
const DEFAULT_SCHEDULE = {
  monday:    [{ start: '09:00', end: '17:00' }],
  tuesday:   [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '12:00' }],
  thursday:  [{ start: '09:00', end: '17:00' }],
  friday:    [{ start: '09:00', end: '15:00' }],
  saturday:  [],
  sunday:    [],
};

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  view: 'home',           // 'home' | 'booking' | 'manager'
  meetingDuration: null,  // minutes
  selectedDate: null,     // 'YYYY-MM-DD'
  selectedSlot: null,     // { start, end } HH:MM strings
  schedule: loadSchedule(),
  bookings: loadBookings(),
  authed: !!sessionStorage.getItem('mgr_authed'),
};

/* ── Persistence helpers ────────────────────────────────────────────── */
function loadSchedule() {
  try {
    const raw = localStorage.getItem('dors_schedule');
    return raw ? JSON.parse(raw) : structuredClone(DEFAULT_SCHEDULE);
  } catch { return structuredClone(DEFAULT_SCHEDULE); }
}

function saveSchedule(s) {
  localStorage.setItem('dors_schedule', JSON.stringify(s));
}

function loadBookings() {
  try {
    const raw = localStorage.getItem('dors_bookings');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveBookings(b) {
  localStorage.setItem('dors_bookings', JSON.stringify(b));
}

/* ── DOM refs ───────────────────────────────────────────────────────── */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const dom = {};

function initRefs() {
  dom.hero           = $('#hero');
  dom.features       = $('#features');
  dom.panelBooking   = $('#panel-booking');
  dom.panelManager   = $('#panel-manager');
  dom.navTabs        = $$('[data-view-target]');

  // Booking steps
  dom.typePicker     = $('#meeting-type-picker');
  dom.slotPicker     = $('#slot-picker');
  dom.bookingDetails = $('#booking-details');
  dom.bookingSuccess = $('#booking-success');
  dom.typeCards      = $$('[data-meeting-type]');
  dom.dateRail       = $('[data-date-rail]');
  dom.slotGrid       = $('[data-slot-grid]');
  dom.slotEmpty      = $('[data-slot-empty]');
  dom.tzLabel        = $('[data-timezone-label]');
  dom.selectedDur    = $('[data-selected-duration]');
  dom.bookingSummary = $('[data-booking-summary]');
  dom.bookingForm    = $('[data-booking-form]');
  dom.backToSlots    = $('[data-back-to-slots]');

  // Manager
  dom.managerGate    = $('[data-manager-gate]');
  dom.managerShell   = $('[data-manager-shell]');
  dom.managerLogin   = $('[data-manager-login]');
  dom.managerSignout = $('[data-manager-signout]');
  dom.googleStatus   = $('[data-google-status]');
  dom.googleConnect  = $('[data-google-connect]');
  dom.availForm      = $('#availability-form');
}

/* ── View switching ─────────────────────────────────────────────────── */
function showView(view) {
  state.view = view;

  const isHome    = view === 'home';
  const isBooking = view === 'booking';
  const isManager = view === 'manager';

  // Hero / features only on home
  setVisible(dom.hero,     isHome, 'fade');
  setVisible(dom.features, isHome, 'fade');

  // Panels
  setVisible(dom.panelBooking, isBooking, 'slide-up');
  setVisible(dom.panelManager, isManager, 'slide-up');

  // Nav tab active state
  dom.navTabs.forEach(btn => {
    const match = btn.dataset.viewTarget === view;
    btn.classList.toggle('is-active', match);
    btn.setAttribute('aria-current', match ? 'page' : 'false');
  });

  if (isBooking) resetBookingFlow();
  if (isManager) renderManagerView();
}

/* Show/hide with animation class */
function setVisible(el, show, animClass) {
  if (!el) return;
  if (show) {
    el.hidden = false;
    el.classList.remove('anim-out');
    el.classList.add('anim-in', animClass);
  } else {
    el.classList.remove('anim-in');
    el.classList.add('anim-out');
    // hide after animation
    const onEnd = () => {
      el.hidden = true;
      el.classList.remove('anim-out', animClass);
      el.removeEventListener('animationend', onEnd);
    };
    el.addEventListener('animationend', onEnd, { once: true });
    // fallback if no animation fires
    setTimeout(() => { if (!el.hidden) { el.hidden = true; el.classList.remove('anim-out', animClass); } }, 350);
  }
}

/* ── Booking flow ───────────────────────────────────────────────────── */
function resetBookingFlow() {
  state.meetingDuration = null;
  state.selectedDate    = null;
  state.selectedSlot    = null;

  // Reset aria-pressed on type cards
  dom.typeCards.forEach(c => c.setAttribute('aria-pressed', 'false'));

  showStep('type-picker');
}

function showStep(step) {
  const steps = {
    'type-picker':      dom.typePicker,
    'slot-picker':      dom.slotPicker,
    'booking-details':  dom.bookingDetails,
    'booking-success':  dom.bookingSuccess,
  };
  Object.entries(steps).forEach(([key, el]) => {
    if (!el) return;
    const show = key === step;
    if (show) {
      el.hidden = false;
      el.classList.add('step-enter');
      requestAnimationFrame(() => el.classList.add('step-enter-active'));
      setTimeout(() => el.classList.remove('step-enter', 'step-enter-active'), 400);
    } else {
      el.hidden = true;
      el.classList.remove('step-enter', 'step-enter-active');
    }
  });
}

/* Meeting type selection */
function handleTypeSelect(btn) {
  const duration = parseInt(btn.dataset.meetingType, 10);
  state.meetingDuration = duration;

  dom.typeCards.forEach(c => c.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');

  // Update slot picker meta
  if (dom.selectedDur) dom.selectedDur.textContent = `${duration} min`;
  if (dom.tzLabel) {
    try {
      dom.tzLabel.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      dom.tzLabel.textContent = 'Local time';
    }
  }

  renderDateRail();
  showStep('slot-picker');
}

/* ── Date rail ──────────────────────────────────────────────────────── */
function renderDateRail() {
  dom.dateRail.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let rendered = 0;
  let offset   = 0;

  // Skip today if within min-notice window
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() + MIN_NOTICE_HOURS);

  while (rendered < BOOKING_WINDOW_DAYS && offset < BOOKING_WINDOW_DAYS + 7) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    offset++;

    const dayKey = DAY_NAMES[d.getDay()];
    const windows = state.schedule[dayKey] || [];
    if (!windows.length) continue;

    const slots = getSlotsForDate(d, state.meetingDuration);
    if (!slots.length) continue;

    const iso = toISODate(d);
    const li  = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.dateBtn = iso;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `
      <span class="date-day">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="date-num">${d.getDate()}</span>
      <span class="date-mon">${d.toLocaleDateString(undefined, { month: 'short' })}</span>
    `;
    btn.addEventListener('click', () => handleDateSelect(iso, btn));
    li.appendChild(btn);
    dom.dateRail.appendChild(li);
    rendered++;
  }

  if (!dom.dateRail.children.length) {
    const li = document.createElement('li');
    li.textContent = 'No available dates in the next 30 days.';
    li.style.color = 'var(--color-muted)';
    li.style.padding = '0.5rem';
    dom.dateRail.appendChild(li);
  }
}

function handleDateSelect(iso, btn) {
  state.selectedDate = iso;

  $$('[data-date-btn]').forEach(b => b.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');

  renderSlotGrid(iso);
}

/* ── Slot grid ──────────────────────────────────────────────────────── */
function renderSlotGrid(iso) {
  dom.slotGrid.innerHTML = '';
  const date  = new Date(iso + 'T00:00:00');
  const slots = getSlotsForDate(date, state.meetingDuration);

  if (!slots.length) {
    dom.slotEmpty.hidden = false;
    return;
  }
  dom.slotEmpty.hidden = true;

  slots.forEach(slot => {
    const li  = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.slotBtn = slot.start;
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = formatTime(slot.start);
    btn.addEventListener('click', () => handleSlotSelect(slot, btn));
    li.appendChild(btn);
    dom.slotGrid.appendChild(li);
  });
}

function handleSlotSelect(slot, btn) {
  state.selectedSlot = slot;

  $$('[data-slot-btn]').forEach(b => b.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');

  renderBookingSummary();

  // Brief pause so user sees the selection, then advance
  setTimeout(() => showStep('booking-details'), 220);
}

/* ── Booking summary ────────────────────────────────────────────────── */
function renderBookingSummary() {
  if (!dom.bookingSummary) return;
  const { selectedDate: iso, selectedSlot, meetingDuration } = state;
  if (!iso || !selectedSlot) return;

  const date = new Date(iso + 'T00:00:00');
  const dateStr = date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  dom.bookingSummary.innerHTML = `
    <p><strong>Date:</strong> ${dateStr}</p>
    <p><strong>Time:</strong> ${formatTime(selectedSlot.start)} – ${formatTime(selectedSlot.end)}</p>
    <p><strong>Duration:</strong> ${meetingDuration} minutes</p>
  `;
}

/* ── Booking form submit ─────────────────────────────────────────────── */
function handleBookingSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));

  if (!data.name.trim()) { focusInvalid(form.elements.name, 'Name is required'); return; }
  if (!data.email.trim() || !data.email.includes('@')) { focusInvalid(form.elements.email, 'Valid email is required'); return; }

  const booking = {
    id:       crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
    name:     data.name.trim(),
    email:    data.email.trim(),
    notes:    data.notes?.trim() || '',
    date:     state.selectedDate,
    start:    state.selectedSlot.start,
    end:      state.selectedSlot.end,
    duration: state.meetingDuration,
    bookedAt: new Date().toISOString(),
  };

  state.bookings.push(booking);
  saveBookings(state.bookings);
  form.reset();
  showStep('booking-success');
}

function focusInvalid(input, msg) {
  input.focus();
  input.setCustomValidity(msg);
  input.reportValidity();
  setTimeout(() => input.setCustomValidity(''), 3000);
}

/* ── Slot generation ────────────────────────────────────────────────── */
function getSlotsForDate(date, durationMin) {
  const dur = durationMin || 30;
  const dayKey = DAY_NAMES[date.getDay()];
  const windows = (state.schedule[dayKey] || []);
  const isoDate = toISODate(date);
  const slots = [];

  const cutoff = new Date();
  cutoff.setMinutes(cutoff.getMinutes() + MIN_NOTICE_HOURS * 60);

  for (const win of windows) {
    let cur = parseMinutes(win.start);
    const end = parseMinutes(win.end);

    while (cur + dur <= end) {
      const startStr = minutesToHHMM(cur);
      const endStr   = minutesToHHMM(cur + dur);

      // Check notice period
      const slotDate = new Date(`${isoDate}T${startStr}:00`);
      if (slotDate <= cutoff) { cur += dur; continue; }

      // Check not already booked
      const conflict = state.bookings.some(b =>
        b.date === isoDate &&
        parseMinutes(b.start) < cur + dur &&
        parseMinutes(b.end) > cur
      );
      if (!conflict) slots.push({ start: startStr, end: endStr });

      cur += dur;
    }
  }
  return slots;
}

/* ── Manager view ───────────────────────────────────────────────────── */
function renderManagerView() {
  if (state.authed) {
    dom.managerGate.hidden  = true;
    dom.managerShell.hidden = false;
    loadAvailabilityForm();
    updateGoogleStatus();
  } else {
    dom.managerGate.hidden  = false;
    dom.managerShell.hidden = true;
  }
}

function handleManagerLogin(e) {
  e.preventDefault();
  const form  = e.target;
  const email = form.elements.email.value.trim();
  const pass  = form.elements.password.value;
  const btn   = form.querySelector('[type="submit"]');

  if (email === DEMO_EMAIL && pass === DEMO_PASSWORD) {
    state.authed = true;
    sessionStorage.setItem('mgr_authed', '1');
    btn.textContent = 'Signed in!';
    setTimeout(() => renderManagerView(), 400);
  } else {
    shakeElement(form);
    const err = form.querySelector('.login-error') || (() => {
      const p = document.createElement('p');
      p.className = 'login-error';
      p.style.cssText = 'color:#dc2626;font-size:0.875rem;margin-top:0.5rem;';
      form.querySelector('.form-actions').after(p);
      return p;
    })();
    err.textContent = 'Invalid email or password. Try: manager@dorsbooking.com / demo1234';
  }
}

function handleManagerSignout() {
  state.authed = false;
  sessionStorage.removeItem('mgr_authed');
  renderManagerView();
}

function updateGoogleStatus() {
  if (!dom.googleStatus) return;
  dom.googleStatus.textContent = 'Not connected. Google Calendar integration requires a server-side OAuth flow.';
  dom.googleConnect.textContent = 'Connect Google Calendar';
}

/* Availability form ─────────────────────────────────────────────────── */
function loadAvailabilityForm() {
  if (!dom.availForm) return;
  const sched = state.schedule;

  // Default hours – derive from monday as baseline
  const mon = sched.monday?.[0];
  const startEl = dom.availForm.elements['availabilityStart'];
  const endEl   = dom.availForm.elements['availabilityEnd'];
  if (mon && startEl) startEl.value = mon.start;
  if (mon && endEl)   endEl.value   = mon.end;

  // Per-day
  DAY_NAMES.forEach(day => {
    const cb  = dom.availForm.elements[`day-${day}`];
    const s   = dom.availForm.elements[`${day}-start`];
    const end = dom.availForm.elements[`${day}-end`];
    const win = sched[day]?.[0];
    if (cb) cb.checked = !!win;
    if (s)  s.value    = win?.start || '09:00';
    if (end) end.value = win?.end   || '17:00';
    updateWeekdayRowDisabled(day, !!win);
  });
}

function updateWeekdayRowDisabled(day, enabled) {
  const row = $(`[data-weekday="${day}"]`);
  if (!row) return;
  const inputs = $$('input[type="time"]', row);
  inputs.forEach(i => { i.disabled = !enabled; i.style.opacity = enabled ? '' : '0.4'; });
}

function handleAvailabilitySubmit(e) {
  e.preventDefault();
  const form = e.target;
  const newSched = {};

  DAY_NAMES.forEach(day => {
    const cb  = form.elements[`day-${day}`];
    const s   = form.elements[`${day}-start`];
    const end = form.elements[`${day}-end`];
    newSched[day] = cb?.checked ? [{ start: s.value, end: end.value }] : [];
  });

  state.schedule = newSched;
  saveSchedule(newSched);

  const btn = form.querySelector('[data-save-availability]');
  const orig = btn.textContent;
  btn.textContent = 'Saved!';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2,'0')}:${String(min % 60).padStart(2,'0')}`;
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour   = h % 12 || 12;
  return `${hour}:${String(m).padStart(2,'0')} ${period}`;
}

function shakeElement(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

/* ── Event wiring ───────────────────────────────────────────────────── */
function wireEvents() {
  // Nav tabs + hero CTAs (all data-view-target buttons)
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-view-target]');
    if (btn) showView(btn.dataset.viewTarget);
  });

  // Meeting type cards
  dom.typeCards.forEach(card => {
    card.addEventListener('click', () => handleTypeSelect(card));
  });

  // Back to slots
  if (dom.backToSlots) {
    dom.backToSlots.addEventListener('click', () => showStep('slot-picker'));
  }

  // Booking form
  if (dom.bookingForm) {
    dom.bookingForm.addEventListener('submit', handleBookingSubmit);
  }

  // Manager login
  if (dom.managerLogin) {
    dom.managerLogin.addEventListener('submit', handleManagerLogin);
  }

  // Manager sign out
  if (dom.managerSignout) {
    dom.managerSignout.addEventListener('click', handleManagerSignout);
  }

  // Availability form
  if (dom.availForm) {
    dom.availForm.addEventListener('submit', handleAvailabilitySubmit);

    // Per-day checkbox toggles time inputs
    DAY_NAMES.forEach(day => {
      const cb = dom.availForm.elements[`day-${day}`];
      if (cb) cb.addEventListener('change', () => updateWeekdayRowDisabled(day, cb.checked));
    });

    // Default hours → propagate to enabled days
    const propBtn = dom.availForm.elements['availabilityStart'];
    if (propBtn) {
      ['availabilityStart', 'availabilityEnd'].forEach(name => {
        const input = dom.availForm.elements[name];
        if (!input) return;
        input.addEventListener('change', () => {
          DAY_NAMES.forEach(day => {
            const cb  = dom.availForm.elements[`day-${day}`];
            if (!cb?.checked) return;
            const target = name === 'availabilityStart' ? `${day}-start` : `${day}-end`;
            const t = dom.availForm.elements[target];
            if (t) t.value = input.value;
          });
        });
      });
    }
  }

  // Google connect (demo only)
  if (dom.googleConnect) {
    dom.googleConnect.addEventListener('click', () => {
      dom.googleStatus.textContent = 'Google Calendar OAuth requires a server-side implementation. Not available in demo mode.';
    });
  }
}

/* ── Init ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initRefs();
  wireEvents();
  showView('home');
});
