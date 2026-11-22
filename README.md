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

Set `CORS_ORIGINS` to a comma-separated list of exact frontend origins (for local Vite development, `http://localhost:5173,http://127.0.0.1:5173`). In production, `CORS_ORIGINS` is required; the API does not allow arbitrary browser origins. CORS allows the API methods and `Authorization`, `Content-Type`, and `x-device-id` headers, with credentialed cookies enabled for the signed device cookie.

All responses include baseline security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`). `Strict-Transport-Security` is added when `NODE_ENV=production`. Request logs redact ticket-path tokens and sensitive query parameters before Morgan writes them, so QR and confirmation credentials are never logged. Authorization headers are not logged.

Email verification is not implemented or enforced. The legacy `emailVerifiedAt` column is retained in the schema for compatibility but is not exposed by authentication responses and does not gate any endpoint. Accounts become usable immediately on registration; do not build client flows that depend on a verification state.

## Database foundation

The Prisma schema defines users, events, group RSVP registrations, individual attendees, tickets, check-ins, photos, and audit logs. Events use soft deletion so their related records and history can be retained.

## RSVP API

Public RSVP submission:

- `POST /api/events/public/:slug/rsvp`
- Required JSON fields: `primaryGuestName`, `primaryGuestEmail`, `primaryGuestPhone`, and `attendanceIntent` (`ATTENDING` or `NOT_ATTENDING`).
- Optional fields: `relationshipToGraduate` and `additionalGuestNames` (an array of full names; allowed only when attending and limited by the event).
- Returns `201` with the registration summary and a long-lived confirmation credential. The database stores only its SHA-256 hash.
- Returns `400` for invalid input, `404` when the event is unavailable, `409` after the RSVP deadline or for a recent duplicate, and `429` when rate limited.

Duplicate protection is rule-based: one registration per event and primary email in any five-minute sliding window, and one active reservation per event and device hash. Email comparison is case-insensitive; cancelled registrations release both the email window and the device lock. Application checks return friendly `409` responses, and database constraints enforce the same rules if concurrent requests bypass the checks.

`additionalGuestNames` accepts up to 1000 names per request, matching the maximum event-level `additionalGuestLimit`; the event's configured limit is still enforced per RSVP. Organisers cannot lower `additionalGuestLimit` below the largest number of additional guests already reserved for an active registration.

Publishing an event requires `graduateName`, `eventDate`, `timezone`, `venueName`, and `rsvpDeadline`. The timezone must be a valid IANA identifier, the event date and RSVP deadline must be in the future, and the deadline must be before the event date.

`GET /api/events` and `GET /api/events/:id` return a `counts` object containing `registrationCount`, `pendingRegistrationCount`, `approvedAttendeeCount`, `checkedInCount`, and capacity fields. `checkedInCount` is derived from tickets that have a check-in record for that event.

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

`POST /api/events/:eventId/image-upload-signature` requires a bearer access token and an empty JSON body. It returns `200` with `{ "upload": { "cloud_name", "api_key", "timestamp", "signature", "folder", "public_id", "resource_type", "allowed_formats", "overwrite", "client_max_file_size_bytes", "expires_at" } }`. The signature binds the event-specific folder, server-generated public ID, image format allowlist, overwrite setting, and current timestamp. `client_max_file_size_bytes` is an advisory 5 MiB client hint, not a signed Cloudinary upload parameter. The API secret is never returned. Invalid event IDs return `400`; missing or non-owned events return `404`; missing Cloudinary configuration returns `500` with a safe message.

Upload the image directly from the frontend to Cloudinary using the returned signed fields, then save its HTTPS `secure_url` through the existing event update endpoint as `coverImageUrl`. The request body is strictly empty, so callers cannot override the folder, public ID, or format allowlist. Cloudinary signed upload timestamps are valid for up to one hour. Cloudinary does not accept `file_size_limit` as a signed upload parameter; enforce the 5 MiB cap in the upload widget and configure the Cloudinary account-level upload limit as the hard server-side cap.

Public rate limits are 5 RSVP submissions per IP per hour and 20 confirmation/cancellation lookups per IP per 15 minutes. Authenticated upload signing and ticket issue/reissue/revoke are limited to 30 requests per user per 15 minutes; check-in is limited to 200 requests per user per 15 minutes so a venue kiosk is not throttled during a normal event. These counters remain process-local. They return `429` with `Retry-After`. The Express app is configured with `app.set('trust proxy', 1)` to trust one upstream reverse proxy (such as Render's default ingress) when resolving client IPs. If additional proxy or CDN layers (such as Cloudflare) are placed in front of the service, adjust the trusted proxy hop count or CIDR configuration accordingly. Counters are in memory, bounded to 10,000 keys, per backend process, and reset when a process restarts; they are not shared across multiple instances. A multi-instance deployment needs a shared store such as Redis.

`npm test` is the safe default: it validates `.env.test.local`, applies migrations to the disposable `gather_rsvp_test` database, and runs the integration suite there. Use `npm run test:direct` only when you intentionally want to run against the current environment. CI runs typechecking, whitespace checks, and the safe suite.

## Transactional email notifications

RSVP creation and organiser decisions write idempotent notification jobs to the PostgreSQL outbox in the same transaction as the RSVP change. A background worker sends the four transactional notification types through Resend and retries transient failures up to five attempts. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, use a two-minute lease and a Resend `Idempotency-Key`, and expose failures through `NotificationOutbox.status`, `attemptCount`, and `lastError`. Without `RESEND_API_KEY`, jobs remain pending and RSVP operations continue normally. Configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in the backend environment; the default sender is `onboarding@resend.dev`, which Resend restricts to verified test recipients. `FRONTEND_URL` is optional and is used only to form public invitation links. Additional guests are not emailed.

The worker can run in the web process (the default) or as a separate deployment. For separate workers, set `EMAIL_WORKER_IN_WEB=false` on the web service and run `npm run worker` locally or `npm run start:worker` from the built output. Multiple worker instances can safely share the outbox because claims are row-locked and delivery is idempotent. `EMAIL_WORKER_IN_WEB=true|false` is validated at startup.

For safe local integration tests, put the disposable Neon test database URLs in ignored `.env.test.local` and run `npm run test:safe`. The runner validates both URLs point to Neon database `gather_rsvp_test`, applies migrations to that database, then runs the suite. It requires no production `.env` database fallback. Production migrations are not applied by this runner or by Vercel; run `prisma migrate deploy` with production `DATABASE_URL` and `DIRECT_URL` as a separate deployment step. The `20261121130000_enforce_rsvp_duplicate_rules` migration requires PostgreSQL 14+ for `sha256()` and the `btree_gist` extension.

## Individual attendee tickets and check-in

Tickets are persisted per `Attendee`. Only attendees belonging to an `APPROVED` registration with `attendanceIntent: ATTENDING` are eligible. Approving an attending RSVP creates one ticket for its primary and additional attendees in the same transaction as the approval. Ticket issuance stores a SHA-256 hash of a cryptographically random token; raw `qrToken` values are returned only for tickets newly issued by that request.

The existing `POST /api/events/:eventId/rsvps/:registrationId/approve` response keeps its `registration` object and adds a top-level `tickets` array with the same newly-issued ticket shape shown below. Rejections return an empty `tickets` array. Token-bearing approval and issuance responses use `Cache-Control: no-store`.

Authenticated event-owner endpoints:

- `POST /api/events/:eventId/tickets/issue` issues any missing eligible tickets for the event. It is safe to call repeatedly. Returns `200` with `{ "issuedCount": 1, "tickets": [{ "attendeeId": "...", "ticketId": "...", "qrToken": "..." }] }`. Existing tickets are not recreated and their raw tokens cannot be recovered by this endpoint. Keep tokens private and deliver/display them only to the intended attendee.
- `POST /api/events/:eventId/attendees/:attendeeId/tickets/reissue` replaces the QR token on an existing ticket for an `APPROVED`, `ATTENDING` attendee. Returns `200` with `{ "attendeeId", "ticketId", "qrToken" }` and `Cache-Control: no-store`. The old token is revoked immediately because its hash is overwritten. Checked-in, used, void, cancelled, and foreign-event tickets return 404/409. Reissue is serialized with check-in by a per-event advisory lock and its update is conditional on the ticket still being issued and unscanned.
- `POST /api/events/:eventId/attendees/:attendeeId/tickets/revoke` permanently voids an unscanned ticket and returns `{ attendeeId, ticketId, ticketStatus: "VOID" }`. Already-revoked and checked-in tickets return `409`; the raw token is not returned. The action is written to `AuditLog` as `TICKET_REVOKED`.
- `GET /api/events/:eventId/attendees?page=1&pageSize=50` returns `{ attendees, pagination }`. Each attendee contains `id`, `firstName`, `lastName`, `attendeeType`, `attendanceIntent`, `registrationStatus`, `hasTicket`, `ticketStatus` (`ISSUED`, `USED`, `VOID`, or `null`), `checkedIn`, and `checkedInAt`. QR tokens and hashes are never included. Page size is 1–100.
- `GET /api/events/:eventId/tickets?page=1&pageSize=50` returns `{ tickets, pagination }`. Each ticket contains `id`, `attendeeId`, `attendeeName`, `ticketStatus`, `revoked` (true for `VOID`), `issuedAt`, `usedAt`, and `checkedInAt`. Tokens and hashes are never included.
- `POST /api/events/:eventId/tickets/:ticketId/reissue` and `POST /api/events/:eventId/tickets/:ticketId/revoke` are additive ticket-id variants of the attendee routes above; reissue returns the raw token with `Cache-Control: no-store`.
- `GET /api/events/:eventId/attendees`, `GET /api/events/:eventId/rsvps`, and `GET /api/events/:eventId/tickets` return a content-derived `ETag` plus `Cache-Control: private, max-age=0, must-revalidate`. Clients can poll with `If-None-Match`; unchanged lists return `304` with an empty body. ETags are hashed from the public response bodies only.

Ticket status meanings:

| Status | Meaning | Check-in | Reissue |
|---|---|---|---|
| `ISSUED` | Active, not scanned | Allowed | Allowed |
| `USED` | Successfully scanned | Rejected | Rejected |
| `VOID` | Cancelled or revoked | Rejected | Rejected |

`POST /api/tickets/checkin` requires an authenticated owner of the supplied event and JSON `{ "eventId": "<UUID>", "qrToken": "<single-use token>" }`. It atomically marks the ticket used and creates its check-in record. It returns a safe attendee summary and `checkedInAt`. Check-in takes the same per-event advisory lock as issuance, cancellation, and reissue, and its conditional update includes the token hash, so a rotated token cannot be consumed by an in-flight scan. Concurrent scans produce exactly one success; repeat scans return `409` with `already been checked in`. Unknown, wrong-event, and rotated tokens return `404`; cancelled registrations, void tickets, and ineligible attendees return distinct `409` messages. Successful check-ins and reissues write `AuditLog` entries (`TICKET_CHECKED_IN`, `TICKET_REISSUED`) containing the actor, event, non-secret ticket identifiers, and time; raw tokens are never persisted. For a short client transition, `qrCode` is accepted as an alias for `qrToken`, but its value must now be a server-issued token.

The former in-memory `GET /api/tickets/validate/:qrCode` route now returns 410 with migration guidance. Prototype tickets held only in process memory are not migrated or recognized. Raw tokens are intentionally not stored; a lost token is recovered through the owner-only reissue endpoint above, not by repeating idempotent issuance.

## RSVP cancellation

A reservation can be cancelled in two ways. Both set `status: CANCELLED` and `cancelledAt`, release the event's guest capacity, release the per-device reservation lock, and void still-unscanned tickets for that registration. Tickets already marked `USED` remain `USED` so check-in history is preserved.

- `POST /api/events/public/:slug/rsvp/cancel` is public and uses the confirmation token as a bearer credential: `{ "token": "<confirmationToken>" }`. It returns `200` with `{ "registration": { "id", "status", "cancelledAt" }, "voidedTickets": <number> }`. Unknown tokens return 404; cancelling twice returns 409.
- `POST /api/events/:eventId/rsvps/:registrationId/cancel` requires an authenticated owner of the event and returns the same shape. Foreign or missing registrations return 404.

The public event response's `event.hasReserved` is false again after cancellation, so the guest can reserve once more on the same event and device. Confirmation lookups continue to work for cancelled registrations so guests can see their status.

## Event lifecycle

Events move through `DRAFT` → `PUBLISHED` → `UNPUBLISHED` or a terminal state. Owner-only transitions:

- `POST /api/events/:id/publish` validates required fields and dates (see above).
- `POST /api/events/:id/unpublish` returns a published event to `UNPUBLISHED`.
- `POST /api/events/:id/cancel` moves any non-terminal event to `CANCELLED`, cancels its active registrations, and voids its still-unscanned tickets. Checked-in tickets remain `USED`. Repeat transitions and transitions from terminal states return `409`.
- `POST /api/events/:id/complete` moves a published event to `COMPLETED`.

All transitions re-check the status under the event advisory lock and use a conditional status update, so concurrent transitions cannot overwrite one another. Terminal events cannot be edited, published, transitioned again, or used for ticket issue/reissue/revoke/check-in. `DELETE /api/events/:id` soft-deletes the event.

## Operations

- `GET /health` is a static liveness probe. `GET /health/ready` checks database connectivity and returns `503` when the database is unreachable.
- Every response carries `X-Request-Id`; clients may supply a validated `X-Request-Id` header for correlation. Request logs include the ID and redact token-like query parameters and ticket path segments.
- Sensitive organizer actions are recorded in `AuditLog` with actor, event, action, timestamp, and safe metadata only: event create/update/publish/unpublish/cancel/complete/delete, RSVP decisions and cancellations, ticket issue/reissue/revoke/check-in, and upload signing. Raw QR and confirmation tokens are never written to audit records, and no ordinary route exposes or edits audit logs.
- `npm test` and `npm run test:safe` run the safe suite; CI runs typechecking, whitespace checks, and the safe suite. `npm run test:direct` bypasses the database guard and should only be used deliberately.

## Notes
See `API.md` for the consolidated route/auth/pagination contract. Authentication, event management, RSVP, ticket issuance, attendee listing, and ticket check-in use Prisma/PostgreSQL. The frontend RSVP and ticket-scanning flows are not verified as connected to these APIs. Existing QR-token delivery to guests is not implemented by this backend.
