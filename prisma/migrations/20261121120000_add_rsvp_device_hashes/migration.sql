ALTER TABLE "RSVPRegistration"
ADD COLUMN "deviceCookieHash" CHAR(64),
ADD COLUMN "deviceClientHash" CHAR(64);

CREATE INDEX "RSVPRegistration_eventId_deviceCookieHash_idx" ON "RSVPRegistration"("eventId", "deviceCookieHash");
CREATE INDEX "RSVPRegistration_eventId_deviceClientHash_idx" ON "RSVPRegistration"("eventId", "deviceClientHash");
