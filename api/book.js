/*
 * api/book.js
 * Booking handler for Dorsbooking.
 *
 * Planned endpoints:
 *   POST   /api/book          — create a new appointment for a given slot
 *   DELETE /api/book/:id      — cancel an existing appointment (manager, auth required)
 *   GET    /api/book          — list all upcoming bookings (manager, auth required)
 *
 * Expected POST body:
 *   {
 *     "name":      "Visitor name",
 *     "email":     "visitor@example.com",
 *     "date":      "YYYY-MM-DD",
 *     "startTime": "HH:MM",
 *     "endTime":   "HH:MM"
 *   }
 *
 * Future: on successful booking, create a Google Calendar event via the
 * Calendar API and email confirmation to both parties.
 *
 * TODO: validate request body
 * TODO: check that the requested slot is still available
 * TODO: persist the booking (file, DB, or Google Calendar event)
 * TODO: send confirmation response / trigger notification
 */
