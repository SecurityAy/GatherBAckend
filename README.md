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
- `POST /api/events/:eventId/rsvps/:registrationId/approve`
- `POST /api/events/:eventId/rsvps/:registrationId/reject`
- All four routes require a bearer access token. The RSVP list/detail and decision routes return `404` for an event or registration the authenticated organiser cannot access.
- The list response includes pagination metadata. Approval and rejection endpoints accept an empty body only and return `200` with the updated registration and attendee details. The response shape is:

```json
{
  "registration": {
    "id": "<registrationId>",
    "attendanceIntent": "ATTENDING",
    "status": "APPROVED",
    "relationshipToGraduate": null,
    "createdAt": "<ISO timestamp>",
    "approvedAt": "<ISO timestamp>",
    "declinedAt": null,
    "attendees": [
      {
        "id": "<attendeeId>",
        "firstName": "Ada",
        "lastName": "Okafor",
        "email": "ada@example.com",
        "phone": "+234 801 234 5678",
        "attendeeType": "PRIMARY",
        "createdAt": "<ISO timestamp>"
      }
    ]
  }
}
```

  For rejection, `status` is `DECLINED`, `approvedAt` is `null`, and `declinedAt` contains the decision timestamp. Confirmation tokens and hashes are excluded.
- Only `PENDING` registrations can be decided. Approval also requires `attendanceIntent: "ATTENDING"`; it sets status to `APPROVED`, `approvedAt` to the decision time, and clears `declinedAt`. Rejection sets status to `DECLINED`, `declinedAt` to the decision time, and clears `approvedAt`. Other statuses and non-attending RSVPs cannot be approved or rejected.
- Missing or inaccessible registrations return `404` with `{ "message": "Registration not found." }`. Attempts to decide a registration outside `PENDING` return `409` with either `{ "message": "Only pending registrations can be approved." }` or `{ "message": "Only pending registrations can be rejected." }`. A pending non-attending registration, if present, returns `409` with `{ "message": "Only attending registrations can be approved." }`. Non-empty bodies return `400` with the standard validation response. Missing/invalid authentication returns `401`; inactive accounts return `403`.

## Graduate photo uploads

`POST /api/events/:eventId/image-upload-signature` requires a bearer access token and an empty JSON body. It returns `200` with `{ "upload": { "cloud_name", "api_key", "timestamp", "signature", "folder", "public_id", "resource_type", "allowed_formats", "overwrite", "client_max_file_size_bytes", "expires_at" } }`. The signature binds the event-specific folder, server-generated public ID, image format allowlist, overwrite setting, and current timestamp. The API secret is never returned. Invalid event IDs return `400`; missing or non-owned events return `404`; missing Cloudinary configuration returns `500` with a safe message.

Upload the image directly from the frontend to Cloudinary using the returned signed fields, then save its HTTPS `secure_url` through the existing event update endpoint as `coverImageUrl`. The returned 5 MiB file-size value is a client-side limit. Cloudinary does not provide a per-request file-size field for signed uploads; configure a suitable server-side maximum in the Cloudinary account Usage Limits for a hard upload cap. Cloudinary signed upload timestamps are valid for up to one hour.

Public rate limits are 5 RSVP submissions per IP per hour and 20 confirmation lookups per IP per 15 minutes. They return `429` with `Retry-After`. The Express app is configured with `app.set('trust proxy', 1)` to trust the immediate single upstream reverse proxy (such as Render's default ingress) and evaluate the rightmost client IP from `X-Forwarded-For`. If additional proxy or CDN layers (such as Cloudflare) are placed in front of the service, adjust the trusted proxy hop count or CIDR configuration accordingly. Counters are in memory, are per backend process, and reset when a process restarts; they are not shared across multiple instances.

Run the RSVP integration test with `npm test`. It uses the configured PostgreSQL database to create uniquely named temporary records and removes them after the run.

## Transactional email notifications

RSVP creation and organiser decisions write idempotent notification jobs to the PostgreSQL outbox in the same transaction as the RSVP change. A background worker sends the four transactional notification types through Resend and retries transient failures up to five attempts. Without `RESEND_API_KEY`, jobs remain pending and RSVP operations continue normally. Configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in the backend environment; the default sender is `onboarding@resend.dev`, which Resend restricts to verified test recipients. `FRONTEND_URL` is optional and is used only to form public invitation links. Additional guests are not emailed.

For safe local integration tests, put the disposable Neon test database URLs in ignored `.env.test.local` and run `npm run test:safe`. The runner validates both URLs point to Neon database `gather_rsvp_test`, applies migrations to that database, then runs the suite. It requires no production `.env` database fallback.

## Notes
Authentication and event management use Prisma/PostgreSQL. RSVP submissions and organiser registration reads are also implemented on the backend, but the frontend RSVP flow is not connected yet. Ticket and check-in routes are still prototype implementations and should not be used as authoritative production workflows.
