import { AttendanceIntent, AttendeeType, EventStatus, Prisma, RegistrationStatus, TicketStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { capacitySummary, countReservedGuestSpaces, lockEventCapacity } from './capacity.service.js';
import { deviceRegistrationFilter, type DeviceContext } from './device.service.js';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalUrl = z.string().url().max(2048).nullable().optional();
const optionalDate = z.string().datetime({ offset: true }).transform((value) => new Date(value)).nullable().optional();

const eventFields = {
  title: z.string().trim().min(2).max(200),
  slug: z.string().trim().min(1).max(200).optional(),
  eventCategory: z.string().trim().min(2).max(100),
  description: optionalText(10000),
  graduateName: optionalText(200),
  graduateImageUrl: optionalUrl,
  institution: optionalText(200),
  faculty: optionalText(200),
  department: optionalText(200),
  qualification: optionalText(200),
  eventDate: optionalDate,
  timezone: z.string().trim().min(1).max(100).nullable().optional(),
  venueName: optionalText(200),
  venueAddress: optionalText(1000),
  venueInstructions: optionalText(2000),
  personalMessage: optionalText(5000),
  coverImageUrl: optionalUrl,
  rsvpDeadline: optionalDate,
  additionalGuestLimit: z.number().int().min(0).max(1000).nullable().optional(),
  maxGuestCapacity: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  approvalRequired: z.boolean().optional(),
} satisfies z.ZodRawShape;

const createEventSchema = z.object(eventFields).strict();
const updateEventSchema = z.object(eventFields).partial().strict().refine(
  (payload) => Object.keys(payload).length > 0,
  'Provide at least one event field to update.',
);

const eventSelect = {
  id: true,
  userId: true,
  title: true,
  slug: true,
  eventCategory: true,
  description: true,
  graduateName: true,
  graduateImageUrl: true,
  institution: true,
  faculty: true,
  department: true,
  qualification: true,
  eventDate: true,
  timezone: true,
  venueName: true,
  venueAddress: true,
  venueInstructions: true,
  personalMessage: true,
  coverImageUrl: true,
  rsvpDeadline: true,
  additionalGuestLimit: true,
  maxGuestCapacity: true,
  approvalRequired: true,
  eventStatus: true,
  publishedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EventSelect;

const publicEventSelect = {
  title: true,
  slug: true,
  eventCategory: true,
  description: true,
  graduateName: true,
  graduateImageUrl: true,
  institution: true,
  faculty: true,
  department: true,
  qualification: true,
  eventDate: true,
  timezone: true,
  venueName: true,
  venueAddress: true,
  venueInstructions: true,
  personalMessage: true,
  coverImageUrl: true,
  rsvpDeadline: true,
  additionalGuestLimit: true,
  maxGuestCapacity: true,
} satisfies Prisma.EventSelect;

type CreateEventInput = z.infer<typeof createEventSchema>;
type UpdateEventInput = z.infer<typeof updateEventSchema>;

const registrationSummarySelect = {
  id: true,
  eventId: true,
  status: true,
  attendanceIntent: true,
  _count: { select: { attendees: true } },
} satisfies Prisma.RSVPRegistrationSelect;

function slugify(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || 'event';
}

function isSlugUniqueConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  const targetDescription = Array.isArray(target) ? target.join(' ') : String(target ?? '');
  return /slug|Event_slug_key/i.test(targetDescription);
}

function isTerminal(eventStatus: EventStatus) {
  return eventStatus === EventStatus.CANCELLED || eventStatus === EventStatus.COMPLETED;
}

type SelectedEvent = Prisma.EventGetPayload<{ select: typeof eventSelect }>;

async function writeAudit(
  writer: Pick<Prisma.TransactionClient, 'auditLog'>,
  actorId: string,
  eventId: string,
  action: string,
  details?: Record<string, unknown>,
) {
  await writer.auditLog.create({
    data: {
      actorId,
      eventId,
      action,
      ...(details === undefined ? {} : { details: JSON.stringify(details) }),
    },
  });
}

async function transitionEvent(
  eventId: string,
  userId: string,
  options: {
    allowedFrom: EventStatus[];
    nextStatus: EventStatus;
    conflictMessage: string;
    action: string;
    data: Prisma.EventUpdateInput;
    validate?: (event: SelectedEvent) => void;
    beforeUpdate?: (transaction: Prisma.TransactionClient, event: SelectedEvent) => Promise<void>;
    auditDetails?: Record<string, unknown>;
  },
) {
  return prisma.$transaction(async (transaction) => {
    await lockEventCapacity(transaction, eventId);
    const current = await transaction.event.findFirst({
      where: { id: eventId, userId, deletedAt: null },
      select: eventSelect,
    });
    if (!current) throw new HttpError(404, 'Event not found.');
    ensureModifiable(current.eventStatus);
    if (!options.allowedFrom.includes(current.eventStatus)) {
      throw new HttpError(409, options.conflictMessage);
    }
    options.validate?.(current);
    await options.beforeUpdate?.(transaction, current);

    const changed = await transaction.event.updateMany({
      where: { id: eventId, userId, deletedAt: null, eventStatus: { in: options.allowedFrom } },
      data: { ...options.data, eventStatus: options.nextStatus },
    });
    if (changed.count !== 1) {
      throw new HttpError(409, options.conflictMessage);
    }

    const updated = await transaction.event.findFirstOrThrow({
      where: { id: eventId, userId, deletedAt: null },
      select: eventSelect,
    });
    await writeAudit(transaction, userId, eventId, options.action, options.auditDetails);
    return updated;
  }, { maxWait: 10000, timeout: 30000 });
}

function toDashboardCounts(registrations: Array<{
  status: string;
  attendanceIntent: string;
  _count: { attendees: number };
}>, checkedInCount = 0) {
  return {
    registrationCount: registrations.length,
    pendingRegistrationCount: registrations.filter((item) => item.status === 'PENDING').length,
    approvedAttendeeCount: registrations
      .filter((item) => item.status === 'APPROVED' && item.attendanceIntent === 'ATTENDING')
      .reduce((total, item) => total + item._count.attendees, 0),
    reservedGuestCount: registrations
      .filter((item) => (item.status === 'PENDING' || item.status === 'APPROVED') && item.attendanceIntent === 'ATTENDING')
      .reduce((total, item) => total + item._count.attendees, 0),
    checkedInCount,
  };
}

async function getCheckedInCounts(
  registrations: Array<{ id: string; eventId: string }>,
  eventIds: string[],
) {
  if (eventIds.length === 0) {
    return new Map<string, number>();
  }

  // A check-in belongs to a ticket, which belongs to an attendee, which belongs to
  // a registration. Group at the attendee level and map through the registrations
  // already loaded for the dashboard instead of scanning tickets once per event.
  const groups = await prisma.attendee.groupBy({
    by: ['registrationId'],
    where: {
      registration: { eventId: { in: eventIds } },
      ticket: { attendance: { isNot: null } },
    },
    _count: { _all: true },
  });
  const eventByRegistration = new Map(registrations.map((item) => [item.id, item.eventId]));
  const counts = new Map<string, number>();
  for (const group of groups) {
    const eventId = eventByRegistration.get(group.registrationId);
    if (eventId) {
      counts.set(eventId, (counts.get(eventId) ?? 0) + group._count._all);
    }
  }
  return counts;
}

async function getDashboardCounts(eventIds: string[]) {
  if (eventIds.length === 0) {
    return new Map<string, ReturnType<typeof toDashboardCounts>>();
  }

  const registrations = await prisma.rSVPRegistration.findMany({
    where: { eventId: { in: eventIds } },
    select: registrationSummarySelect,
  });
  const checkedInCounts = await getCheckedInCounts(registrations, eventIds);
  const grouped = new Map<string, typeof registrations>();

  for (const registration of registrations) {
    const items = grouped.get(registration.eventId) ?? [];
    items.push(registration);
    grouped.set(registration.eventId, items);
  }

  return new Map(eventIds.map((eventId) => [
    eventId,
    toDashboardCounts(grouped.get(eventId) ?? [], checkedInCounts.get(eventId) ?? 0),
  ]));
}

export async function listEventsByUser(userId: string, page: number, pageSize: number) {
  const where = { userId, deletedAt: null };
  const [events, total] = await prisma.$transaction([
    prisma.event.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: eventSelect,
    }),
    prisma.event.count({ where }),
  ]);
  const counts = await getDashboardCounts(events.map((event) => event.id));

  return {
    events: events.map((event) => {
      const eventCounts = counts.get(event.id) ?? toDashboardCounts([]);
      const { reservedGuestCount, ...dashboardCounts } = eventCounts;
      return {
        ...event,
        ...capacitySummary(event.maxGuestCapacity, reservedGuestCount),
        counts: dashboardCounts,
      };
    }),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

export async function createEvent(userId: string, input: unknown) {
  const payload: CreateEventInput = createEventSchema.parse(input);
  const baseSlug = slugify(payload.slug ?? payload.title);
  const { slug: _requestedSlug, ...eventData } = payload;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidateSlug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;

    try {
      const event = await prisma.$transaction(async (transaction) => {
        const created = await transaction.event.create({
          data: {
            ...eventData,
            slug: candidateSlug,
            userId,
            eventStatus: EventStatus.DRAFT,
            publishedAt: null,
          },
          select: eventSelect,
        });
        await writeAudit(transaction, userId, created.id, 'EVENT_CREATED');
        return created;
      });
      return { ...event, ...capacitySummary(event.maxGuestCapacity, 0) };
    } catch (error) {
      if (!isSlugUniqueConflict(error)) {
        throw error;
      }
    }
  }

  throw new HttpError(409, 'Could not generate a unique event URL. Please try again.');
}

export async function getEventById(id: string, userId: string) {
  const event = await prisma.event.findFirst({
    where: { id, userId, deletedAt: null },
    select: eventSelect,
  });

  if (!event) {
    throw new HttpError(404, 'Event not found.');
  }

  const registrations = await prisma.rSVPRegistration.findMany({
    where: { eventId: event.id },
    select: registrationSummarySelect,
  });

  const checkedInCounts = await getCheckedInCounts(registrations, [event.id]);
  const counts = toDashboardCounts(registrations, checkedInCounts.get(event.id) ?? 0);
  const { reservedGuestCount, ...dashboardCounts } = counts;
  return {
    ...event,
    ...capacitySummary(event.maxGuestCapacity, reservedGuestCount),
    counts: dashboardCounts,
  };
}

export async function getPublicEventBySlug(slug: string, device?: DeviceContext) {
  const event = await prisma.event.findFirst({
    where: { slug, eventStatus: EventStatus.PUBLISHED, deletedAt: null },
    select: { ...publicEventSelect, id: true },
  });

  if (!event) {
    throw new HttpError(404, 'Event not found.');
  }

  const reservedGuestCount = await countReservedGuestSpaces(prisma, event.id);
  let hasReserved = false;
  if (device && device.lookupHashes.length > 0) {
    try {
      const existingRegistration = await prisma.rSVPRegistration.findFirst({
        where: deviceRegistrationFilter(event.id, device.lookupHashes),
        select: { id: true },
      });
      hasReserved = Boolean(existingRegistration);
    } catch (error) {
      // Only tolerate the device-hash columns not existing yet. Real database
      // failures must still surface instead of silently reporting a new visitor.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)
        || !['P2021', 'P2022'].includes(error.code)) {
        throw error;
      }
      console.error(`Device reservation columns are missing (${error.code}); treating the visitor as a new device until migration is applied.`);
    }
  }
  const { id: _eventId, ...publicFields } = event;
  return {
    ...publicFields,
    ...capacitySummary(event.maxGuestCapacity, reservedGuestCount),
    hasReserved,
  };
}

async function maxReservedAdditionalGuests(
  reader: Pick<Prisma.TransactionClient, 'rSVPRegistration'>,
  eventId: string,
) {
  const registrations = await reader.rSVPRegistration.findMany({
    where: {
      eventId,
      status: { in: [RegistrationStatus.PENDING, RegistrationStatus.APPROVED] },
      attendanceIntent: AttendanceIntent.ATTENDING,
    },
    select: { attendees: { where: { attendeeType: AttendeeType.ADDITIONAL }, select: { id: true } } },
  });
  return registrations.reduce((maximum, registration) => Math.max(maximum, registration.attendees.length), 0);
}

export async function updateEvent(id: string, userId: string, input: unknown) {
  const payload: UpdateEventInput = updateEventSchema.parse(input);
  const event = await findOwnedEvent(id, userId);
  ensureModifiable(event.eventStatus);
  const { slug: requestedSlug, ...eventData } = payload;

  const updateInTransaction = (candidateSlug?: string) => prisma.$transaction(async (transaction) => {
    await lockEventCapacity(transaction, event.id);
    const currentEvent = await transaction.event.findFirst({
      where: { id: event.id, userId, deletedAt: null },
      select: eventSelect,
    });
    if (!currentEvent) throw new HttpError(404, 'Event not found.');
    ensureModifiable(currentEvent.eventStatus);

    const reservedGuestCount = await countReservedGuestSpaces(transaction, event.id);
    if (
      payload.maxGuestCapacity !== undefined &&
      payload.maxGuestCapacity !== null &&
      payload.maxGuestCapacity < reservedGuestCount
    ) {
      throw new HttpError(409, `Capacity cannot be lower than the ${reservedGuestCount} guest spaces already reserved.`);
    }

    if (payload.additionalGuestLimit !== undefined && payload.additionalGuestLimit !== null) {
      const maxReservedGuests = await maxReservedAdditionalGuests(transaction, event.id);
      if (payload.additionalGuestLimit < maxReservedGuests) {
        throw new HttpError(409, `Additional guest limit cannot be lower than the ${maxReservedGuests} guests already reserved.`);
      }
    }

    const updated = await transaction.event.update({
      where: { id: event.id },
      data: candidateSlug === undefined
        ? eventData
        : { ...eventData, slug: candidateSlug },
      select: eventSelect,
    });
    const scheduleFieldsTouched = ['eventDate', 'timezone', 'rsvpDeadline']
      .some((field) => Object.prototype.hasOwnProperty.call(payload, field));
    if (scheduleFieldsTouched && updated.eventStatus === EventStatus.PUBLISHED) {
      assertPublishedSchedule(updated);
    }
    const changedFields = [...new Set([
      ...Object.keys(payload),
      ...(candidateSlug === undefined ? [] : ['slug']),
    ])];
    await writeAudit(transaction, userId, event.id, 'EVENT_UPDATED', { changedFields });
    return { ...updated, ...capacitySummary(updated.maxGuestCapacity, reservedGuestCount) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 15000 });

  if (!requestedSlug) return updateInTransaction();

  const baseSlug = slugify(requestedSlug);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidateSlug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;

    try {
      return await updateInTransaction(candidateSlug);
    } catch (error) {
      if (!isSlugUniqueConflict(error)) throw error;
    }
  }

  throw new HttpError(409, 'Could not generate a unique event URL. Please try again.');
}

function assertPublishedSchedule(event: SelectedEvent) {
  const missingScheduleFields = [
    ['eventDate', event.eventDate],
    ['timezone', event.timezone],
    ['rsvpDeadline', event.rsvpDeadline],
  ].filter(([, value]) => value === null || value === undefined || value === '').map(([field]) => field);
  if (missingScheduleFields.length > 0) {
    throw new HttpError(400, `Published events must keep a valid schedule: ${missingScheduleFields.join(', ')}.`);
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: event.timezone! });
  } catch {
    throw new HttpError(400, 'Event timezone must be a valid IANA timezone.');
  }

  const now = new Date();
  if (event.eventDate! <= now) {
    throw new HttpError(400, 'Event date must be in the future before publishing.');
  }
  if (event.rsvpDeadline! <= now) {
    throw new HttpError(400, 'RSVP deadline must be in the future before publishing.');
  }
  if (event.rsvpDeadline! >= event.eventDate!) {
    throw new HttpError(400, 'RSVP deadline must be before the event date.');
  }
}

function assertPublishable(event: SelectedEvent) {
  const missingFields = [
    ['graduateName', event.graduateName],
    ['eventDate', event.eventDate],
    ['timezone', event.timezone],
    ['venueName', event.venueName],
    ['rsvpDeadline', event.rsvpDeadline],
  ].filter(([, value]) => value === null || value === undefined || value === '').map(([field]) => field);

  if (missingFields.length > 0) {
    throw new HttpError(400, `Complete required event details before publishing: ${missingFields.join(', ')}.`);
  }

  assertPublishedSchedule(event);
}

export async function publishEvent(id: string, userId: string) {
  return transitionEvent(id, userId, {
    allowedFrom: [EventStatus.DRAFT, EventStatus.UNPUBLISHED],
    nextStatus: EventStatus.PUBLISHED,
    conflictMessage: 'Only draft or unpublished events can be published.',
    action: 'EVENT_PUBLISHED',
    data: { publishedAt: new Date() },
    validate: assertPublishable,
  });
}

export async function unpublishEvent(id: string, userId: string) {
  return transitionEvent(id, userId, {
    allowedFrom: [EventStatus.PUBLISHED],
    nextStatus: EventStatus.UNPUBLISHED,
    conflictMessage: 'Only published events can be unpublished.',
    action: 'EVENT_UNPUBLISHED',
    data: {},
  });
}

export async function cancelEvent(id: string, userId: string) {
  const cancelledAt = new Date();
  return transitionEvent(id, userId, {
    allowedFrom: [EventStatus.DRAFT, EventStatus.PUBLISHED, EventStatus.UNPUBLISHED],
    nextStatus: EventStatus.CANCELLED,
    conflictMessage: 'Only non-terminal events can be cancelled.',
    action: 'EVENT_CANCELLED',
    data: {},
    auditDetails: { cancelledAt: cancelledAt.toISOString() },
    beforeUpdate: async (transaction, current) => {
      await transaction.rSVPRegistration.updateMany({
        where: {
          eventId: current.id,
          status: { in: [RegistrationStatus.PENDING, RegistrationStatus.APPROVED] },
        },
        data: { status: RegistrationStatus.CANCELLED, cancelledAt },
      });
      // Checked-in tickets remain USED; only active tickets can be voided.
      await transaction.ticket.updateMany({
        where: {
          attendee: { registration: { eventId: current.id } },
          ticketStatus: TicketStatus.ISSUED,
        },
        data: { ticketStatus: TicketStatus.VOID },
      });
    },
  });
}

export async function completeEvent(id: string, userId: string) {
  return transitionEvent(id, userId, {
    allowedFrom: [EventStatus.PUBLISHED],
    nextStatus: EventStatus.COMPLETED,
    conflictMessage: 'Only published events can be completed.',
    action: 'EVENT_COMPLETED',
    data: {},
  });
}

export async function softDeleteEvent(id: string, userId: string) {
  return prisma.$transaction(async (transaction) => {
    await lockEventCapacity(transaction, id);
    const current = await transaction.event.findFirst({
      where: { id, userId, deletedAt: null },
      select: eventSelect,
    });
    if (!current) throw new HttpError(404, 'Event not found.');

    const deletedAt = new Date();
    const changed = await transaction.event.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt },
    });
    if (changed.count !== 1) {
      throw new HttpError(409, 'Event is no longer available.');
    }

    const updated = await transaction.event.findFirstOrThrow({
      where: { id, userId },
      select: eventSelect,
    });
    await writeAudit(transaction, userId, id, 'EVENT_DELETED', { deletedAt: deletedAt.toISOString() });
    return updated;
  }, { maxWait: 10000, timeout: 30000 });
}

async function findOwnedEvent(id: string, userId: string) {
  const event = await prisma.event.findFirst({
    where: { id, userId, deletedAt: null },
    select: eventSelect,
  });

  if (!event) {
    throw new HttpError(404, 'Event not found.');
  }

  return event;
}

function ensureModifiable(eventStatus: EventStatus) {
  if (isTerminal(eventStatus)) {
    throw new HttpError(409, 'Cancelled or completed events cannot be modified.');
  }
}
