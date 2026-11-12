# Gather Backend

This project is a backend scaffold for the Gather graduation invitation platform described in the product requirements document.

## Stack
- Node.js + TypeScript
- Express
- PostgreSQL + Prisma
- JWT auth and middleware-based authorization

## Getting started
1. Install dependencies: `npm install`
2. Set up a PostgreSQL database (the current deployment uses Supabase).
3. Copy `.env.example` to `.env` and configure `DATABASE_URL`, `DIRECT_URL`, and `JWT_SECRET`.
4. Generate the Prisma Client: `npm run prisma:generate`
5. Start the API: `npm run dev`

The initial Prisma migration has been applied to the configured Supabase database. Review migration SQL before preparing future migrations.

Set `CORS_ORIGINS` to a comma-separated list of exact frontend origins (for local Vite development, `http://localhost:5173,http://127.0.0.1:5173`). In production, `CORS_ORIGINS` is required; the API does not allow arbitrary browser origins. CORS allows the API methods and `Authorization`/`Content-Type` headers without enabling credentialed cookies.

## Database foundation

The Prisma schema defines users, events, group RSVP registrations, individual attendees, tickets, check-ins, photos, and audit logs. Events use soft deletion so their related records and history can be retained.

## RSVP API

Public RSVP submission:

- `POST /api/events/public/:slug/rsvp`
- Required JSON fields: `primaryGuestName`, `primaryGuestEmail`, `primaryGuestPhone`, and `attendanceIntent` (`ATTENDING` or `NOT_ATTENDING`).
- Optional fields: `relationshipToGraduate` and `additionalGuestNames` (an array of full names; allowed only when attending and limited by the event).
- Returns `201` with the registration summary and a one-time confirmation token. The database stores only its SHA-256 hash.
- Returns `400` for invalid input, `404` when the event is unavailable, `409` after the RSVP deadline or for a recent duplicate, and `429` when rate limited.

Public confirmation lookup:

- `POST /api/events/public/:slug/rsvp/confirmation`
- JSON body: `{ "token": "<confirmation token>" }`
- Returns `200` with safe confirmation details, or `404` for an invalid token or event mismatch. The token and token hash are not included in the response.

Authenticated organiser endpoints:

- `GET /api/events/:eventId/rsvps?page=1&pageSize=20`
- `GET /api/events/:eventId/rsvps/:registrationId`
- Both require a bearer access token and return `404` when the event or registration is not owned by the authenticated organiser.
- The list response includes pagination metadata. No approval or decline action is provided by these endpoints.

Public rate limits are 5 RSVP submissions per IP per hour and 20 confirmation lookups per IP per 15 minutes. They return `429` with `Retry-After`. The Express app is configured with `app.set('trust proxy', 1)` to trust the immediate single upstream reverse proxy (such as Render's default ingress) and evaluate the rightmost client IP from `X-Forwarded-For`. If additional proxy or CDN layers (such as Cloudflare) are placed in front of the service, adjust the trusted proxy hop count or CIDR configuration accordingly. Counters are in memory, are per backend process, and reset when a process restarts; they are not shared across multiple instances.

Run the RSVP integration test with `npm test`. It uses the configured PostgreSQL database to create uniquely named temporary records and removes them after the run.

## Notes
Authentication and event management use Prisma/PostgreSQL. RSVP submissions and organiser registration reads are also implemented on the backend, but the frontend RSVP flow is not connected yet. Ticket and check-in routes are still prototype implementations and should not be used as authoritative production workflows.
