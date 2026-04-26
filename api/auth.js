/*
 * api/auth.js
 * Authentication handler for the manager-side of Dorsbooking.
 *
 * Planned endpoints:
 *   POST /api/auth/login   — validate manager credentials, issue a session token
 *   POST /api/auth/logout  — invalidate the current session
 *   GET  /api/auth/me      — return current authenticated user (used by frontend to check state)
 *
 * Future: integrate with Google OAuth to allow Google Calendar access on behalf
 * of the manager. The OAuth tokens returned by Google will be stored server-side
 * and referenced via the session.
 *
 * TODO: implement login / logout / session verification
 * TODO: add Google OAuth callback handler
 */
