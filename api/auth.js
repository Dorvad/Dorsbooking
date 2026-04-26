/*
 * api/auth.js
 * Google OAuth 2.0 handler for the Dorsbooking manager.
 *
 * Actions (all via query-string):
 *   GET /api/auth?action=start      Redirect browser to Google's consent screen
 *   GET /api/auth?action=callback   Google lands here; exchange code for tokens
 *   GET /api/auth?action=status     Return current connection state as JSON
 *   GET /api/auth?action=logout     Revoke token and clear cookies
 *
 * Deployment: Vercel Serverless Function (Node.js 18+).
 * Tokens are stored in httpOnly cookies — no database required at this stage.
 *
 * ── Required environment variables ──────────────────────────────────
 *
 *   GOOGLE_CLIENT_ID        OAuth 2.0 client ID (Google Cloud Console)
 *   GOOGLE_CLIENT_SECRET    OAuth 2.0 client secret
 *   GOOGLE_REDIRECT_URI     Registered redirect URI, must match Google Console
 *                           e.g. https://yourdomain.vercel.app/api/auth?action=callback
 *   APP_BASE_URL            Root URL for post-auth redirects
 *                           e.g. https://yourdomain.vercel.app
 *
 * ── Optional environment variables ──────────────────────────────────
 *
 *   GOOGLE_AUTH_SCOPES      Comma-separated OAuth scopes (defaults listed below)
 *   AUTH_COOKIE_SECURE      Set to "false" to allow non-HTTPS cookies in local dev
 *                           (defaults to true; always true in production)
 *   GOOGLE_CALENDAR_ID      Calendar ID used by api/availability.js for event queries
 */

'use strict';

const crypto = require('crypto');

/* ── Google endpoint URLs ───────────────────────────────────────────── */

const GOOGLE_AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/* ── Default OAuth scopes ───────────────────────────────────────────── */

const DEFAULT_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar',
];

/* ── Cookie names ───────────────────────────────────────────────────── */

const COOKIE = {
  STATE:         'g_oauth_state',  // short-lived CSRF nonce set during start
  ACCESS_TOKEN:  'g_access_token',
  REFRESH_TOKEN: 'g_refresh_token',
  TOKEN_EXPIRY:  'g_token_expiry', // Unix ms; lets future code detect staleness
  EMAIL:         'g_email',        // connected account email — not httpOnly (display use)
};

/* ── Main handler ───────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  // Vercel populates req.query; parseQueryString is a fallback for plain Node.
  const q = req.query ?? parseQueryString(req.url ?? '');
  const { action, code, state, source, error } = q;

  try {
    switch (action) {
      case 'start':    return await handleStart(req, res, source);
      case 'callback': return await handleCallback(req, res, { code, state, error });
      case 'status':   return handleStatus(req, res);
      case 'logout':   return await handleLogout(req, res);
      default:
        return sendJson(res, 400, { error: 'Unknown or missing action parameter.' });
    }
  } catch (err) {
    console.error(`[auth] Unhandled error in action=${action}:`, err.message);
    return sendJson(res, 500, { error: 'Internal server error.' });
  }
};

/* ── action=start ───────────────────────────────────────────────────── */

async function handleStart(req, res, source) {
  const clientId    = requireEnv('GOOGLE_CLIENT_ID');
  const redirectUri = requireEnv('GOOGLE_REDIRECT_URI');

  // A random nonce stored in a cookie and echoed back by Google as ?state=
  // lets the callback verify that it originated from this server (CSRF guard).
  const nonce = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         getScopes().join(' '),
    access_type:   'offline',
    // 'consent' forces Google to always re-issue a refresh_token.
    // Switch to 'select_account' once tokens are persisted across deployments.
    prompt:        'consent',
    state:         nonce,
  });

  res.setHeader('Set-Cookie', [
    buildCookie(COOKIE.STATE, nonce, {
      maxAge:   600, // 10 minutes — enough to complete the browser redirect round-trip
      httpOnly: true,
      secure:   cookieSecure(),
      sameSite: 'lax', // lax (not strict) is required: Google's redirect is cross-site
      path:     '/',
    }),
  ]);

  redirect(res, `${GOOGLE_AUTH_URL}?${params}`);
}

/* ── action=callback ────────────────────────────────────────────────── */

async function handleCallback(req, res, { code, state: stateParam, error }) {
  const baseUrl    = requireEnv('APP_BASE_URL');
  const managerUrl = `${baseUrl}/#manage`;

  if (error) {
    console.warn('[auth] Google returned an error in callback:', error);
    return redirect(res, `${managerUrl}?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    console.error('[auth] Callback received without an authorization code.');
    return redirect(res, `${managerUrl}?error=missing_code`);
  }

  // Validate state to prevent CSRF.
  const cookies    = parseCookies(req);
  const savedNonce = cookies[COOKIE.STATE];
  if (!savedNonce || savedNonce !== stateParam) {
    console.error('[auth] OAuth state mismatch — possible CSRF attempt.');
    return redirect(res, `${managerUrl}?error=state_mismatch`);
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error('[auth] Token exchange failed:', err.message);
    return redirect(res, `${managerUrl}?error=token_exchange_failed`);
  }

  const isSecure  = cookieSecure();
  const expiresIn = tokens.expires_in ?? 3600;
  const expiryMs  = Date.now() + expiresIn * 1000;
  const email     = extractEmailFromIdToken(tokens.id_token);

  const cookiesToSet = [
    // Clear the short-lived CSRF nonce — it has served its purpose.
    buildCookie(COOKIE.STATE, '', { maxAge: 0, httpOnly: true, path: '/' }),

    buildCookie(COOKIE.ACCESS_TOKEN, tokens.access_token, {
      maxAge:   expiresIn,
      httpOnly: true,
      secure:   isSecure,
      sameSite: 'lax',
      path:     '/',
    }),

    buildCookie(COOKIE.TOKEN_EXPIRY, String(expiryMs), {
      maxAge:   60 * 60 * 24 * 30, // 30 days — outlive the access_token
      httpOnly: true,
      secure:   isSecure,
      sameSite: 'lax',
      path:     '/',
    }),
  ];

  // refresh_token is only included on the first authorisation (or when prompt=consent).
  if (tokens.refresh_token) {
    cookiesToSet.push(
      buildCookie(COOKIE.REFRESH_TOKEN, tokens.refresh_token, {
        maxAge:   60 * 60 * 24 * 30,
        httpOnly: true,
        secure:   isSecure,
        sameSite: 'lax',
        path:     '/',
      })
    );
  }

  // Email is intentionally not httpOnly so the frontend status call can read it.
  if (email) {
    cookiesToSet.push(
      buildCookie(COOKIE.EMAIL, email, {
        maxAge:   60 * 60 * 24 * 30,
        httpOnly: false,
        secure:   isSecure,
        sameSite: 'lax',
        path:     '/',
      })
    );
  }

  res.setHeader('Set-Cookie', cookiesToSet);
  redirect(res, managerUrl);
}

/* ── action=status ──────────────────────────────────────────────────── */

function handleStatus(req, res) {
  const cookies     = parseCookies(req);
  const accessToken = cookies[COOKIE.ACCESS_TOKEN];

  if (!accessToken) {
    return sendJson(res, 200, { connected: false, label: 'Not connected' });
  }

  const email = cookies[COOKIE.EMAIL];
  const label = email ? `Connected as ${email}` : 'Connected';
  return sendJson(res, 200, { connected: true, label });
}

/* ── action=logout ──────────────────────────────────────────────────── */

async function handleLogout(req, res) {
  const cookies     = parseCookies(req);
  const accessToken = cookies[COOKIE.ACCESS_TOKEN];

  // Revoke the token so it cannot be replayed. Non-fatal if it fails.
  if (accessToken) {
    try {
      const r = await fetch(
        `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(accessToken)}`,
        { method: 'POST' }
      );
      if (!r.ok) console.warn('[auth] Token revocation returned HTTP', r.status);
    } catch (err) {
      console.warn('[auth] Token revocation request failed (non-fatal):', err.message);
    }
  }

  res.setHeader('Set-Cookie', [
    buildCookie(COOKIE.ACCESS_TOKEN,  '', { maxAge: 0, httpOnly: true,  path: '/' }),
    buildCookie(COOKIE.REFRESH_TOKEN, '', { maxAge: 0, httpOnly: true,  path: '/' }),
    buildCookie(COOKIE.TOKEN_EXPIRY,  '', { maxAge: 0, httpOnly: true,  path: '/' }),
    buildCookie(COOKIE.EMAIL,         '', { maxAge: 0, httpOnly: false, path: '/' }),
  ]);

  sendJson(res, 200, { success: true });
}

/* ── Token exchange ─────────────────────────────────────────────────── */

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id:     requireEnv('GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
    redirect_uri:  requireEnv('GOOGLE_REDIRECT_URI'),
    grant_type:    'authorization_code',
  });

  const r    = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();

  if (!r.ok) {
    throw new Error(data.error_description ?? data.error ?? `HTTP ${r.status}`);
  }
  return data;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Throw a clear error if a required environment variable is absent. */
function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

/**
 * Whether to set the Secure flag on cookies.
 * Defaults to true. Set AUTH_COOKIE_SECURE=false for local HTTP development.
 */
function cookieSecure() {
  const val = process.env.AUTH_COOKIE_SECURE;
  if (val === undefined) return true;
  return val !== 'false' && val !== '0';
}

/** Return the configured OAuth scopes, or the built-in defaults. */
function getScopes() {
  const raw = process.env.GOOGLE_AUTH_SCOPES;
  if (raw) return raw.split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_SCOPES;
}

/**
 * Decode a Google id_token JWT payload to extract the email claim.
 * The signature is intentionally NOT verified here — we trust that the
 * token was issued by Google's own token endpoint moments ago.
 */
function extractEmailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const payloadSegment = idToken.split('.')[1];
    if (!payloadSegment) return null;
    // Node 18+ supports the 'base64url' encoding directly.
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    return JSON.parse(json).email ?? null;
  } catch {
    return null;
  }
}

/** Parse the Cookie request header into a plain { name: value } object. */
function parseCookies(req) {
  const header = req.headers?.cookie ?? '';
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap(pair => {
      const idx = pair.indexOf('=');
      if (idx === -1) return [];
      const name  = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      return name ? [[name, decodeURIComponent(value)]] : [];
    })
  );
}

/**
 * Serialise a Set-Cookie header string.
 * Values are percent-encoded; names are expected to be safe ASCII.
 */
function buildCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge  != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path)            parts.push(`Path=${opts.path}`);
  if (opts.httpOnly)        parts.push('HttpOnly');
  if (opts.secure)          parts.push('Secure');
  if (opts.sameSite)        parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}

/** Write a JSON response body with the given HTTP status code. */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Issue a 302 redirect. Uses writeHead for compatibility with plain Node http. */
function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

/** Parse the query string from a raw URL path. Fallback when req.query is absent. */
function parseQueryString(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}
