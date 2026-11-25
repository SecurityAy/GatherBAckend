-- Per-user JWT generation counter. Password changes and resets increment it so
-- bearer tokens issued before those events fail requireAuth immediately.

ALTER TABLE "User"
  ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
