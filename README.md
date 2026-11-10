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

## Notes
Authentication and event management use Prisma/PostgreSQL. RSVP submissions and organiser registration reads are also implemented on the backend, but the frontend RSVP flow is not connected yet. Ticket and check-in routes are still prototype implementations and should not be used as authoritative production workflows.
