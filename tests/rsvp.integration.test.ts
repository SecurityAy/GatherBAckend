import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { AttendanceIntent, AttendeeType, EventStatus, RegistrationStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import app from '../src/app.js';
import { getRsvpConfirmation, submitRsvp } from '../src/modules/events/rsvp.service.js';

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

after(async () => {
  await prisma.$disconnect();
});
