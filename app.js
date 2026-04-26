/*
 * app.js – Dorsbooking client-side logic.
 *
 * Public booking page; no login required to book.
 * Login is only for the manager settings panel (footer ⚙ link).
 *
 * All data is stored server-side via the REST API in server.js.
 * Google Calendar: generates a pre-filled URL after booking — no OAuth needed.
 */

/* ── Constants ──────────────────────────────────────────────────────── */
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  meetingType:   null,   // { duration: number, name: string }
  selectedDate:  null,   // 'YYYY-MM-DD'
  selectedSlot:  null,   // { start: 'HH:MM', end: 'HH:MM' }
  mgrToken:      sessionStorage.getItem('mgr_token') || null,
  authed:        !!sessionStorage.getItem('mgr_token'),
  tz:            getUserTimezone(),
};

/* ── API helper ─────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.mgrToken) headers['Authorization'] = `Bearer ${state.mgrToken}`;
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { status: res.status });
  }
  return res.json();
}

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
async function renderDateRail() {
  dom.dateRail.innerHTML = '';
  dom.slotGrid.innerHTML = '';
  if (dom.slotHint)  dom.slotHint.hidden  = false;
  if (dom.slotEmpty) dom.slotEmpty.hidden = true;
  if (dom.slotDateLabel) dom.slotDateLabel.hidden = true;

  const loadingLi = document.createElement('li');
  loadingLi.style.cssText = 'color:var(--c-muted);font-size:0.875rem;padding:0.5rem 1rem;';
  loadingLi.textContent = 'Loading availability…';
  dom.dateRail.appendChild(loadingLi);

  try {
    const { dates } = await api('/api/availability');
    dom.dateRail.innerHTML = '';

    if (!dates.length) {
      const li = document.createElement('li');
      li.style.cssText = 'color:var(--c-muted);font-size:0.875rem;padding:0.5rem 1rem;';
      li.textContent = 'No available dates in the next 30 days.';
      dom.dateRail.appendChild(li);
      return;
    }

    dates.forEach(iso => {
      const d   = new Date(iso + 'T00:00:00');
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
    });
  } catch {
    dom.dateRail.innerHTML = '';
    const li = document.createElement('li');
    li.style.cssText = 'color:var(--c-muted);font-size:0.875rem;padding:0.5rem 1rem;';
    li.textContent = 'Could not load availability. Please try again.';
    dom.dateRail.appendChild(li);
  }
}

/* ── Step 2b: slot grid ─────────────────────────────────────────────── */
async function handleDateSelect(iso, btn) {
  state.selectedDate = iso;
  state.selectedSlot = null;

  $$('[data-date-btn]').forEach(b => b.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');

  await renderSlotGrid(iso);
}

async function renderSlotGrid(iso) {
  dom.slotGrid.innerHTML = '';
  if (dom.slotHint)      dom.slotHint.hidden      = true;
  if (dom.slotEmpty)     dom.slotEmpty.hidden      = true;
  if (dom.slotDateLabel) dom.slotDateLabel.hidden  = true;

  const loadingLi = document.createElement('li');
  loadingLi.style.cssText = 'color:var(--c-muted);font-size:0.875rem;padding:0.5rem;';
  loadingLi.textContent = 'Loading…';
  dom.slotGrid.appendChild(loadingLi);

  try {
    const dur = state.meetingType?.duration ?? 30;
    const { slots } = await api(`/api/availability?date=${iso}&duration=${dur}`);
    dom.slotGrid.innerHTML = '';

    if (!slots.length) {
      if (dom.slotEmpty) dom.slotEmpty.hidden = false;
      return;
    }

    const date = new Date(iso + 'T00:00:00');
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
  } catch {
    dom.slotGrid.innerHTML = '';
    if (dom.slotEmpty) {
      dom.slotEmpty.hidden = false;
      dom.slotEmpty.textContent = 'Could not load slots. Please try again.';
    }
  }
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

async function handleBookingSubmit(e) {
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

  const submitBtn = form.querySelector('[type="submit"]');
  const origText  = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Booking…';

  // Clear any previous error
  const prevErr = form.querySelector('.booking-error');
  if (prevErr) prevErr.remove();

  try {
    const result = await api('/api/book', {
      method: 'POST',
      body: JSON.stringify({
        name:     data.name.trim(),
        email:    data.email.trim(),
        notes:    data.notes?.trim() || '',
        date:     state.selectedDate,
        start:    state.selectedSlot.start,
        end:      state.selectedSlot.end,
        duration: state.meetingType.duration,
      }),
    });

    const booking = {
      id:       result.id,
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

    form.reset();
    showSuccessScreen(booking);
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = origText;

    const errEl = document.createElement('p');
    errEl.className = 'booking-error';
    errEl.style.cssText = 'color:var(--c-error,#c00);margin-top:0.5rem;font-size:0.875rem;';
    errEl.textContent = err.status === 409
      ? 'That slot was just taken. Please go back and choose another time.'
      : 'Something went wrong. Please try again.';
    submitBtn.insertAdjacentElement('afterend', errEl);
  }
}

/* ── Step 4: success ────────────────────────────────────────────────── */
function showSuccessScreen(booking) {
  const date = new Date(booking.date + 'T00:00:00');
  const dateStr = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  if (dom.successSummary) {
    dom.successSummary.innerHTML = `
      <div class="summary-row"><span class="summary-label">Meeting</span><span>${booking.typeName} · ${booking.duration} min</span></div>
      <div class="summary-row"><span class="summary-label">Date</span><span>${dateStr}</span></div>
      <div class="summary-row"><span class="summary-label">Time</span><span>${formatTime(booking.start)} – ${formatTime(booking.end)}</span></div>
    `;
  }

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

async function handleManagerLogin(e) {
  e.preventDefault();
  const form = e.target;
  const email = form.elements.email.value.trim();
  const pass  = form.elements.password.value;

  const submitBtn = form.querySelector('[type="submit"]');
  submitBtn.disabled = true;

  try {
    const { token } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: pass }),
    });

    state.mgrToken = token;
    state.authed   = true;
    sessionStorage.setItem('mgr_token', token);
    renderManagerView();
  } catch {
    submitBtn.disabled = false;
    shakeElement(form);
    let errEl = form.querySelector('.login-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.className = 'login-error';
      form.querySelector('[type="submit"]').insertAdjacentElement('afterend', errEl);
    }
    errEl.textContent = 'Incorrect email or password.';
  }
}

async function handleManagerSignout() {
  if (state.mgrToken) {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  }
  state.mgrToken = null;
  state.authed   = false;
  sessionStorage.removeItem('mgr_token');
  renderManagerView();
}

function renderGoogleStatus() {
  if (dom.googleStatus) {
    dom.googleStatus.textContent = 'Not connected. Google Calendar OAuth requires a server-side flow.';
  }
}

/* ── Availability form ──────────────────────────────────────────────── */
const DEFAULT_SCHEDULE = {
  monday:    [{ start: '09:00', end: '17:00' }],
  tuesday:   [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '12:00' }],
  thursday:  [{ start: '09:00', end: '17:00' }],
  friday:    [{ start: '09:00', end: '15:00' }],
  saturday:  [],
  sunday:    [],
};

async function loadAvailabilityForm() {
  if (!dom.availForm) return;

  let schedule           = DEFAULT_SCHEDULE;
  let slotDuration       = 30;
  let bufferMinutes      = 0;
  let minimumNoticeHours = 24;
  let bookingWindowDays  = 30;

  try {
    const config         = await api('/api/settings');
    schedule             = config.weeklySchedule      || DEFAULT_SCHEDULE;
    slotDuration         = config.slotDurationMinutes || 30;
    bufferMinutes        = config.bufferMinutes        ?? 0;
    minimumNoticeHours   = config.minimumNoticeHours   ?? 24;
    bookingWindowDays    = config.bookingWindowDays    ?? 30;
  } catch {
    // falls back to defaults — form still renders
  }

  const mon     = schedule.monday?.[0];
  const startEl = dom.availForm.elements['availabilityStart'];
  const endEl   = dom.availForm.elements['availabilityEnd'];
  if (mon && startEl) startEl.value = mon.start;
  if (mon && endEl)   endEl.value   = mon.end;

  DAY_NAMES.forEach(day => {
    const cb  = dom.availForm.elements[`day-${day}`];
    const se  = dom.availForm.elements[`${day}-start`];
    const en  = dom.availForm.elements[`${day}-end`];
    const win = schedule[day]?.[0];
    if (cb) cb.checked = !!win;
    if (se) se.value   = win?.start || '09:00';
    if (en) en.value   = win?.end   || '17:00';
    setWeekdayRowEnabled(day, !!win);
  });

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

async function handleAvailabilitySubmit(e) {
  e.preventDefault();
  const form     = e.target;
  const newSched = {};

  DAY_NAMES.forEach(day => {
    const cb = form.elements[`day-${day}`];
    const se = form.elements[`${day}-start`];
    const en = form.elements[`${day}-end`];
    newSched[day] = cb?.checked ? [{ start: se.value, end: en.value }] : [];
  });

  const btn  = form.querySelector('[data-save-availability]');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  // Clear previous error
  form.querySelector('.avail-error')?.remove();

  try {
    await api('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({
        weeklySchedule:      newSched,
        slotDurationMinutes: parseInt(form.elements['slotDuration']?.value,       10) || 30,
        bufferMinutes:       parseInt(form.elements['bufferMinutes']?.value,      10) || 0,
        minimumNoticeHours:  parseInt(form.elements['minimumNoticeHours']?.value, 10) || 24,
        bookingWindowDays:   parseInt(form.elements['bookingWindowDays']?.value,  10) || 30,
      }),
    });
    btn.textContent = '✓ Saved!';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  } catch {
    btn.disabled = false;
    btn.textContent = orig;
    const errEl = document.createElement('p');
    errEl.className = 'avail-error';
    errEl.style.cssText = 'color:var(--c-error,#c00);font-size:0.875rem;margin-top:0.5rem;';
    errEl.textContent = 'Failed to save. Please try again.';
    btn.insertAdjacentElement('afterend', errEl);
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────── */
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
  dom.typeCards.forEach(card => {
    card.addEventListener('click', () => handleTypeSelect(card));
  });

  const backToType  = $('[data-back-to-type]');
  const backToSlots = $('[data-back-to-slots]');
  if (backToType)  backToType.addEventListener('click',  () => showStep('type-picker'));
  if (backToSlots) backToSlots.addEventListener('click', () => showStep('slot-picker'));

  if (dom.bookingForm) {
    dom.bookingForm.addEventListener('submit', handleBookingSubmit);
  }

  const bookAnother = $('[data-book-another]');
  if (bookAnother) {
    bookAnother.addEventListener('click', () => resetBookingFlow());
  }

  const manageBtn = $('[data-view-manager]');
  if (manageBtn) manageBtn.addEventListener('click', showManagerView);

  document.addEventListener('click', e => {
    if (e.target.closest('[data-manager-close]')) showBookingView();
  });

  if (dom.managerLogin) {
    dom.managerLogin.addEventListener('submit', handleManagerLogin);
  }

  const signoutBtn = $('[data-manager-signout]');
  if (signoutBtn) signoutBtn.addEventListener('click', handleManagerSignout);

  const gcalBtn = $('[data-google-connect]');
  if (gcalBtn) {
    gcalBtn.addEventListener('click', () => {
      if (dom.googleStatus) {
        dom.googleStatus.textContent = 'Google Calendar OAuth is only available with a server-side implementation.';
      }
    });
  }

  if (dom.availForm) {
    dom.availForm.addEventListener('submit', handleAvailabilitySubmit);

    DAY_NAMES.forEach(day => {
      const cb = dom.availForm.elements[`day-${day}`];
      if (cb) cb.addEventListener('change', () => setWeekdayRowEnabled(day, cb.checked));
    });

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
document.addEventListener('DOMContentLoaded', async () => {
  initRefs();
  wireEvents();

  // Verify any stored session token is still valid; clear if expired
  if (state.mgrToken) {
    try {
      await api('/api/auth/me');
    } catch {
      state.mgrToken = null;
      state.authed   = false;
      sessionStorage.removeItem('mgr_token');
    }
  }

  dom.panelBooking.hidden = false;
  dom.panelManager.hidden = true;
  showStep('type-picker');
});
