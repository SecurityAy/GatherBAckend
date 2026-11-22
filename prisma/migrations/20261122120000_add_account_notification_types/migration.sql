-- Append the notification kinds used by password recovery and ticket delivery.
-- PostgreSQL requires enum values to be committed before a later migration can use them.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_DELIVERY';
