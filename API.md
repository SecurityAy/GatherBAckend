# Gather Backend API contract

Base URL: `/api`. All bodies are JSON. Errors use `{ "message": string }`; validation errors add `errors: [{ path, message }]`. Successful token-bearing responses set `Cache-Control: no-store`.

## Authentication and identity

| Route | Auth | Notes |
|---|---|---|
| `POST /auth/register` | Public | Rate limited. Returns safe user fields and a seven-day bearer token. |
| `POST /auth/login` | Public | Rate limited. Returns safe user fields and a bearer token. |
| `GET /auth/me` | Bearer | Returns the current safe user projection. |

Organizer routes require `Authorization: Bearer <token>` and are scoped to events owned by that user. Guest self-service uses a long-lived confirmation credential in the request body; it is not an account login and remains usable until the registration is cancelled.

Public RSVP submissions are identified by the signed httpOnly `gather_device` cookie, with an `X-Device-Id` header as the initial/fallback identifier. Raw device IDs are stored only as SHA-256 hashes.

## Public event routes

| Route | Body | Success |
|---|---|---|
| `GET /events/public/:slug` | — | Public event fields, capacity, and `hasReserved`. |
| `POST /events/public/:slug/rsvp` | `primaryGuestName`, `primaryGuestEmail`, `primaryGuestPhone`, `attendanceIntent`, optional `relationshipToGraduate`, `additionalGuestNames` | `201` with registration, confirmation token, and newly issued tickets. |
| `POST /events/public/:slug/rsvp/confirmation` | `{ token }` | `200` with safe confirmation details. |
| `POST /events/public/:slug/rsvp/cancel` | `{ token }` | `200` with cancellation and voided-ticket count. |

RSVP and confirmation routes are rate limited. A cancelled registration releases capacity and the device reservation, and voids only still-unscanned tickets.

## Organizer event routes

All routes below require a bearer token and owner-scoped event access.

| Route | Body / query | Success |
|---|---|---|
| `GET /events` | `page`, `pageSize` | Event list with counts (including `checkedInCount`), capacity, and pagination. |
| `POST /events` | Event fields | `201` with a draft event. |
| `GET /events/:id` | — | Event details with counts (including `checkedInCount`) and capacity. |
| `PATCH /events/:id` | Any supported event field | `200`; cannot lower capacity below reservations or set invalid published-event dates. |
| `POST /events/:id/publish` | Empty | `200`; validates required fields, IANA timezone, future dates, and deadline order. |
| `POST /events/:id/unpublish` | Empty | `200`. |
| `POST /events/:id/cancel` | Empty | `200`; cancels active registrations and voids unscanned tickets. |
| `POST /events/:id/complete` | Empty | `200` from `PUBLISHED`. |
| `DELETE /events/:id` | — | `200`; soft delete. |
| `POST /events/:eventId/image-upload-signature` | Empty | `200` with one-hour signed Cloudinary fields and an advisory 5 MiB client size hint; enforce the hard cap in Cloudinary account settings. |

Terminal events (`CANCELLED`, `COMPLETED`) reject edits, further transitions, and ticket operations.

## Organizer RSVP routes

| Route | Body / query | Success |
|---|---|---|
| `GET /events/:eventId/rsvps` | `page`, `pageSize` | Registration list with pagination. |
| `GET /events/:eventId/rsvps/:registrationId` | — | Registration and attendee details. |
| `POST /events/:eventId/rsvps/:registrationId/approve` | Empty | `200` with registration and newly issued tickets. |
| `POST /events/:eventId/rsvps/:registrationId/reject` | Empty | `200` with registration and an empty tickets array. |
| `POST /events/:eventId/rsvps/bulk-approve` | `{ registrationIds: string[] }` (1–100 UUIDs) | `200` with `{ results: [{ registrationId, ok, status?, tickets?, error? }] }`; token-bearing response uses `Cache-Control: no-store`. |
| `POST /events/:eventId/rsvps/bulk-decline` | `{ registrationIds: string[] }` (1–100 UUIDs) | `200` with `{ results: [{ registrationId, ok, status?, error? }] }`. |
| `POST /events/:eventId/rsvps/:registrationId/cancel` | Empty | `200` with cancellation and voided-ticket count. |

Only `PENDING` registrations can be approved or rejected. Approval requires `ATTENDING`. Foreign or missing registrations return `404`; invalid state transitions return `409`.

Bulk actions apply the same single-registration decision service once per id in a separate transaction, so a bad id does not roll back the batch. Each result reports `ok`, the resulting `status` when successful, and either `tickets` (approve only) or a short `error`. Capacity is rechecked per registration; later approvals fail explicitly if the event fills mid-batch.

## Ticket routes

| Route | Auth | Success |
|---|---|---|
| `GET /events/:eventId/attendees` | Bearer, owner | Paginated safe attendee rows including `ticketStatus`, `checkedIn`, and `checkedInAt`; never tokens. |
| `GET /events/:eventId/tickets` | Bearer, owner | Paginated safe ticket rows including `ticketStatus`, `revoked`, `checkedInAt`, and `attendeeName`; never tokens. |
| `GET /events/:eventId/audit` | Bearer, owner | `page`, `pageSize`; `{ entries: [{ id, action, actorId, eventId, details, createdAt }], pagination }`, newest first. |
| `GET /events/:eventId/rsvps` | Bearer, owner | Paginated registrations. |
| `POST /events/:eventId/tickets/issue` | Bearer, owner | Issues missing eligible tickets; new raw `qrToken` values are returned only here. |
| `POST /events/:eventId/attendees/:attendeeId/tickets/reissue` | Bearer, owner | Rotates the token; the old token stops working immediately. |
| `POST /events/:eventId/attendees/:attendeeId/tickets/revoke` | Bearer, owner | Permanently voids an unscanned ticket. |
| `POST /events/:eventId/tickets/:ticketId/reissue` | Bearer, owner | Additive ticket-id variant; rotates the token and returns `{ attendeeId, ticketId, qrToken }` with `Cache-Control: no-store`. |
| `POST /events/:eventId/tickets/:ticketId/revoke` | Bearer, owner | Additive ticket-id variant; returns `{ attendeeId, ticketId, ticketStatus: "VOID" }`. |
| `POST /tickets/checkin` | Bearer, owner of `eventId` | Atomically marks an `ISSUED` ticket `USED` and creates one check-in. |
| `GET /tickets/validate/:qrCode` | Bearer | Retired; always `410`. |

`ticketStatus` values: `ISSUED` (active), `USED` (checked in), `VOID` (cancelled/revoked). Check-in, reissue, and revocation are serialized by a per-event advisory lock and write `AuditLog` records without raw tokens.

`GET /events/:eventId/attendees`, `GET /events/:eventId/rsvps`, `GET /events/:eventId/tickets`, and `GET /events/:eventId/audit` return a content-derived `ETag` and `Cache-Control: private, max-age=0, must-revalidate`. Clients may poll with `If-None-Match`; an unchanged list returns `304 Not Modified` with an empty body. ETags are hashes of the public response bodies only and never contain tokens.

## Health

| Route | Meaning |
|---|---|
| `GET /health` | Liveness; always `200` when the process can respond. |
| `GET /health/ready` | Database readiness; `200` or `503`. |

Every response carries `X-Request-Id`; incoming `X-Request-Id` values are validated before being echoed and logged.
