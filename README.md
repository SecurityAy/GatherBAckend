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

Duplicate protection is rule-based: one registration per event and primary email in any five-minute sliding window, and one active reservation per event and device hash. Email comparison is case-insensitive; cancelled registrations release both the email window and the device lock. Application checks return friendly `409` responses, and database constraints enforce the same rules if concurrent requests bypass the checks.

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

For safe local integration tests, put the disposable Neon test database URLs in ignored `.env.test.local` and run `npm run test:safe`. The runner validates both URLs point to Neon database `gather_rsvp_test`, applies migrations to that database, then runs the suite. It requires no production `.env` database fallback. Production migrations are not applied by this runner or by Vercel; run `prisma migrate deploy` with production `DATABASE_URL` and `DIRECT_URL` as a separate deployment step. The `20261121130000_enforce_rsvp_duplicate_rules` migration requires PostgreSQL 14+ for `sha256()` and the `btree_gist` extension.

## Individual attendee tickets and check-in

Tickets are persisted per `Attendee`. Only attendees belonging to an `APPROVED` registration with `attendanceIntent: ATTENDING` are eligible. Approving an attending RSVP creates one ticket for its primary and additional attendees in the same transaction as the approval. Ticket issuance stores a SHA-256 hash of a cryptographically random token; raw `qrToken` values are returned only for tickets newly issued by that request.

The existing `POST /api/events/:eventId/rsvps/:registrationId/approve` response keeps its `registration` object and adds a top-level `tickets` array with the same newly-issued ticket shape shown below. Rejections return an empty `tickets` array. Token-bearing approval and issuance responses use `Cache-Control: no-store`.

Authenticated event-owner endpoints:

- `POST /api/events/:eventId/tickets/issue` issues any missing eligible tickets for the event. It is safe to call repeatedly. Returns `200` with `{ "issuedCount": 1, "tickets": [{ "attendeeId": "...", "ticketId": "...", "qrToken": "..." }] }`. Existing tickets are not recreated and their raw tokens cannot be recovered by this endpoint. Keep tokens private and deliver/display them only to the intended attendee.
- `POST /api/events/:eventId/attendees/:attendeeId/tickets/reissue` replaces the QR token on an existing ticket for an `APPROVED`, `ATTENDING` attendee. Returns `200` with `{ "attendeeId", "ticketId", "qrToken" }` and `Cache-Control: no-store`. The old token is revoked immediately because its hash is overwritten. Checked-in, used, cancelled, and foreign-event tickets return 404/409.
- `GET /api/events/:eventId/attendees?page=1&pageSize=50` returns `{ attendees, pagination }`. Each attendee contains `id`, `firstName`, `lastName`, `attendeeType`, `attendanceIntent`, `registrationStatus`, `hasTicket`, `checkedIn`, and `checkedInAt`. QR tokens and hashes are never included. Page size is 1–100.

`POST /api/tickets/checkin` requires an authenticated owner of the supplied event and JSON `{ "eventId": "<UUID>", "qrToken": "<one-time token>" }`. It atomically marks the ticket used and creates its check-in record. It returns a safe attendee summary and `checkedInAt`; unknown/wrong-event tickets return 404 and already-used/ineligible tickets return 409. For a short client transition, `qrCode` is accepted as an alias for `qrToken`, but its value must now be a server-issued token.

The former in-memory `GET /api/tickets/validate/:qrCode` route now returns 410 with migration guidance. Prototype tickets held only in process memory are not migrated or recognized. Raw tokens are intentionally not stored; a lost token is recovered through the owner-only reissue endpoint above, not by repeating idempotent issuance.

## RSVP cancellation

A reservation can be cancelled in two ways. Both set `status: CANCELLED` and `cancelledAt`, release the event's guest capacity, release the per-device reservation lock, and void any tickets already issued for that registration.

- `POST /api/events/public/:slug/rsvp/cancel` is public and uses the confirmation token as a bearer credential: `{ "token": "<confirmationToken>" }`. It returns `200` with `{ "registration": { "id", "status", "cancelledAt" }, "voidedTickets": <number> }`. Unknown tokens return 404; cancelling twice returns 409.
- `POST /api/events/:eventId/rsvps/:registrationId/cancel` requires an authenticated owner of the event and returns the same shape. Foreign or missing registrations return 404.

The public event response's `event.hasReserved` is false again after cancellation, so the guest can reserve once more on the same event and device. Confirmation lookups continue to work for cancelled registrations so guests can see their status.

## Notes
Authentication, event management, RSVP, ticket issuance, attendee listing, and ticket check-in use Prisma/PostgreSQL. The frontend RSVP and ticket-scanning flows are not verified as connected to these APIs. Existing QR-token delivery to guests is not implemented by this backend.
