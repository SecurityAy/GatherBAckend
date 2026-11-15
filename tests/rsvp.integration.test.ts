import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { AttendanceIntent, AttendeeType, EventStatus, NotificationStatus, NotificationType, RegistrationStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import { env, readResendConfiguration } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import app from '../src/app.js';
import { decideEventRegistration, getRsvpConfirmation, submitRsvp } from '../src/modules/events/rsvp.service.js';
import { notificationRetryDelay, runNotificationWorkerOnce, setNotificationSenderForTests } from '../src/modules/notifications/notification-outbox.service.js';
import { renderNotificationEmail } from '../src/modules/notifications/email-templates.js';

const suffix = randomUUID();
const emailPrefix = `rsvp-integration-${suffix}`;
const testUserIds: string[] = [];
const testEventIds: string[] = [];
let server: ReturnType<typeof app.listen> | undefined;
let ownerId: string;
let otherOwnerId: string;
let publishedEventId: string;
let publishedEventSlug: string;
let unpublishedEventSlug: string;
let deadlineEventSlug: string;
let otherEventId: string;
let otherEventSlug: string;

function accessToken(userId: string) {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: '5m', algorithm: 'HS256' });
}

async function request(path: string, init?: RequestInit) {
  assert.ok(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

function rsvpBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    primaryGuestName: 'Integration Guest',
    primaryGuestEmail: email,
    primaryGuestPhone: '+1 555 123 4567',
    attendanceIntent: AttendanceIntent.ATTENDING,
    additionalGuestNames: [],
    ...overrides,
  };
}

function expectHttpError(statusCode: number) {
  return (error: unknown) =>
    error instanceof Error &&
    'statusCode' in error &&
    error.statusCode === statusCode;
}

type CapacityResponse = {
  maxGuestCapacity: number | null;
  reservedGuestCount: number;
  availableGuestCount: number | null;
};

test('public RSVP validation, persistence, confirmation, ownership, and throttling', async () => {
  try {
    const [owner, otherOwner] = await Promise.all([
      prisma.user.create({
        data: {
          firstName: 'Test',
          lastName: 'Owner',
          email: `${emailPrefix}-owner@example.test`,
          passwordHash: 'test-only-hash',
        },
      }),
      prisma.user.create({
        data: {
          firstName: 'Other',
          lastName: 'Owner',
          email: `${emailPrefix}-other-owner@example.test`,
          passwordHash: 'test-only-hash',
        },
      }),
    ]);
    ownerId = owner.id;
    otherOwnerId = otherOwner.id;
    testUserIds.push(owner.id, otherOwner.id);

    const publishedEvent = await prisma.event.create({
      data: {
        userId: ownerId,
        title: 'Temporary RSVP Integration',
        slug: `rsvp-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        approvalRequired: true,
        additionalGuestLimit: 2,
      },
    });
    publishedEventId = publishedEvent.id;
    publishedEventSlug = publishedEvent.slug;
    testEventIds.push(publishedEvent.id);

    const unpublishedEvent = await prisma.event.create({
      data: {
        userId: ownerId,
        title: 'Temporary Unpublished RSVP Integration',
        slug: `rsvp-unpublished-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.UNPUBLISHED,
      },
    });
    unpublishedEventSlug = unpublishedEvent.slug;
    testEventIds.push(unpublishedEvent.id);

    const deadlineEvent = await prisma.event.create({
      data: {
        userId: ownerId,
        title: 'Temporary Expired RSVP Integration',
        slug: `rsvp-expired-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        rsvpDeadline: new Date(Date.now() - 60_000),
      },
    });
    deadlineEventSlug = deadlineEvent.slug;
    testEventIds.push(deadlineEvent.id);

    const otherEvent = await prisma.event.create({
      data: {
        userId: otherOwnerId,
        title: 'Temporary Other Owner RSVP Integration',
        slug: `rsvp-other-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
      },
    });
    otherEventId = otherEvent.id;
    otherEventSlug = otherEvent.slug;
    testEventIds.push(otherEvent.id);

    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });

    await assert.rejects(
      submitRsvp(publishedEventSlug, rsvpBody(`${emailPrefix}-missing-phone@example.test`, { primaryGuestPhone: undefined })),
      ZodError,
      'missing primary guest phone must be rejected',
    );

    await assert.rejects(
      submitRsvp(publishedEventSlug, rsvpBody(`${emailPrefix}-bad-relationship@example.test`, { relationshipToGraduate: 42 })),
      ZodError,
      'a supplied non-string relationship must be rejected',
    );

    await assert.rejects(
      submitRsvp(publishedEventSlug, rsvpBody(`${emailPrefix}-protected-field@example.test`, { eventId: otherEventId })),
      ZodError,
      'client-supplied event IDs must be rejected',
    );

    const missingPhoneResponse = await request(`/api/events/public/${publishedEventSlug}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rsvpBody(`${emailPrefix}-missing-phone-http@example.test`, { primaryGuestPhone: undefined })),
    });
    assert.equal(missingPhoneResponse.status, 400);
    assert.equal((await missingPhoneResponse.json()).message, 'Request validation failed.');

    const unpublishedResponse = await request(`/api/events/public/${unpublishedEventSlug}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rsvpBody(`${emailPrefix}-unpublished@example.test`)),
    });
    assert.equal(unpublishedResponse.status, 404);

    await assert.rejects(
      submitRsvp(deadlineEventSlug, rsvpBody(`${emailPrefix}-expired@example.test`)),
      expectHttpError(409),
      'an expired RSVP deadline must be rejected',
    );

    const submissionResponse = await request(`/api/events/public/${publishedEventSlug}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rsvpBody(`${emailPrefix}-primary@example.test`, {
        additionalGuestNames: ['Additional Guest One', 'Additional Guest Two'],
      })),
    });
    assert.equal(submissionResponse.status, 201);
    const submission = await submissionResponse.json() as {
      confirmationToken: string;
      registration: { status: RegistrationStatus; attendees: Array<{ attendeeType: AttendeeType }> };
    };
    assert.equal(submission.registration.status, RegistrationStatus.PENDING);
    assert.equal(submission.registration.attendees.length, 3);
    assert.equal(submission.registration.attendees.filter(({ attendeeType }) => attendeeType === AttendeeType.PRIMARY).length, 1);
    assert.equal(submission.registration.attendees.filter(({ attendeeType }) => attendeeType === AttendeeType.ADDITIONAL).length, 2);
    assert.match(submission.confirmationToken, /^[A-Za-z0-9_-]{43}$/);

    const tokenHash = createHash('sha256').update(submission.confirmationToken).digest('hex');
    const registration = await prisma.rSVPRegistration.findUnique({
      where: { confirmationTokenHash: tokenHash },
      include: { attendees: true },
    });
    assert.ok(registration);
    assert.equal(registration.relationshipToGraduate, null, 'relationship is optional and stored as null');
    assert.equal(registration.confirmationTokenHash, tokenHash, 'only the token hash is stored');
    assert.equal(await prisma.ticket.count({ where: { attendee: { registrationId: registration.id } } }), 0);

    await assert.rejects(
      submitRsvp(publishedEventSlug, rsvpBody(`${emailPrefix}-primary@example.test`)),
      expectHttpError(409),
      'a recent same-event RSVP from the same email must be rejected',
    );

    const confirmationResponse = await request(`/api/events/public/${publishedEventSlug}/rsvp/confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: submission.confirmationToken }),
    });
    assert.equal(confirmationResponse.status, 200);
    const confirmationBody = await confirmationResponse.text();
    assert.ok(!confirmationBody.includes(submission.confirmationToken));
    assert.ok(!confirmationBody.includes(tokenHash));
    const confirmation = JSON.parse(confirmationBody) as { confirmation: { attendees: Array<{ firstName: string }> } };
    assert.equal(confirmation.confirmation.attendees.length, 3);

    const invalidConfirmation = await request(`/api/events/public/${publishedEventSlug}/rsvp/confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'A'.repeat(43) }),
    });
    assert.equal(invalidConfirmation.status, 404);
    await assert.rejects(
      getRsvpConfirmation(otherEventSlug, { token: submission.confirmationToken }),
      expectHttpError(404),
      'a token must not work for another event',
    );

    const notAttending = await submitRsvp(publishedEventSlug, rsvpBody(`${emailPrefix}-not-attending@example.test`, {
      attendanceIntent: AttendanceIntent.NOT_ATTENDING,
    }));
    const notAttendingHash = createHash('sha256').update(notAttending.confirmationToken).digest('hex');
    const notAttendingRecord = await prisma.rSVPRegistration.findUnique({
      where: { confirmationTokenHash: notAttendingHash },
      include: { attendees: true },
    });
    assert.ok(notAttendingRecord);
    assert.equal(notAttendingRecord.status, RegistrationStatus.NOT_REQUIRED);
    assert.equal(notAttendingRecord.attendees.length, 1);
    assert.equal(notAttendingRecord.attendees[0].attendeeType, AttendeeType.PRIMARY);
    assert.equal(await prisma.ticket.count({ where: { attendee: { registrationId: notAttendingRecord.id } } }), 0);

    const unauthenticatedList = await request(`/api/events/${publishedEventId}/rsvps`);
    assert.equal(unauthenticatedList.status, 401);

    const ownerHeaders = { Authorization: `Bearer ${accessToken(ownerId)}` };
    const ownerList = await request(`/api/events/${publishedEventId}/rsvps?page=1&pageSize=20`, { headers: ownerHeaders });
    assert.equal(ownerList.status, 200);
    const ownerListResult = await ownerList.json() as {
      registrations: Array<{ id: string }>;
      pagination: { total: number; page: number; pageSize: number };
    };
    assert.equal(ownerListResult.pagination.total, 2);
    assert.equal(ownerListResult.pagination.page, 1);
    assert.equal(ownerListResult.pagination.pageSize, 20);
    const listedRegistration = ownerListResult.registrations.find(({ id }) => id === registration.id);
    assert.ok(listedRegistration);

    const ownerDetail = await request(`/api/events/${publishedEventId}/rsvps/${registration.id}`, { headers: ownerHeaders });
    assert.equal(ownerDetail.status, 200);

    const otherHeaders = { Authorization: `Bearer ${accessToken(otherOwnerId)}` };
    const otherOwnerList = await request(`/api/events/${publishedEventId}/rsvps`, { headers: otherHeaders });
    assert.equal(otherOwnerList.status, 404);
    const otherOwnerDetail = await request(`/api/events/${publishedEventId}/rsvps/${registration.id}`, { headers: otherHeaders });
    assert.equal(otherOwnerDetail.status, 404);

    const unknownSlug = `rsvp-rate-limit-${suffix}`;
    const submissionRateLimitIp = '198.51.100.201';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(`/api/events/public/${unknownSlug}/rsvp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': submissionRateLimitIp,
        },
        body: JSON.stringify(rsvpBody(`${emailPrefix}-rate-${attempt}@example.test`)),
      });
      assert.equal(response.status, 404);
    }
    const rateLimitedRsvp = await request(`/api/events/public/${unknownSlug}/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': submissionRateLimitIp,
      },
      body: JSON.stringify(rsvpBody(`${emailPrefix}-rate-limit@example.test`)),
    });
    assert.equal(rateLimitedRsvp.status, 429);
    assert.match(rateLimitedRsvp.headers.get('retry-after') ?? '', /^\d+$/);
    assert.ok(Number(rateLimitedRsvp.headers.get('retry-after')) > 0);

    const forwardedClientIp = '203.0.113.42';
    for (const spoofedForwardedIp of ['198.51.100.10', '198.51.100.99']) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await request(`/api/events/public/${unknownSlug}/rsvp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `${spoofedForwardedIp}, ${forwardedClientIp}`,
          },
          body: JSON.stringify(rsvpBody(`${emailPrefix}-proxy-${spoofedForwardedIp}-${attempt}@example.test`)),
        });
        if (spoofedForwardedIp.endsWith('99') && attempt === 2) {
          assert.equal(response.status, 429, 'the trusted rightmost client IP shares a bucket despite a changed leftmost forwarded value');
          assert.match(response.headers.get('retry-after') ?? '', /^\d+$/);
          assert.ok(Number(response.headers.get('retry-after')) > 0);
        } else {
          assert.equal(response.status, 404);
        }
      }
    }

    const confirmationRateLimitIp = '198.51.100.202';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(`/api/events/public/${publishedEventSlug}/rsvp/confirmation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': confirmationRateLimitIp,
        },
        body: JSON.stringify({ token: 'A'.repeat(43) }),
      });
      assert.equal(response.status, 404);
    }
    const rateLimitedConfirmation = await request(`/api/events/public/${publishedEventSlug}/rsvp/confirmation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': confirmationRateLimitIp,
      },
      body: JSON.stringify({ token: 'A'.repeat(43) }),
    });
    assert.equal(rateLimitedConfirmation.status, 429);
    assert.match(rateLimitedConfirmation.headers.get('retry-after') ?? '', /^\d+$/);
    assert.ok(Number(rateLimitedConfirmation.headers.get('retry-after')) > 0);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (testEventIds.length) {
      await prisma.attendanceCheckIn.deleteMany({
        where: { ticket: { attendee: { registration: { eventId: { in: testEventIds } } } } },
      });
      await prisma.ticket.deleteMany({ where: { attendee: { registration: { eventId: { in: testEventIds } } } } });
      await prisma.attendee.deleteMany({ where: { registration: { eventId: { in: testEventIds } } } });
      await prisma.rSVPRegistration.deleteMany({ where: { eventId: { in: testEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: testEventIds } } });
    }
    if (testUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
    }
  }
});

test('event guest capacity accounts for reserved attendee rows and serializes submissions and updates', async () => {
  const suffix = randomUUID();
  const eventIds: string[] = [];
  const userIds: string[] = [];
  let capacityServer: ReturnType<typeof app.listen> | undefined;

  try {
    const owner = await prisma.user.create({
      data: {
        firstName: 'Capacity',
        lastName: 'Owner',
        email: `capacity-owner-${suffix}@example.test`,
        passwordHash: 'test-only-hash',
      },
    });
    userIds.push(owner.id);
    const ownerHeaders = { Authorization: `Bearer ${accessToken(owner.id)}` };

    capacityServer = app.listen(0);
    server = capacityServer;
    await new Promise<void>((resolve, reject) => {
      capacityServer!.once('listening', resolve);
      capacityServer!.once('error', reject);
    });

    let rateLimitIp = 1;
    const nextHeaders = () => ({
      'Content-Type': 'application/json',
      'X-Forwarded-For': `198.18.${Math.floor(rateLimitIp / 250)}.${rateLimitIp++ % 250 + 1}`,
    });
    const postSubmission = (slug: string, email: string, additionalGuestNames: string[] = [], attendanceIntent = AttendanceIntent.ATTENDING) =>
      request(`/api/events/public/${slug}/rsvp`, {
        method: 'POST',
        headers: nextHeaders(),
        body: JSON.stringify(rsvpBody(email, { additionalGuestNames, attendanceIntent })),
      });

    const event = await prisma.event.create({
      data: {
        userId: owner.id,
        title: 'Capacity 100 Event',
        slug: `capacity-100-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        approvalRequired: true,
        additionalGuestLimit: 100,
        maxGuestCapacity: 100,
      },
    });
    eventIds.push(event.id);

    const attendeeData = (count: number) => Array.from({ length: count }, (_, index) => ({
      firstName: `Guest${index}`,
      lastName: 'Capacity',
      email: index === 0 ? `capacity-fixture-${suffix}-${count}@example.test` : null,
      attendeeType: index === 0 ? AttendeeType.PRIMARY : AttendeeType.ADDITIONAL,
    }));
    const pendingGroup = await prisma.rSVPRegistration.create({
      data: {
        eventId: event.id,
        attendanceIntent: AttendanceIntent.ATTENDING,
        status: RegistrationStatus.PENDING,
        attendees: { create: attendeeData(72) },
      },
      select: { id: true },
    });
    await prisma.rSVPRegistration.create({
      data: {
        eventId: event.id,
        attendanceIntent: AttendanceIntent.ATTENDING,
        status: RegistrationStatus.CANCELLED,
        cancelledAt: new Date(),
        attendees: { create: attendeeData(4) },
      },
    });
    await prisma.rSVPRegistration.create({
      data: {
        eventId: event.id,
        attendanceIntent: AttendanceIntent.NOT_ATTENDING,
        status: RegistrationStatus.NOT_REQUIRED,
        attendees: { create: attendeeData(1) },
      },
    });

    const cancelledLater = await prisma.rSVPRegistration.create({
      data: {
        eventId: event.id,
        attendanceIntent: AttendanceIntent.ATTENDING,
        status: RegistrationStatus.PENDING,
        attendees: { create: attendeeData(2) },
      },
      select: { id: true },
    });
    const beforeCancellation = await request(`/api/events/${event.id}`, { headers: ownerHeaders });
    assert.equal(((await beforeCancellation.json()) as { event: CapacityResponse }).event.reservedGuestCount, 74);
    await prisma.rSVPRegistration.update({
      where: { id: cancelledLater.id },
      data: { status: RegistrationStatus.CANCELLED, cancelledAt: new Date() },
    });
    const afterCancellation = await request(`/api/events/${event.id}`, { headers: ownerHeaders });
    assert.equal(((await afterCancellation.json()) as { event: CapacityResponse }).event.reservedGuestCount, 72);

    const publicSummary = await request(`/api/events/public/${event.slug}`);
    assert.equal(publicSummary.status, 200);
    const publicEvent = (await publicSummary.json() as { event: CapacityResponse }).event;
    assert.equal(publicEvent.maxGuestCapacity, 100);
    assert.equal(publicEvent.reservedGuestCount, 72);
    assert.equal(publicEvent.availableGuestCount, 28);

    const ownerEventResponse = await request(`/api/events/${event.id}`, { headers: ownerHeaders });
    assert.equal(ownerEventResponse.status, 200);
    const ownerEvent = (await ownerEventResponse.json() as { event: CapacityResponse }).event;
    assert.equal(ownerEvent.reservedGuestCount, 72);
    assert.equal(ownerEvent.availableGuestCount, 28);

    const tooLow = await request(`/api/events/${event.id}`, {
      method: 'PATCH',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxGuestCapacity: 71 }),
    });
    assert.equal(tooLow.status, 409);
    assert.match((await tooLow.json()).message, /72 guest spaces already reserved/);

    for (const capacity of [100, 101, 73]) {
      const updated = await request(`/api/events/${event.id}`, {
        method: 'PATCH',
        headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxGuestCapacity: capacity }),
      });
      assert.equal(updated.status, 200);
      assert.equal(((await updated.json()) as { event: { maxGuestCapacity: number } }).event.maxGuestCapacity, capacity);
    }

    const beforeOverflowRegistrations = await prisma.rSVPRegistration.count({ where: { eventId: event.id } });
    const beforeOverflowNotifications = await prisma.notificationOutbox.count({ where: { registration: { eventId: event.id } } });
    const overflow = await postSubmission(event.slug, `capacity-overflow-${suffix}@example.test`, ['Extra Guest One', 'Extra Guest Two']);
    assert.equal(overflow.status, 409);
    assert.match((await overflow.json()).message, /1 guest space available.*requires 3/);
    assert.equal(await prisma.rSVPRegistration.count({ where: { eventId: event.id } }), beforeOverflowRegistrations);
    assert.equal(await prisma.notificationOutbox.count({ where: { registration: { eventId: event.id } } }), beforeOverflowNotifications);

    const oneSpace = await postSubmission(event.slug, `capacity-one-${suffix}@example.test`);
    assert.equal(oneSpace.status, 201);
    const oneSpaceResult = await oneSpace.json() as { registration: { status: RegistrationStatus } };
    assert.equal(oneSpaceResult.registration.status, RegistrationStatus.PENDING);
    const fullSummary = await request(`/api/events/${event.id}`, { headers: ownerHeaders });
    const fullEvent = (await fullSummary.json() as { event: CapacityResponse }).event;
    assert.equal(fullEvent.reservedGuestCount, 73);
    assert.equal(fullEvent.availableGuestCount, 0);

    const oneSpaceRegistration = await prisma.rSVPRegistration.findFirstOrThrow({
      where: { eventId: event.id, attendees: { some: { email: `capacity-one-${suffix}@example.test` } } },
      select: { id: true },
    });
    const approval = await request(`/api/events/${event.id}/rsvps/${oneSpaceRegistration.id}/approve`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(approval.status, 200);
    const afterApproval = await request(`/api/events/${event.id}`, { headers: ownerHeaders });
    assert.equal(((await afterApproval.json()) as { event: CapacityResponse }).event.reservedGuestCount, 73);

    const notAttending = await postSubmission(
      event.slug,
      `capacity-no-${suffix}@example.test`,
      [],
      AttendanceIntent.NOT_ATTENDING,
    );
    assert.equal(notAttending.status, 201, 'NOT_ATTENDING must remain possible when full');
    const afterNotAttending = await request(`/api/events/${event.id}`, { headers: ownerHeaders });
    assert.equal(((await afterNotAttending.json()) as { event: CapacityResponse }).event.reservedGuestCount, 73);

    const decline = await request(`/api/events/${event.id}/rsvps/${pendingGroup.id}/reject`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(decline.status, 200);
    const afterDecline = await request(`/api/events/${event.id}`, { headers: ownerHeaders });
    assert.equal(((await afterDecline.json()) as { event: CapacityResponse }).event.reservedGuestCount, 1);

    const createdZero = await request('/api/events', {
      method: 'POST',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Zero Capacity Event', eventCategory: 'Test', maxGuestCapacity: 0 }),
    });
    assert.equal(createdZero.status, 201);
    const zeroEvent = (await createdZero.json() as { event: {
      id: string;
      slug: string;
      maxGuestCapacity: number | null;
      reservedGuestCount: number;
      availableGuestCount: number | null;
    } }).event;
    eventIds.push(zeroEvent.id);
    await prisma.event.update({
      where: { id: zeroEvent.id },
      data: { eventStatus: EventStatus.PUBLISHED, approvalRequired: true },
    });
    assert.equal(zeroEvent.maxGuestCapacity, 0);
    assert.equal(zeroEvent.reservedGuestCount, 0);
    assert.equal(zeroEvent.availableGuestCount, 0);

    for (const invalidCapacity of [-1, 1.5]) {
      const invalid = await request('/api/events', {
        method: 'POST',
        headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Invalid Capacity ${invalidCapacity}`, eventCategory: 'Test', maxGuestCapacity: invalidCapacity }),
      });
      assert.equal(invalid.status, 400);
    }

    const zeroAttending = await postSubmission(zeroEvent.slug, `capacity-zero-yes-${suffix}@example.test`);
    assert.equal(zeroAttending.status, 409);
    const zeroNotAttending = await postSubmission(
      zeroEvent.slug,
      `capacity-zero-no-${suffix}@example.test`,
      [],
      AttendanceIntent.NOT_ATTENDING,
    );
    assert.equal(zeroNotAttending.status, 201);

    const groupEvent = await prisma.event.create({
      data: {
        userId: owner.id,
        title: 'Four Guest Capacity Event',
        slug: `capacity-group-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        additionalGuestLimit: 3,
        maxGuestCapacity: 4,
      },
    });
    eventIds.push(groupEvent.id);
    const fourGuests = await postSubmission(groupEvent.slug, `capacity-group-${suffix}@example.test`, [
      'Additional One', 'Additional Two', 'Additional Three',
    ]);
    assert.equal(fourGuests.status, 201);
    const groupSummaryResponse = await request(`/api/events/${groupEvent.id}`, { headers: ownerHeaders });
    const groupSummary = (await groupSummaryResponse.json() as { event: CapacityResponse }).event;
    assert.equal(groupSummary.reservedGuestCount, 4);
    assert.equal(groupSummary.availableGuestCount, 0);

    const concurrentEvent = await prisma.event.create({
      data: {
        userId: owner.id,
        title: 'Concurrent Capacity Event',
        slug: `capacity-race-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        additionalGuestLimit: 2,
        maxGuestCapacity: 3,
      },
    });
    eventIds.push(concurrentEvent.id);
    const racingSubmissions = await Promise.all([
      postSubmission(concurrentEvent.slug, `capacity-race-a-${suffix}@example.test`, ['Race Guest A']),
      postSubmission(concurrentEvent.slug, `capacity-race-b-${suffix}@example.test`, ['Race Guest B']),
    ]);
    assert.deepEqual(racingSubmissions.map(({ status }) => status).sort(), [201, 409]);
    const concurrentSummary = await request(`/api/events/${concurrentEvent.id}`, { headers: ownerHeaders });
    const concurrentCapacity = (await concurrentSummary.json() as { event: CapacityResponse }).event;
    assert.equal(concurrentCapacity.reservedGuestCount, 2);
    assert.ok(concurrentCapacity.reservedGuestCount <= concurrentCapacity.maxGuestCapacity!);
    assert.equal(await prisma.notificationOutbox.count({ where: { registration: { eventId: concurrentEvent.id } } }), 2);

    const unlimitedEvent = await prisma.event.create({
      data: {
        userId: owner.id,
        title: 'Unlimited Capacity Event',
        slug: `capacity-unlimited-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        additionalGuestLimit: 3,
        maxGuestCapacity: null,
      },
    });
    eventIds.push(unlimitedEvent.id);
    const unsetCapacity = await request(`/api/events/${unlimitedEvent.id}`, {
      method: 'PATCH',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxGuestCapacity: null }),
    });
    assert.equal(unsetCapacity.status, 200);
    assert.equal(((await unsetCapacity.json()) as { event: { maxGuestCapacity: number | null } }).event.maxGuestCapacity, null);
    const unlimitedResponse = await postSubmission(unlimitedEvent.slug, `capacity-unlimited-${suffix}@example.test`, [
      'Unlimited Guest One', 'Unlimited Guest Two', 'Unlimited Guest Three',
    ]);
    assert.equal(unlimitedResponse.status, 201);
    const unlimitedSummaryResponse = await request(`/api/events/public/${unlimitedEvent.slug}`);
    const unlimitedSummary = (await unlimitedSummaryResponse.json() as { event: CapacityResponse }).event;
    assert.equal(unlimitedSummary.maxGuestCapacity, null);
    assert.equal(unlimitedSummary.reservedGuestCount, 4);
    assert.equal(unlimitedSummary.availableGuestCount, null);
  } finally {
    if (capacityServer) {
      await new Promise<void>((resolve, reject) => capacityServer!.close((error) => error ? reject(error) : resolve()));
      if (server === capacityServer) server = undefined;
    }
    if (eventIds.length) {
      await prisma.attendee.deleteMany({ where: { registration: { eventId: { in: eventIds } } } });
      await prisma.rSVPRegistration.deleteMany({ where: { eventId: { in: eventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

test('organiser RSVP decisions enforce ownership, pending state, and atomic transitions', async () => {
  const suffix = randomUUID();
  const testUserIds: string[] = [];
  const testEventIds: string[] = [];

  try {
    const owner = await prisma.user.create({
      data: {
        firstName: 'Decision',
        lastName: 'Owner',
        email: `rsvp-decision-${suffix}-owner@example.test`,
        passwordHash: 'test-only-hash',
      },
    });
    testUserIds.push(owner.id);
    const otherOwner = await prisma.user.create({
      data: {
        firstName: 'Other',
        lastName: 'Decision Owner',
        email: `rsvp-decision-${suffix}-other@example.test`,
        passwordHash: 'test-only-hash',
      },
    });
    testUserIds.push(otherOwner.id);

    const event = await prisma.event.create({
      data: {
        userId: owner.id,
        title: 'Decision Integration Event',
        slug: `rsvp-decision-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        approvalRequired: true,
      },
    });
    testEventIds.push(event.id);
    const otherEvent = await prisma.event.create({
      data: {
        userId: otherOwner.id,
        title: 'Other Decision Integration Event',
        slug: `rsvp-decision-other-${suffix}`,
        eventCategory: 'Test',
        eventStatus: EventStatus.PUBLISHED,
        approvalRequired: true,
      },
    });
    testEventIds.push(otherEvent.id);

    async function createPendingRegistration(slug: string, emailSuffix: string) {
      const submission = await submitRsvp(slug, rsvpBody(`rsvp-decision-${suffix}-${emailSuffix}@example.test`));
      const tokenHash = createHash('sha256').update(submission.confirmationToken).digest('hex');
      const registration = await prisma.rSVPRegistration.findUniqueOrThrow({
        where: { confirmationTokenHash: tokenHash },
        select: { id: true },
      });
      const notices = await prisma.notificationOutbox.findMany({ where: { registrationId: registration.id } });
      assert.equal(notices.length, 2);
      assert.equal(notices.find((notice) => notice.type === NotificationType.ORGANISER_NEW_RSVP)?.recipientEmail, slug === otherEvent.slug ? otherOwner.email : owner.email);
      const organiserNotice = notices.find((notice) => notice.type === NotificationType.ORGANISER_NEW_RSVP)!;
      const organiserPayload = organiserNotice.payload as unknown as Parameters<typeof renderNotificationEmail>[0];
      const expectedDashboardUrl = env.frontendUrl
        ? `${env.frontendUrl.replace(/\/$/, '')}/dashboard/events/${encodeURIComponent(slug === otherEvent.slug ? otherEvent.id : event.id)}/guests`
        : undefined;
      assert.equal(organiserPayload.dashboardUrl, expectedDashboardUrl);
      if (expectedDashboardUrl) {
        const organiserEmail = renderNotificationEmail(organiserPayload);
        assert.match(organiserEmail.html, new RegExp(expectedDashboardUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(organiserEmail.text, new RegExp(expectedDashboardUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      assert.equal(notices.find((notice) => notice.type === NotificationType.GUEST_RSVP_RECEIVED)?.recipientEmail, `rsvp-decision-${suffix}-${emailSuffix}@example.test`);
      assert.equal(notices.find((notice) => notice.type === NotificationType.GUEST_RSVP_RECEIVED)?.status, NotificationStatus.PENDING);
      assert.equal((notices.find((notice) => notice.type === NotificationType.GUEST_RSVP_RECEIVED)?.payload as { status: string }).status, 'PENDING');
      return { id: registration.id, tokenHash };
    }

    const approval = await createPendingRegistration(event.slug, 'approve');
    const rejection = await createPendingRegistration(event.slug, 'reject');
    const concurrent = await createPendingRegistration(event.slug, 'concurrent');
    const foreign = await createPendingRegistration(otherEvent.slug, 'foreign');
    const notAttending = await submitRsvp(event.slug, rsvpBody(
      `rsvp-decision-${suffix}-not-attending@example.test`,
      { attendanceIntent: AttendanceIntent.NOT_ATTENDING },
    ));
    const notAttendingHash = createHash('sha256').update(notAttending.confirmationToken).digest('hex');
    const notAttendingRegistration = await prisma.rSVPRegistration.findUniqueOrThrow({
      where: { confirmationTokenHash: notAttendingHash },
      select: { id: true },
    });
    assert.equal(await prisma.notificationOutbox.count({ where: { registrationId: notAttendingRegistration.id } }), 2);
    assert.equal(await prisma.attendee.count({ where: { registrationId: notAttendingRegistration.id, attendeeType: AttendeeType.ADDITIONAL, email: { not: null } } }), 0);

    const cancelled = await prisma.rSVPRegistration.create({
      data: { eventId: event.id, attendanceIntent: AttendanceIntent.ATTENDING, status: RegistrationStatus.CANCELLED, cancelledAt: new Date() },
      select: { id: true },
    });

    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });

    const ownerHeaders = { Authorization: `Bearer ${accessToken(owner.id)}` };
    const otherOwnerHeaders = { Authorization: `Bearer ${accessToken(otherOwner.id)}` };
    const basePath = `/api/events/${event.id}/rsvps`;

    const unauthenticated = await request(`${basePath}/${approval.id}/approve`, { method: 'POST' });
    assert.equal(unauthenticated.status, 401);

    const ownerApproval = await request(`${basePath}/${approval.id}/approve`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(ownerApproval.status, 200);
    const approvedBody = await ownerApproval.json() as {
      registration: {
        id: string;
        attendanceIntent: AttendanceIntent;
        status: RegistrationStatus;
        relationshipToGraduate: string | null;
        createdAt: string;
        approvedAt: string | null;
        declinedAt: string | null;
        attendees: Array<{ email: string | null; phone: string | null }>;
      };
    };
    assert.equal(approvedBody.registration.id, approval.id);
    assert.equal(approvedBody.registration.attendanceIntent, AttendanceIntent.ATTENDING);
    assert.equal(approvedBody.registration.status, RegistrationStatus.APPROVED);
    assert.ok(approvedBody.registration.approvedAt);
    assert.equal(approvedBody.registration.declinedAt, null);
    assert.ok(approvedBody.registration.createdAt);
    assert.equal(approvedBody.registration.attendees.length, 1);
    const approvedJson = JSON.stringify(approvedBody);
    assert.ok(!approvedJson.includes(approval.tokenHash));
    assert.doesNotMatch(approvedJson, /confirmationToken|passwordHash/);
    const approvalNotice = await prisma.notificationOutbox.findUnique({
      where: { registrationId_type: { registrationId: approval.id, type: 'GUEST_RSVP_APPROVED' } },
    });
    assert.equal(approvalNotice?.recipientEmail, `rsvp-decision-${suffix}-approve@example.test`);
    assert.equal(approvalNotice?.status, 'PENDING');

    const ownerRejection = await request(`${basePath}/${rejection.id}/reject`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(ownerRejection.status, 200);
    const rejectedBody = await ownerRejection.json() as {
      registration: { status: RegistrationStatus; approvedAt: string | null; declinedAt: string | null; attendees: unknown[] };
    };
    assert.equal(rejectedBody.registration.status, RegistrationStatus.DECLINED);
    assert.equal(rejectedBody.registration.approvedAt, null);
    assert.ok(rejectedBody.registration.declinedAt);
    assert.equal(rejectedBody.registration.attendees.length, 1);
    const declineNotice = await prisma.notificationOutbox.findUnique({
      where: { registrationId_type: { registrationId: rejection.id, type: 'GUEST_RSVP_DECLINED' } },
    });
    assert.equal(declineNotice?.recipientEmail, `rsvp-decision-${suffix}-reject@example.test`);

    const foreignApproval = await request(`/api/events/${otherEvent.id}/rsvps/${foreign.id}/approve`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(foreignApproval.status, 404);
    const foreignRejection = await request(`/api/events/${otherEvent.id}/rsvps/${foreign.id}/reject`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(foreignRejection.status, 404);
    const foreignOwnerCannotDecide = await request(`/api/events/${event.id}/rsvps/${approval.id}/approve`, {
      method: 'POST',
      headers: otherOwnerHeaders,
    });
    assert.equal(foreignOwnerCannotDecide.status, 404);

    const notAttendingApproval = await request(`${basePath}/${notAttendingRegistration.id}/approve`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(notAttendingApproval.status, 409);
    assert.deepEqual(await notAttendingApproval.json(), { message: 'Only pending registrations can be approved.' });

    const repeatApproval = await request(`${basePath}/${approval.id}/approve`, { method: 'POST', headers: ownerHeaders });
    assert.equal(repeatApproval.status, 409);
    const approveDeclined = await request(`${basePath}/${rejection.id}/approve`, { method: 'POST', headers: ownerHeaders });
    assert.equal(approveDeclined.status, 409);
    const repeatRejection = await request(`${basePath}/${rejection.id}/reject`, { method: 'POST', headers: ownerHeaders });
    assert.equal(repeatRejection.status, 409);
    const rejectApproved = await request(`${basePath}/${approval.id}/reject`, { method: 'POST', headers: ownerHeaders });
    assert.equal(rejectApproved.status, 409);

    const cancelledDecision = await request(`${basePath}/${cancelled.id}/reject`, { method: 'POST', headers: ownerHeaders });
    assert.equal(cancelledDecision.status, 409);
    const notRequiredDecision = await request(`${basePath}/${notAttendingRegistration.id}/reject`, { method: 'POST', headers: ownerHeaders });
    assert.equal(notRequiredDecision.status, 409);

    const invalidRegistration = await request(`${basePath}/missing-registration-id/approve`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(invalidRegistration.status, 404);

    const bodyOverride = await request(`${basePath}/${concurrent.id}/approve`, {
      method: 'POST',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId: otherOwner.id, status: 'DECLINED', approvedAt: null }),
    });
    assert.equal(bodyOverride.status, 400);

    const [approveRace, rejectRace] = await Promise.all([
      request(`${basePath}/${concurrent.id}/approve`, { method: 'POST', headers: ownerHeaders }),
      request(`${basePath}/${concurrent.id}/reject`, { method: 'POST', headers: ownerHeaders }),
    ]);
    assert.deepEqual([approveRace.status, rejectRace.status].sort(), [200, 409]);
    const finalRaceState = await prisma.rSVPRegistration.findUniqueOrThrow({
      where: { id: concurrent.id },
      select: { status: true, approvedAt: true, declinedAt: true },
    });
    assert.ok(
      finalRaceState.status === RegistrationStatus.APPROVED ||
      finalRaceState.status === RegistrationStatus.DECLINED,
    );
    assert.ok(!(finalRaceState.approvedAt && finalRaceState.declinedAt));
    assert.equal(await prisma.notificationOutbox.count({ where: { registrationId: concurrent.id, type: { in: ['GUEST_RSVP_APPROVED', 'GUEST_RSVP_DECLINED'] } } }), 1);
    assert.equal(await prisma.notificationOutbox.count({ where: { registrationId: approval.id, type: 'GUEST_RSVP_APPROVED' } }), 1);
    await assert.rejects(prisma.notificationOutbox.create({ data: {
      registrationId: approval.id,
      type: NotificationType.GUEST_RSVP_APPROVED,
      recipientEmail: `rsvp-decision-${suffix}-approve@example.test`,
      payload: {},
    } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'P2002');

    const retryNotice = approvalNotice!;
    let retryCalls = 0;
    setNotificationSenderForTests({ emails: { send: async () => {
      retryCalls += 1;
      return retryCalls === 1 ? { error: { name: 'rate_limit' } } : { data: { id: 'mock-send' }, error: null };
    } } }, 'onboarding@resend.dev');
    const retryStartedAt = Date.now();
    await runNotificationWorkerOnce(retryNotice.id);
    const retryState = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: retryNotice.id } });
    assert.equal(retryState.status, NotificationStatus.PENDING);
    assert.equal(retryState.attemptCount, 1);
    assert.equal(retryState.lastError, 'Error');
    assert.equal(notificationRetryDelay(1), 30_000);
    assert.ok(retryState.nextRetryAt.getTime() - retryStartedAt >= 29_000);
    await prisma.notificationOutbox.update({ where: { id: retryNotice.id }, data: { nextRetryAt: new Date(0) } });
    await runNotificationWorkerOnce(retryNotice.id);
    const sentState = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: retryNotice.id } });
    assert.equal(sentState.status, NotificationStatus.SENT);
    assert.equal(sentState.attemptCount, 2);
    assert.equal(retryCalls, 2);
    assert.ok(await prisma.rSVPRegistration.findUnique({ where: { id: approval.id } }), 'provider failure must not roll back the approved RSVP');

    let concurrentSendCalls = 0;
    setNotificationSenderForTests({ emails: { send: async () => {
      concurrentSendCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { data: { id: 'mock-send' }, error: null };
    } } }, 'onboarding@resend.dev');
    const [workerOne, workerTwo] = await Promise.all([
      runNotificationWorkerOnce(declineNotice!.id),
      runNotificationWorkerOnce(declineNotice!.id),
    ]);
    assert.equal(Number(workerOne) + Number(workerTwo), 1);
    assert.equal(concurrentSendCalls, 1);
    assert.equal((await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: declineNotice!.id } })).status, NotificationStatus.SENT);

    const concurrentNotice = await prisma.notificationOutbox.findFirstOrThrow({
      where: { registrationId: concurrent.id, type: { in: [NotificationType.GUEST_RSVP_APPROVED, NotificationType.GUEST_RSVP_DECLINED] } },
    });
    await prisma.notificationOutbox.update({ where: { id: concurrentNotice.id }, data: { attemptCount: 4, nextRetryAt: new Date(0) } });
    setNotificationSenderForTests({ emails: { send: async () => ({ error: { name: 'invalid_recipient' } }) } }, 'onboarding@resend.dev');
    await runNotificationWorkerOnce(concurrentNotice.id);
    const permanentFailure = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: concurrentNotice.id } });
    assert.equal(permanentFailure.status, NotificationStatus.FAILED);
    assert.equal(permanentFailure.attemptCount, 5);
    setNotificationSenderForTests(undefined);
    const queuedWithoutProvider = await prisma.notificationOutbox.findFirst({ where: { registrationId: notAttendingRegistration.id, type: NotificationType.GUEST_RSVP_RECEIVED } });
    assert.ok(queuedWithoutProvider);
    await runNotificationWorkerOnce(queuedWithoutProvider.id);
    const stillQueued = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: queuedWithoutProvider.id } });
    assert.equal(stillQueued.status, NotificationStatus.PENDING);
    assert.equal(stillQueued.attemptCount, 0);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (testEventIds.length) {
      await prisma.attendanceCheckIn.deleteMany({
        where: { ticket: { attendee: { registration: { eventId: { in: testEventIds } } } } },
      });
      await prisma.ticket.deleteMany({ where: { attendee: { registration: { eventId: { in: testEventIds } } } } });
      await prisma.attendee.deleteMany({ where: { registration: { eventId: { in: testEventIds } } } });
      await prisma.rSVPRegistration.deleteMany({ where: { eventId: { in: testEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: testEventIds } } });
    }
    if (testUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
    }
  }
});

test('event image upload signatures are owner-scoped and sign server-controlled image parameters', async () => {
  const suffix = randomUUID();
  const testUserIds: string[] = [];
  const testEventIds: string[] = [];
  const originalCloudinary = env.cloudinary;

  try {
    const owner = await prisma.user.create({
      data: {
        firstName: 'Image',
        lastName: 'Owner',
        email: `image-upload-${suffix}-owner@example.test`,
        passwordHash: 'test-only-hash',
      },
    });
    testUserIds.push(owner.id);
    const otherOwner = await prisma.user.create({
      data: {
        firstName: 'Other',
        lastName: 'Image Owner',
        email: `image-upload-${suffix}-other@example.test`,
        passwordHash: 'test-only-hash',
      },
    });
    testUserIds.push(otherOwner.id);

    const event = await prisma.event.create({
      data: {
        userId: owner.id,
        title: 'Image Upload Integration Event',
        slug: `image-upload-${suffix}`,
        eventCategory: 'Test',
      },
    });
    testEventIds.push(event.id);

    env.cloudinary = {
      cloudName: 'test-cloud',
      apiKey: '123456789012345',
      apiSecret: 'integration-test-cloudinary-secret',
    };

    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });

    const path = `/api/events/${event.id}/image-upload-signature`;
    const ownerHeaders = { Authorization: `Bearer ${accessToken(owner.id)}` };
    const otherOwnerHeaders = { Authorization: `Bearer ${accessToken(otherOwner.id)}` };

    const unauthenticated = await request(path, { method: 'POST' });
    assert.equal(unauthenticated.status, 401);

    const invalidEventId = await request('/api/events/not-a-uuid/image-upload-signature', {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(invalidEventId.status, 400);

    const missingEvent = await request(`/api/events/${randomUUID()}/image-upload-signature`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    assert.equal(missingEvent.status, 404);

    const nonOwner = await request(path, { method: 'POST', headers: otherOwnerHeaders });
    assert.equal(nonOwner.status, 404);

    const parameterOverride = await request(path, {
      method: 'POST',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'untrusted/folder', public_id: 'chosen-id', allowed_formats: 'pdf' }),
    });
    assert.equal(parameterOverride.status, 400);

    env.cloudinary = undefined;
    const missingConfiguration = await request(path, { method: 'POST', headers: ownerHeaders });
    assert.equal(missingConfiguration.status, 500);
    assert.deepEqual(await missingConfiguration.json(), { message: 'Image uploads are not configured.' });

    env.cloudinary = {
      cloudName: 'test-cloud',
      apiKey: '123456789012345',
      apiSecret: 'integration-test-cloudinary-secret',
    };
    const success = await request(path, { method: 'POST', headers: ownerHeaders });
    assert.equal(success.status, 200);
    const responseText = await success.text();
    assert.ok(!responseText.includes('integration-test-cloudinary-secret'));
    assert.doesNotMatch(responseText, /api_secret|apiSecret/);
    const response = JSON.parse(responseText) as {
      upload: {
        cloud_name: string;
        api_key: string;
        timestamp: number;
        signature: string;
        folder: string;
        public_id: string;
        resource_type: string;
        allowed_formats: string;
        overwrite: boolean;
        client_max_file_size_bytes: number;
        expires_at: number;
      };
    };
    const upload = response.upload;
    assert.equal(upload.cloud_name, 'test-cloud');
    assert.equal(upload.api_key, '123456789012345');
    assert.equal(upload.resource_type, 'image');
    assert.equal(upload.folder, `gather/events/${event.id}`);
    assert.match(upload.public_id, /^[0-9a-f-]{36}$/i);
    assert.equal(upload.allowed_formats, 'jpg,jpeg,png,webp');
    assert.equal(upload.overwrite, false);
    assert.equal(upload.client_max_file_size_bytes, 5 * 1024 * 1024);
    assert.ok(upload.timestamp <= Math.floor(Date.now() / 1000));
    assert.ok(upload.expires_at > upload.timestamp);

    const signedParameters = {
      allowed_formats: upload.allowed_formats,
      folder: upload.folder,
      overwrite: upload.overwrite,
      public_id: upload.public_id,
      timestamp: upload.timestamp,
    };
    const serializedParameters = Object.entries(signedParameters)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('&');
    const expectedSignature = createHash('sha1')
      .update(`${serializedParameters}integration-test-cloudinary-secret`, 'utf8')
      .digest('hex');
    assert.equal(upload.signature, expectedSignature);

    const secondSuccess = await request(path, { method: 'POST', headers: ownerHeaders });
    assert.equal(secondSuccess.status, 200);
    const secondResponse = await secondSuccess.json() as { upload: { public_id: string } };
    assert.notEqual(secondResponse.upload.public_id, upload.public_id);
  } finally {
    env.cloudinary = originalCloudinary;
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (testEventIds.length) {
      await prisma.event.deleteMany({ where: { id: { in: testEventIds } } });
    }
    if (testUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
    }
  }
});

test('Resend configuration gaps preserve RSVP flows and acknowledgements render status-specific content', async () => {
  const suffix = randomUUID();
  const originalResend = env.resend;
  const originalFrontendUrl = env.frontendUrl;
  let ownerId: string | undefined;
  let eventId: string | undefined;
  try {
    const staleFixtures = await prisma.event.findMany({ where: { slug: { startsWith: 'email-status-' } }, select: { id: true } });
    if (staleFixtures.length) {
      const staleIds = staleFixtures.map(({ id }) => id);
      await prisma.attendee.deleteMany({ where: { registration: { eventId: { in: staleIds } } } });
      await prisma.rSVPRegistration.deleteMany({ where: { eventId: { in: staleIds } } });
      await prisma.event.deleteMany({ where: { id: { in: staleIds } } });
      await prisma.user.deleteMany({ where: { email: { startsWith: 'mail-owner-' } } });
    }
    assert.equal(readResendConfiguration(undefined, 'onboarding@resend.dev'), undefined);
    assert.deepEqual(readResendConfiguration('test-only-key', undefined), {
      apiKey: 'test-only-key',
      fromEmail: 'onboarding@resend.dev',
    });

    const owner = await prisma.user.create({ data: {
      firstName: 'Mail', lastName: 'Owner', email: `mail-owner-${suffix}@example.test`, passwordHash: 'test-only-hash',
    } });
    ownerId = owner.id;
    const event = await prisma.event.create({ data: {
      userId: owner.id, title: 'Email Status Event', slug: `email-status-${suffix}`, eventCategory: 'Test',
      eventStatus: EventStatus.PUBLISHED, approvalRequired: true,
    } });
    eventId = event.id;
    env.resend = undefined;
    env.frontendUrl = 'https://gather-test.example';

    const pending = await submitRsvp(event.slug, rsvpBody(`guest-pending-${suffix}@example.test`));
    assert.equal(pending.registration.status, RegistrationStatus.PENDING);
    const pendingId = (await prisma.rSVPRegistration.findUniqueOrThrow({
      where: { confirmationTokenHash: createHash('sha256').update(pending.confirmationToken).digest('hex') }, select: { id: true },
    })).id;
    const organiserNotice = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { registrationId_type: { registrationId: pendingId, type: NotificationType.ORGANISER_NEW_RSVP } },
    });
    const organiserPayload = organiserNotice.payload as unknown as Parameters<typeof renderNotificationEmail>[0];
    const expectedDashboardUrl = `https://gather-test.example/dashboard/events/${event.id}/guests`;
    assert.equal(organiserPayload.dashboardUrl, expectedDashboardUrl);
    const organiserEmail = renderNotificationEmail(organiserPayload);
    assert.ok(organiserEmail.html.includes(expectedDashboardUrl));
    assert.ok(organiserEmail.text.includes(expectedDashboardUrl));
    const pendingEmail = renderNotificationEmail({
      type: 'GUEST_RSVP_RECEIVED', recipientEmail: `guest-pending-${suffix}@example.test`,
      guestName: 'Guest Person', guestEmail: `guest-pending-${suffix}@example.test`, eventName: event.title,
      attendanceIntent: 'ATTENDING', status: 'PENDING',
    });
    assert.equal(pendingEmail.subject, `We received your RSVP for ${event.title}`);
    assert.match(pendingEmail.text, /received and is awaiting organiser approval/i);
    assert.match(pendingEmail.html, /received and is awaiting organiser approval/i);

    await decideEventRegistration(event.id, pendingId, owner.id, 'approve');
    const approvedEmail = renderNotificationEmail({
      type: 'GUEST_RSVP_RECEIVED', recipientEmail: `guest-pending-${suffix}@example.test`,
      guestName: 'Guest Person', guestEmail: `guest-pending-${suffix}@example.test`, eventName: event.title,
      attendanceIntent: 'ATTENDING', status: 'APPROVED',
    });
    assert.match(approvedEmail.text, /your RSVP is approved/i);
    assert.match(approvedEmail.html, /your RSVP is approved/i);

    env.resend = readResendConfiguration('test-only-key', undefined);
    const notAttending = await submitRsvp(event.slug, rsvpBody(`guest-no-${suffix}@example.test`, { attendanceIntent: AttendanceIntent.NOT_ATTENDING }));
    assert.equal(notAttending.registration.status, RegistrationStatus.NOT_REQUIRED);
    const notRequiredEmail = renderNotificationEmail({
      type: 'GUEST_RSVP_RECEIVED', recipientEmail: `guest-no-${suffix}@example.test`,
      guestName: 'Guest Person', guestEmail: `guest-no-${suffix}@example.test`, eventName: event.title,
      attendanceIntent: 'NOT_ATTENDING', status: 'NOT_REQUIRED',
    });
    assert.match(notRequiredEmail.text, /response was recorded as not attending; no approval is required/i);
    assert.match(notRequiredEmail.html, /response was recorded as not attending; no approval is required/i);

    const declined = await submitRsvp(event.slug, rsvpBody(`guest-decline-${suffix}@example.test`));
    const declinedId = (await prisma.rSVPRegistration.findUniqueOrThrow({
      where: { confirmationTokenHash: createHash('sha256').update(declined.confirmationToken).digest('hex') }, select: { id: true },
    })).id;
    const beforeDecline = await prisma.notificationOutbox.count({ where: { registrationId: declinedId, type: NotificationType.GUEST_RSVP_DECLINED } });
    await decideEventRegistration(event.id, declinedId, owner.id, 'reject');
    assert.equal(beforeDecline, 0);
    assert.equal(await prisma.notificationOutbox.count({ where: { registrationId: declinedId, type: NotificationType.GUEST_RSVP_DECLINED } }), 1);
    assert.equal((await prisma.notificationOutbox.findMany({ where: { registrationId: pendingId } })).length, 3);
  } finally {
    env.resend = originalResend;
    env.frontendUrl = originalFrontendUrl;
    if (eventId) {
      await prisma.attendee.deleteMany({ where: { registration: { eventId } } });
      await prisma.rSVPRegistration.deleteMany({ where: { eventId } });
      await prisma.event.deleteMany({ where: { id: eventId } });
    }
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
  }
});

after(async () => {
  await prisma.$disconnect();
});
