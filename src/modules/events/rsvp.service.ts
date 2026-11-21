import { createHash, randomBytes } from 'node:crypto';
import { AttendanceIntent, AttendeeType, EventStatus, NotificationType, Prisma, RegistrationStatus, TicketStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { env } from '../../config/env.js';
import { enqueueNotification, notificationPayload } from '../notifications/notification-outbox.service.js';
import { countReservedGuestSpaces, lockEventCapacity } from './capacity.service.js';
import { defaultDeviceContext, deviceRegistrationFilter, type DeviceContext } from './device.service.js';
import { issueEligibleRegistrationTickets } from '../tickets/ticket.service.js';

const guestNameSchema = z.string().trim().min(2).max(200).refine(
  (value) => value.split(/\s+/).length >= 2,
  'Enter the guest’s first and last name.',
);

const primaryPhoneSchema = z.string()
  .trim()
  .min(7)
  .max(40)
  .regex(/^[+()\d.\-\s]+$/)
  .refine((phone) => {
    const digitCount = phone.match(/\d/g)?.length ?? 0;
    return digitCount >= 7 && digitCount <= 15;
  }, 'Enter a valid phone number.');

const rsvpSchema = z.object({
  primaryGuestName: guestNameSchema,
  primaryGuestEmail: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  primaryGuestPhone: primaryPhoneSchema,
  relationshipToGraduate: z.string().trim().min(1).max(100).optional(),
  attendanceIntent: z.nativeEnum(AttendanceIntent),
  additionalGuestNames: z.array(guestNameSchema).max(50).default([]),
}).strict();

const confirmationSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid confirmation token.'),
}).strict();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const publicConfirmationSelect = {
  attendanceIntent: true,
  status: true,
  relationshipToGraduate: true,
  createdAt: true,
  event: {
    select: {
      title: true,
      slug: true,
      eventDate: true,
      timezone: true,
      venueName: true,
      venueAddress: true,
      eventStatus: true,
    },
  },
  attendees: {
    orderBy: [{ attendeeType: 'asc' }, { createdAt: 'asc' }],
    select: {
      firstName: true,
      lastName: true,
      attendeeType: true,
    },
  },
} satisfies Prisma.RSVPRegistrationSelect;

const organiserRegistrationSelect = {
  id: true,
  attendanceIntent: true,
  status: true,
  relationshipToGraduate: true,
  createdAt: true,
  attendees: {
    orderBy: [{ attendeeType: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      attendeeType: true,
      createdAt: true,
    },
  },
} satisfies Prisma.RSVPRegistrationSelect;

const organiserDecisionRegistrationSelect = {
  id: true,
  attendanceIntent: true,
  status: true,
  relationshipToGraduate: true,
  createdAt: true,
  approvedAt: true,
  declinedAt: true,
  attendees: {
    orderBy: [{ attendeeType: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      attendeeType: true,
      createdAt: true,
    },
  },
} satisfies Prisma.RSVPRegistrationSelect;

type ParsedRsvp = z.infer<typeof rsvpSchema>;

function splitFullName(fullName: string) {
  const [firstName, ...remainingName] = fullName.trim().split(/\s+/);
  return { firstName, lastName: remainingName.join(' ') };
}

function hashConfirmationToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashPrimaryEmail(email: string) {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

function isRegistrationConflict(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002' || error.code === 'P2034') return true;
    // Some PostgreSQL constraint violations are reported as P2010.
    if (error.code === 'P2010') {
      return error.meta?.code === '23P01' ||
        String(error.meta?.message ?? '').includes('exclusion constraint');
    }
    return false;
  }

  // Prisma reports exclusion-constraint violations (SQLSTATE 23P01) as an
  // unknown request error with no code/meta, so inspect the safe error text.
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /23P01|exclusion constraint|conflicting key value/i.test(error.message);
  }
  return false;
}

async function findAcceptingEvent(slug: string) {
  const event = await prisma.event.findFirst({
    where: {
      slug,
      eventStatus: EventStatus.PUBLISHED,
      deletedAt: null,
    },
    select: {
      id: true,
      title: true,
      slug: true,
      eventStatus: true,
      deletedAt: true,
      approvalRequired: true,
      additionalGuestLimit: true,
      maxGuestCapacity: true,
      rsvpDeadline: true,
      user: { select: { email: true } },
      eventDate: true,
      venueName: true,
    },
  });

  if (!event) {
    throw new HttpError(404, 'Event not found or RSVP is unavailable.');
  }

  if (event.rsvpDeadline && event.rsvpDeadline <= new Date()) {
    throw new HttpError(409, 'The RSVP deadline for this event has passed.');
  }

  return event;
}

export async function submitRsvp(
  slug: string,
  input: unknown,
  device: DeviceContext = defaultDeviceContext(),
) {
  const payload: ParsedRsvp = rsvpSchema.parse(input);
  const event = await findAcceptingEvent(slug);

  if (payload.attendanceIntent === AttendanceIntent.NOT_ATTENDING && payload.additionalGuestNames.length > 0) {
    throw new HttpError(400, 'Additional guests can only be included when attending.');
  }

  const token = randomBytes(32).toString('base64url');
  const confirmationTokenHash = hashConfirmationToken(token);
  const primaryName = splitFullName(payload.primaryGuestName);
  const additionalAttendees = payload.attendanceIntent === AttendanceIntent.ATTENDING
    ? payload.additionalGuestNames.map((name) => ({
      ...splitFullName(name),
      attendeeType: AttendeeType.ADDITIONAL,
    }))
    : [];
  const duplicateWindowStart = new Date(Date.now() - 5 * 60 * 1000);
  // Normalize the advisory-lock key to match the case-insensitive duplicate rule.
  const lockKey = `${event.id}:${payload.primaryGuestEmail.trim().toLowerCase()}`;

  try {
    const result = await prisma.$transaction(async (transaction) => {
      await lockEventCapacity(transaction, event.id);
      await transaction.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS advisory_lock`;

      const currentEvent = await transaction.event.findFirst({
        where: {
          id: event.id,
          eventStatus: EventStatus.PUBLISHED,
          deletedAt: null,
          OR: [{ rsvpDeadline: null }, { rsvpDeadline: { gt: new Date() } }],
        },
        select: {
          id: true,
          title: true,
          slug: true,
          approvalRequired: true,
          additionalGuestLimit: true,
          maxGuestCapacity: true,
          user: { select: { email: true } },
          eventDate: true,
          venueName: true,
        },
      });

      if (!currentEvent) {
        throw new HttpError(409, 'RSVP is no longer available for this event.');
      }

      // A device may reserve an event only once, regardless of attendance intent.
      // Checked under the event capacity lock so concurrent submissions cannot both pass.
      if (device.lookupHashes.length > 0) {
        const existingDeviceRegistration = await transaction.rSVPRegistration.findFirst({
          where: deviceRegistrationFilter(event.id, device.lookupHashes),
          select: { id: true },
        });
        if (existingDeviceRegistration) {
          throw new HttpError(409, 'A reservation has already been made for this event on this device.');
        }
      }

      if (
        payload.attendanceIntent === AttendanceIntent.ATTENDING &&
        currentEvent.additionalGuestLimit !== null &&
        payload.additionalGuestNames.length > currentEvent.additionalGuestLimit
      ) {
        throw new HttpError(400, `This event allows at most ${currentEvent.additionalGuestLimit} additional guests.`);
      }

      const recentDuplicate = await transaction.rSVPRegistration.findFirst({
        where: {
          eventId: event.id,
          createdAt: { gte: duplicateWindowStart },
          status: { not: RegistrationStatus.CANCELLED },
          attendees: {
            some: {
              attendeeType: AttendeeType.PRIMARY,
              email: { equals: payload.primaryGuestEmail, mode: 'insensitive' },
            },
          },
        },
        select: { id: true },
      });

      if (recentDuplicate) {
        throw new HttpError(409, 'A recent RSVP for this email and event was already received.');
      }

      if (payload.attendanceIntent === AttendanceIntent.ATTENDING && currentEvent.maxGuestCapacity !== null) {
        const reservedGuestCount = await countReservedGuestSpaces(transaction, event.id);
        const requestedGuestCount = 1 + payload.additionalGuestNames.length;
        if (reservedGuestCount + requestedGuestCount > currentEvent.maxGuestCapacity) {
          const availableGuestCount = Math.max(0, currentEvent.maxGuestCapacity - reservedGuestCount);
          throw new HttpError(
            409,
            `This event has ${availableGuestCount} guest space${availableGuestCount === 1 ? '' : 's'} available, but this RSVP requires ${requestedGuestCount}.`,
          );
        }
      }

      const status = payload.attendanceIntent === AttendanceIntent.NOT_ATTENDING
        ? RegistrationStatus.NOT_REQUIRED
        : currentEvent.approvalRequired
          ? RegistrationStatus.PENDING
          : RegistrationStatus.APPROVED;

      const createdRegistration = await transaction.rSVPRegistration.create({
        data: {
          eventId: event.id,
          attendanceIntent: payload.attendanceIntent,
          status,
          relationshipToGraduate: payload.relationshipToGraduate ?? null,
          confirmationTokenHash,
          primaryEmailHash: hashPrimaryEmail(payload.primaryGuestEmail),
          deviceCookieHash: device.cookieHash,
          deviceClientHash: device.clientHash ?? null,
          attendees: {
            create: [
              {
                ...primaryName,
                email: payload.primaryGuestEmail,
                phone: payload.primaryGuestPhone,
                attendeeType: AttendeeType.PRIMARY,
              },
              ...additionalAttendees,
            ],
          },
        },
        select: {
          id: true,
          attendanceIntent: true,
          status: true,
          createdAt: true,
          attendees: {
            orderBy: [{ attendeeType: 'asc' }, { createdAt: 'asc' }],
            select: { firstName: true, lastName: true, attendeeType: true },
          },
        },
      });

      // Auto-approved attending registrations never pass through decideEventRegistration,
      // so issue their tickets here while the capacity lock and transaction are still held.
      const issuedTickets = createdRegistration.status === RegistrationStatus.APPROVED &&
        createdRegistration.attendanceIntent === AttendanceIntent.ATTENDING
        ? await issueEligibleRegistrationTickets(transaction, createdRegistration.id, event.id)
        : [];

      const guestName = `${primaryName.firstName} ${primaryName.lastName}`.trim();
      const basePayload = {
        guestName,
        guestEmail: payload.primaryGuestEmail,
        eventName: currentEvent.title,
        attendanceIntent: payload.attendanceIntent,
        status: createdRegistration.status,
        eventDate: currentEvent.eventDate?.toISOString() ?? null,
        venue: currentEvent.venueName,
        dashboardUrl: env.frontendUrl
          ? `${env.frontendUrl.replace(/\/$/, '')}/dashboard/events/${encodeURIComponent(event.id)}/guests`
          : undefined,
        invitationUrl: env.frontendUrl && currentEvent.slug ? `${env.frontendUrl.replace(/\/$/, '')}/event/${encodeURIComponent(currentEvent.slug)}` : undefined,
      } as const;
      await enqueueNotification(transaction, createdRegistration.id, NotificationType.ORGANISER_NEW_RSVP, currentEvent.user.email,
        notificationPayload({ type: 'ORGANISER_NEW_RSVP', recipientEmail: currentEvent.user.email, ...basePayload }));
      await enqueueNotification(transaction, createdRegistration.id, NotificationType.GUEST_RSVP_RECEIVED, payload.primaryGuestEmail,
        notificationPayload({ type: 'GUEST_RSVP_RECEIVED', recipientEmail: payload.primaryGuestEmail, ...basePayload }));
      return { registration: createdRegistration, tickets: issuedTickets };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10000,
      timeout: 15000,
    });

    return {
      confirmationToken: token,
      ...result,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (isRegistrationConflict(error)) {
      throw new HttpError(409, 'This RSVP conflicts with an existing submission. Please try again.');
    }

    throw error;
  }
}

export async function getRsvpConfirmation(slug: string, input: unknown) {
  const { token } = confirmationSchema.parse(input);
  const registration = await prisma.rSVPRegistration.findFirst({
    where: {
      confirmationTokenHash: hashConfirmationToken(token),
      event: { is: { slug, deletedAt: null } },
    },
    select: publicConfirmationSelect,
  });

  if (!registration) {
    throw new HttpError(404, 'RSVP confirmation not found.');
  }

  return registration;
}

async function cancelRegistrationInTransaction(
  transaction: Prisma.TransactionClient,
  registration: { id: string; status: RegistrationStatus },
) {
  if (registration.status === RegistrationStatus.CANCELLED) {
    throw new HttpError(409, 'This reservation has already been cancelled.');
  }

  const cancelledAt = new Date();
  const updated = await transaction.rSVPRegistration.updateMany({
    where: { id: registration.id, status: { not: RegistrationStatus.CANCELLED } },
    data: { status: RegistrationStatus.CANCELLED, cancelledAt },
  });
  if (updated.count !== 1) {
    throw new HttpError(409, 'This reservation has already been cancelled.');
  }

  // Cancelled registrations must not leave a usable QR token behind.
  const voided = await transaction.ticket.updateMany({
    where: { attendee: { registrationId: registration.id }, ticketStatus: { not: TicketStatus.VOID } },
    data: { ticketStatus: TicketStatus.VOID },
  });

  return { cancelledAt, voidedTickets: voided.count };
}

function cancelledResult(registrationId: string, cancelledAt: Date, voidedTickets: number) {
  return {
    registration: {
      id: registrationId,
      status: RegistrationStatus.CANCELLED,
      cancelledAt,
    },
    voidedTickets,
  };
}

/** Guest-initiated cancellation. The confirmation token is the bearer credential. */
export async function cancelRsvpByToken(slug: string, input: unknown) {
  const { token } = confirmationSchema.parse(input);
  const existing = await prisma.rSVPRegistration.findFirst({
    where: {
      confirmationTokenHash: hashConfirmationToken(token),
      event: { is: { slug, deletedAt: null } },
    },
    select: { id: true, eventId: true, status: true },
  });

  if (!existing) {
    throw new HttpError(404, 'RSVP confirmation not found.');
  }

  return prisma.$transaction(async (transaction) => {
    await lockEventCapacity(transaction, existing.eventId);
    const registration = await transaction.rSVPRegistration.findFirst({
      where: { id: existing.id, eventId: existing.eventId },
      select: { id: true, status: true },
    });
    if (!registration) {
      throw new HttpError(404, 'RSVP confirmation not found.');
    }
    const outcome = await cancelRegistrationInTransaction(transaction, registration);
    return cancelledResult(registration.id, outcome.cancelledAt, outcome.voidedTickets);
  }, { maxWait: 10000, timeout: 30000 });
}

/** Organiser-initiated cancellation, scoped to an owned, non-deleted event. */
export async function cancelEventRegistration(
  eventId: string,
  registrationId: string,
  ownerId: string,
) {
  return prisma.$transaction(async (transaction) => {
    await lockEventCapacity(transaction, eventId);
    const registration = await transaction.rSVPRegistration.findFirst({
      where: {
        id: registrationId,
        eventId,
        event: { is: { userId: ownerId, deletedAt: null } },
      },
      select: { id: true, status: true },
    });
    if (!registration) {
      throw new HttpError(404, 'Registration not found.');
    }
    const outcome = await cancelRegistrationInTransaction(transaction, registration);
    return cancelledResult(registration.id, outcome.cancelledAt, outcome.voidedTickets);
  }, { maxWait: 10000, timeout: 30000 });
}

export async function listEventRegistrations(
  eventId: string,
  ownerId: string,
  page: number,
  pageSize: number,
) {
  const eventExists = await prisma.event.findFirst({
    where: { id: eventId, userId: ownerId, deletedAt: null },
    select: { id: true },
  });

  if (!eventExists) {
    throw new HttpError(404, 'Event not found.');
  }

  const where: Prisma.RSVPRegistrationWhereInput = {
    eventId,
    event: { is: { userId: ownerId, deletedAt: null } },
  };
  const [registrations, total] = await prisma.$transaction([
    prisma.rSVPRegistration.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: organiserRegistrationSelect,
    }),
    prisma.rSVPRegistration.count({ where }),
  ]);

  return {
    registrations,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getEventRegistration(eventId: string, registrationId: string, ownerId: string) {
  const registration = await prisma.rSVPRegistration.findFirst({
    where: {
      id: registrationId,
      eventId,
      event: { is: { userId: ownerId, deletedAt: null } },
    },
    select: organiserRegistrationSelect,
  });

  if (!registration) {
    throw new HttpError(404, 'Registration not found.');
  }

  return registration;
}

export async function decideEventRegistration(
  eventId: string,
  registrationId: string,
  ownerId: string,
  decision: 'approve' | 'reject',
) {
  try {
    return await prisma.$transaction(async (transaction) => {
    await lockEventCapacity(transaction, eventId);
    const registration = await transaction.rSVPRegistration.findFirst({
      where: {
        id: registrationId,
        eventId,
        event: { is: { userId: ownerId, deletedAt: null } },
      },
      select: { id: true, attendanceIntent: true, status: true, attendees: { where: { attendeeType: AttendeeType.PRIMARY }, select: { firstName: true, lastName: true, email: true } }, event: { select: { title: true, slug: true, eventDate: true, venueName: true } } },
    });

    if (!registration) {
      throw new HttpError(404, 'Registration not found.');
    }

    if (registration.status !== RegistrationStatus.PENDING) {
      throw new HttpError(409, `Only pending registrations can be ${decision === 'approve' ? 'approved' : 'rejected'}.`);
    }

    if (decision === 'approve' && registration.attendanceIntent !== AttendanceIntent.ATTENDING) {
      throw new HttpError(409, 'Only attending registrations can be approved.');
    }

    const decidedAt = new Date();
    const updateResult = await transaction.rSVPRegistration.updateMany({
      where: {
        id: registration.id,
        eventId,
        status: RegistrationStatus.PENDING,
        ...(decision === 'approve' ? { attendanceIntent: AttendanceIntent.ATTENDING } : {}),
        event: { is: { userId: ownerId, deletedAt: null } },
      },
      data: decision === 'approve'
        ? { status: RegistrationStatus.APPROVED, approvedAt: decidedAt, declinedAt: null }
        : { status: RegistrationStatus.DECLINED, approvedAt: null, declinedAt: decidedAt },
    });

    if (updateResult.count !== 1) {
      throw new HttpError(409, `Only pending registrations can be ${decision === 'approve' ? 'approved' : 'rejected'}.`);
    }

    const updatedRegistration = await transaction.rSVPRegistration.findFirst({
      where: {
        id: registration.id,
        eventId,
        event: { is: { userId: ownerId, deletedAt: null } },
      },
      select: organiserDecisionRegistrationSelect,
    });

    if (!updatedRegistration) {
      throw new HttpError(404, 'Registration not found.');
    }

    const issuedTickets = decision === 'approve'
      ? await issueEligibleRegistrationTickets(transaction, registration.id, eventId)
      : [];

    const primary = registration.attendees[0];
    const notificationType = decision === 'approve' ? NotificationType.GUEST_RSVP_APPROVED : NotificationType.GUEST_RSVP_DECLINED;
    if (primary?.email) {
      await enqueueNotification(transaction, registration.id, notificationType, primary.email,
        notificationPayload({
          type: notificationType,
          recipientEmail: primary.email,
          guestName: `${primary.firstName} ${primary.lastName}`.trim(),
          guestEmail: primary.email,
          eventName: registration.event.title,
          attendanceIntent: registration.attendanceIntent,
          status: updatedRegistration.status,
          eventDate: registration.event.eventDate?.toISOString() ?? null,
          venue: registration.event.venueName,
          invitationUrl: env.frontendUrl && registration.event.slug ? `${env.frontendUrl.replace(/\/$/, '')}/event/${encodeURIComponent(registration.event.slug)}` : undefined,
        }));
    }

    return { registration: updatedRegistration, tickets: issuedTickets };
    }, { maxWait: 10000, timeout: 30000 });
  } catch (error) {
    const diagnostic = error instanceof Prisma.PrismaClientKnownRequestError
      ? { errorType: error.name, code: error.code }
      : error instanceof Prisma.PrismaClientUnknownRequestError
        ? { errorType: error.name, code: 'UNKNOWN_REQUEST' }
        : error instanceof Prisma.PrismaClientRustPanicError
          ? { errorType: error.name, code: 'ENGINE_PANIC' }
          : { errorType: error instanceof Error ? error.name : 'UnknownError', code: 'UNCLASSIFIED' };
    console.warn('RSVP decision transaction failed', diagnostic);
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002')) {
      throw new HttpError(409, `Only pending registrations can be ${decision === 'approve' ? 'approved' : 'rejected'}.`);
    }
    throw error;
  }
}

export function parseRegistrationPagination(input: unknown) {
  return paginationSchema.parse(input);
}
