-- Additive account self-service, password recovery, and ticket email delivery fields.
-- Registration-scoped outbox rows keep their existing cascade; user/ticket-scoped rows
-- use a required application dedupe key for idempotent enqueueing.

CREATE TYPE "TicketDeliveryStatus" AS ENUM ('NOT_SENT', 'SENT', 'FAILED');

ALTER TABLE "User"
  ADD COLUMN "passwordResetTokenHash" CHAR(64),
  ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3),
  ADD COLUMN "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';

CREATE UNIQUE INDEX "User_passwordResetTokenHash_key"
  ON "User"("passwordResetTokenHash");

ALTER TABLE "NotificationOutbox"
  ALTER COLUMN "registrationId" DROP NOT NULL,
  ADD COLUMN "userId" TEXT,
  ADD COLUMN "ticketId" TEXT,
  ADD COLUMN "dedupeKey" TEXT;

ALTER TABLE "NotificationOutbox"
  ADD CONSTRAINT "NotificationOutbox_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "NotificationOutbox_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_type_key"
  ON "NotificationOutbox"("dedupeKey", "type");
CREATE INDEX "NotificationOutbox_userId_type_idx"
  ON "NotificationOutbox"("userId", "type");
CREATE INDEX "NotificationOutbox_ticketId_type_idx"
  ON "NotificationOutbox"("ticketId", "type");

ALTER TABLE "Ticket"
  ADD COLUMN "deliveryStatus" "TicketDeliveryStatus" NOT NULL DEFAULT 'NOT_SENT',
  ADD COLUMN "lastDeliveryAt" TIMESTAMP(3),
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDeliveryError" TEXT;
