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

export async function enqueueNotification(
  tx: Prisma.TransactionClient,
  registrationId: string,
  type: NotificationType,
  recipientEmail: string,
  payload: Prisma.InputJsonObject,
) {
  const normalizedEmail = recipientEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return;
  await tx.notificationOutbox.upsert({
    where: { registrationId_type: { registrationId, type } },
    create: { registrationId, type, recipientEmail: normalizedEmail, payload },
    update: {},
  });
}

async function claimOne(notificationId?: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; payload: Prisma.JsonValue; recipientEmail: string; type: NotificationType; attemptCount: number }>>`
      SELECT "id", "payload", "recipientEmail", "type", "attemptCount"
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
    await prisma.notificationOutbox.update({ where: { id: job.id }, data: { status: NotificationStatus.SENT, sentAt: new Date(), processingUntil: null, lastError: null } });
  } catch (error) {
    const attemptCount = job.attemptCount + 1;
    const permanent = attemptCount >= maxAttempts;
    const safeError = error instanceof Error ? error.name.slice(0, 100) : 'Delivery failed';
    const delay = notificationRetryDelay(attemptCount);
    await prisma.notificationOutbox.update({
      where: { id: job.id },
      data: { status: permanent ? NotificationStatus.FAILED : NotificationStatus.PENDING, processingUntil: null, nextRetryAt: new Date(Date.now() + delay), lastError: safeError },
    });
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
