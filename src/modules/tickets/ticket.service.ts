import { createHash, randomBytes } from 'node:crypto';
import { AttendanceIntent, Prisma, RegistrationStatus, TicketStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { lockEventCapacity } from '../events/capacity.service.js';

function hashQrToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type IssuedTicket = {
  attendeeId: string;
  ticketId: string;
  qrToken: string;
};

/** Must be called inside a transaction holding the event capacity advisory lock. */
export async function issueEligibleRegistrationTickets(
  tx: Prisma.TransactionClient,
  registrationId: string,
  eventId: string,
): Promise<IssuedTicket[]> {
  const registration = await tx.rSVPRegistration.findFirst({
    where: {
      id: registrationId,
      eventId,
      status: RegistrationStatus.APPROVED,
      attendanceIntent: AttendanceIntent.ATTENDING,
    },
    select: { attendees: { orderBy: [{ attendeeType: 'asc' }, { createdAt: 'asc' }], select: { id: true } } },
  });

  if (!registration) return [];

  const issued: IssuedTicket[] = [];
  for (const attendee of registration.attendees) {
    const existing = await tx.ticket.findUnique({ where: { attendeeId: attendee.id }, select: { id: true } });
    if (existing) continue;

    const qrToken = randomBytes(32).toString('base64url');
    const ticket = await tx.ticket.create({
      data: { attendeeId: attendee.id, qrTokenHash: hashQrToken(qrToken) },
      select: { id: true },
    });
    issued.push({ attendeeId: attendee.id, ticketId: ticket.id, qrToken });
  }

  return issued;
}

export async function issueMissingEventTickets(eventId: string, ownerId: string) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findFirst({
      where: { id: eventId, userId: ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, 'Event not found.');

    await lockEventCapacity(tx, event.id);
    const registrations = await tx.rSVPRegistration.findMany({
      where: {
        eventId: event.id,
        status: RegistrationStatus.APPROVED,
        attendanceIntent: AttendanceIntent.ATTENDING,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    const tickets: IssuedTicket[] = [];
    for (const registration of registrations) {
      tickets.push(...await issueEligibleRegistrationTickets(tx, registration.id, event.id));
    }
    return { tickets, issuedCount: tickets.length };
  }, { maxWait: 10000, timeout: 30000 });
}

export async function listEventAttendees(eventId: string, ownerId: string, page: number, pageSize: number) {
  const where = { registration: { eventId, event: { is: { userId: ownerId, deletedAt: null } } } };
  const event = await prisma.event.findFirst({
    where: { id: eventId, userId: ownerId, deletedAt: null },
    select: { id: true },
  });
  if (!event) throw new HttpError(404, 'Event not found.');

  const [attendees, total] = await prisma.$transaction([
    prisma.attendee.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        attendeeType: true,
        registration: { select: { attendanceIntent: true, status: true } },
        ticket: { select: { id: true, attendance: { select: { checkedInAt: true } } } },
      },
    }),
    prisma.attendee.count({ where }),
  ]);

  return {
    attendees: attendees.map(({ registration, ticket, ...attendee }) => ({
      ...attendee,
      attendanceIntent: registration.attendanceIntent,
      registrationStatus: registration.status,
      hasTicket: ticket !== null,
      checkedIn: ticket?.attendance !== null && ticket?.attendance !== undefined,
      checkedInAt: ticket?.attendance?.checkedInAt ?? null,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

type ScanTicket = {
  id: string;
  ticketStatus: TicketStatus;
  attendance: { checkedInAt: Date } | null;
  attendee: {
    id: string;
    firstName: string;
    lastName: string;
    attendeeType: string;
    registration: { attendanceIntent: AttendanceIntent; status: RegistrationStatus };
  };
};

async function findOwnedScanTicket(
  reader: Pick<Prisma.TransactionClient, 'ticket'> | typeof prisma,
  eventId: string,
  ownerId: string,
  qrToken: string,
): Promise<ScanTicket | null> {
  return reader.ticket.findFirst({
    where: {
      qrTokenHash: hashQrToken(qrToken),
      attendee: { registration: { eventId, event: { is: { userId: ownerId, deletedAt: null } } } },
    },
    select: {
      id: true,
      ticketStatus: true,
      attendance: { select: { checkedInAt: true } },
      attendee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          attendeeType: true,
          registration: { select: { attendanceIntent: true, status: true } },
        },
      },
    },
  }) as Promise<ScanTicket | null>;
}

function ensureEligibleScanTicket(ticket: ScanTicket | null) {
  if (!ticket) throw new HttpError(404, 'Ticket not found for this event.');
  if (ticket.attendee.registration.status !== RegistrationStatus.APPROVED ||
      ticket.attendee.registration.attendanceIntent !== AttendanceIntent.ATTENDING ||
      ticket.ticketStatus !== TicketStatus.ISSUED || ticket.attendance) {
    throw new HttpError(409, 'This ticket is not eligible for check-in.');
  }
  return ticket;
}

function safeScanSummary(ticket: ScanTicket) {
  return {
    attendee: {
      id: ticket.attendee.id,
      firstName: ticket.attendee.firstName,
      lastName: ticket.attendee.lastName,
      attendeeType: ticket.attendee.attendeeType,
    },
  };
}

export async function checkInEventTicket(eventId: string, ownerId: string, qrToken: string) {
  return prisma.$transaction(async (tx) => {
    const ticket = ensureEligibleScanTicket(await findOwnedScanTicket(tx, eventId, ownerId, qrToken));
    const claimed = await tx.ticket.updateMany({
      where: { id: ticket.id, ticketStatus: TicketStatus.ISSUED },
      data: { ticketStatus: TicketStatus.USED, usedAt: new Date() },
    });
    if (claimed.count !== 1) throw new HttpError(409, 'This ticket is not eligible for check-in.');

    const checkIn = await tx.attendanceCheckIn.create({
      data: { ticketId: ticket.id, checkedInByUserId: ownerId },
      select: { checkedInAt: true },
    });
    return { message: 'Guest checked in successfully.', ...safeScanSummary(ticket), checkedInAt: checkIn.checkedInAt };
  }, { maxWait: 10000, timeout: 15000 });
}
