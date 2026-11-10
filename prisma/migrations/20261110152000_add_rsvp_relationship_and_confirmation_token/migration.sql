-- AlterTable
ALTER TABLE "RSVPRegistration" ADD COLUMN     "confirmationTokenHash" CHAR(64),
ADD COLUMN     "relationshipToGraduate" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RSVPRegistration_confirmationTokenHash_key" ON "RSVPRegistration"("confirmationTokenHash");
