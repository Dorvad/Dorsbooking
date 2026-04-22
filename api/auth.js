// api/auth.js
//
// Starter Google OAuth backend for a booking app.
// Works well as a serverless function shape on platforms like Vercel/Netlify-style Node backends.
// No external packages required.
//
// Environment variables you should set:
// GOOGLE_CLIENT_ID=...
// GOOGLE_CLIENT_SECRET=...
// GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth?action=callback
// APP_BASE_URL=https://your-domain.com
// GOOGLE_CALENDAR_ID=primary
//
// Optional:
// AUTH_COOKIE_SECURE=true
// GOOGLE_AUTH_SCOPES=openid email profile https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const DEFAULT_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events"
];

export default async function handler(req, res) {
  try {
    const action = String(req.query.action || "start");

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
      return json(res, 500, {
        ok: false,
        error: "Missing required environment variables.",
        required: [
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "GOOGLE_REDIRECT_URI"
        ]
      });
    }

    if (action === "start") {
      return startOAuth(req, res);
    }

    if (action === "callback") {
      return handleCallback(req, res);
    }

    if (action === "status") {
      return getStatus(req, res);
    }

    if (action === "logout") {
      return logout(req, res);
    }

    return json(res, 400, {
      ok: false,
      error: `Unsupported action: ${action}`
    });
  } catch (error) {
    console.error("auth.js fatal error:", error);
    return json(res, 500, {
      ok: false,
      error: "Unexpected auth error."
    });
  }
}

function startOAuth(req, res) {
  const state = randomString(32);
  const source = String(req.query.source || "manager");
  const scopes = getScopes();

  const redirect = new URL(GOOGLE_AUTH_URL);
  redirect.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  redirect.searchParams.set("redirect_uri", process.env.GOOGLE_REDIRECT_URI);
  redirect.searchParams.set("response_type", "code");
  redirect.searchParams.set("scope", scopes.join(" "));
  redirect.searchParams.set("access_type", "offline");
  redirect.searchParams.set("include_granted_scopes", "true");
  redirect.searchParams.set("prompt", "consent");
  redirect.searchParams.set("state", state);

  const cookies = [
    createCookie("oauth_state", state, {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 60 * 10,
      path: "/"
    }),
    createCookie("oauth_source", source, {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 60 * 10,
      path: "/"
    })
  ];

  res.setHeader("Set-Cookie", cookies);
  res.writeHead(302, { Location: redirect.toString() });
  res.end();
}

async function handleCallback(req, res) {
  const cookies = parseCookies(req);
  const expectedState = cookies.oauth_state || "";
  const returnedState = String(req.query.state || "");
  const code = String(req.query.code || "");
  const source = cookies.oauth_source || "manager";

  if (!code) {
    return redirectWithError(res, "missing_code");
  }

  if (!expectedState || !returnedState || expectedState !== returnedState) {
    return redirectWithError(res, "invalid_state");
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code"
    }).toString()
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    console.error("Token exchange failed:", tokenData);
    return redirectWithError(res, "token_exchange_failed");
  }

  let profile = null;

  if (tokenData.access_token) {
    try {
      const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      });

      if (profileResponse.ok) {
        profile = await profileResponse.json();
      }
    } catch (error) {
      console.warn("Could not fetch profile:", error);
    }
  }

  const cookieHeaders = [
    createCookie("oauth_state", "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 0,
      path: "/"
    }),
    createCookie("oauth_source", "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 0,
      path: "/"
    }),
    createCookie("google_connected", "true", {
      httpOnly: false,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/"
    }),
    createCookie("google_access_token", tokenData.access_token || "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: Math.max(Number(tokenData.expires_in || 3600), 60),
      path: "/"
    }),
    createCookie("google_refresh_token", tokenData.refresh_token || "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 90,
      path: "/"
    }),
    createCookie("google_id_token", tokenData.id_token || "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: Math.max(Number(tokenData.expires_in || 3600), 60),
      path: "/"
    }),
    createCookie("google_user_email", profile?.email || "", {
      httpOnly: false,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/"
    }),
    createCookie("google_user_name", profile?.name || "", {
      httpOnly: false,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/"
    }),
    createCookie("google_auth_source", source, {
      httpOnly: false,
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7,
      path: "/"
    })
  ];

  res.setHeader("Set-Cookie", cookieHeaders);

  const target = new URL(process.env.APP_BASE_URL || inferBaseUrl(req));
  target.hash = source === "manager" ? "manager" : "booking";
  target.searchParams.set("google", "connected");

  res.writeHead(302, { Location: target.toString() });
  res.end();
}

function getStatus(req, res) {
  const cookies = parseCookies(req);

  return json(res, 200, {
    ok: true,
    connected: cookies.google_connected === "true",
    email: cookies.google_user_email || null,
    name: cookies.google_user_name || null,
    source: cookies.google_auth_source || null,
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary"
  });
}

async function logout(req, res) {
  const cookies = parseCookies(req);
  const accessToken = cookies.google_access_token || "";

  if (accessToken) {
    try {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(accessToken)}`, {
        method: "POST"
      });
    } catch (error) {
      console.warn("Token revocation failed:", error);
    }
  }

  const expiredCookies = [
    "google_connected",
    "google_access_token",
    "google_refresh_token",
    "google_id_token",
    "google_user_email",
    "google_user_name",
    "google_auth_source",
    "oauth_state",
    "oauth_source"
  ].map((name) =>
    createCookie(name, "", {
      httpOnly: name.includes("token") || name.startsWith("oauth_"),
      secure: isSecureCookies(),
      sameSite: "Lax",
      maxAge: 0,
      path: "/"
    })
  );

  res.setHeader("Set-Cookie", expiredCookies);

  return json(res, 200, {
    ok: true,
    connected: false
  });
}

function redirectWithError(res, code) {
  const target = new URL(process.env.APP_BASE_URL || "http://localhost:3000");
  target.hash = "manager";
  target.searchParams.set("google", "error");
  target.searchParams.set("reason", code);

  res.writeHead(302, { Location: target.toString() });
  res.end();
}

function getScopes() {
  const raw = process.env.GOOGLE_AUTH_SCOPES?.trim();
  if (!raw) return DEFAULT_SCOPES;
  return raw.split(/\s+/).filter(Boolean);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const output = {};

  header.split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    output[key] = decodeURIComponent(value);
  });

  return output;
}

function createCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  parts.push(`Path=${options.path || "/"}`);

  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join("; ");
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

function randomString(length = 32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < bytes.length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function isSecureCookies() {
  return String(process.env.AUTH_COOKIE_SECURE || "true") === "true";
}

function inferBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}
