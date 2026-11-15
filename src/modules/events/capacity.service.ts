import { AttendanceIntent, Prisma, RegistrationStatus } from '@prisma/client';

type CapacityReader = Pick<Prisma.TransactionClient, 'attendee'>;

export async function lockEventCapacity(tx: Prisma.TransactionClient, eventId: string) {
  const lockKey = `gather:event-capacity:${eventId}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS advisory_lock`;
}

export async function countReservedGuestSpaces(reader: CapacityReader, eventId: string) {
  return reader.attendee.count({
    where: {
      registration: {
        is: {
          eventId,
          attendanceIntent: AttendanceIntent.ATTENDING,
          status: { in: [RegistrationStatus.PENDING, RegistrationStatus.APPROVED] },
        },
      },
    },
  });
}

export function capacitySummary(maxGuestCapacity: number | null, reservedGuestCount: number) {
  return {
    maxGuestCapacity,
    reservedGuestCount,
    availableGuestCount: maxGuestCapacity === null ? null : Math.max(0, maxGuestCapacity - reservedGuestCount),
  };
}
