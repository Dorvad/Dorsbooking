/*
 * app.js – Dorsbooking client-side logic.
 *
 * The app is a public booking page. No login is required to book.
 * Login is only for the manager settings panel (footer ⚙ link).
 *
 * Demo manager credentials: manager@dorsbooking.com / demo1234
 *
 * Persistence: localStorage (bookings + schedule).
 * Google Calendar: generates a pre-filled URL after booking — no OAuth needed.
 */

/* ── Constants ──────────────────────────────────────────────────────── */
const DEMO_EMAIL    = 'manager@dorsbooking.com';
const DEMO_PASSWORD = 'demo1234';
const DAY_NAMES     = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  meetingType:   null,   // { duration: number, name: string }
  selectedDate:  null,   // 'YYYY-MM-DD'
  selectedSlot:  null,   // { start: 'HH:MM', end: 'HH:MM' }
  schedule:      loadSchedule(),
  bookings:      loadBookings(),
  settings:      loadSettings(),
  authed:        !!sessionStorage.getItem('mgr_authed'),
  tz:            getUserTimezone(),
};

/* ── Persistence ────────────────────────────────────────────────────── */
const DEFAULT_SCHEDULE = {
  monday:    [{ start: '09:00', end: '17:00' }],
  tuesday:   [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '12:00' }],
  thursday:  [{ start: '09:00', end: '17:00' }],
  friday:    [{ start: '09:00', end: '15:00' }],
  saturday:  [],
  sunday:    [],
};

const DEFAULT_SETTINGS = {
  slotDuration:       30,
  bufferMinutes:      0,
  minimumNoticeHours: 24,
  bookingWindowDays:  30,
};

function loadSchedule() {
  try { return JSON.parse(localStorage.getItem('dors_schedule')) || structuredClone(DEFAULT_SCHEDULE); }
  catch { return structuredClone(DEFAULT_SCHEDULE); }
}

function loadBookings() {
  try { return JSON.parse(localStorage.getItem('dors_bookings')) || []; }
  catch { return []; }
}

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('dors_settings')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSchedule(s)  { localStorage.setItem('dors_schedule', JSON.stringify(s)); }
function saveBookings(b)  { localStorage.setItem('dors_bookings', JSON.stringify(b)); }
function saveSettings(s)  { localStorage.setItem('dors_settings', JSON.stringify(s)); }

function getUserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'Local time'; }
}

/* ── DOM refs ───────────────────────────────────────────────────────── */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

let dom = {};

function initRefs() {
  dom.panelBooking    = $('#panel-booking');
  dom.panelManager    = $('#panel-manager');

  // Booking steps
  dom.typePicker      = $('#meeting-type-picker');
  dom.slotPicker      = $('#slot-picker');
  dom.bookingDetails  = $('#booking-details');
  dom.bookingSuccess  = $('#booking-success');
  dom.typeCards       = $$('[data-meeting-type]');
  dom.dateRail        = $('[data-date-rail]');
  dom.slotGrid        = $('[data-slot-grid]');
  dom.slotEmpty       = $('[data-slot-empty]');
  dom.slotHint        = $('[data-slot-hint]');
  dom.slotDateLabel   = $('[data-slot-date-label]');
  dom.tzLabel         = $('[data-timezone-label]');
  dom.selectedDur     = $('[data-selected-duration]');
  dom.bookingSummary  = $('[data-booking-summary]');
  dom.bookingForm     = $('[data-booking-form]');
  dom.successSummary  = $('[data-success-summary]');
  dom.gcalLink        = $('[data-gcal-link]');

  // Step progress
  dom.stepProgress    = $('.step-progress');
  dom.stepDots        = $$('[data-step]');
  dom.stepLines       = $$('[data-step-line]');

  // Manager
  dom.managerGate     = $('[data-manager-gate]');
  dom.managerShell    = $('[data-manager-shell]');
  dom.managerLogin    = $('[data-manager-login]');
  dom.googleStatus    = $('[data-google-status]');
  dom.availForm       = $('#availability-form');
}

/* ── View: booking ↔ manager ────────────────────────────────────────── */
function showBookingView() {
  animateOut(dom.panelManager, () => {
    dom.panelManager.hidden = true;
    dom.panelBooking.hidden = false;
    dom.panelBooking.classList.add('anim-enter');
    dom.panelBooking.addEventListener('animationend', () => dom.panelBooking.classList.remove('anim-enter'), { once: true });
  });
}

function showManagerView() {
  animateOut(dom.panelBooking, () => {
    dom.panelBooking.hidden = true;
    dom.panelManager.hidden = false;
    dom.panelManager.classList.add('anim-enter');
    dom.panelManager.addEventListener('animationend', () => dom.panelManager.classList.remove('anim-enter'), { once: true });
    renderManagerView();
  });
}

function animateOut(el, cb) {
  if (!el || el.hidden) { cb(); return; }
  el.classList.add('anim-out');
  const done = () => { el.classList.remove('anim-out'); cb(); };
  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, 250); // fallback
}

/* ── Booking flow ───────────────────────────────────────────────────── */
const MEETING_TYPES = {
  '15': { name: 'Quick Intro',     duration: 15 },
  '30': { name: 'Discovery Call',  duration: 30 },
  '60': { name: 'Deep Dive',       duration: 60 },
};

function resetBookingFlow() {
  state.meetingType  = null;
  state.selectedDate = null;
  state.selectedSlot = null;
  dom.typeCards.forEach(c => c.setAttribute('aria-pressed', 'false'));
  showStep('type-picker');
}

function showStep(step) {
  const map = {
    'type-picker':     [dom.typePicker,     1],
    'slot-picker':     [dom.slotPicker,     2],
    'booking-details': [dom.bookingDetails, 3],
    'booking-success': [dom.bookingSuccess, 4],
  };

  Object.entries(map).forEach(([key, [el]]) => {
    if (!el) return;
    const isTarget = key === step;
    if (isTarget) {
      el.hidden = false;
      el.classList.add('anim-enter');
      el.addEventListener('animationend', () => el.classList.remove('anim-enter'), { once: true });
    } else {
      el.hidden = true;
      el.classList.remove('anim-enter');
    }
  });

  const stepNum = map[step]?.[1] ?? 1;
  updateStepProgress(stepNum);

  // Scroll panel to top on step change
  dom.panelBooking?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateStepProgress(currentStep) {
  if (!dom.stepProgress) return;
  dom.stepProgress.hidden = currentStep === 4;

  dom.stepDots.forEach(dot => {
    const n = parseInt(dot.dataset.step, 10);
    dot.classList.toggle('is-active', n === currentStep);
    dot.classList.toggle('is-done',   n < currentStep);
    dot.textContent = n < currentStep ? '✓' : String(n);
  });

  dom.stepLines.forEach(line => {
    const n = parseInt(line.dataset.stepLine, 10);
    line.classList.toggle('is-done', n < currentStep);
  });
}

/* ── Step 1: meeting type ───────────────────────────────────────────── */
function handleTypeSelect(btn) {
  const key = btn.dataset.meetingType;
  state.meetingType = MEETING_TYPES[key];

  dom.typeCards.forEach(c => c.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');

  if (dom.selectedDur) dom.selectedDur.textContent = `${state.meetingType.duration} min`;
  if (dom.tzLabel)     dom.tzLabel.textContent = state.tz;

  renderDateRail();
  showStep('slot-picker');
}

/* ── Step 2a: date rail ─────────────────────────────────────────────── */
function renderDateRail() {
  dom.dateRail.innerHTML = '';
  dom.slotGrid.innerHTML = '';
  if (dom.slotHint)  dom.slotHint.hidden  = false;
  if (dom.slotEmpty) dom.slotEmpty.hidden = true;
  if (dom.slotDateLabel) dom.slotDateLabel.hidden = true;

  const today   = new Date();
  today.setHours(0, 0, 0, 0);
  const window  = state.settings.bookingWindowDays;
  let rendered  = 0;

  for (let i = 0; rendered < window && i < window + 14; i++) {
    const d      = new Date(today);
    d.setDate(today.getDate() + i);
    const dayKey = DAY_NAMES[d.getDay()];
    if (!(state.schedule[dayKey] || []).length) continue;
    if (!getSlotsForDate(d).length) continue;

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
    li.style.cssText = 'color:var(--c-muted);font-size:0.875rem;padding:0.5rem 1rem;';
    li.textContent = 'No available dates in the next 30 days.';
    dom.dateRail.appendChild(li);
  }
}

/* ── Step 2b: slot grid ─────────────────────────────────────────────── */
function handleDateSelect(iso, btn) {
  state.selectedDate = iso;
  state.selectedSlot = null;

  $$('[data-date-btn]').forEach(b => b.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');

  renderSlotGrid(iso);
}

function renderSlotGrid(iso) {
  dom.slotGrid.innerHTML = '';
  if (dom.slotHint) dom.slotHint.hidden = true;

  const date  = new Date(iso + 'T00:00:00');
  const slots = getSlotsForDate(date);

  if (!slots.length) {
    if (dom.slotEmpty) dom.slotEmpty.hidden = false;
    if (dom.slotDateLabel) dom.slotDateLabel.hidden = true;
    return;
  }

  if (dom.slotEmpty) dom.slotEmpty.hidden = true;

  if (dom.slotDateLabel) {
    dom.slotDateLabel.hidden = false;
    dom.slotDateLabel.textContent = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

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
  setTimeout(() => showStep('booking-details'), 180);
}

/* ── Step 3: booking form ───────────────────────────────────────────── */
function renderBookingSummary() {
  if (!dom.bookingSummary) return;
  const { meetingType, selectedDate, selectedSlot } = state;
  if (!meetingType || !selectedDate || !selectedSlot) return;

  const date = new Date(selectedDate + 'T00:00:00');
  const dateStr = date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  dom.bookingSummary.innerHTML = `
    <strong>${meetingType.name} · ${meetingType.duration} min</strong>
    <div style="margin-top:0.3125rem;color:var(--c-primary);font-size:0.9rem">
      ${dateStr}<br>
      ${formatTime(selectedSlot.start)} – ${formatTime(selectedSlot.end)}
    </div>
  `;
}

function handleBookingSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));

  if (!data.name.trim()) {
    focusInvalid(form.elements.name, 'Please enter your name');
    return;
  }
  if (!data.email.trim() || !data.email.includes('@')) {
    focusInvalid(form.elements.email, 'Please enter a valid email');
    return;
  }

  const booking = {
    id:       crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
    name:     data.name.trim(),
    email:    data.email.trim(),
    notes:    data.notes?.trim() || '',
    typeName: state.meetingType.name,
    date:     state.selectedDate,
    start:    state.selectedSlot.start,
    end:      state.selectedSlot.end,
    duration: state.meetingType.duration,
    bookedAt: new Date().toISOString(),
  };

  state.bookings.push(booking);
  saveBookings(state.bookings);
  form.reset();
  showSuccessScreen(booking);
}

/* ── Step 4: success ────────────────────────────────────────────────── */
function showSuccessScreen(booking) {
  // Populate success summary
  const date = new Date(booking.date + 'T00:00:00');
  const dateStr = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  if (dom.successSummary) {
    dom.successSummary.innerHTML = `
      <div class="summary-row"><span class="summary-label">Meeting</span><span>${booking.typeName} · ${booking.duration} min</span></div>
      <div class="summary-row"><span class="summary-label">Date</span><span>${dateStr}</span></div>
      <div class="summary-row"><span class="summary-label">Time</span><span>${formatTime(booking.start)} – ${formatTime(booking.end)}</span></div>
    `;
  }

  // Build Google Calendar URL
  if (dom.gcalLink) {
    dom.gcalLink.href = buildGCalUrl(booking);
  }

  showStep('booking-success');
}

function buildGCalUrl(booking) {
  const d     = booking.date.replace(/-/g, '');
  const start = booking.start.replace(':', '') + '00';
  const end   = booking.end.replace(':', '')   + '00';
  const title = encodeURIComponent(`Meeting with Dors`);
  const desc  = encodeURIComponent(`${booking.typeName} — booked via Dorsbooking`);
  const tz    = encodeURIComponent(state.tz);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${d}T${start}/${d}T${end}&details=${desc}&ctz=${tz}`;
}

/* ── Manager view ───────────────────────────────────────────────────── */
function renderManagerView() {
  if (state.authed) {
    dom.managerGate.hidden  = true;
    dom.managerShell.hidden = false;
    loadAvailabilityForm();
    renderGoogleStatus();
  } else {
    dom.managerGate.hidden  = false;
    dom.managerShell.hidden = true;
  }
}

function handleManagerLogin(e) {
  e.preventDefault();
  const form = e.target;
  const email = form.elements.email.value.trim();
  const pass  = form.elements.password.value;

  if (email === DEMO_EMAIL && pass === DEMO_PASSWORD) {
    state.authed = true;
    sessionStorage.setItem('mgr_authed', '1');
    renderManagerView();
  } else {
    shakeElement(form);
    let errEl = form.querySelector('.login-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.className = 'login-error';
      form.querySelector('[type="submit"]').insertAdjacentElement('afterend', errEl);
    }
    errEl.textContent = 'Incorrect email or password. Hint: manager@dorsbooking.com / demo1234';
  }
}

function handleManagerSignout() {
  state.authed = false;
  sessionStorage.removeItem('mgr_authed');
  renderManagerView();
}

function renderGoogleStatus() {
  if (dom.googleStatus) {
    dom.googleStatus.textContent = 'Not connected. Google Calendar OAuth requires a server-side flow.';
  }
}

/* ── Availability form ──────────────────────────────────────────────── */
function loadAvailabilityForm() {
  if (!dom.availForm) return;
  const s = state.schedule;

  // Default hours from monday
  const mon = s.monday?.[0];
  const startEl = dom.availForm.elements['availabilityStart'];
  const endEl   = dom.availForm.elements['availabilityEnd'];
  if (mon && startEl) startEl.value = mon.start;
  if (mon && endEl)   endEl.value   = mon.end;

  // Per-day
  DAY_NAMES.forEach(day => {
    const cb  = dom.availForm.elements[`day-${day}`];
    const se  = dom.availForm.elements[`${day}-start`];
    const en  = dom.availForm.elements[`${day}-end`];
    const win = s[day]?.[0];
    if (cb) cb.checked = !!win;
    if (se) se.value   = win?.start || '09:00';
    if (en) en.value   = win?.end   || '17:00';
    setWeekdayRowEnabled(day, !!win);
  });

  // Booking rules
  const { slotDuration, bufferMinutes, minimumNoticeHours, bookingWindowDays } = state.settings;
  const sl = dom.availForm.elements['slotDuration'];
  const bu = dom.availForm.elements['bufferMinutes'];
  const mn = dom.availForm.elements['minimumNoticeHours'];
  const bw = dom.availForm.elements['bookingWindowDays'];
  if (sl) sl.value = slotDuration;
  if (bu) bu.value = bufferMinutes;
  if (mn) mn.value = minimumNoticeHours;
  if (bw) bw.value = bookingWindowDays;
}

function setWeekdayRowEnabled(day, enabled) {
  const row = $(`[data-weekday="${day}"]`);
  if (!row) return;
  $$('input[type="time"]', row).forEach(i => {
    i.disabled = !enabled;
    i.style.opacity = enabled ? '' : '0.35';
  });
}

function handleAvailabilitySubmit(e) {
  e.preventDefault();
  const form = e.target;
  const newSched = {};

  DAY_NAMES.forEach(day => {
    const cb = form.elements[`day-${day}`];
    const se = form.elements[`${day}-start`];
    const en = form.elements[`${day}-end`];
    newSched[day] = cb?.checked ? [{ start: se.value, end: en.value }] : [];
  });

  state.schedule = newSched;
  saveSchedule(newSched);

  const newSettings = {
    slotDuration:       parseInt(form.elements['slotDuration']?.value,       10) || 30,
    bufferMinutes:      parseInt(form.elements['bufferMinutes']?.value,      10) || 0,
    minimumNoticeHours: parseInt(form.elements['minimumNoticeHours']?.value, 10) || 24,
    bookingWindowDays:  parseInt(form.elements['bookingWindowDays']?.value,  10) || 30,
  };
  state.settings = newSettings;
  saveSettings(newSettings);

  const btn = form.querySelector('[data-save-availability]');
  const orig = btn.textContent;
  btn.textContent = '✓ Saved!';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
}

/* ── Slot generation ────────────────────────────────────────────────── */
function getSlotsForDate(date) {
  const dur      = state.meetingType?.duration ?? state.settings.slotDuration;
  const buffer   = state.settings.bufferMinutes;
  const dayKey   = DAY_NAMES[date.getDay()];
  const windows  = state.schedule[dayKey] || [];
  const isoDate  = toISODate(date);
  const slots    = [];

  const cutoff = new Date();
  cutoff.setMinutes(cutoff.getMinutes() + state.settings.minimumNoticeHours * 60);

  for (const win of windows) {
    let cur    = parseMinutes(win.start);
    const end  = parseMinutes(win.end);

    while (cur + dur <= end) {
      const startStr  = minutesToHHMM(cur);
      const endStr    = minutesToHHMM(cur + dur);
      const slotTime  = new Date(`${isoDate}T${startStr}:00`);

      if (slotTime > cutoff) {
        const conflict = state.bookings.some(b =>
          b.date === isoDate &&
          parseMinutes(b.start) < cur + dur &&
          parseMinutes(b.end)   > cur
        );
        if (!conflict) slots.push({ start: startStr, end: endStr });
      }
      cur += dur + buffer;
    }
  }
  return slots;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToHHMM(min) {
  return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`;
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour   = h % 12 || 12;
  return `${hour}:${String(m).padStart(2,'0')} ${period}`;
}

function focusInvalid(input, msg) {
  input.focus();
  input.setCustomValidity(msg);
  input.reportValidity();
  input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
}

function shakeElement(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

/* ── Event wiring ───────────────────────────────────────────────────── */
function wireEvents() {
  // Meeting type cards
  dom.typeCards.forEach(card => {
    card.addEventListener('click', () => handleTypeSelect(card));
  });

  // Back buttons
  const backToType  = $('[data-back-to-type]');
  const backToSlots = $('[data-back-to-slots]');
  if (backToType)  backToType.addEventListener('click',  () => showStep('type-picker'));
  if (backToSlots) backToSlots.addEventListener('click', () => showStep('slot-picker'));

  // Booking form
  if (dom.bookingForm) {
    dom.bookingForm.addEventListener('submit', handleBookingSubmit);
  }

  // Book another
  const bookAnother = $('[data-book-another]');
  if (bookAnother) {
    bookAnother.addEventListener('click', () => {
      resetBookingFlow();
    });
  }

  // Footer → manager
  const manageBtn = $('[data-view-manager]');
  if (manageBtn) manageBtn.addEventListener('click', showManagerView);

  // Manager panel: back + close
  document.addEventListener('click', e => {
    if (e.target.closest('[data-manager-close]')) showBookingView();
  });

  // Manager login
  if (dom.managerLogin) {
    dom.managerLogin.addEventListener('submit', handleManagerLogin);
  }

  // Manager sign out
  const signoutBtn = $('[data-manager-signout]');
  if (signoutBtn) signoutBtn.addEventListener('click', handleManagerSignout);

  // Google connect (demo)
  const gcalBtn = $('[data-google-connect]');
  if (gcalBtn) {
    gcalBtn.addEventListener('click', () => {
      if (dom.googleStatus) {
        dom.googleStatus.textContent = 'Google Calendar OAuth is only available with a server-side implementation.';
      }
    });
  }

  // Availability form
  if (dom.availForm) {
    dom.availForm.addEventListener('submit', handleAvailabilitySubmit);

    DAY_NAMES.forEach(day => {
      const cb = dom.availForm.elements[`day-${day}`];
      if (cb) cb.addEventListener('change', () => setWeekdayRowEnabled(day, cb.checked));
    });

    // Propagate default hours to all enabled days
    ['availabilityStart', 'availabilityEnd'].forEach(name => {
      const input = dom.availForm.elements[name];
      if (!input) return;
      input.addEventListener('change', () => {
        DAY_NAMES.forEach(day => {
          const cb = dom.availForm.elements[`day-${day}`];
          if (!cb?.checked) return;
          const target = name === 'availabilityStart' ? `${day}-start` : `${day}-end`;
          const t = dom.availForm.elements[target];
          if (t) t.value = input.value;
        });
      });
    });
  }
}

/* ── Init ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initRefs();
  wireEvents();

  // Start directly on the booking flow
  dom.panelBooking.hidden = false;
  dom.panelManager.hidden = true;
  showStep('type-picker');
});
