import { NotificationStatus, NotificationType, Prisma } from '@prisma/client';
import { Resend } from 'resend';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { renderNotificationEmail, type NotificationEmail } from './email-templates.js';

const maxAttempts = 5;
const leaseMs = 2 * 60 * 1000;
const pollMs = 5000;
let timer: NodeJS.Timeout | undefined;
let polling = false;
let stopping = false;
type EmailSender = { emails: { send: (input: any) => Promise<any> } };
let resend: EmailSender | undefined = env.resend ? new Resend(env.resend.apiKey) : undefined;
let testConfigOverride: { fromEmail: string } | undefined;

export function setNotificationSenderForTests(sender: EmailSender | undefined, fromEmail?: string) {
  resend = sender;
  testConfigOverride = fromEmail ? { fromEmail } : undefined;
}

export function notificationRetryDelay(attempt: number) {
  return Math.min(60 * 60 * 1000, 30_000 * (2 ** (attempt - 1)));
}

export function notificationPayload(input: NotificationEmail): Prisma.InputJsonObject {
  return input as unknown as Prisma.InputJsonObject;
}

function normalizeRecipientEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : undefined;
}

function redactJsonValue(value: Prisma.JsonValue): Prisma.InputJsonValue {
  if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry));
  if (!value || typeof value !== 'object') return value as Prisma.InputJsonValue;

  const result: Record<string, Prisma.InputJsonValue> = {};
  const secretKeys = new Set(['reseturl', 'ticketurl', 'qrdatauri']);
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    // ticketUrl embeds the raw QR token in its query string, so it is as sensitive
    // as resetUrl even though its key does not contain "token".
    result[key] = normalizedKey.includes('token') || secretKeys.has(normalizedKey)
      ? '[redacted]'
      : redactJsonValue(nested ?? null);
  }
  return result;
}

/** Raw delivery tokens are needed only until the send succeeds; strip them from stored payloads afterwards. */
function redactedPayload(payload: Prisma.JsonValue): Prisma.InputJsonObject {
  const redacted = redactJsonValue(payload);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Prisma.InputJsonObject
    : {};
}

async function upsertDedupedNotification(
  tx: Prisma.TransactionClient,
  dedupeKey: string,
  type: NotificationType,
  data: Omit<Prisma.NotificationOutboxUncheckedCreateInput, 'id' | 'dedupeKey' | 'type'>,
) {
  if (!dedupeKey || dedupeKey.length > 200) {
    throw new Error('A non-empty dedupe key is required for user and ticket notifications.');
  }
  await tx.notificationOutbox.upsert({
    where: { dedupeKey_type: { dedupeKey, type } },
    create: { ...data, dedupeKey, type },
    update: { ...data },
  });
}

/** Existing registration-scoped helper; its call sites and unique key are unchanged. */
export async function enqueueNotification(
  tx: Prisma.TransactionClient,
  registrationId: string,
  type: NotificationType,
  recipientEmail: string,
  payload: Prisma.InputJsonObject,
) {
  const normalizedEmail = normalizeRecipientEmail(recipientEmail);
  if (!normalizedEmail) return;
  await tx.notificationOutbox.upsert({
    where: { registrationId_type: { registrationId, type } },
    create: { registrationId, type, recipientEmail: normalizedEmail, payload },
    update: {},
  });
}

export async function enqueueUserNotification(
  tx: Prisma.TransactionClient,
  userId: string,
  type: NotificationType,
  recipientEmail: string,
  payload: Prisma.InputJsonObject,
  dedupeKey: string,
) {
  const normalizedEmail = normalizeRecipientEmail(recipientEmail);
  if (!normalizedEmail || !userId) return;
  await upsertDedupedNotification(tx, dedupeKey, type, {
    userId,
    recipientEmail: normalizedEmail,
    payload,
    status: NotificationStatus.PENDING,
    attemptCount: 0,
    nextRetryAt: new Date(),
    processingUntil: null,
    sentAt: null,
    lastError: null,
  });
}

export async function enqueueTicketDelivery(
  tx: Prisma.TransactionClient,
  ticketId: string,
  recipientEmail: string,
  payload: Prisma.InputJsonObject,
  dedupeKey: string,
) {
  const normalizedEmail = normalizeRecipientEmail(recipientEmail);
  if (!normalizedEmail || !ticketId) return;
  await upsertDedupedNotification(tx, dedupeKey, typeForTicketDelivery(), {
    ticketId,
    recipientEmail: normalizedEmail,
    payload,
    status: NotificationStatus.PENDING,
    attemptCount: 0,
    nextRetryAt: new Date(),
    processingUntil: null,
    sentAt: null,
    lastError: null,
  });
}

function typeForTicketDelivery() {
  return NotificationType.TICKET_DELIVERY;
}

/**
 * If a ticket delivery job already exists, make its payload use the newly rotated
 * token instead of sending a stale link. No new row is created on ordinary reissue.
 */
export async function supersedeTicketDelivery(
  tx: Prisma.TransactionClient,
  ticketId: string,
  recipientEmail: string,
  payload: Prisma.InputJsonObject,
  dedupeKey: string,
) {
  const normalizedEmail = normalizeRecipientEmail(recipientEmail);
  if (!ticketId || !normalizedEmail || !dedupeKey || dedupeKey.length > 200) return;
  await tx.notificationOutbox.updateMany({
    where: { ticketId, type: NotificationType.TICKET_DELIVERY },
    data: {
      dedupeKey,
      recipientEmail: normalizedEmail,
      payload,
      status: NotificationStatus.PENDING,
      attemptCount: 0,
      nextRetryAt: new Date(),
      processingUntil: null,
      sentAt: null,
      lastError: null,
    },
  });
}

/** Rotating a ticket must also update RSVP emails that have not been sent yet. */
export async function supersedeQueuedRegistrationTicketLinks(
  tx: Prisma.TransactionClient,
  registrationId: string,
  ticketId: string,
  qrToken: string,
  ticketUrl?: string,
) {
  const jobs = await tx.notificationOutbox.findMany({
    where: {
      registrationId,
      type: { in: [NotificationType.GUEST_RSVP_RECEIVED, NotificationType.GUEST_RSVP_APPROVED] },
      status: { in: [NotificationStatus.PENDING, NotificationStatus.PROCESSING] },
    },
    select: { id: true, payload: true },
  });

  for (const job of jobs) {
    const payload = job.payload as Prisma.JsonObject;
    const ticket = payload?.ticket as Prisma.JsonObject | undefined;
    if (!ticket || ticket.ticketId !== ticketId) continue;

    const updatedTicket: Record<string, Prisma.InputJsonValue | undefined> = { ...ticket, qrToken };
    if (ticketUrl) updatedTicket.ticketUrl = ticketUrl;
    else delete updatedTicket.ticketUrl;

    await tx.notificationOutbox.update({
      where: { id: job.id },
      data: { payload: { ...payload, ticket: updatedTicket } as unknown as Prisma.InputJsonObject },
    });
  }
}

async function claimOne(notificationId?: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      payload: Prisma.JsonValue;
      recipientEmail: string;
      type: NotificationType;
      attemptCount: number;
      ticketId: string | null;
    }>>`
      SELECT "id", "payload", "recipientEmail", "type", "attemptCount", "ticketId"
      FROM "NotificationOutbox"
      WHERE (("status" = 'PENDING' AND "nextRetryAt" <= NOW()) OR ("status" = 'PROCESSING' AND "processingUntil" < NOW()))
        AND "attemptCount" < ${maxAttempts}
        AND (${notificationId ?? null}::text IS NULL OR "id" = ${notificationId ?? null})
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const job = rows[0];
    if (!job) return undefined;
    await tx.notificationOutbox.update({
      where: { id: job.id },
      data: { status: NotificationStatus.PROCESSING, attemptCount: { increment: 1 }, processingUntil: new Date(Date.now() + leaseMs) },
    });
    return job;
  });
}

async function updateTicketDeliveryStatus(ticketId: string | null, status: 'SENT' | 'FAILED', attemptCount: number, sentAt: Date, error?: string) {
  if (!ticketId) return;
  await prisma.ticket.updateMany({
    where: { id: ticketId },
    data: {
      deliveryStatus: status,
      lastDeliveryAt: status === 'SENT' ? sentAt : undefined,
      deliveryAttempts: attemptCount,
      lastDeliveryError: status === 'FAILED' ? (error ?? 'Delivery failed') : null,
    },
  });
}

async function redactDeliveredPayload(notificationId: string, payload: Prisma.JsonValue) {
  await prisma.notificationOutbox.update({
    where: { id: notificationId },
    data: { payload: redactedPayload(payload) },
  });
}

export async function runNotificationWorkerOnce(notificationId?: string) {
  const job = await claimOne(notificationId);
  if (!job) return false;
  if (!resend || (!env.resend && !testConfigOverride)) {
    await prisma.notificationOutbox.update({ where: { id: job.id }, data: { status: NotificationStatus.PENDING, attemptCount: { decrement: 1 }, processingUntil: null, nextRetryAt: new Date(Date.now() + 60_000), lastError: 'Email provider is not configured.' } });
    return false;
  }
  try {
    const payload = job.payload as unknown as NotificationEmail;
    const rendered = renderNotificationEmail(payload);
    const result = await resend.emails.send({
      from: env.resend?.fromEmail ?? testConfigOverride!.fromEmail,
      to: job.recipientEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: { 'Idempotency-Key': job.id },
    });
    if (result.error) throw new Error(`Resend error ${result.error.name || 'delivery failed'}`);
    const sentAt = new Date();
    await prisma.notificationOutbox.update({ where: { id: job.id }, data: { status: NotificationStatus.SENT, sentAt, processingUntil: null, lastError: null } });
    if (job.type === NotificationType.TICKET_DELIVERY) {
      try {
        await updateTicketDeliveryStatus(job.ticketId, 'SENT', job.attemptCount + 1, sentAt);
      } catch (error) {
        console.warn('Ticket delivery status update failed', { error: error instanceof Error ? error.name : 'UnknownError' });
      }
    }
    try {
      await redactDeliveredPayload(job.id, job.payload);
    } catch (error) {
      console.warn('Outbox payload redaction failed', { error: error instanceof Error ? error.name : 'UnknownError' });
    }
  } catch (error) {
    const attemptCount = job.attemptCount + 1;
    const permanent = attemptCount >= maxAttempts;
    const safeError = error instanceof Error ? error.name.slice(0, 100) : 'Delivery failed';
    const delay = notificationRetryDelay(attemptCount);
    await prisma.notificationOutbox.update({
      where: { id: job.id },
      data: { status: permanent ? NotificationStatus.FAILED : NotificationStatus.PENDING, processingUntil: null, nextRetryAt: new Date(Date.now() + delay), lastError: safeError },
    });
    if (job.type === NotificationType.TICKET_DELIVERY && permanent) {
      try {
        await updateTicketDeliveryStatus(job.ticketId, 'FAILED', attemptCount, new Date(), safeError);
      } catch (statusError) {
        console.warn('Ticket delivery failure status update failed', { error: statusError instanceof Error ? statusError.name : 'UnknownError' });
      }
    }
    console.warn('Email notification delivery failed', { type: job.type, attempt: attemptCount, permanent, error: safeError });
  }
  return true;
}

async function deliverOne() {
  return runNotificationWorkerOnce();
}

async function poll() {
  if (polling || stopping) return;
  polling = true;
  try {
    while (!stopping && await deliverOne()) { /* drain available work without holding HTTP requests */ }
  } catch (error) {
    console.warn('Email notification worker cycle failed', { error: error instanceof Error ? error.name : 'UnknownError' });
  } finally {
    polling = false;
  }
}

export function startNotificationWorker() {
  if (timer) return;
  stopping = false;
  if (!resend) console.warn('Email notifications are queued until RESEND_API_KEY is configured.');
  timer = setInterval(() => void poll(), pollMs);
  timer.unref();
  void poll();
}

export async function stopNotificationWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  while (polling) await new Promise((resolve) => setTimeout(resolve, 25));
}
