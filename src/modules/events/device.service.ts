import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import type { Prisma } from '@prisma/client';

export const DEVICE_COOKIE_NAME = 'gather_device';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

// Derive a dedicated key so a device cookie can never be confused with an auth token.
const cookieSecret = createHash('sha256')
  .update(`gather-device-cookie:${env.jwtSecret}`)
  .digest('hex');

export type DeviceContext = {
  /** Stable identifier written into the signed cookie. */
  deviceId: string;
  /** Hash stored on the registration so a returning cookie can be recognised. */
  cookieHash: string;
  /** Hash of a client-supplied device ID, when one was provided. */
  clientHash?: string;
  /** Hashes presented by this request, used to detect an existing reservation. */
  lookupHashes: string[];
};

export function hashDeviceIdentifier(identifier: string) {
  return createHash('sha256').update(identifier, 'utf8').digest('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const equalsIndex = pair.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = pair.slice(0, equalsIndex).trim();
    if (!key) continue;
    const rawValue = pair.slice(equalsIndex + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

export function signDeviceCookie(deviceId: string) {
  return jwt.sign({ deviceId }, cookieSecret, {
    algorithm: 'HS256',
    expiresIn: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
}

function readCookieDeviceId(req: Request): string | undefined {
  const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE_NAME];
  if (!token) return undefined;
  try {
    const payload = jwt.verify(token, cookieSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.deviceId !== 'string') return undefined;
    return DEVICE_ID_PATTERN.test(payload.deviceId) ? payload.deviceId : undefined;
  } catch {
    return undefined;
  }
}

function readClientDeviceId(req: Request): string | undefined {
  const header = req.headers['x-device-id'];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value && DEVICE_ID_PATTERN.test(value) ? value : undefined;
}

/** Resolve the device identity from the signed cookie, falling back to the client ID header. */
export function resolveDeviceContext(req: Request): DeviceContext {
  const cookieId = readCookieDeviceId(req);
  const clientId = readClientDeviceId(req);
  const deviceId = cookieId ?? clientId ?? randomUUID();
  const cookieHash = hashDeviceIdentifier(deviceId);
  const clientHash = clientId ? hashDeviceIdentifier(clientId) : undefined;
  const lookupHashes = [...new Set([
    cookieId ? hashDeviceIdentifier(cookieId) : undefined,
    clientHash,
  ].filter((hash): hash is string => Boolean(hash)))];
  return { deviceId, cookieHash, clientHash, lookupHashes };
}

/** Used by direct service calls (e.g. tests) that have no HTTP device identity. */
export function defaultDeviceContext(): DeviceContext {
  const deviceId = randomUUID();
  return { deviceId, cookieHash: hashDeviceIdentifier(deviceId), lookupHashes: [] };
}

export function deviceRegistrationFilter(eventId: string, lookupHashes: string[]): Prisma.RSVPRegistrationWhereInput {
  const or: Prisma.RSVPRegistrationWhereInput[] = [];
  for (const hash of lookupHashes) {
    or.push({ deviceCookieHash: hash }, { deviceClientHash: hash });
  }
  return { eventId, OR: or };
}

export function setDeviceCookie(res: Response, deviceId: string) {
  res.cookie(DEVICE_COOKIE_NAME, signDeviceCookie(deviceId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS * 1000,
    path: '/',
  });
}
