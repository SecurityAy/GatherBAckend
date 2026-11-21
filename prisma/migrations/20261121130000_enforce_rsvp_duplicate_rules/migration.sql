-- Enforce the existing duplicate-RSVP rules at the database level so concurrent
-- requests cannot bypass them. Application checks remain for friendly 409 responses.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "RSVPRegistration"
ADD COLUMN "primaryEmailHash" CHAR(64);

-- Backfill existing rows using the same normalization as the application.
UPDATE "RSVPRegistration" AS r
SET "primaryEmailHash" = encode(sha256(convert_to(lower(btrim(a."email")), 'UTF8')), 'hex')
FROM "Attendee" AS a
WHERE a."registrationId" = r."id"
  AND a."attendeeType" = 'PRIMARY';

-- One non-cancelled registration per event and primary email in any 5-minute
-- sliding window. Cancelled registrations release the email for a new RSVP.
ALTER TABLE "RSVPRegistration"
ADD CONSTRAINT "RSVPRegistration_event_email_five_minute_excl"
EXCLUDE USING gist (
  "eventId" WITH =,
  "primaryEmailHash" WITH =,
  tsrange("createdAt", "createdAt" + interval '5 minutes', '[)') WITH &&
) WHERE ("status" <> 'CANCELLED');

-- A device hash may belong to only one active reservation per event.
-- Separate indexes cover both cookie and client-supplied device identifiers.
CREATE UNIQUE INDEX "RSVPRegistration_eventId_deviceCookieHash_active_key"
ON "RSVPRegistration"("eventId", "deviceCookieHash")
WHERE "deviceCookieHash" IS NOT NULL AND "status" <> 'CANCELLED';

CREATE UNIQUE INDEX "RSVPRegistration_eventId_deviceClientHash_active_key"
ON "RSVPRegistration"("eventId", "deviceClientHash")
WHERE "deviceClientHash" IS NOT NULL AND "status" <> 'CANCELLED';
