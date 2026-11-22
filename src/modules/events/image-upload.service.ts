import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';

const eventIdSchema = z.string().uuid();
const allowedFormats = 'jpg,jpeg,png,webp';
const maxFileSizeBytes = 5 * 1024 * 1024;
const cloudinarySignatureLifetimeSeconds = 60 * 60;

function createSignature(parameters: Record<string, string | number | boolean>, apiSecret: string) {
  const serializedParameters = Object.entries(parameters)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');

  return createHash('sha1')
    .update(`${serializedParameters}${apiSecret}`, 'utf8')
    .digest('hex');
}

export async function createEventImageUploadSignature(eventIdInput: string, userId: string) {
  const eventId = eventIdSchema.parse(eventIdInput);
  const event = await prisma.event.findFirst({
    where: { id: eventId, userId, deletedAt: null },
    select: { id: true },
  });

  if (!event) {
    throw new HttpError(404, 'Event not found.');
  }

  const cloudinary = env.cloudinary;
  if (!cloudinary) {
    throw new HttpError(500, 'Image uploads are not configured.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `gather/events/${event.id}`;
  const publicId = randomUUID();
  // Cloudinary has no signed `file_size_limit` upload parameter. The size below is an
  // advisory client hint only; the account-level Cloudinary upload cap is the hard limit.
  const signedParameters = {
    allowed_formats: allowedFormats,
    folder,
    overwrite: false,
    public_id: publicId,
    timestamp,
  };
  const signature = createSignature(signedParameters, cloudinary.apiSecret);

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      eventId: event.id,
      action: 'IMAGE_UPLOAD_SIGNED',
      details: JSON.stringify({ publicId }),
    },
  });

  return {
    cloud_name: cloudinary.cloudName,
    api_key: cloudinary.apiKey,
    timestamp,
    signature,
    folder,
    public_id: publicId,
    resource_type: 'image' as const,
    allowed_formats: allowedFormats,
    overwrite: false,
    client_max_file_size_bytes: maxFileSizeBytes,
    expires_at: timestamp + cloudinarySignatureLifetimeSeconds,
  };
}
