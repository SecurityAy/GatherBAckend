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

/**
 * Replaces a lost ticket token with a fresh one. The old hash is overwritten, which
 * revokes the old token immediately. Never returns the raw token except to the caller.
 */
export async function reissueTicketForAttendee(eventId: string, attendeeId: string, ownerId: string) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findFirst({
      where: { id: eventId, userId: ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!event) throw new HttpError(404, 'Event not found.');

    await lockEventCapacity(tx, event.id);
    const attendee = await tx.attendee.findFirst({
      where: {
        id: attendeeId,
        registration: {
          eventId: event.id,
          status: RegistrationStatus.APPROVED,
          attendanceIntent: AttendanceIntent.ATTENDING,
        },
      },
      select: {
        id: true,
        ticket: {
          select: {
            id: true,
            ticketStatus: true,
            attendance: { select: { checkedInAt: true } },
          },
        },
      },
    });
    if (!attendee) throw new HttpError(404, 'Eligible attendee not found for this event.');
    if (attendee.ticket?.attendance) {
      throw new HttpError(409, 'A checked-in ticket cannot be reissued.');
    }
    if (attendee.ticket?.ticketStatus === TicketStatus.USED) {
      throw new HttpError(409, 'A used ticket cannot be reissued.');
    }
    if (attendee.ticket?.ticketStatus === TicketStatus.VOID) {
      throw new HttpError(409, 'A void ticket cannot be reissued.');
    }

    const qrToken = randomBytes(32).toString('base64url');
    const qrTokenHash = hashQrToken(qrToken);
    let ticketId: string;
    if (attendee.ticket) {
      // Conditional update defends against a scan that bypasses the advisory lock:
      // only a still-issued, unscanned ticket may rotate its token.
      const rotated = await tx.ticket.updateMany({
        where: {
          id: attendee.ticket.id,
          ticketStatus: TicketStatus.ISSUED,
          attendance: { is: null },
        },
        data: { qrTokenHash, ticketStatus: TicketStatus.ISSUED, usedAt: null },
      });
      if (rotated.count !== 1) {
        throw new HttpError(409, 'This ticket is no longer eligible for reissue.');
      }
      ticketId = attendee.ticket.id;
    } else {
      const created = await tx.ticket.create({
        data: { attendeeId: attendee.id, qrTokenHash },
        select: { id: true },
      });
      ticketId = created.id;
    }

    await tx.auditLog.create({
      data: {
        actorId: ownerId,
        eventId: event.id,
        action: 'TICKET_REISSUED',
        // Never persist the raw token; only the non-secret ticket identity is recorded.
        details: JSON.stringify({ ticketId, attendeeId: attendee.id }),
      },
    });

    return { attendeeId: attendee.id, ticketId, qrToken };
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
        ticket: { select: { id: true, ticketStatus: true, attendance: { select: { checkedInAt: true } } } },
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
      ticketStatus: ticket?.ticketStatus ?? null,
      checkedIn: ticket?.attendance !== null && ticket?.attendance !== undefined,
      checkedInAt: ticket?.attendance?.checkedInAt ?? null,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

type ScanTicket = {
  id: string;
  qrTokenHash: string;
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
      qrTokenHash: true,
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
  if (ticket.attendee.registration.status === RegistrationStatus.CANCELLED) {
    throw new HttpError(409, 'This reservation has been cancelled.');
  }
  if (ticket.attendee.registration.status !== RegistrationStatus.APPROVED ||
      ticket.attendee.registration.attendanceIntent !== AttendanceIntent.ATTENDING) {
    throw new HttpError(409, 'This ticket is not eligible for check-in.');
  }
  if (ticket.ticketStatus === TicketStatus.VOID) {
    throw new HttpError(409, 'This ticket has been voided and cannot be checked in.');
  }
  if (ticket.ticketStatus === TicketStatus.USED || ticket.attendance) {
    throw new HttpError(409, 'This ticket has already been checked in.');
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
    // Serialize scans with reissue, cancellation and issuance for this event so a
    // token rotation cannot land between validation and the state transition.
    await lockEventCapacity(tx, eventId);
    const ticket = ensureEligibleScanTicket(await findOwnedScanTicket(tx, eventId, ownerId, qrToken));
    // Match the exact token hash as well as the status: if a reissue rotated the
    // token after validation, the in-flight scan must fail rather than consume it.
    const claimed = await tx.ticket.updateMany({
      where: {
        id: ticket.id,
        qrTokenHash: ticket.qrTokenHash,
        ticketStatus: TicketStatus.ISSUED,
        attendance: { is: null },
      },
      data: { ticketStatus: TicketStatus.USED, usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new HttpError(409, 'This ticket is no longer eligible for check-in.');
    }

    const checkIn = await tx.attendanceCheckIn.create({
      data: { ticketId: ticket.id, checkedInByUserId: ownerId },
      select: { checkedInAt: true },
    });
    await tx.auditLog.create({
      data: {
        actorId: ownerId,
        eventId,
        action: 'TICKET_CHECKED_IN',
        // Record the non-secret identities and time; the QR token is never stored.
        details: JSON.stringify({
          ticketId: ticket.id,
          attendeeId: ticket.attendee.id,
          checkedInAt: checkIn.checkedInAt.toISOString(),
        }),
      },
    });
    return { message: 'Guest checked in successfully.', ...safeScanSummary(ticket), checkedInAt: checkIn.checkedInAt };
  }, { maxWait: 10000, timeout: 15000 });
}
