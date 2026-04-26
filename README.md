# Dorsbooking

A mobile-first meeting scheduler web app built with plain HTML, CSS, and JavaScript.

## Structure

```
Dorsbooking/
├── index.html              # App shell — public booking + manager views
├── styles.css              # Mobile-first global styles (no framework)
├── app.js                  # Client-side entry point
├── config/
│   └── availability.json   # Weekly schedule config, fetched by the availability API
└── api/
    ├── auth.js             # Manager authentication (login, logout, Google OAuth)
    ├── availability.js     # Returns open slots; future Google Calendar integration
    └── book.js             # Creates / cancels appointments
```

## Sides

| Side | URL | Auth |
|------|-----|------|
| Public booking | `/` | None |
| Manager dashboard | `/#manage` | Required |

## Roadmap

- [ ] Render available time slots in the booking form
- [ ] Submit and confirm bookings via `/api/book`
- [ ] Manager login via `/api/auth`
- [ ] Manager availability editor
- [ ] Google Calendar integration (OAuth + event creation)

## Running locally

No build step required. Serve the project root with any static file server, for example:

```bash
npx serve .
# or
python3 -m http.server 8080
```

The `api/` files are Node.js modules intended to run behind a lightweight server
(e.g. Express or a serverless function host). They are stubs for now.
