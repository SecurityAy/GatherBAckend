CREATE TYPE "NotificationType" AS ENUM (
  'ORGANISER_NEW_RSVP',
  'GUEST_RSVP_RECEIVED',
  'GUEST_RSVP_APPROVED',
  'GUEST_RSVP_DECLINED'
);

CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

CREATE TABLE "NotificationOutbox" (
  "id" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processingUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationOutbox_registrationId_type_key"
  ON "NotificationOutbox"("registrationId", "type");
CREATE INDEX "NotificationOutbox_status_nextRetryAt_idx"
  ON "NotificationOutbox"("status", "nextRetryAt");
ALTER TABLE "NotificationOutbox"
  ADD CONSTRAINT "NotificationOutbox_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "RSVPRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
