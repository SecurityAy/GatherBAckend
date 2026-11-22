# Gather Backend Codebase Guide

**Scope:** Source review of the checked-out `GatherBAckend` repository. This is not a production deployment or live database audit. No secrets are included.

## 1. Executive summary

Gather is a Node.js/TypeScript API using Express 4, Prisma 5, and PostgreSQL. It is a small modular monolith: auth, event and RSVP flows, persistent per-attendee tickets/check-ins, and an email notification outbox. `src/index.ts` starts the server and optionally the worker; `src/worker.ts` provides a standalone worker entrypoint; `src/app.ts` wires middleware and routes. There are no separate controller or repository layers; route handlers invoke services, which use Prisma directly.

The most complete business flow is RSVP. Public submission validates input, serializes capacity and duplicate checks with PostgreSQL transaction advisory locks, stores one registration plus primary/additional attendee rows, and inserts notification jobs transactionally. Organisers list and decide registrations through owner-scoped routes. Capacity counts attendee rows for attending registrations in `PENDING` or `APPROVED`. Rejection and cancellation release capacity; cancellation is available through guest-token and organiser routes.

Event CRUD/publishing and JWT auth are implemented. Dashboard and event detail counts include `checkedInCount`, aggregated from tickets with check-in rows. Organizer attendees, RSVP, and ticket lists return content-derived ETags for flicker-free polling. Publishing now requires a valid IANA timezone, future event date and RSVP deadline, with the deadline before the event. Graduate image upload uses signed Cloudinary parameters and returns a 5 MiB advisory client size hint; Cloudinary has no signed file-size upload parameter, so the account-level cap is the hard limit. Email uses a Resend outbox worker that can run in the web process or as a separate deployment. Ticket issuance and check-in use Prisma models: tickets are issued per attendee only after an attending RSVP is approved, and the prior in-memory validation route is retired. Check-in and reissue are serialized by the event advisory lock and write audit records. Terminal event transitions (`cancel`, `complete`) and owner ticket revocation are available. Email verification is deliberately not implemented or enforced; the legacy `emailVerifiedAt` column is not exposed. README says frontend RSVP is not connected.

## 2. Repository structure

- `src/index.ts`: entry point, listener, worker start, SIGINT/SIGTERM shutdown.
- `src/app.ts`: Express middleware, `/health`, API router mounting, 404/error middleware.
- `src/config/env.ts`: dotenv and configuration validation; optional Cloudinary/Resend/frontend settings.
- `src/lib/prisma.ts`: singleton `PrismaClient`.
- `src/middleware/auth.ts`: JWT verification, current-user lookup, active-account check.
- `src/middleware/errorHandler.ts`: `HttpError`, Zod/Prisma mapping, generic 500 and 404 responses; logs Prisma codes without credentials.
- `src/middleware/rateLimit.ts`: shared bounded fixed-window limiter keyed by route, client IP, or authenticated user.
- `src/modules/auth/`: registration, login, `/me` routes and service.
- `src/modules/events/`: `event.routes.ts`, `event.service.ts`, `rsvp.service.ts`, `capacity.service.ts`, `image-upload.service.ts`.
- `src/modules/notifications/`: outbox worker and email templates.
- `src/modules/tickets/`: persistent ticket issuance, attendee listing, and check-in (`ticket.service.ts`, `ticket.routes.ts`).
- `prisma/schema.prisma`, `prisma/migrations/`: PostgreSQL schema and six checked-in SQL migrations.
- `tests/rsvp.integration.test.ts`: fourteen integration tests using Prisma and a local HTTP server.
- `scripts/run-safe-tests.js`: Neon database guard, client generation, migrations, then test run.
- `dist/`: TypeScript output (`tsconfig.json`); currently present and ignored.
- `.env.example`: variable names/placeholders. Actual ignored env files were not read.
- `README.md`: setup, RSVP, upload, notifications, testing, and known prototype notes.

There is a GitHub Actions CI workflow, an `API.md` route contract, and a standalone worker entrypoint; there is no generated OpenAPI document or Render manifest. `.vscode/` is untracked workspace content and not part of the backend design review.

## 3. Backend architecture

### Request lifecycle

`src/app.ts` trusts one proxy hop, adds security headers and request IDs, configures CORS with credentialed device cookies, parses JSON/URL-encoded bodies, writes redacted Morgan logs, exposes `/health` and `/health/ready`, then mounts `/api/auth`, `/api/events`, and `/api/tickets`. Not-found runs before the final error handler. Async route failures are passed to `next`. `src/index.ts` starts the notification worker after listening when `EMAIL_WORKER_IN_WEB=true` and stops it during shutdown.

Event public routes are registered before `eventRouter.use(requireAuth)`; all later event routes require a bearer token. Auth registration/login are public; `/me` is protected. The whole ticket router is protected.

### Validation, errors, logging

Zod validates auth, event create/update, pagination, RSVP/confirmation, decision body, image-signature body, and check-in input. Validation failures return 400 `{message, errors:[{path,message}]}`. `HttpError` returns its status and `{message}`. Prisma P2002 maps to 409. Other errors log the request ID, error name, and safe Prisma code, then return a generic 500 without a stack trace or database details. Morgan logs redacted URLs and a request ID; `/health` is liveness and `/health/ready` performs a database round trip. Metrics and structured tracing are not implemented.

### Notifications

`notification-outbox.service.ts` polls every five seconds. It claims jobs with `FOR UPDATE SKIP LOCKED`, sets a two-minute processing lease, and retries up to five times with exponential delay capped at one hour. Resend calls use outbox ID as idempotency key. The worker runs in the web process by default, or in a separate `src/worker.ts` process when `EMAIL_WORKER_IN_WEB=false`; DB row locking coordinates claims across instances. If Resend config is absent, jobs are returned to pending and RSVP operations proceed.

## 4. Database model documentation

Prisma provider is PostgreSQL. `DATABASE_URL` is runtime URL and `DIRECT_URL` is the schema's direct connection URL. This section reflects schema and checked-in migrations, not live DB introspection.

### Models

- **User**: organiser/account, unique email, password hash, optional verification/profile image, account status and timestamps. Owns events, audit logs, check-ins. Event FK uses `Restrict`; audit actor uses `SetNull`.
- **Event**: owner, title/unique slug/category, graduate/institution details, date/timezone/venue/messages, image URLs, RSVP deadline, additional guest limit, nullable `maxGuestCapacity`, approval flag, status, publish and soft-delete timestamps. User FK `Restrict`; registrations/photos/audit logs. Index `[userId,deletedAt,eventStatus]`. Deletion is soft via `deletedAt`.
- **RSVPRegistration**: event, attendance intent, status, relationship, nullable unique confirmation token hash, normalized primary-email hash, nullable device cookie/client hashes, approval/decline/cancel timestamps. Event FK `Restrict`; indexes `[eventId,status]` and `[eventId,attendanceIntent]`.
- **Attendee**: primary/additional attendee name and optional email/phone, linked to registration; optional one-to-one Ticket. Index `[registrationId,attendeeType]`. Partial unique index permits at most one PRIMARY per registration; SQL check requires primary email nonblank. Registration FK `Restrict`.
- **NotificationOutbox**: registration, type, recipient, JSON payload, status, attempt/retry/lease/error/delivery data. Registration deletion cascades. Unique `(registrationId,type)` and index `(status,nextRetryAt)`.
- **Ticket**: one unique attendee, unique 64-character QR hash, status and issue/use timestamps; optional one-to-one check-in; status index. `ticket.service.ts` stores only SHA-256 hashes of random tokens.
- **AttendanceCheckIn**: unique ticket check-in by user and timestamps; ticket/user FKs `Restrict`; index on check-in time. Persistent check-in uses a conditional ticket status update and creates this record in one transaction.
- **Photo**: event image URL, optional title, publish flag/timestamps; event FK `Restrict`; `(eventId,isPublished)` index. No photo API found.
- **AuditLog**: optional actor/event, action/details/time; both FKs `SetNull`; indexes by event/time and actor/time. Sensitive organizer actions write records; no ordinary route reads or edits them.

### Enums and database rules

Enums: `AccountStatus` (`ACTIVE`, `SUSPENDED`, `DELETED`); `EventStatus` (`DRAFT`, `PUBLISHED`, `UNPUBLISHED`, `CANCELLED`, `COMPLETED`); `AttendanceIntent` (`ATTENDING`, `NOT_ATTENDING`); `RegistrationStatus` (`PENDING`, `APPROVED`, `DECLINED`, `CANCELLED`, `NOT_REQUIRED`); `AttendeeType` (`PRIMARY`, `ADDITIONAL`); `TicketStatus` (`ISSUED`, `USED`, `VOID`); notification type (organiser new RSVP, guest received/approved/declined) and status (`PENDING`, `PROCESSING`, `SENT`, `FAILED`).

Unique constraints include user email, event slug, nullable confirmation hash, attendee per ticket, QR hash, one check-in per ticket, and notification registration/type. Core relations generally restrict deletion; outbox cascades from registration; audit references set null. SQL check `RSVPRegistration_attendance_status_check` requires NOT_ATTENDING => NOT_REQUIRED and ATTENDING != NOT_REQUIRED. The duplicate-RSVP migration adds a case-insensitive five-minute same-event email exclusion constraint plus active device-hash indexes; capacity, minimum attendee count, additional guest limits, and approval transitions remain application rules. `maxGuestCapacity` has no SQL nonnegative check; API Zod enforces it.

### Migration history

1. `20261110142200_init_gather_database`: core enums/tables/keys/indexes/FKs, primary attendee partial index, primary-email and intent/status checks.
2. `20261110152000_add_rsvp_relationship_and_confirmation_token`: relationship and unique nullable confirmation hash.
3. `20261114120000_add_notification_outbox`: outbox enums/table/indexes and cascading FK.
4. `20261115120000_add_event_guest_capacity`: nullable event capacity.
5. `20261121120000_add_rsvp_device_hashes`: primary-email and device hash columns with active-device indexes.
6. `20261121130000_enforce_rsvp_duplicate_rules`: `btree_gist`, case-insensitive five-minute email exclusion constraint, and active device-hash indexes.

Migration files do not establish production application status. README says the initial migration has been applied; no live migration status was queried.

## 5. API endpoint inventory

All paths include mount prefixes. Standard validation errors are 400; auth errors 401, inactive account 403; unknown errors generic 500.

| Method / path | Auth | Inputs, purpose, responses and notable errors |
|---|---|---|
| `GET /health` | Public | Static `{status:"ok",service:"gather-backend"}`; no DB check. |
| `GET /health/ready` | Public | `200 {status:"ready"}` after a successful database query, otherwise `503 {status:"not ready"}`. |
| `POST /api/auth/register` | Public; 5/IP/hour | `firstName`, `lastName` (2–100); email valid/max 254/lowercased; password min 8/max 72 UTF-8 bytes. 201 `{user,token}`; duplicate 409; validation 400; throttle 429. |
| `POST /api/auth/login` | Public; 10/IP/15 min | Email/password with same bounds. 200 `{user,token}`; bad credentials 401; inactive 403; 400/429. |
| `GET /api/auth/me` | Bearer | 200 `{user}` safe account fields; missing/invalid token 401; inactive 403. |
| `GET /api/events/public/:slug` | Public | Published nondeleted event; 200 `{event}` with public fields/capacity summary, internal ID omitted; missing 404. |
| `POST /api/events/public/:slug/rsvp` | Public; 5/IP/hour | Primary full name/email/phone, attendance intent, optional relationship/additional names. 201 `{confirmationToken,registration,tickets}`; 400 validation; 404 unavailable; 409 deadline/duplicate/capacity; 429 throttle. |
| `POST /api/events/public/:slug/rsvp/confirmation` | Public; 20/IP/15 min | `{token}` exactly 43 base64url chars. 200 `{confirmation}` safe selection; invalid token/event 404; malformed 400; 429 throttle. |
| `GET /api/events?page=&pageSize=` | Bearer | User's nondeleted events, page>=1 and pageSize 1–100 (defaults 1/20). Events + counts (including `checkedInCount`)/capacity and pagination. |
| `POST /api/events` | Bearer | Strict event create body: title/category required; other fields optional and bounded in `event.service.ts`; slug normalized and collision-suffixed. 201 `{event}`, status DRAFT; invalid 400; exhausted slug 409. |
| `GET /api/events/:id` | Bearer + owner | Owned nondeleted event, dashboard counts/capacity; inaccessible 404. |
| `PATCH /api/events/:id` | Bearer + owner | Strict partial event fields, at least one key; terminal event blocked; capacity below reservations 409; validation 400. 200 `{event}`. |
| `POST /api/events/:id/publish` | Bearer + owner | Requires draft/unpublished plus graduate name, venue, deadline, valid IANA timezone, future date and deadline before the event; 200 `{event}`; incomplete/invalid dates 400, bad state 409. |
| `POST /api/events/:id/unpublish` | Bearer + owner | Published only; 200 `{event}`; invalid state 409. |
| `POST /api/events/:id/cancel` | Bearer + owner | Non-terminal only; cancels active registrations and voids unscanned tickets; 200 `{event}`, invalid state 409. |
| `POST /api/events/:id/complete` | Bearer + owner | Published only; 200 `{event}`, invalid state 409. |
| `DELETE /api/events/:id` | Bearer + owner | Soft delete; 200 `{event}`; missing 404. |
| `POST /api/events/:eventId/image-upload-signature` | Bearer + owner | Empty body, UUID event; signed Cloudinary upload params. 200 `{upload}`; invalid UUID 400, not found 404, config missing 500. |
| `GET /api/events/:eventId/rsvps?page=&pageSize=` | Bearer + owner | Paged registration list, pageSize 1–100/default 20; 200 `{registrations,pagination}`; inaccessible event 404. |
| `GET /api/events/:eventId/rsvps/:registrationId` | Bearer + owner | Registration and attendees; 200 `{registration}`; inaccessible/missing 404. |
| `POST /api/events/:eventId/rsvps/:registrationId/approve` | Bearer + owner | Empty strict body; pending attending only; 200 `{registration,tickets}`; newly issued tokens appear only in `tickets`; `Cache-Control: no-store`; 404 inaccessible; 409 wrong state/nonattending. |
| `POST /api/events/:eventId/rsvps/:registrationId/reject` | Bearer + owner | Empty strict body; pending only; 200 `{registration,tickets:[]}`; 404 inaccessible; 409 wrong state. |
| `POST /api/events/:eventId/rsvps/:registrationId/cancel` | Bearer + owner | Empty strict body; cancels an active registration, releases device/capacity, and voids unscanned tickets; 404 inaccessible, 409 wrong state. |
| `POST /api/events/public/:slug/rsvp/cancel` | Public; 20/IP/15 min | `{token}`; guest cancellation with the same registration/ticket effects; malformed 400, unknown token 404, repeat cancel 409. |
| `POST /api/events/:eventId/tickets/issue` | Bearer + owner | Idempotently issues missing tickets for APPROVED+ATTENDING registrations. 200 `{tickets,issuedCount}`; returns raw token only for newly created tickets; inaccessible event 404. |
| `POST /api/events/:eventId/attendees/:attendeeId/tickets/reissue` | Bearer + owner | Rotates the token for an eligible attendee; 200 with raw token, `Cache-Control: no-store`; old token immediately stops working. |
| `POST /api/events/:eventId/attendees/:attendeeId/tickets/revoke` | Bearer + owner | Voids an unscanned ticket permanently; 200 with `VOID`, 409 used/void, 404 ineligible attendee. |
| `GET /api/events/:eventId/tickets?page=&pageSize=` | Bearer + owner | Safe paginated ticket rows with `ticketStatus`, `revoked`, `checkedInAt`, and `attendeeName`; never tokens. Supports `If-None-Match`. |
| `POST /api/events/:eventId/tickets/:ticketId/reissue` | Bearer + owner | Ticket-id variant of reissue; 200 with raw token and `Cache-Control: no-store`. |
| `POST /api/events/:eventId/tickets/:ticketId/revoke` | Bearer + owner | Ticket-id variant of revoke; 200 with `VOID`. |

`GET /api/events/:eventId/attendees`, `GET /api/events/:eventId/rsvps`, and `GET /api/events/:eventId/tickets` set an `ETag` derived from the safe response body and `Cache-Control: private, max-age=0, must-revalidate`. A matching `If-None-Match` returns `304` with an empty body.
| `GET /api/events/:eventId/attendees?page=&pageSize=` | Bearer + owner | Paged attendee list with RSVP state, ticket presence, check-in state/time. Never returns token or hash. |
| `POST /api/tickets/checkin` | Bearer + event owner | JSON `{eventId,qrToken}` (legacy `qrCode` property accepted as alias). Atomically marks ticket USED and creates check-in. 200 safe attendee summary; unknown/wrong event 404; used/ineligible 409. |
| `GET /api/tickets/validate/:qrCode` | Bearer | Retired in-memory path; 410 migration message, request token redacted in Morgan log. |
| Any other route | N/A | 404 `{message:"Route not found."}`; the URL is never reflected. |

No generated OpenAPI contract exists; `API.md` documents routes, auth, pagination, and error conventions. Exact selection fields live in service Prisma selects and README. The backend repository has no frontend API client, so frontend endpoint usage cannot be comprehensively verified. README explicitly says RSVP frontend is not connected. README describes direct Cloudinary upload followed by event PATCH of `coverImageUrl`, but this is not proof of an active client call.

## 6. Complete feature inventory

- **Auth:** registration/login, bcrypt, JWT, `/me`. No password reset or email verification route.
- **Event management:** create/update, ownership, slug generation, list/detail/dashboard counts, publish/unpublish/cancel/complete, soft delete. Transitions re-check status under the event advisory lock and use conditional updates.
- **Invitation/public event:** Event public slug is invitation surface; only published/nondeleted events are publicly returned. No separate invitation model/send route.
- **RSVP/guests:** public submit and confirmation lookup; organizer list/detail/approve/reject/cancel and guest-token cancellation. Additional guests are Attendee rows on same registration, only names captured.
- **Capacity:** nullable max means unlimited; finite max uses reserved attendee count. Event update checks new max against reservations.
- **Images:** Cloudinary signed direct upload; JPG/JPEG/PNG/WebP, server-generated folder/public ID, overwrite false, one-hour signature, advisory 5 MiB client hint. No upload proxy/photo CRUD found. Event image fields are URL-validated.
- **Email:** organiser and primary guest notified on RSVP; guest notified on decision. Outbox writes share transaction with RSVP state change. Additional guests are not emailed.
- **Tickets/check-in:** `Ticket` is one-to-one with each primary/additional `Attendee`. Only approved attending registrations qualify. Random 32-byte tokens are SHA-256 hashed in DB; approval and event-wide issuance use the event capacity advisory lock. Check-in updates `TicketStatus` conditionally and creates `AttendanceCheckIn` transactionally.
- **Photos/audit:** Photo has no routes; sensitive organizer actions write AuditLog records with safe metadata, and no ordinary route reads or edits them.

## 7. RSVP and capacity business logic

### Submission

`event.routes.ts` rate-limits and calls `submitRsvp`. `rsvp.service.ts` parses a strict schema: guest names must have two words, email lowercased, phone allowed characters and 7–15 digits, intent enum, up to 1000 additional names. Additional names with NOT_ATTENDING are rejected. `findAcceptingEvent` requires PUBLISHED, nondeleted, and deadline in future.

The service creates 32 random bytes as base64url confirmation token and persists only SHA-256 hash. In a Prisma interactive transaction it takes a transaction-scoped PostgreSQL advisory lock keyed by event for capacity, then another keyed by event+primary email for duplicate suppression. It re-reads event publication/deadline, validates per-event additional limit, checks same primary email in previous five minutes, and checks capacity. Attending RSVP consumes `1 + additional names` spaces. A full event returns 409 with available and requested counts.

Attending starts PENDING when approval required, otherwise APPROVED. Not-attending becomes NOT_REQUIRED. Registration and PRIMARY/ADDITIONAL attendee rows are inserted together, then two notification jobs are enqueued. Transaction isolation is ReadCommitted, max wait 10 seconds, timeout 30 seconds for large groups. Response includes a long-lived confirmation credential and selected registration; hash is excluded.

### Counting and decisions

`capacity.service.ts` counts attendees where registration event matches, intent ATTENDING and status PENDING or APPROVED. Pending therefore reserves capacity. DECLINED, CANCELLED and NOT_REQUIRED do not reserve. Rejecting PENDING changes to DECLINED and frees spaces; approval changes PENDING to APPROVED and preserves reservation. Guest-token and organiser cancellation set CANCELLED, free spaces, release the device reservation, and void unscanned tickets.

Approval/rejection transaction also takes event capacity lock; decision uses conditional `updateMany` requiring PENDING (and ATTENDING for approval), reads updated registration, enqueues notification before commit. Concurrent second decision loses the state predicate; P2002/P2034 mapped to 409. Event updates also take same capacity lock, recount, and reject a finite capacity lower than existing reservations. RSVP and capacity editing therefore serialize across these code paths.

### Limits and edge behavior

Capacity locks protect callers that use these service paths; no DB aggregate constraint protects against other writers bypassing service logic. No live concurrency run was performed. Additional guest limit and status transition rules are application-enforced. An attending registration always needs one slot for primary guest; capacity zero prevents it. NOT_ATTENDING still creates a primary attendee but consumes no capacity. Changing `approvalRequired` affects future submissions only; existing statuses are untouched. Public confirmation requires token/event slug and nondeleted event but does not require published status.

## 8. Authentication and authorisation

Registration lowercases email, checks case-insensitively, bcrypt-hashes at cost 12 and returns safe user projection plus seven-day HS256 token. Login compares password and checks active status. JWT contains subject user ID. `requireAuth` verifies Bearer format and HS256, reloads user, rejects missing/deactivated accounts, and attaches safe user fields. There is no refresh/revocation flow. Event, RSVP, and image service queries include owner ID and nondeleted event checks. There is no role/team membership model; the unused `requireOwnerOrSelf` helper has been removed.

## 9. Security and reliability assessment

### Confirmed source issues

1. **One-time QR token recovery:** the API returns random tokens to the authenticated event owner only when tickets are created or reissued. Hashes are irreversible, so retrying issuance cannot recover a lost token; owner-only reissue rotates it and revoke permanently voids it. Token-bearing responses use `Cache-Control: no-store`.
2. **Rate limits are per process:** auth, RSVP, upload, ticket, and check-in counters are in-memory, bounded, and reset on restart; horizontal replicas need a shared store such as Redis.
3. **Upload size:** the 5 MiB value is only an advisory client hint; Cloudinary has no signed file-size upload parameter, so an account-level cap is required for hard enforcement.
4. **Health:** `/health` is liveness and `/health/ready` checks database connectivity.
5. **Feature coverage:** AuditLog writes cover sensitive organizer actions; Photo still has no dedicated routes. Ticket/check-in now use Prisma persistently.

### Deployment-dependent risks / unknowns

- `JWT_SECRET` minimum length and production `CORS_ORIGINS` are startup validated; actual Render values were not inspected. `.env` and `.env.test.local` values were not read.
- `DIRECT_URL` is validated at startup because the Prisma datasource references it.
- `trust proxy=1` assumes exactly one upstream proxy; README documents adjustment for extra proxies/CDN.
- Email verification timestamp exists, but no verification flow or requirement exists in code; intended account policy is unknown.
- Public confirmation reveals attendee names/event details to possession of a high-entropy token. Primary email/phone are not selected. Retention policy unknown.
- Capacity and guest limit are application rules; other DB writers can bypass locks.
- Outbox has retries and leases but no retention/operations endpoint identified.
- CORS is browser-origin control, not API authentication. Production allowlist correctness is unknown.
- No production config, live database, penetration test or Cloudinary account policy was examined.

## 10. Testing and build instructions

`package.json` scripts: `npm run dev` (tsx watch), `npm run build` (TypeScript compile to `dist`), `npm test` and `npm run test:safe` (safe runner: Prisma generate, `migrate deploy`, then `test:direct`), `npm run test:direct` (raw Node test runner), `npm start` (`node dist/index.js`), `npm run worker` / `npm run start:worker`, `npm run prisma:generate`, `npm run prisma:migrate` (`migrate dev`).

Thirteen integration tests cover public RSVP validation/persistence/confirmation/ownership/throttle; capacity and concurrent submit/update behavior; organiser decisions, issuance, check-in and redaction; signed uploads; notification rendering/outbox behavior; duplicate-RVP DB constraints; publishing/lifecycle rules; operational/readiness endpoints; and organizer authorization. They use PostgreSQL/Prisma, not mocked persistence. The safe runner requires `.env.test.local`, validates both test URLs as Neon `gather_rsvp_test`, generates Prisma Client, deploys migrations, and runs the suite; production DB/config is not targeted.

No separate unit test suite or linter is configured. Untested/unclear areas include production provider failures, deployment header verification, multi-instance rate limits, and load/capacity benchmarks. CI runs typecheck, build, whitespace check, and the safe suite with injected test database secrets.

## 11. Deployment overview

README identifies Render and Supabase PostgreSQL. Prisma uses `DATABASE_URL` and `DIRECT_URL`; exact pooler/direct setup is not independently verified. Build is `tsc -p tsconfig.json`; production start is `node dist/index.js` (`npm start`). Startup-required values are `JWT_SECRET` (>=32 chars), `DATABASE_URL`, and `DIRECT_URL`; production also requires `CORS_ORIGINS`. Optional validated names: `NODE_ENV` (`development`/`test`/`production`, default `development`), `PORT`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FRONTEND_URL`, and `EMAIL_WORKER_IN_WEB` (default `true`). Values omitted.

No Render manifest/dashboard was inspected. Actual Render build/start/health settings, instance count, proxy chain, environment configuration and release migration process are unknown. App exposes `GET /health` and `/health/ready`; no manifest config was found. The worker runs in the web process by default or via `npm run start:worker` when `EMAIL_WORKER_IN_WEB=false`. Safe test runner uses `migrate deploy` only for disposable Neon test DB; no automatic production migration config was found. Checked-in migrations do not prove production DB state.

## 12. Known issues and technical debt

1. Lost QR tokens cannot be recovered because only hashes are stored; owner reissue rotates them, but guest delivery is still outside this backend.
2. Rate limits are process-local; multi-instance deployments need a shared store.
3. README says frontend RSVP flow is not connected; frontend source was unavailable.
4. Photo and profile routes do not exist; guest self-cancel, RSVP organiser cancel, and event cancellation/completion are implemented.
5. `VOID` is used for cancelled and revoked tickets; reissue rotates the same ticket's token in place, and `USED` is retained for check-in history.
6. Upload size is only an advisory client hint; a Cloudinary account-level cap is required for hard enforcement.
7. `API.md` documents the contract, but no generated OpenAPI spec or separate unit-test suite exists.
8. CI and a safe migration/test runner exist; a Render manifest and formal migration release runbook are still absent.
9. The notification worker can run separately, but failed-job cleanup/retention policy is still undefined.
10. Schema capabilities exceed implemented routes, notably photos and group-entry QR.

## 13. Questions or uncertainties requiring investigation

- Which frontend repository consumes this API and which routes are actively called?
- What are current Render build/start/health settings, proxy topology, and replica count?
- What is production migration status and release procedure using `DIRECT_URL`?
- Is Cloudinary account usage capped to intended file-size maximum?
- How are failed email jobs, retention, and sender verification operated?
- Email verification is intentionally out of scope; `emailVerifiedAt` is legacy and hidden from responses.
- Event cancellation/completion, RSVP cancellation, ticketing/check-in, and audit writes are implemented; photo routes and group-entry QR remain unimplemented.
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
