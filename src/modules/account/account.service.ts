import { randomBytes } from 'node:crypto';
import { AccountStatus, NotificationStatus, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { HttpError } from '../../middleware/errorHandler.js';
import { prisma } from '../../lib/prisma.js';

const preferencesSelect = {
  emailNotifications: true,
  locale: true,
} satisfies Prisma.UserSelect;

export type AccountPreferences = Prisma.UserGetPayload<{ select: typeof preferencesSelect }>;

const preferencesSchema = z.object({
  emailNotifications: z.boolean().optional(),
  locale: z.string().trim().min(2).max(35).regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/i).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one preference field to update.',
});

export async function getAccountPreferences(userId: string): Promise<AccountPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: preferencesSelect,
  });
  if (!user) throw new HttpError(404, 'Account not found.');
  return user;
}

export async function updateAccountPreferences(userId: string, input: unknown): Promise<AccountPreferences> {
  const payload = preferencesSchema.parse(input);
  try {
    return await prisma.user.update({
      where: { id: userId },
      data: {
        ...(payload.emailNotifications === undefined ? {} : { emailNotifications: payload.emailNotifications }),
        ...(payload.locale === undefined ? {} : { locale: payload.locale }),
      },
      select: preferencesSelect,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new HttpError(404, 'Account not found.');
    }
    throw error;
  }
}

export async function getAccountDataExport(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      profileImageUrl: true,
      accountStatus: true,
      emailNotifications: true,
      locale: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!user) throw new HttpError(404, 'Account not found.');

  const [events, registrations, checkIns, auditLogs] = await Promise.all([
    prisma.event.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        slug: true,
        eventCategory: true,
        description: true,
        graduateName: true,
        eventDate: true,
        timezone: true,
        venueName: true,
        venueAddress: true,
        eventStatus: true,
        publishedAt: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.rSVPRegistration.findMany({
      where: {
        OR: [
          { event: { is: { userId } } },
          { attendees: { some: { email: { equals: user.email, mode: 'insensitive' } } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        eventId: true,
        attendanceIntent: true,
        status: true,
        relationshipToGraduate: true,
        approvedAt: true,
        declinedAt: true,
        cancelledAt: true,
        createdAt: true,
        updatedAt: true,
        event: { select: { id: true, title: true, slug: true } },
        attendees: {
          orderBy: [{ attendeeType: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            attendeeType: true,
            createdAt: true,
            ticket: {
              select: {
                id: true,
                ticketStatus: true,
                deliveryStatus: true,
                issuedAt: true,
                usedAt: true,
                lastDeliveryAt: true,
              },
            },
          },
        },
      },
    }),
    prisma.attendanceCheckIn.findMany({
      where: { checkedInByUserId: userId },
      orderBy: { checkedInAt: 'asc' },
      select: {
        id: true,
        ticketId: true,
        checkedInAt: true,
        ticket: {
          select: {
            attendee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                registration: { select: { id: true, eventId: true } },
              },
            },
          },
        },
      },
    }),
    prisma.auditLog.findMany({
      where: { actorId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, eventId: true, action: true, details: true, createdAt: true },
    }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    user,
    events,
    registrations,
    checkIns,
    auditLogs,
  };
}

export async function deleteAccount(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) throw new HttpError(404, 'Account not found.');

  // Existing JWTs cannot be revoked individually, but requireAuth checks the account
  // status on every request, so marking the account DELETED invalidates all sessions.
  const anonymizedPasswordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 12);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        firstName: 'Deleted',
        lastName: 'User',
        email: `deleted-${userId}@invalid.local`,
        profileImageUrl: null,
        passwordHash: anonymizedPasswordHash,
        accountStatus: AccountStatus.DELETED,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });
    await tx.event.updateMany({
      where: { userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await tx.notificationOutbox.updateMany({
      where: { userId },
      data: {
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        processingUntil: null,
        payload: {},
      },
    });
  });

  return { message: 'Your account has been deleted.' };
}
