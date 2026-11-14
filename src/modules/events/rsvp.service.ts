import { createHash, randomBytes } from 'node:crypto';
import { AttendanceIntent, AttendeeType, EventStatus, Prisma, RegistrationStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';

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

function isRegistrationConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034');
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
      rsvpDeadline: true,
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

export async function submitRsvp(slug: string, input: unknown) {
  const payload: ParsedRsvp = rsvpSchema.parse(input);
  const event = await findAcceptingEvent(slug);

  if (payload.attendanceIntent === AttendanceIntent.NOT_ATTENDING && payload.additionalGuestNames.length > 0) {
    throw new HttpError(400, 'Additional guests can only be included when attending.');
  }

  if (
    payload.attendanceIntent === AttendanceIntent.ATTENDING &&
    event.additionalGuestLimit !== null &&
    payload.additionalGuestNames.length > event.additionalGuestLimit
  ) {
    throw new HttpError(400, `This event allows at most ${event.additionalGuestLimit} additional guests.`);
  }

  const token = randomBytes(32).toString('base64url');
  const confirmationTokenHash = hashConfirmationToken(token);
  const status = payload.attendanceIntent === AttendanceIntent.NOT_ATTENDING
    ? RegistrationStatus.NOT_REQUIRED
    : event.approvalRequired
      ? RegistrationStatus.PENDING
      : RegistrationStatus.APPROVED;
  const primaryName = splitFullName(payload.primaryGuestName);
  const additionalAttendees = payload.attendanceIntent === AttendanceIntent.ATTENDING
    ? payload.additionalGuestNames.map((name) => ({
      ...splitFullName(name),
      attendeeType: AttendeeType.ADDITIONAL,
    }))
    : [];
  const duplicateWindowStart = new Date(Date.now() - 5 * 60 * 1000);
  const lockKey = `${event.id}:${payload.primaryGuestEmail}`;

  try {
    const registration = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS advisory_lock`;

      const currentEvent = await transaction.event.findFirst({
        where: {
          id: event.id,
          eventStatus: EventStatus.PUBLISHED,
          deletedAt: null,
          OR: [{ rsvpDeadline: null }, { rsvpDeadline: { gt: new Date() } }],
        },
        select: { id: true },
      });

      if (!currentEvent) {
        throw new HttpError(409, 'RSVP is no longer available for this event.');
      }

      const recentDuplicate = await transaction.rSVPRegistration.findFirst({
        where: {
          eventId: event.id,
          createdAt: { gte: duplicateWindowStart },
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

      return transaction.rSVPRegistration.create({
        data: {
          eventId: event.id,
          attendanceIntent: payload.attendanceIntent,
          status,
          relationshipToGraduate: payload.relationshipToGraduate ?? null,
          confirmationTokenHash,
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
          attendanceIntent: true,
          status: true,
          createdAt: true,
          attendees: {
            orderBy: [{ attendeeType: 'asc' }, { createdAt: 'asc' }],
            select: { firstName: true, lastName: true, attendeeType: true },
          },
        },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10000,
      timeout: 15000,
    });

    return {
      confirmationToken: token,
      registration,
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
  return prisma.$transaction(async (transaction) => {
    const registration = await transaction.rSVPRegistration.findFirst({
      where: {
        id: registrationId,
        eventId,
        event: { is: { userId: ownerId, deletedAt: null } },
      },
      select: { id: true, attendanceIntent: true, status: true },
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

    return updatedRegistration;
  });
}

export function parseRegistrationPagination(input: unknown) {
  return paginationSchema.parse(input);
}
