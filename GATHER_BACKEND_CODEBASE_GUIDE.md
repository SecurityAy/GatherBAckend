# Gather Backend Codebase Guide

**Scope:** Source review of the checked-out `GatherBAckend` repository. This is not a production deployment or live database audit. No secrets are included.

## 1. Executive summary

Gather is a Node.js/TypeScript API using Express 4, Prisma 5, and PostgreSQL. It is a small modular monolith: auth, event and RSVP flows, persistent per-attendee tickets/check-ins, and an email notification outbox. `src/index.ts` starts the server and worker; `src/app.ts` wires middleware and routes. There are no separate controller or repository layers; route handlers invoke services, which use Prisma directly.

The most complete business flow is RSVP. Public submission validates input, serializes capacity and duplicate checks with PostgreSQL transaction advisory locks, stores one registration plus primary/additional attendee rows, and inserts notification jobs transactionally. Organisers list and decide registrations through owner-scoped routes. Capacity counts attendee rows for attending registrations in `PENDING` or `APPROVED`. Rejection releases capacity; cancellation statuses exist but no cancellation API is present.

Event CRUD/publishing and JWT auth are implemented. Graduate image upload uses signed Cloudinary parameters. Email uses an in-process Resend worker and PostgreSQL outbox. Ticket issuance and check-in now use Prisma models: tickets are issued per attendee only after an attending RSVP is approved, and the prior in-memory validation route is retired. There are no photo routes, audit-log writes, refresh tokens, email-verification flow, or durable external queue visible here. README says frontend RSVP is not connected.

## 2. Repository structure

- `src/index.ts`: entry point, listener, worker start, SIGINT/SIGTERM shutdown.
- `src/app.ts`: Express middleware, `/health`, API router mounting, 404/error middleware.
- `src/config/env.ts`: dotenv and configuration validation; optional Cloudinary/Resend/frontend settings.
- `src/lib/prisma.ts`: singleton `PrismaClient`.
- `src/middleware/auth.ts`: JWT verification, current-user lookup, active-account check; unused `requireOwnerOrSelf` helper.
- `src/middleware/errorHandler.ts`: `HttpError`, Zod/Prisma mapping, generic 500 and 404 responses.
- `src/modules/auth/`: registration, login, `/me` routes and service.
- `src/modules/events/`: `event.routes.ts`, `event.service.ts`, `rsvp.service.ts`, `capacity.service.ts`, `image-upload.service.ts`.
- `src/modules/notifications/`: outbox worker and email templates.
- `src/modules/tickets/`: persistent ticket issuance, attendee listing, and check-in (`ticket.service.ts`, `ticket.routes.ts`).
- `prisma/schema.prisma`, `prisma/migrations/`: PostgreSQL schema and four checked-in SQL migrations.
- `tests/rsvp.integration.test.ts`: five integration tests using Prisma and a local HTTP server.
- `scripts/run-safe-tests.js`: Neon database guard, client generation, migrations, then test run.
- `dist/`: TypeScript output (`tsconfig.json`); currently present and ignored.
- `.env.example`: variable names/placeholders. Actual ignored env files were not read.
- `README.md`: setup, RSVP, upload, notifications, testing, and known prototype notes.

There are no Render manifest, CI workflow, OpenAPI document, separate worker deployment, or controller/repository directories in the enumerated tree. `.vscode/` is untracked workspace content and not part of the backend design review.

## 3. Backend architecture

### Request lifecycle

`src/app.ts` trusts one proxy hop, configures CORS, JSON and URL-encoded parsing, Morgan `dev` request logs, `/health`, then `/api/auth`, `/api/events`, and `/api/tickets`. Not-found runs before the final error handler. Async route failures are passed to `next`. `src/index.ts` starts the notification worker after listening and stops it during shutdown.

Event public routes are registered before `eventRouter.use(requireAuth)`; all later event routes require a bearer token. Auth registration/login are public; `/me` is protected. The whole ticket router is protected.

### Validation, errors, logging

Zod validates auth, event create/update, pagination, RSVP/confirmation, decision body, image-signature body, and check-in input. Validation failures return 400 `{message, errors:[{path,message}]}`. `HttpError` returns its status and `{message}`. Prisma P2002 maps to 409. Other errors log the error name and return a generic 500. Morgan logs requests; no request IDs, metrics, tracing, or structured observability pipeline is visible. `/health` is a static liveness response, not a database readiness check.

### Notifications

`notification-outbox.service.ts` polls every five seconds. It claims jobs with `FOR UPDATE SKIP LOCKED`, sets a two-minute processing lease, and retries up to five times with exponential delay capped at one hour. Resend calls use outbox ID as idempotency key. The worker runs in each web process; DB row locking coordinates claims. If Resend config is absent, jobs are returned to pending and RSVP operations proceed.

## 4. Database model documentation

Prisma provider is PostgreSQL. `DATABASE_URL` is runtime URL and `DIRECT_URL` is the schema's direct connection URL. This section reflects schema and checked-in migrations, not live DB introspection.

### Models

- **User**: organiser/account, unique email, password hash, optional verification/profile image, account status and timestamps. Owns events, audit logs, check-ins. Event FK uses `Restrict`; audit actor uses `SetNull`.
- **Event**: owner, title/unique slug/category, graduate/institution details, date/timezone/venue/messages, image URLs, RSVP deadline, additional guest limit, nullable `maxGuestCapacity`, approval flag, status, publish and soft-delete timestamps. User FK `Restrict`; registrations/photos/audit logs. Index `[userId,deletedAt,eventStatus]`. Deletion is soft via `deletedAt`.
- **RSVPRegistration**: event, attendance intent, status, relationship, nullable unique confirmation token hash, approval/decline/cancel timestamps. Event FK `Restrict`; indexes `[eventId,status]` and `[eventId,attendanceIntent]`.
- **Attendee**: primary/additional attendee name and optional email/phone, linked to registration; optional one-to-one Ticket. Index `[registrationId,attendeeType]`. Partial unique index permits at most one PRIMARY per registration; SQL check requires primary email nonblank. Registration FK `Restrict`.
- **NotificationOutbox**: registration, type, recipient, JSON payload, status, attempt/retry/lease/error/delivery data. Registration deletion cascades. Unique `(registrationId,type)` and index `(status,nextRetryAt)`.
- **Ticket**: one unique attendee, unique 64-character QR hash, status and issue/use timestamps; optional one-to-one check-in; status index. `ticket.service.ts` stores only SHA-256 hashes of random tokens.
- **AttendanceCheckIn**: unique ticket check-in by user and timestamps; ticket/user FKs `Restrict`; index on check-in time. Persistent check-in uses a conditional ticket status update and creates this record in one transaction.
- **Photo**: event image URL, optional title, publish flag/timestamps; event FK `Restrict`; `(eventId,isPublished)` index. No photo API found.
- **AuditLog**: optional actor/event, action/details/time; both FKs `SetNull`; indexes by event/time and actor/time. No write path found.

### Enums and database rules

Enums: `AccountStatus` (`ACTIVE`, `SUSPENDED`, `DELETED`); `EventStatus` (`DRAFT`, `PUBLISHED`, `UNPUBLISHED`, `CANCELLED`, `COMPLETED`); `AttendanceIntent` (`ATTENDING`, `NOT_ATTENDING`); `RegistrationStatus` (`PENDING`, `APPROVED`, `DECLINED`, `CANCELLED`, `NOT_REQUIRED`); `AttendeeType` (`PRIMARY`, `ADDITIONAL`); `TicketStatus` (`ISSUED`, `USED`, `VOID`); notification type (organiser new RSVP, guest received/approved/declined) and status (`PENDING`, `PROCESSING`, `SENT`, `FAILED`).

Unique constraints include user email, event slug, nullable confirmation hash, attendee per ticket, QR hash, one check-in per ticket, and notification registration/type. Core relations generally restrict deletion; outbox cascades from registration; audit references set null. SQL check `RSVPRegistration_attendance_status_check` requires NOT_ATTENDING => NOT_REQUIRED and ATTENDING != NOT_REQUIRED. Capacity, minimum attendee count, additional guest limits, and approval transitions are application rules rather than DB constraints. `maxGuestCapacity` has no SQL nonnegative check; API Zod enforces it.

### Migration history

1. `20261110142200_init_gather_database`: core enums/tables/keys/indexes/FKs, primary attendee partial index, primary-email and intent/status checks.
2. `20261110152000_add_rsvp_relationship_and_confirmation_token`: relationship and unique nullable confirmation hash.
3. `20261114120000_add_notification_outbox`: outbox enums/table/indexes and cascading FK.
4. `20261115120000_add_event_guest_capacity`: nullable event capacity.

Migration files do not establish production application status. README says the initial migration has been applied; no live migration status was queried.

## 5. API endpoint inventory

All paths include mount prefixes. Standard validation errors are 400; auth errors 401, inactive account 403; unknown errors generic 500.

| Method / path | Auth | Inputs, purpose, responses and notable errors |
|---|---|---|
| `GET /health` | Public | Static `{status:"ok",service:"gather-backend"}`; no DB check. |
| `POST /api/auth/register` | Public; 5/IP/hour | `firstName`, `lastName` (2–100); email valid/max 254/lowercased; password min 8/max 72 UTF-8 bytes. 201 `{user,token}`; duplicate 409; validation 400; throttle 429. |
| `POST /api/auth/login` | Public; 10/IP/15 min | Email/password with same bounds. 200 `{user,token}`; bad credentials 401; inactive 403; 400/429. |
| `GET /api/auth/me` | Bearer | 200 `{user}` safe account fields; missing/invalid token 401; inactive 403. |
| `GET /api/events/public/:slug` | Public | Published nondeleted event; 200 `{event}` with public fields/capacity summary, internal ID omitted; missing 404. |
| `POST /api/events/public/:slug/rsvp` | Public; 5/IP/hour | Primary full name/email/phone, attendance intent, optional relationship/additional names. 201 `{confirmationToken,registration}`; 400 validation; 404 unavailable; 409 deadline/duplicate/capacity; 429 throttle. |
| `POST /api/events/public/:slug/rsvp/confirmation` | Public; 20/IP/15 min | `{token}` exactly 43 base64url chars. 200 `{confirmation}` safe selection; invalid token/event 404; malformed 400; 429 throttle. |
| `GET /api/events?page=&pageSize=` | Bearer | User's nondeleted events, page>=1 and pageSize 1–100 (defaults 1/20). Events + counts/capacity and pagination. |
| `POST /api/events` | Bearer | Strict event create body: title/category required; other fields optional and bounded in `event.service.ts`; slug normalized and collision-suffixed. 201 `{event}`, status DRAFT; invalid 400; exhausted slug 409. |
| `GET /api/events/:id` | Bearer + owner | Owned nondeleted event, dashboard counts/capacity; inaccessible 404. |
| `PATCH /api/events/:id` | Bearer + owner | Strict partial event fields, at least one key; terminal event blocked; capacity below reservations 409; validation 400. 200 `{event}`. |
| `POST /api/events/:id/publish` | Bearer + owner | Requires draft/unpublished, graduate name/date/valid IANA timezone/venue; 200 `{event}`; incomplete 400, bad state 409. |
| `POST /api/events/:id/unpublish` | Bearer + owner | Published only; 200 `{event}`; invalid state 409. |
| `DELETE /api/events/:id` | Bearer + owner | Soft delete; 200 `{event}`; missing 404. |
| `POST /api/events/:eventId/image-upload-signature` | Bearer + owner | Empty body, UUID event; signed Cloudinary upload params. 200 `{upload}`; invalid UUID 400, not found 404, config missing 500. |
| `GET /api/events/:eventId/rsvps?page=&pageSize=` | Bearer + owner | Paged registration list, pageSize 1–100/default 20; 200 `{registrations,pagination}`; inaccessible event 404. |
| `GET /api/events/:eventId/rsvps/:registrationId` | Bearer + owner | Registration and attendees; 200 `{registration}`; inaccessible/missing 404. |
| `POST /api/events/:eventId/rsvps/:registrationId/approve` | Bearer + owner | Empty strict body; pending attending only; 200 `{registration,tickets}`; newly issued tokens appear only in `tickets`; `Cache-Control: no-store`; 404 inaccessible; 409 wrong state/nonattending. |
| `POST /api/events/:eventId/rsvps/:registrationId/reject` | Bearer + owner | Empty strict body; pending only; 200 `{registration,tickets:[]}`; 404 inaccessible; 409 wrong state. |
| `POST /api/events/:eventId/tickets/issue` | Bearer + owner | Idempotently issues missing tickets for APPROVED+ATTENDING registrations. 200 `{tickets,issuedCount}`; returns raw token only for newly created tickets; inaccessible event 404. |
| `GET /api/events/:eventId/attendees?page=&pageSize=` | Bearer + owner | Paged attendee list with RSVP state, ticket presence, check-in state/time. Never returns token or hash. |
| `POST /api/tickets/checkin` | Bearer + event owner | JSON `{eventId,qrToken}` (legacy `qrCode` property accepted as alias). Atomically marks ticket USED and creates check-in. 200 safe attendee summary; unknown/wrong event 404; used/ineligible 409. |
| `GET /api/tickets/validate/:qrCode` | Bearer | Retired in-memory path; 410 migration message, request token redacted in Morgan log. |
| Any other route | N/A | 404 `{message:"Route not found: <originalUrl>"}`. |

No OpenAPI contract was found. Exact selection fields live in service Prisma selects and README. The backend repository has no frontend API client, so frontend endpoint usage cannot be comprehensively verified. README explicitly says RSVP frontend is not connected. README describes direct Cloudinary upload followed by event PATCH of `coverImageUrl`, but this is not proof of an active client call.

## 6. Complete feature inventory

- **Auth:** registration/login, bcrypt, JWT, `/me`. No password reset or email verification route.
- **Event management:** create/update, ownership, slug generation, list/detail/dashboard counts, publish/unpublish, soft delete. No route transitions status to CANCELLED/COMPLETED.
- **Invitation/public event:** Event public slug is invitation surface; only published/nondeleted events are publicly returned. No separate invitation model/send route.
- **RSVP/guests:** public submit and token lookup; organizer list/detail/approve/reject. Additional guests are Attendee rows on same registration, only names captured. No guest self-cancel/update endpoint.
- **Capacity:** nullable max means unlimited; finite max uses reserved attendee count. Event update checks new max against reservations.
- **Images:** Cloudinary signed direct upload; JPG/JPEG/PNG/WebP, server-generated folder/public ID, overwrite false, one-hour signature. 5 MiB field is client hint only. No upload proxy/photo CRUD found. Event image fields are URL-validated.
- **Email:** organiser and primary guest notified on RSVP; guest notified on decision. Outbox writes share transaction with RSVP state change. Additional guests are not emailed.
- **Tickets/check-in:** `Ticket` is one-to-one with each primary/additional `Attendee`. Only approved attending registrations qualify. Random 32-byte tokens are SHA-256 hashed in DB; approval and event-wide issuance use the event capacity advisory lock. Check-in updates `TicketStatus` conditionally and creates `AttendanceCheckIn` transactionally.
- **Photos/audit:** models exist, no routes or writes identified.

## 7. RSVP and capacity business logic

### Submission

`event.routes.ts` rate-limits and calls `submitRsvp`. `rsvp.service.ts` parses a strict schema: guest names must have two words, email lowercased, phone allowed characters and 7–15 digits, intent enum, up to 50 additional names. Additional names with NOT_ATTENDING are rejected. `findAcceptingEvent` requires PUBLISHED, nondeleted, and deadline in future.

The service creates 32 random bytes as base64url confirmation token and persists only SHA-256 hash. In a Prisma interactive transaction it takes a transaction-scoped PostgreSQL advisory lock keyed by event for capacity, then another keyed by event+primary email for duplicate suppression. It re-reads event publication/deadline, validates per-event additional limit, checks same primary email in previous five minutes, and checks capacity. Attending RSVP consumes `1 + additional names` spaces. A full event returns 409 with available and requested counts.

Attending starts PENDING when approval required, otherwise APPROVED. Not-attending becomes NOT_REQUIRED. Registration and PRIMARY/ADDITIONAL attendee rows are inserted together, then two notification jobs are enqueued. Transaction isolation is ReadCommitted, max wait 10 seconds, timeout 15 seconds. Response includes one-time token and selected registration; hash is excluded.

### Counting and decisions

`capacity.service.ts` counts attendees where registration event matches, intent ATTENDING and status PENDING or APPROVED. Pending therefore reserves capacity. DECLINED, CANCELLED and NOT_REQUIRED do not reserve. Rejecting PENDING changes to DECLINED and frees spaces; approval changes PENDING to APPROVED and preserves reservation. CANCELLED exists but no cancellation operation was found.

Approval/rejection transaction also takes event capacity lock; decision uses conditional `updateMany` requiring PENDING (and ATTENDING for approval), reads updated registration, enqueues notification before commit. Concurrent second decision loses the state predicate; P2002/P2034 mapped to 409. Event updates also take same capacity lock, recount, and reject a finite capacity lower than existing reservations. RSVP and capacity editing therefore serialize across these code paths.

### Limits and edge behavior

Capacity locks protect callers that use these service paths; no DB aggregate constraint protects against other writers bypassing service logic. No live concurrency run was performed. Additional guest limit and status transition rules are application-enforced. An attending registration always needs one slot for primary guest; capacity zero prevents it. NOT_ATTENDING still creates a primary attendee but consumes no capacity. Changing `approvalRequired` affects future submissions only; existing statuses are untouched. Public confirmation requires token/event slug and nondeleted event but does not require published status.

## 8. Authentication and authorisation

Registration lowercases email, checks case-insensitively, bcrypt-hashes at cost 12 and returns safe user projection plus seven-day HS256 token. Login compares password and checks active status. JWT contains subject user ID. `requireAuth` verifies Bearer format and HS256, reloads user, rejects missing/deactivated accounts, and attaches safe user fields. There is no refresh/revocation flow. Event, RSVP, and image service queries include owner ID and nondeleted event checks. There is no role/team membership model; `requireOwnerOrSelf` is unused.

## 9. Security and reliability assessment

### Confirmed source issues

1. **One-time QR token recovery:** the API returns random tokens to the authenticated event owner only when tickets are created. Hashes are irreversible, so a lost token cannot be recovered by retrying issuance; revoke/reissue is not implemented. Token-bearing approval/issuance responses are `Cache-Control: no-store`.
2. **Rate limits are per process:** registration/login/RSVP counters are in-memory and reset on restart; horizontal replicas do not share the limits.
3. **Image size is not hard-enforced by signature:** returned 5 MiB value is client-side metadata. README says configure Cloudinary account Usage Limits for a hard cap.
4. **Health is liveness only:** `/health` always returns ok without database/provider readiness.
5. **Feature mismatch:** Photo and AuditLog models still have no corresponding routes/writes; ticket/check-in now use Prisma persistently.

### Deployment-dependent risks / unknowns

- `JWT_SECRET` minimum length and production `CORS_ORIGINS` are startup validated; actual Render values were not inspected. `.env` and `.env.test.local` values were not read.
- `DIRECT_URL` appears in Prisma schema/example but runtime config validator explicitly validates `DATABASE_URL` only.
- `trust proxy=1` assumes exactly one upstream proxy; README documents adjustment for extra proxies/CDN.
- Email verification timestamp exists, but no verification flow or requirement exists in code; intended account policy is unknown.
- Public confirmation reveals attendee names/event details to possession of a high-entropy token. Primary email/phone are not selected. Retention policy unknown.
- Capacity and guest limit are application rules; other DB writers can bypass locks.
- Outbox has retries and leases but no retention/operations endpoint identified.
- CORS is browser-origin control, not API authentication. Production allowlist correctness is unknown.
- No production config, live database, penetration test or Cloudinary account policy was examined.

## 10. Testing and build instructions

`package.json` scripts: `npm run dev` (tsx watch), `npm run build` (TypeScript compile to `dist`), `npm test` (Node test runner on integration file), `npm run test:safe`, `npm start` (`node dist/index.js`), `npm run prisma:generate`, `npm run prisma:migrate` (`migrate dev`).

Five integration tests cover public RSVP validation/persistence/confirmation/ownership/throttle; capacity and concurrent submits/updates; organiser decisions plus ticket issuance, owner access, check-in and token redaction; image signatures; Resend configuration, email templates and outbox behavior. They use PostgreSQL/Prisma, not mocked persistence. The safe runner validated both test URLs as Neon `gather_rsvp_test`, generated Prisma Client, found no pending migrations, and ran the suite. All five tests passed. `npm run build` passed. The suite uses only the disposable test database; production DB/config was not accessed.

No separate unit test suite was found. Untested/unclear areas include photo/audit, profile, full publish/update/delete route behaviors, multi-process rate limits, production provider failures, and operational deployment. Ticket flows are covered by the RSVP integration test against the disposable test DB.

## 11. Deployment overview

README identifies Render and Supabase PostgreSQL. Prisma uses `DATABASE_URL` and `DIRECT_URL`; exact pooler/direct setup is not independently verified. Build is `tsc -p tsconfig.json`; production start is `node dist/index.js` (`npm start`). Required environment variable names: `JWT_SECRET` (>=32 chars), `DATABASE_URL`, production `CORS_ORIGINS`; Prisma schema also references `DIRECT_URL`. Optional names: `PORT`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FRONTEND_URL`. Values omitted.

No Render manifest/dashboard was inspected. Actual Render build/start/health settings, instance count, proxy chain, environment configuration and release migration process are unknown. App exposes `GET /health`, but no manifest config was found. Worker runs in web process. Safe test runner uses `migrate deploy` only for disposable Neon test DB; no automatic production migration config was found. Checked-in migrations do not prove production DB state.

## 12. Known issues and technical debt

1. Lost QR tokens cannot be recovered because only hashes are stored; token revocation/reissue and guest delivery remain unimplemented.
2. Auth and RSVP throttles are process-local.
3. README says frontend RSVP flow is not connected; frontend source was unavailable.
4. No Photo, AuditLog, profile, guest self-cancel, or event cancellation/completion routes were found.
5. `CANCELLED` statuses/timestamps exist without transition APIs.
6. Upload size cap requires provider-level enforcement.
7. No OpenAPI spec or separate unit-test suite.
8. No Render manifest, CI workflow or migration release runbook in repository.
9. Notification worker is coupled to web process; no backlog/failed-job visibility or cleanup policy found.
10. Schema capabilities exceed implemented routes.

## 13. Questions or uncertainties requiring investigation

- Which frontend repository consumes this API and which routes are actively called?
- What are current Render build/start/health settings, proxy topology, and replica count?
- What is production migration status and release procedure using `DIRECT_URL`?
- Is Cloudinary account usage capped to intended file-size maximum?
- How are failed email jobs, retention, and sender verification operated?
- Is email verification intended, given `emailVerifiedAt` but no flow?
- Are event cancellation, RSVP cancellation, ticketing/check-in, photos, and audit planned or scaffold-only?
- What RSVP PII/outbox retention policy applies?
- Are per-instance rate limits acceptable at current deployment scale?

## Priority files for future changes

- `src/modules/events/rsvp.service.ts` — RSVP validation, token, attendee creation, reservation checks, decisions, notifications.
- `src/modules/events/capacity.service.ts` — canonical lock key and reservation count; capacity-related writers must coordinate here.
- `src/modules/events/event.service.ts` — CRUD, publish rules, ownership, dashboard counts, capacity edits.
- `src/modules/events/event.routes.ts` — public/auth route boundary, schemas and rate limits.
- `src/modules/auth/auth.service.ts`, `src/middleware/auth.ts` — credential/token handling and active user check.
- `prisma/schema.prisma`, `prisma/migrations/*` — persistence contract and history.
- `src/modules/notifications/notification-outbox.service.ts` — job claim, retry and delivery.
- `tests/rsvp.integration.test.ts`, `scripts/run-safe-tests.js` — behavior examples and test DB guardrails.
- `src/app.ts`, `src/config/env.ts`, `src/middleware/errorHandler.ts` — wiring/config/error contract.
