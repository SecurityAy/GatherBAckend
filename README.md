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
5. Apply reviewed migrations to your own database: `npx prisma migrate deploy` (use `npm.cmd exec -- prisma migrate deploy` on Windows; production requires an explicit backup and deployment step)
6. Start the API: `npm run dev`

The initial Prisma migration has been applied to the configured Supabase database. Review migration SQL before preparing future migrations; this work did not apply any migration to production.

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
- `POST /api/events/:eventId/rsvps/bulk-approve` and `POST /api/events/:eventId/rsvps/bulk-decline` accept `{ "registrationIds": ["<uuid>", ...] }` (1–100 ids). They apply the single-registration decision path once per id in its own transaction and return `{ "results": [{ "registrationId", "ok", "status"?, "tickets"?, "error"? }] }`. One failure does not roll back the rest of the batch, and capacity is rechecked for every approval. Bulk-approve responses contain raw QR tokens and use `Cache-Control: no-store`.
- All routes above require a bearer access token. The RSVP list/detail and decision routes return `404` for an event or registration the authenticated organiser cannot access.
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

RSVP creation and organiser decisions write idempotent notification jobs to the PostgreSQL outbox in the same transaction as the RSVP change. A background worker sends six transactional notification types through Resend and retries transient failures up to five attempts: `ORGANISER_NEW_RSVP`, `GUEST_RSVP_RECEIVED`, `GUEST_RSVP_APPROVED`, `GUEST_RSVP_DECLINED`, `PASSWORD_RESET`, and `TICKET_DELIVERY`. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, use a two-minute lease and a Resend `Idempotency-Key`, and expose failures through `NotificationOutbox.status`, `attemptCount`, and `lastError`. Without `RESEND_API_KEY`, jobs remain pending and RSVP operations continue normally. Configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in the backend environment; the default sender is `onboarding@resend.dev`, which Resend restricts to verified test recipients. `FRONTEND_URL` is optional and is used only to form public invitation, password reset, and ticket links. Additional guests are not emailed individually; the primary ticket is included in the primary guest's approval/RSVP email. Raw `qrToken`, `resetUrl`, `ticketUrl`, and other token-like payload fields are redacted after a successful send, and reset tokens are single-use.

The worker can run in the web process (the default) or as a separate deployment. For separate workers, set `EMAIL_WORKER_IN_WEB=false` on the web service and run `npm run worker` locally or `npm run start:worker` from the built output. Multiple worker instances can safely share the outbox because claims are row-locked and delivery is idempotent. `EMAIL_WORKER_IN_WEB=true|false` is validated at startup.

New optional environment variables:

- `PASSWORD_RESET_URL` — absolute HTTP(S) URL of the frontend reset page. The backend appends `?token=<resetToken>` (or `&token=` when a query string is present). If unset, it falls back to `${FRONTEND_URL}/reset-password`; if both are unset, forgot-password requests still return the generic response but no email is queued.
- `PASSWORD_RESET_TTL_MINUTES` — integer reset-link lifetime from 5 to 1440 minutes; default `60`. A new request replaces the outstanding token and supersedes any queued reset email for that user.

`emailNotifications` is stored as a user preference but does not suppress security messages (password reset or ticket delivery). `locale` is stored for future i18n; email copy is currently English only.

For safe local integration tests, put the disposable Neon test database URLs in ignored `.env.test.local` and run `npm run test:safe`. The runner validates both URLs point to Neon database `gather_rsvp_test`, applies migrations to that database, then runs the suite. It requires no production `.env` database fallback. Production migrations are not applied by this runner or by Vercel; run `prisma migrate deploy` with production `DATABASE_URL` and `DIRECT_URL` as a separate deployment step. The `20261121130000_enforce_rsvp_duplicate_rules` migration requires PostgreSQL 14+ for `sha256()` and the `btree_gist` extension.

## Migration runbook and rollback

No migration in this work was applied to production. Apply only after a verified database backup, with the email worker stopped or drained, and with the previous application version ready to redeploy if rollback is needed.

Pending account/delivery migrations, in order:

1. `20261122120000_add_account_notification_types` appends `PASSWORD_RESET` and `TICKET_DELIVERY` to the `NotificationType` enum used by `NotificationOutbox.type`.
2. `20261122121000_add_account_self_service_and_ticket_delivery` creates the `TicketDeliveryStatus` enum; adds `User.passwordResetTokenHash` (`CHAR(64)`, unique index `User_passwordResetTokenHash_key`), `User.passwordResetExpiresAt`, `User.emailNotifications` (default `true`), and `User.locale` (default `en`); makes `NotificationOutbox.registrationId` nullable, adds `userId`, `ticketId`, and `dedupeKey`, adds cascade FKs `NotificationOutbox_userId_fkey` and `NotificationOutbox_ticketId_fkey`, the unique index `NotificationOutbox_dedupeKey_type_key`, and indexes `NotificationOutbox_userId_type_idx` / `NotificationOutbox_ticketId_type_idx` while retaining `NotificationOutbox_registrationId_type_key`; and adds `Ticket.deliveryStatus` (default `NOT_SENT`), `lastDeliveryAt`, `deliveryAttempts`, and `lastDeliveryError`.

Rollback order: deploy the previous application version first, keep the backup, then roll back `20261122121000...` with SQL equivalent to:

```sql
DELETE FROM "NotificationOutbox"
WHERE "userId" IS NOT NULL OR "ticketId" IS NOT NULL OR "dedupeKey" IS NOT NULL
   OR "type" IN ('PASSWORD_RESET', 'TICKET_DELIVERY');
ALTER TABLE "NotificationOutbox" DROP CONSTRAINT IF EXISTS "NotificationOutbox_ticketId_fkey";
ALTER TABLE "NotificationOutbox" DROP CONSTRAINT IF EXISTS "NotificationOutbox_userId_fkey";
DROP INDEX IF EXISTS "NotificationOutbox_ticketId_type_idx";
DROP INDEX IF EXISTS "NotificationOutbox_userId_type_idx";
DROP INDEX IF EXISTS "NotificationOutbox_dedupeKey_type_key";
ALTER TABLE "NotificationOutbox"
  DROP COLUMN IF EXISTS "dedupeKey", DROP COLUMN IF EXISTS "ticketId", DROP COLUMN IF EXISTS "userId",
  ALTER COLUMN "registrationId" SET NOT NULL;
ALTER TABLE "Ticket"
  DROP COLUMN IF EXISTS "lastDeliveryError", DROP COLUMN IF EXISTS "deliveryAttempts",
  DROP COLUMN IF EXISTS "lastDeliveryAt", DROP COLUMN IF EXISTS "deliveryStatus";
DROP TYPE IF EXISTS "TicketDeliveryStatus";
DROP INDEX IF EXISTS "User_passwordResetTokenHash_key";
ALTER TABLE "User"
  DROP COLUMN IF EXISTS "locale", DROP COLUMN IF EXISTS "emailNotifications",
  DROP COLUMN IF EXISTS "passwordResetExpiresAt", DROP COLUMN IF EXISTS "passwordResetTokenHash";
```

The `DELETE` removes queued password-reset/ticket-delivery messages because those rows have no registration id and cannot satisfy the restored `NOT NULL` constraint. PostgreSQL cannot remove enum values added with `ALTER TYPE ... ADD VALUE`; the safe rollback for `20261122120000...` is to leave `PASSWORD_RESET` and `TICKET_DELIVERY` present but unused. Removing them requires recreating `NotificationType` after ensuring no rows use them and the worker is stopped, so it is not part of the automatic rollback.

The earlier device migrations are already in the repo and follow the same backup-first rule. `20261121120000_add_rsvp_device_hashes` adds `RSVPRegistration.deviceCookieHash` / `deviceClientHash` (`CHAR(64)`) and indexes `RSVPRegistration_eventId_deviceCookieHash_idx` / `RSVPRegistration_eventId_deviceClientHash_idx`. `20261121130000_enforce_rsvp_duplicate_rules` requires PostgreSQL 14+ and `btree_gist`, backfills `primaryEmailHash`, adds the exclusion constraint `RSVPRegistration_event_email_five_minute_excl` for active same-event/same-email rows within five minutes, and partial unique indexes `RSVPRegistration_eventId_deviceCookieHash_active_key` / `RSVPRegistration_eventId_deviceClientHash_active_key`. Before applying it, check for conflicting active rows; the migration will fail rather than silently merge them. To roll back, redeploy the earlier app, drop the two partial unique indexes and exclusion constraint, drop `primaryEmailHash`, then optionally drop the device hash columns and their indexes; leave the `btree_gist` extension installed.

## Account self-service and password recovery

All routes below are under `/api/me` except the auth routes, require a bearer token where indicated, return `X-Request-Id`, and set `Cache-Control: no-store`.

- `POST /api/auth/forgot-password` with `{ "email": "..." }` always returns `200` with the same message, so callers cannot enumerate accounts. For an active account it stores only a SHA-256 hash of a random token, expires it after `PASSWORD_RESET_TTL_MINUTES`, and upserts one `PASSWORD_RESET` job keyed by user. A second request invalidates the earlier token and replaces the queued email.
- `POST /api/auth/reset-password` with `{ "token": "...", "password": "..." }` consumes the token in a conditional update, bcrypt-hashes the new password, clears all password-reset jobs for the user, and returns `200`. Invalid or expired tokens return `400`.
- `PATCH /api/auth/me` updates `firstName`, `lastName`, and/or `email` and returns the same safe user projection as registration/login. An email already used by another account returns `409`; changing the email also clears any outstanding reset token.
- `POST /api/auth/change-password` verifies `currentPassword`, rejects an unchanged `newPassword`, replaces the bcrypt hash, and clears reset jobs. It does not revoke already-issued bearer tokens; JWTs have no per-token version and expire after seven days.
- `GET /api/me/data-export` returns `{ exportedAt, user, events, registrations, checkIns, auditLogs }` with safe fields only. It includes owned events and registrations tied to those events or to the account's email; tokens, password hashes, and QR hashes are excluded.
- `DELETE /api/me` sets `accountStatus: DELETED`, anonymizes the profile and password hash, clears reset state, and soft-deletes owned events. It is a soft/anonymizing deletion: event, registration, attendee, and audit history is retained for integrity, and guest RSVP rows are not rewritten. JWTs cannot be revoked individually, but `requireAuth` checks account status on every request, so existing tokens receive `403` after deletion.
- `GET /api/me/preferences` and `PUT /api/me/preferences` read/update `{ emailNotifications, locale }`. `locale` accepts short tags such as `en` or `en-GB`.

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
- `POST /api/events/:eventId/tickets/:ticketId/resend-email` requires an empty body and an `APPROVED`, `ATTENDING`, unscanned ticket in an active owned event. It rotates the token (invalidating earlier email links), resets delivery state to `NOT_SENT`, and upserts one `TICKET_DELIVERY` job using `ticket-delivery:<ticketId>` as the dedupe key. The response contains only `{ ticketId, attendeeId, deliveryStatus, message }` with `Cache-Control: no-store`; the raw token is delivered only to the email worker. The email uses a token link under `${FRONTEND_URL}/tickets?token=...`; no QR image is generated.
- `GET /api/events/:eventId/attendees`, `GET /api/events/:eventId/rsvps`, `GET /api/events/:eventId/tickets`, and `GET /api/events/:eventId/audit` return a content-derived `ETag` plus `Cache-Control: private, max-age=0, must-revalidate`. Clients can poll with `If-None-Match`; unchanged lists return `304` with an empty body. ETags are hashed from the public response bodies only.

Ticket status meanings:

| Status | Meaning | Check-in | Reissue |
|---|---|---|---|
| `ISSUED` | Active, not scanned | Allowed | Allowed |
| `USED` | Successfully scanned | Rejected | Rejected |
| `VOID` | Cancelled or revoked | Rejected | Rejected |

Ticket list rows also include `deliveryStatus` (`NOT_SENT`, `SENT`, `FAILED`), `lastDeliveryAt`, `deliveryAttempts`, and `lastDeliveryError`. Delivery status is updated by the worker only for `TICKET_DELIVERY` jobs and is reset to `NOT_SENT` whenever a token is rotated by reissue or resend. Reissue rewrites any already queued delivery or approval email with the new token so a stale link is never emailed. The primary guest's ticket is embedded in `GUEST_RSVP_RECEIVED`/`GUEST_RSVP_APPROVED` emails as a `ticketUrl` token link.

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
- Sensitive organizer actions are recorded in `AuditLog` with actor, event, action, timestamp, and safe metadata only: event create/update/publish/unpublish/cancel/complete/delete, RSVP decisions and cancellations, ticket issue/reissue/revoke/check-in, and upload signing. Raw QR and confirmation tokens are never written to audit records. `GET /api/events/:eventId/audit?page=1&pageSize=20` is a read-only, owner-scoped view (`pageSize` max 100) that returns `entries` and `pagination` with `details` exactly as stored; audit rows cannot be edited through the API.
- `npm test` and `npm run test:safe` run the safe suite; CI runs typechecking, whitespace checks, and the safe suite. `npm run test:direct` bypasses the database guard and should only be used deliberately.

## Deployment smoke tests

Use disposable accounts and events after a successful migration/deploy:

1. `GET /health/ready` returns `200` and responses carry `X-Request-Id`.
2. `POST /api/auth/forgot-password` with a known test account returns the generic `200` message; the `PASSWORD_RESET` outbox job reaches `SENT` when Resend is configured, the emailed link works once, and login with the new password succeeds. Repeating the forgot request invalidates the first link.
3. `PATCH /api/auth/me`, `POST /api/auth/change-password`, `GET/PUT /api/me/preferences`, and `GET /api/me/data-export` return safe fields; after `DELETE /api/me`, the old bearer token receives `403`.
4. Approve a test RSVP (or submit an auto-approval event) and confirm the primary guest's email contains one ticket link. `POST /api/events/:eventId/tickets/:ticketId/resend-email` returns `no-store`, rotates the token, sends a new link, and marks the ticket `SENT`; the older link no longer checks in.
5. Poll `GET /api/events/:eventId/tickets` with its `ETag` in `If-None-Match`; an unchanged list returns `304`.
6. Confirm token-bearing responses set `Cache-Control: no-store` and that no raw token appears in `AuditLog`, outbox payloads after delivery, application logs, or API responses for resend/data export.

## Notes
See `API.md` for the consolidated route/auth/pagination contract. Authentication, event management, RSVP, ticket issuance, attendee listing, ticket check-in, account self-service, and ticket email delivery use Prisma/PostgreSQL. The frontend RSVP and ticket-scanning flows are not verified as connected to these APIs. QR image generation and group QR/photo delivery remain deferred; the backend sends a secure token link for the primary ticket.
