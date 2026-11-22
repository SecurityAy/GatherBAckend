import { createHash, randomBytes } from 'node:crypto';
import { AttendanceIntent, AttendeeType, EventStatus, Prisma, RegistrationStatus, TicketDeliveryStatus, TicketStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { lockEventCapacity } from '../events/capacity.service.js';
import { enqueueTicketDelivery, notificationPayload, supersedeQueuedRegistrationTicketLinks, supersedeTicketDelivery } from '../notifications/notification-outbox.service.js';

function hashQrToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function ticketAccessUrl(qrToken: string) {
  if (!env.frontendUrl) return undefined;
  return `${env.frontendUrl.replace(/\/$/, '')}/tickets?token=${encodeURIComponent(qrToken)}`;
}

type TicketDeliveryDetails = {
  recipientEmail: string;
  recipientName: string;
  eventName: string;
  eventDate?: string | null;
  venue?: string | null;
  invitationUrl?: string;
  attendeeName: string;
  ticketId: string;
  attendeeId: string;
};

function ticketDeliveryPayload(details: TicketDeliveryDetails, qrToken: string) {
  return notificationPayload({
    type: 'TICKET_DELIVERY',
    recipientEmail: details.recipientEmail,
    recipientName: details.recipientName,
    eventName: details.eventName,
    eventDate: details.eventDate,
    venue: details.venue,
    invitationUrl: details.invitationUrl,
    ticket: {
      ticketId: details.ticketId,
      attendeeId: details.attendeeId,
      attendeeName: details.attendeeName,
      qrToken,
      ticketUrl: ticketAccessUrl(qrToken),
    },
  });
}

async function ensureTicketEventActive(
  reader: Pick<Prisma.TransactionClient, 'event'> | typeof prisma,
  eventId: string,
  ownerId: string,
) {
  const event = await reader.event.findFirst({
    where: { id: eventId, userId: ownerId, deletedAt: null },
    select: { eventStatus: true },
  });
  if (!event) throw new HttpError(404, 'Event not found.');
  if (event.eventStatus === EventStatus.CANCELLED || event.eventStatus === EventStatus.COMPLETED) {
    throw new HttpError(409, 'Ticket operations are not available for a cancelled or completed event.');
  }
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

  if (registration.attendees.length === 0) return [];

  // Batch the lookups and writes: large group RSVPs create one ticket per guest,
  // and per-attendee round trips can exceed the transaction budget on remote databases.
  const attendeeIds = registration.attendees.map((attendee) => attendee.id);
  const existing = await tx.ticket.findMany({
    where: { attendeeId: { in: attendeeIds } },
    select: { attendeeId: true },
  });
  const alreadyIssued = new Set(existing.map((ticket) => ticket.attendeeId));
  const missing = registration.attendees.filter((attendee) => !alreadyIssued.has(attendee.id));
  if (missing.length === 0) return [];

  const tokensByAttendee = new Map<string, string>();
  const created = await tx.ticket.createManyAndReturn({
    data: missing.map((attendee) => {
      const qrToken = randomBytes(32).toString('base64url');
      tokensByAttendee.set(attendee.id, qrToken);
      return { attendeeId: attendee.id, qrTokenHash: hashQrToken(qrToken) };
    }),
    select: { id: true, attendeeId: true },
  });

  return created.map((ticket) => ({
    attendeeId: ticket.attendeeId,
    ticketId: ticket.id,
    qrToken: tokensByAttendee.get(ticket.attendeeId)!,
  }));
}

export async function issueMissingEventTickets(eventId: string, ownerId: string) {
  return prisma.$transaction(async (tx) => {
    await lockEventCapacity(tx, eventId);
    await ensureTicketEventActive(tx, eventId, ownerId);
    const registrations = await tx.rSVPRegistration.findMany({
      where: {
        eventId,
        status: RegistrationStatus.APPROVED,
        attendanceIntent: AttendanceIntent.ATTENDING,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    const tickets: IssuedTicket[] = [];
    for (const registration of registrations) {
      tickets.push(...await issueEligibleRegistrationTickets(tx, registration.id, eventId));
    }
    if (tickets.length > 0) {
      await tx.auditLog.create({
        data: {
          actorId: ownerId,
          eventId,
          action: 'TICKETS_ISSUED',
          details: JSON.stringify({ ticketCount: tickets.length }),
        },
      });
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
    await lockEventCapacity(tx, eventId);
    await ensureTicketEventActive(tx, eventId, ownerId);
    const attendee = await tx.attendee.findFirst({
      where: {
        id: attendeeId,
        registration: {
          eventId,
          status: RegistrationStatus.APPROVED,
          attendanceIntent: AttendanceIntent.ATTENDING,
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        registration: {
          select: {
            id: true,
            event: { select: { slug: true, title: true, eventDate: true, venueName: true } },
          },
        },
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
        data: {
          qrTokenHash,
          ticketStatus: TicketStatus.ISSUED,
          usedAt: null,
          deliveryStatus: TicketDeliveryStatus.NOT_SENT,
          lastDeliveryAt: null,
          deliveryAttempts: 0,
          lastDeliveryError: null,
        },
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
        eventId,
        action: 'TICKET_REISSUED',
        // Never persist the raw token; only the non-secret ticket identity is recorded.
        details: JSON.stringify({ ticketId, attendeeId: attendee.id }),
      },
    });

    // A queued approval/RSVP email or delivery job must not send the old token.
    await supersedeQueuedRegistrationTicketLinks(
      tx,
      attendee.registration.id,
      ticketId,
      qrToken,
      ticketAccessUrl(qrToken),
    );
    const primaryAttendee = await tx.attendee.findFirst({
      where: { registrationId: attendee.registration.id, attendeeType: AttendeeType.PRIMARY },
      select: { email: true, firstName: true, lastName: true },
    });
    const recipientEmail = primaryAttendee?.email ?? attendee.email;
    if (recipientEmail) {
      const event = attendee.registration.event;
      const invitationUrl = env.frontendUrl && event.slug
        ? `${env.frontendUrl.replace(/\/$/, '')}/event/${encodeURIComponent(event.slug)}`
        : undefined;
      await supersedeTicketDelivery(
        tx,
        ticketId,
        recipientEmail,
        ticketDeliveryPayload({
          recipientEmail,
          recipientName: `${primaryAttendee?.firstName ?? attendee.firstName} ${primaryAttendee?.lastName ?? attendee.lastName}`.trim(),
          eventName: event.title,
          eventDate: event.eventDate?.toISOString() ?? null,
          venue: event.venueName,
          invitationUrl,
          attendeeName: `${attendee.firstName} ${attendee.lastName}`.trim(),
          ticketId,
          attendeeId: attendee.id,
        }, qrToken),
        `ticket-delivery:${ticketId}`,
      );
    }

    return { attendeeId: attendee.id, ticketId, qrToken };
  }, { maxWait: 10000, timeout: 30000 });
}

/**
 * Rotates a ticket token and queues a delivery email in the same transaction.
 * The raw token is only returned to the email worker; this endpoint response stays secret-free.
 */
export async function resendTicketEmailById(eventId: string, ticketId: string, ownerId: string) {
  return prisma.$transaction(async (tx) => {
    await lockEventCapacity(tx, eventId);
    await ensureTicketEventActive(tx, eventId, ownerId);

    const ticket = await tx.ticket.findFirst({
      where: {
        id: ticketId,
        attendee: {
          registration: {
            eventId,
            status: RegistrationStatus.APPROVED,
            attendanceIntent: AttendanceIntent.ATTENDING,
          },
        },
      },
      select: {
        id: true,
        attendeeId: true,
        ticketStatus: true,
        attendance: { select: { id: true } },
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            registration: {
              select: {
                id: true,
                event: { select: { slug: true, title: true, eventDate: true, venueName: true } },
              },
            },
          },
        },
      },
    });
    if (!ticket) throw new HttpError(404, 'Ticket not found for this event.');
    if (ticket.attendance) throw new HttpError(409, 'A checked-in ticket cannot be resent.');
    if (ticket.ticketStatus === TicketStatus.USED) throw new HttpError(409, 'A used ticket cannot be resent.');
    if (ticket.ticketStatus === TicketStatus.VOID) throw new HttpError(409, 'A void ticket cannot be resent.');

    const primaryAttendee = await tx.attendee.findFirst({
      where: { registrationId: ticket.attendee.registration.id, attendeeType: AttendeeType.PRIMARY },
      select: { email: true, firstName: true, lastName: true },
    });
    const recipientEmail = primaryAttendee?.email ?? ticket.attendee.email;
    if (!recipientEmail) throw new HttpError(409, 'No email address is available for this ticket.');

    const qrToken = randomBytes(32).toString('base64url');
    const rotated = await tx.ticket.updateMany({
      where: {
        id: ticket.id,
        ticketStatus: TicketStatus.ISSUED,
        attendance: { is: null },
      },
      data: {
        qrTokenHash: hashQrToken(qrToken),
        deliveryStatus: TicketDeliveryStatus.NOT_SENT,
        lastDeliveryAt: null,
        deliveryAttempts: 0,
        lastDeliveryError: null,
      },
    });
    if (rotated.count !== 1) {
      throw new HttpError(409, 'This ticket is no longer eligible for email delivery.');
    }

    await tx.auditLog.create({
      data: {
        actorId: ownerId,
        eventId,
        action: 'TICKET_REISSUED',
        // Never persist the raw token or generated email link.
        details: JSON.stringify({ ticketId: ticket.id, attendeeId: ticket.attendeeId, reason: 'EMAIL_RESEND' }),
      },
    });

    const event = ticket.attendee.registration.event;
    const invitationUrl = env.frontendUrl && event.slug
      ? `${env.frontendUrl.replace(/\/$/, '')}/event/${encodeURIComponent(event.slug)}`
      : undefined;
    await enqueueTicketDelivery(
      tx,
      ticket.id,
      recipientEmail,
      ticketDeliveryPayload({
        recipientEmail,
        recipientName: `${primaryAttendee?.firstName ?? ticket.attendee.firstName} ${primaryAttendee?.lastName ?? ticket.attendee.lastName}`.trim(),
        eventName: event.title,
        eventDate: event.eventDate?.toISOString() ?? null,
        venue: event.venueName,
        invitationUrl,
        attendeeName: `${ticket.attendee.firstName} ${ticket.attendee.lastName}`.trim(),
        ticketId: ticket.id,
        attendeeId: ticket.attendeeId,
      }, qrToken),
      `ticket-delivery:${ticket.id}`,
    );
    await supersedeQueuedRegistrationTicketLinks(
      tx,
      ticket.attendee.registration.id,
      ticket.id,
      qrToken,
      ticketAccessUrl(qrToken),
    );

    return {
      ticketId: ticket.id,
      attendeeId: ticket.attendeeId,
      deliveryStatus: TicketDeliveryStatus.NOT_SENT,
      message: 'Ticket email queued.',
    };
  }, { maxWait: 10000, timeout: 30000 });
}

/** Permanently disables an unscanned ticket. The raw token is not returned. */
export async function revokeTicketForAttendee(eventId: string, attendeeId: string, ownerId: string) {
  return prisma.$transaction(async (tx) => {
    await lockEventCapacity(tx, eventId);
    await ensureTicketEventActive(tx, eventId, ownerId);
    const attendee = await tx.attendee.findFirst({
      where: {
        id: attendeeId,
        registration: {
          eventId,
          status: RegistrationStatus.APPROVED,
          attendanceIntent: AttendanceIntent.ATTENDING,
        },
      },
      select: {
        id: true,
        ticket: {
          select: { id: true, ticketStatus: true, attendance: { select: { id: true } } },
        },
      },
    });
    if (!attendee) throw new HttpError(404, 'Eligible attendee not found for this event.');
    const ticket = attendee.ticket;
    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    if (ticket.ticketStatus === TicketStatus.VOID) {
      throw new HttpError(409, 'This ticket has already been revoked.');
    }
    if (ticket.ticketStatus === TicketStatus.USED || ticket.attendance) {
      throw new HttpError(409, 'A checked-in ticket cannot be revoked.');
    }

    const revoked = await tx.ticket.updateMany({
      where: {
        id: ticket.id,
        ticketStatus: TicketStatus.ISSUED,
        attendance: { is: null },
      },
      data: { ticketStatus: TicketStatus.VOID },
    });
    if (revoked.count !== 1) {
      throw new HttpError(409, 'This ticket is no longer eligible for revocation.');
    }

    await tx.auditLog.create({
      data: {
        actorId: ownerId,
        eventId,
        action: 'TICKET_REVOKED',
        details: JSON.stringify({ ticketId: ticket.id, attendeeId: attendee.id }),
      },
    });

    return { attendeeId: attendee.id, ticketId: ticket.id, ticketStatus: TicketStatus.VOID };
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

export async function listEventTickets(eventId: string, ownerId: string, page: number, pageSize: number) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, userId: ownerId, deletedAt: null },
    select: { id: true },
  });
  if (!event) throw new HttpError(404, 'Event not found.');

  const where = {
    attendee: { registration: { eventId, event: { is: { userId: ownerId, deletedAt: null } } } },
  };
  const [tickets, total] = await prisma.$transaction([
    prisma.ticket.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        attendeeId: true,
        ticketStatus: true,
        deliveryStatus: true,
        lastDeliveryAt: true,
        deliveryAttempts: true,
        issuedAt: true,
        usedAt: true,
        attendee: { select: { firstName: true, lastName: true } },
        attendance: { select: { checkedInAt: true } },
      },
    }),
    prisma.ticket.count({ where }),
  ]);

  return {
    tickets: tickets.map(({ attendee, attendance, ...ticket }) => ({
      id: ticket.id,
      attendeeId: ticket.attendeeId,
      attendeeName: `${attendee.firstName} ${attendee.lastName}`.trim(),
      ticketStatus: ticket.ticketStatus,
      revoked: ticket.ticketStatus === TicketStatus.VOID,
      deliveryStatus: ticket.deliveryStatus,
      lastDeliveryAt: ticket.lastDeliveryAt,
      deliveryAttempts: ticket.deliveryAttempts,
      issuedAt: ticket.issuedAt,
      usedAt: ticket.usedAt,
      checkedInAt: attendance?.checkedInAt ?? null,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

async function findOwnedTicketAttendeeId(eventId: string, ticketId: string, ownerId: string) {
  const ticket = await prisma.ticket.findFirst({
    where: {
      id: ticketId,
      attendee: { registration: { eventId, event: { is: { userId: ownerId, deletedAt: null } } } },
    },
    select: { attendeeId: true },
  });
  if (!ticket) throw new HttpError(404, 'Ticket not found for this event.');
  return ticket.attendeeId;
}

/** Ticket-id variant of the attendee reissue route, kept additive for existing clients. */
export async function reissueTicketById(eventId: string, ticketId: string, ownerId: string) {
  const attendeeId = await findOwnedTicketAttendeeId(eventId, ticketId, ownerId);
  return reissueTicketForAttendee(eventId, attendeeId, ownerId);
}

/** Ticket-id variant of the attendee revoke route, kept additive for existing clients. */
export async function revokeTicketById(eventId: string, ticketId: string, ownerId: string) {
  const attendeeId = await findOwnedTicketAttendeeId(eventId, ticketId, ownerId);
  return revokeTicketForAttendee(eventId, attendeeId, ownerId);
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
    await ensureTicketEventActive(tx, eventId, ownerId);
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
