import { EventStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { capacitySummary, countReservedGuestSpaces, lockEventCapacity } from './capacity.service.js';

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

function toDashboardCounts(registrations: Array<{
  status: string;
  attendanceIntent: string;
  _count: { attendees: number };
}>) {
  return {
    registrationCount: registrations.length,
    pendingRegistrationCount: registrations.filter((item) => item.status === 'PENDING').length,
    approvedAttendeeCount: registrations
      .filter((item) => item.status === 'APPROVED' && item.attendanceIntent === 'ATTENDING')
      .reduce((total, item) => total + item._count.attendees, 0),
    reservedGuestCount: registrations
      .filter((item) => (item.status === 'PENDING' || item.status === 'APPROVED') && item.attendanceIntent === 'ATTENDING')
      .reduce((total, item) => total + item._count.attendees, 0),
  };
}

async function getDashboardCounts(eventIds: string[]) {
  if (eventIds.length === 0) {
    return new Map<string, ReturnType<typeof toDashboardCounts>>();
  }

  const registrations = await prisma.rSVPRegistration.findMany({
    where: { eventId: { in: eventIds } },
    select: registrationSummarySelect,
  });
  const grouped = new Map<string, typeof registrations>();

  for (const registration of registrations) {
    const items = grouped.get(registration.eventId) ?? [];
    items.push(registration);
    grouped.set(registration.eventId, items);
  }

  return new Map(eventIds.map((eventId) => [eventId, toDashboardCounts(grouped.get(eventId) ?? [])]));
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
      const event = await prisma.event.create({
        data: {
          ...eventData,
          slug: candidateSlug,
          userId,
          eventStatus: EventStatus.DRAFT,
          publishedAt: null,
        },
        select: eventSelect,
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

  const counts = toDashboardCounts(registrations);
  const { reservedGuestCount, ...dashboardCounts } = counts;
  return {
    ...event,
    ...capacitySummary(event.maxGuestCapacity, reservedGuestCount),
    counts: dashboardCounts,
  };
}

export async function getPublicEventBySlug(slug: string) {
  const event = await prisma.event.findFirst({
    where: { slug, eventStatus: EventStatus.PUBLISHED, deletedAt: null },
    select: { ...publicEventSelect, id: true },
  });

  if (!event) {
    throw new HttpError(404, 'Event not found.');
  }

  const reservedGuestCount = await countReservedGuestSpaces(prisma, event.id);
  const { id: _eventId, ...publicFields } = event;
  return { ...publicFields, ...capacitySummary(event.maxGuestCapacity, reservedGuestCount) };
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

    const updated = await transaction.event.update({
      where: { id: event.id },
      data: candidateSlug === undefined
        ? eventData
        : { ...eventData, slug: candidateSlug },
      select: eventSelect,
    });
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

export async function publishEvent(id: string, userId: string) {
  const event = await findOwnedEvent(id, userId);
  ensureModifiable(event.eventStatus);

  if (event.eventStatus !== EventStatus.DRAFT && event.eventStatus !== EventStatus.UNPUBLISHED) {
    throw new HttpError(409, 'Only draft or unpublished events can be published.');
  }

  const missingFields = [
    ['graduateName', event.graduateName],
    ['eventDate', event.eventDate],
    ['timezone', event.timezone],
    ['venueName', event.venueName],
  ].filter(([, value]) => value === null || value === undefined || value === '').map(([field]) => field);

  if (missingFields.length > 0) {
    throw new HttpError(400, `Complete required event details before publishing: ${missingFields.join(', ')}.`);
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: event.timezone! });
  } catch {
    throw new HttpError(400, 'Event timezone must be a valid IANA timezone.');
  }

  return prisma.event.update({
    where: { id: event.id },
    data: { eventStatus: EventStatus.PUBLISHED, publishedAt: new Date() },
    select: eventSelect,
  });
}

export async function unpublishEvent(id: string, userId: string) {
  const event = await findOwnedEvent(id, userId);
  ensureModifiable(event.eventStatus);

  if (event.eventStatus !== EventStatus.PUBLISHED) {
    throw new HttpError(409, 'Only published events can be unpublished.');
  }

  return prisma.event.update({
    where: { id: event.id },
    data: { eventStatus: EventStatus.UNPUBLISHED },
    select: eventSelect,
  });
}

export async function softDeleteEvent(id: string, userId: string) {
  const event = await findOwnedEvent(id, userId);

  return prisma.event.update({
    where: { id: event.id },
    data: { deletedAt: new Date() },
    select: eventSelect,
  });
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
