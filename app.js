const state = {
  currentView: "booking",
  managerAuthenticated: false,
  managerEmail: "",
  selectedMeetingType: "intro",
  selectedDate: null,
  selectedSlot: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  availability: null,
  bookingDetails: {
    name: "",
    email: "",
    notes: ""
  }
};

const dom = {};

document.addEventListener("DOMContentLoaded", async () => {
  cacheDom();
  bindEvents();
  await loadAvailability();
  renderAll();
});

function cacheDom() {
  dom.viewTabs = document.querySelectorAll("[data-view-target]");
  dom.viewPanels = document.querySelectorAll("[data-view-panel]");

  dom.meetingTypeButtons = document.querySelectorAll("[data-meeting-type]");
  dom.timezoneLabel = document.querySelector("[data-timezone-label]");
  dom.selectedDuration = document.querySelector("[data-selected-duration]");
  dom.dateRail = document.querySelector("[data-date-rail]");
  dom.slotGrid = document.querySelector("[data-slot-grid]");
  dom.slotEmpty = document.querySelector("[data-slot-empty]");
  dom.bookingSummary = document.querySelector("[data-booking-summary]");
  dom.bookingForm = document.querySelector("[data-booking-form]");
  dom.bookingSuccess = document.querySelector("[data-booking-success]");

  dom.nameInput = document.querySelector("#booking-name");
  dom.emailInput = document.querySelector("#booking-email");
  dom.notesInput = document.querySelector("#booking-notes");

  dom.managerLoginForm = document.querySelector("[data-manager-login]");
  dom.managerShell = document.querySelector("[data-manager-shell]");
  dom.managerGate = document.querySelector("[data-manager-gate]");
  dom.managerEmail = document.querySelector("#manager-email");
  dom.managerPassword = document.querySelector("#manager-password");
  dom.managerSignOut = document.querySelector("[data-manager-signout]");

  dom.managerGoogleStatus = document.querySelector("[data-google-status]");
  dom.googleConnectButtons = document.querySelectorAll("[data-google-connect]");
  dom.saveAvailabilityButton = document.querySelector("[data-save-availability]");

  dom.availabilityStart = document.querySelector("#availability-start");
  dom.availabilityEnd = document.querySelector("#availability-end");
  dom.slotDuration = document.querySelector("#slot-duration");
  dom.bufferMinutes = document.querySelector("#buffer-minutes");
  dom.maxMeetingsPerDay = document.querySelector("#max-meetings-per-day");
  dom.minimumNoticeHours = document.querySelector("#minimum-notice-hours");
  dom.bookingWindowDays = document.querySelector("#booking-window-days");
  dom.weekdayCheckboxes = document.querySelectorAll("[data-weekday]");
}

function bindEvents() {
  dom.viewTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.currentView = button.dataset.viewTarget;
      renderViews();
    });
  });

  dom.meetingTypeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedMeetingType = button.dataset.meetingType;
      state.selectedDate = null;
      state.selectedSlot = null;
      renderBooking();
    });
  });

  if (dom.bookingForm) {
    dom.bookingForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleBookingSubmit();
    });
  }

  if (dom.managerLoginForm) {
    dom.managerLoginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleManagerLogin();
    });
  }

  if (dom.managerSignOut) {
    dom.managerSignOut.addEventListener("click", () => {
      state.managerAuthenticated = false;
      state.managerEmail = "";
      renderManager();
    });
  }

  dom.googleConnectButtons.forEach((button) => {
    button.addEventListener("click", () => {
      simulateGoogleConnect(button.dataset.googleConnect);
    });
  });

  if (dom.saveAvailabilityButton) {
    dom.saveAvailabilityButton.addEventListener("click", () => {
      saveAvailabilityFromManagerForm();
    });
  }
}

async function loadAvailability() {
  try {
    const response = await fetch("./config/availability.json");
    if (!response.ok) throw new Error("Could not load availability.json");
    state.availability = await response.json();
  } catch (error) {
    console.error(error);
    state.availability = getFallbackAvailability();
  }
}

function getFallbackAvailability() {
  return {
    app: {
      name: "Meet with Dor",
      managerDemoEmail: "admin@example.com",
      managerDemoPassword: "demo1234"
    },
    calendar: {
      provider: "google",
      connected: false,
      connectionLabel: "Not connected yet",
      calendarId: "primary",
      syncMode: "two_way"
    },
    booking: {
      timezone: "Asia/Jerusalem",
      bookingWindowDays: 21,
      minimumNoticeHours: 12,
      maxMeetingsPerDay: 4,
      bufferMinutes: 15,
      defaultDurationMinutes: 30,
      workingHours: { start: "10:00", end: "18:00" },
      workingDays: [0, 1, 2, 3, 4]
    },
    meetingTypes: [
      {
        id: "intro",
        label: "Intro call",
        durationMinutes: 30,
        description: "A short intro call to get aligned."
      },
      {
        id: "consult",
        label: "Consultation",
        durationMinutes: 60,
        description: "A longer strategic conversation."
      }
    ]
  };
}

function renderAll() {
  renderViews();
  renderBooking();
  renderManager();
}

function renderViews() {
  dom.viewTabs.forEach((button) => {
    const isActive = button.dataset.viewTarget === state.currentView;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  dom.viewPanels.forEach((panel) => {
    const isActive = panel.dataset.viewPanel === state.currentView;
    panel.hidden = !isActive;
  });
}

function renderBooking() {
  if (!state.availability) return;

  renderMeetingTypes();
  renderTimezone();
  renderDateRail();
  renderSlots();
  renderBookingSummary();
}

function renderMeetingTypes() {
  dom.meetingTypeButtons.forEach((button) => {
    const isActive = button.dataset.meetingType === state.selectedMeetingType;
    button.classList.toggle("is-active", isActive);
  });

  const activeType = getActiveMeetingType();
  if (dom.selectedDuration && activeType) {
    dom.selectedDuration.textContent = `${activeType.durationMinutes} min meeting`;
  }
}

function renderTimezone() {
  const label = state.timezone.replaceAll("_", " ");
  if (dom.timezoneLabel) dom.timezoneLabel.textContent = label;
}

function renderDateRail() {
  if (!dom.dateRail) return;

  const days = buildAvailableDates();

  if (!state.selectedDate && days.length > 0) {
    state.selectedDate = days[0].iso;
  }

  dom.dateRail.innerHTML = "";

  days.forEach((day) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "date-chip";

    if (state.selectedDate === day.iso) {
      button.classList.add("is-active");
    }

    button.innerHTML = `
      <span class="date-chip__weekday">${day.weekday}</span>
      <span class="date-chip__day">${day.dayNumber}</span>
      <span class="date-chip__slots">${day.slotCount} slots</span>
    `;

    button.addEventListener("click", () => {
      state.selectedDate = day.iso;
      state.selectedSlot = null;
      renderBooking();
    });

    dom.dateRail.appendChild(button);
  });
}

function renderSlots() {
  if (!dom.slotGrid || !dom.slotEmpty) return;

  const slots = buildSlotsForSelectedDate();
  dom.slotGrid.innerHTML = "";

  if (slots.length === 0) {
    dom.slotEmpty.hidden = false;
    return;
  }

  dom.slotEmpty.hidden = true;

  slots.forEach((slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot-button";

    if (state.selectedSlot === slot.iso) {
      button.classList.add("is-active");
    }

    button.textContent = slot.label;

    button.addEventListener("click", () => {
      state.selectedSlot = slot.iso;
      renderBookingSummary();
    });

    dom.slotGrid.appendChild(button);
  });
}

function renderBookingSummary() {
  if (!dom.bookingSummary) return;

  const meetingType = getActiveMeetingType();
  const slotText = state.selectedSlot ? formatSlotLabel(state.selectedSlot) : "Choose a time";
  const canSubmit = Boolean(state.selectedSlot);

  dom.bookingSummary.innerHTML = `
    <div class="summary-row">
      <span>Meeting</span>
      <strong>${meetingType ? meetingType.label : "—"}</strong>
    </div>
    <div class="summary-row">
      <span>When</span>
      <strong>${slotText}</strong>
    </div>
    <div class="summary-row">
      <span>Timezone</span>
      <strong>${state.timezone}</strong>
    </div>
  `;

  if (dom.bookingForm) {
    const submit = dom.bookingForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !canSubmit;
  }
}

function renderManager() {
  const isAuthed = state.managerAuthenticated;

  if (dom.managerGate) dom.managerGate.hidden = isAuthed;
  if (dom.managerShell) dom.managerShell.hidden = !isAuthed;

  if (!isAuthed || !state.availability) return;

  if (dom.managerGoogleStatus) {
    const calendar = state.availability.calendar;
    dom.managerGoogleStatus.textContent = calendar.connected
      ? `Connected to Google Calendar (${calendar.calendarId})`
      : "Google Calendar is not connected yet";
  }

  const booking = state.availability.booking;

  if (dom.availabilityStart) dom.availabilityStart.value = booking.workingHours.start;
  if (dom.availabilityEnd) dom.availabilityEnd.value = booking.workingHours.end;
  if (dom.slotDuration) dom.slotDuration.value = String(booking.defaultDurationMinutes);
  if (dom.bufferMinutes) dom.bufferMinutes.value = String(booking.bufferMinutes);
  if (dom.maxMeetingsPerDay) dom.maxMeetingsPerDay.value = String(booking.maxMeetingsPerDay);
  if (dom.minimumNoticeHours) dom.minimumNoticeHours.value = String(booking.minimumNoticeHours);
  if (dom.bookingWindowDays) dom.bookingWindowDays.value = String(booking.bookingWindowDays);

  dom.weekdayCheckboxes.forEach((checkbox) => {
    const value = Number(checkbox.dataset.weekday);
    checkbox.checked = booking.workingDays.includes(value);
  });
}

function handleManagerLogin() {
  const email = dom.managerEmail?.value?.trim() || "";
  const password = dom.managerPassword?.value || "";

  const validEmail = state.availability?.app?.managerDemoEmail || "admin@example.com";
  const validPassword = state.availability?.app?.managerDemoPassword || "demo1234";

  if (email === validEmail && password === validPassword) {
    state.managerAuthenticated = true;
    state.managerEmail = email;
    renderManager();
    return;
  }

  alert("Invalid demo credentials. Check availability.json for the current values.");
}

function simulateGoogleConnect(source) {
  if (!state.availability) return;

  if (source === "manager") {
    state.availability.calendar.connected = true;
    state.availability.calendar.connectionLabel = "Connected in demo mode";
    renderManager();
    return;
  }

  alert("This is currently a frontend placeholder. Later it should connect to api/auth.js.");
}

function saveAvailabilityFromManagerForm() {
  if (!state.availability) return;

  const selectedDays = Array.from(dom.weekdayCheckboxes)
    .filter((item) => item.checked)
    .map((item) => Number(item.dataset.weekday))
    .sort((a, b) => a - b);

  state.availability.booking.workingHours.start = dom.availabilityStart.value;
  state.availability.booking.workingHours.end = dom.availabilityEnd.value;
  state.availability.booking.defaultDurationMinutes = Number(dom.slotDuration.value);
  state.availability.booking.bufferMinutes = Number(dom.bufferMinutes.value);
  state.availability.booking.maxMeetingsPerDay = Number(dom.maxMeetingsPerDay.value);
  state.availability.booking.minimumNoticeHours = Number(dom.minimumNoticeHours.value);
  state.availability.booking.bookingWindowDays = Number(dom.bookingWindowDays.value);
  state.availability.booking.workingDays = selectedDays;

  state.selectedDate = null;
  state.selectedSlot = null;

  renderBooking();
  alert("Availability saved in local app state. Next step is wiring it to a real backend.");
}

function handleBookingSubmit() {
  if (!state.selectedSlot) {
    alert("Please choose a time slot first.");
    return;
  }

  state.bookingDetails.name = dom.nameInput?.value?.trim() || "";
  state.bookingDetails.email = dom.emailInput?.value?.trim() || "";
  state.bookingDetails.notes = dom.notesInput?.value?.trim() || "";

  if (!state.bookingDetails.name || !state.bookingDetails.email) {
    alert("Please fill in your name and email.");
    return;
  }

  const meetingType = getActiveMeetingType();

  if (!dom.bookingSuccess) return;

  dom.bookingSuccess.hidden = false;
  dom.bookingSuccess.innerHTML = `
    <div class="success-card">
      <h3>Booking captured</h3>
      <p>This is the frontend flow. Next we’ll connect it to Google Calendar and create real events.</p>
      <div class="summary-row">
        <span>Name</span>
        <strong>${escapeHtml(state.bookingDetails.name)}</strong>
      </div>
      <div class="summary-row">
        <span>Email</span>
        <strong>${escapeHtml(state.bookingDetails.email)}</strong>
      </div>
      <div class="summary-row">
        <span>Meeting</span>
        <strong>${meetingType.label}</strong>
      </div>
      <div class="summary-row">
        <span>Time</span>
        <strong>${formatSlotLabel(state.selectedSlot)}</strong>
      </div>
    </div>
  `;

  dom.bookingSuccess.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
}

function getActiveMeetingType() {
  return (
    state.availability?.meetingTypes?.find((item) => item.id === state.selectedMeetingType) ||
    state.availability?.meetingTypes?.[0] ||
    null
  );
}

function buildAvailableDates() {
  const booking = state.availability.booking;
  const meetingType = getActiveMeetingType();
  const dates = [];
  const now = new Date();
  const msNotice = booking.minimumNoticeHours * 60 * 60 * 1000;

  for (let i = 0; i < booking.bookingWindowDays; i += 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(now.getDate() + i);

    const jsDay = date.getDay();
    const mondayBasedDay = jsDay === 0 ? 6 : jsDay - 1;

    if (!booking.workingDays.includes(mondayBasedDay)) continue;

    const slots = buildSlotsForDate(date, meetingType, msNotice);
    if (slots.length === 0) continue;

    dates.push({
      iso: toDateIso(date),
      weekday: date.toLocaleDateString([], { weekday: "short" }),
      dayNumber: date.getDate(),
      slotCount: slots.length
    });
  }

  return dates;
}

function buildSlotsForSelectedDate() {
  if (!state.selectedDate) return [];

  const date = new Date(`${state.selectedDate}T00:00:00`);
  return buildSlotsForDate(
    date,
    getActiveMeetingType(),
    state.availability.booking.minimumNoticeHours * 60 * 60 * 1000
  );
}

function buildSlotsForDate(date, meetingType, msNotice) {
  const booking = state.availability.booking;
  const [startHour, startMinute] = booking.workingHours.start.split(":").map(Number);
  const [endHour, endMinute] = booking.workingHours.end.split(":").map(Number);

  const start = new Date(date);
  start.setHours(startHour, startMinute, 0, 0);

  const end = new Date(date);
  end.setHours(endHour, endMinute, 0, 0);

  const step = (meetingType.durationMinutes + booking.bufferMinutes) * 60000;
  const nowPlusNotice = Date.now() + msNotice;
  const slots = [];

  for (
    let cursor = new Date(start);
    cursor.getTime() + meetingType.durationMinutes * 60000 <= end.getTime();
    cursor = new Date(cursor.getTime() + step)
  ) {
    if (cursor.getTime() < nowPlusNotice) continue;
    if (slots.length >= booking.maxMeetingsPerDay) break;

    slots.push({
      iso: cursor.toISOString(),
      label: cursor.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    });
  }

  return slots;
}

function toDateIso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatSlotLabel(isoString) {
  const date = new Date(isoString);

  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
