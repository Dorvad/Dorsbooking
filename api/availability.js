/*
 * api/availability.js
 * Availability API for Dorsbooking.
 *
 * Planned endpoints:
 *   GET  /api/availability          — return open time slots for a given date range
 *                                     (reads config/availability.json, subtracts booked slots)
 *   PUT  /api/availability          — manager updates weekly schedule (auth required)
 *
 * Future: query Google Calendar to subtract events that are already blocking time,
 * so the returned slots always reflect real-time calendar state.
 *
 * TODO: load and parse config/availability.json
 * TODO: subtract already-booked appointments
 * TODO: optionally merge with Google Calendar busy times
 * TODO: return structured JSON response to the frontend
 */
