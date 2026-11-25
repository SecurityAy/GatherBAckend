import { createHash, randomBytes } from 'node:crypto';
import { AccountStatus, NotificationStatus, NotificationType, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { prisma } from '../../lib/prisma.js';
import { enqueueUserNotification, notificationPayload } from '../notifications/notification-outbox.service.js';

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(8).refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
  message: 'Password must not exceed 72 UTF-8 bytes.',
});

const registerSchema = z.object({
  firstName: z.string().trim().min(2).max(100),
  lastName: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

const resetPasswordSchema = z.object({
  token: z.string().min(32).max(128),
  password: passwordSchema,
}).strict();

const updateProfileSchema = z.object({
  firstName: z.string().trim().min(2).max(100).optional(),
  lastName: z.string().trim().min(2).max(100).optional(),
  email: emailSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one profile field to update.',
});

const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
}).strict();

const safeUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  accountStatus: true,
  profileImageUrl: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;

const PASSWORD_RESET_MESSAGE = 'If an account exists for that email, a password reset link has been queued.';

function hashResetToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function buildPasswordResetUrl(token: string) {
  const base = env.passwordResetUrl
    ?? (env.frontendUrl ? `${env.frontendUrl.replace(/\/$/, '')}/reset-password` : undefined);
  if (!base) return undefined;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}token=${encodeURIComponent(token)}`;
}

async function closePasswordResetJobs(tx: Prisma.TransactionClient, userId: string) {
  await tx.notificationOutbox.updateMany({
    where: { userId, type: NotificationType.PASSWORD_RESET },
    data: {
      status: NotificationStatus.SENT,
      sentAt: new Date(),
      processingUntil: null,
      payload: {},
    },
  });
}

export async function registerUser(input: unknown) {
  const payload = registerSchema.parse(input);
  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: payload.email, mode: 'insensitive' } },
    select: { id: true },
  });

  if (existingUser) {
    throw new HttpError(409, 'An account with this email already exists.');
  }

  const passwordHash = await bcrypt.hash(payload.password, 12);

  try {
    const created = await prisma.user.create({
      data: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        passwordHash,
      },
      select: { ...safeUserSelect, tokenVersion: true },
    });
    const { tokenVersion, ...user } = created;

    return {
      user,
      token: createAccessToken(user, tokenVersion),
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'An account with this email already exists.');
    }

    throw error;
  }
}

export async function loginUser(input: unknown) {
  const payload = loginSchema.parse(input);
  const user = await prisma.user.findFirst({
    where: { email: { equals: payload.email, mode: 'insensitive' } },
    select: { ...safeUserSelect, passwordHash: true, tokenVersion: true },
  });

  if (!user || !(await bcrypt.compare(payload.password, user.passwordHash))) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  if (user.accountStatus !== AccountStatus.ACTIVE) {
    throw new HttpError(403, 'This account is not active.');
  }

  const { passwordHash: _passwordHash, tokenVersion, ...safeUser } = user;

  return {
    user: safeUser,
    token: createAccessToken(safeUser, tokenVersion),
  };
}

export async function requestPasswordReset(input: unknown) {
  const payload = forgotPasswordSchema.parse(input);
  const user = await prisma.user.findFirst({
    where: {
      email: { equals: payload.email, mode: 'insensitive' },
      accountStatus: AccountStatus.ACTIVE,
    },
    select: { id: true, email: true, firstName: true },
  });
  if (!user) return { message: PASSWORD_RESET_MESSAGE };

  const token = randomBytes(32).toString('base64url');
  const resetUrl = buildPasswordResetUrl(token);
  if (!resetUrl) return { message: PASSWORD_RESET_MESSAGE };

  const passwordResetTokenHash = hashResetToken(token);
  const passwordResetExpiresAt = new Date(Date.now() + env.passwordResetTtlMinutes * 60_000);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordResetTokenHash, passwordResetExpiresAt },
    });
    await enqueueUserNotification(
      tx,
      user.id,
      NotificationType.PASSWORD_RESET,
      user.email,
      notificationPayload({
        type: 'PASSWORD_RESET',
        recipientEmail: user.email,
        recipientName: user.firstName,
        resetUrl,
        expiresAt: passwordResetExpiresAt.toISOString(),
      }),
      `password-reset:${user.id}`,
    );
  });

  return { message: PASSWORD_RESET_MESSAGE };
}

export async function resetPassword(input: unknown) {
  const payload = resetPasswordSchema.parse(input);
  const passwordResetTokenHash = hashResetToken(payload.token);
  const now = new Date();
  const user = await prisma.user.findFirst({
    where: {
      passwordResetTokenHash,
      passwordResetExpiresAt: { gt: now },
      accountStatus: AccountStatus.ACTIVE,
    },
    select: { id: true },
  });
  if (!user) throw new HttpError(400, 'Invalid or expired password reset token.');

  const passwordHash = await bcrypt.hash(payload.password, 12);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: {
        id: user.id,
        passwordResetTokenHash,
        passwordResetExpiresAt: { gt: new Date() },
      },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new HttpError(400, 'Invalid or expired password reset token.');
    await closePasswordResetJobs(tx, user.id);
  });

  return { message: 'Your password has been reset.' };
}

export async function updateCurrentUser(userId: string, input: unknown) {
  const payload = updateProfileSchema.parse(input);

  if (payload.email) {
    const conflict = await prisma.user.findFirst({
      where: { email: { equals: payload.email, mode: 'insensitive' }, id: { not: userId } },
      select: { id: true },
    });
    if (conflict) throw new HttpError(409, 'An account with this email already exists.');
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          ...(payload.firstName ? { firstName: payload.firstName } : {}),
          ...(payload.lastName ? { lastName: payload.lastName } : {}),
          ...(payload.email ? { email: payload.email } : {}),
          ...(payload.email ? { passwordResetTokenHash: null, passwordResetExpiresAt: null } : {}),
        },
        select: safeUserSelect,
      });
      if (payload.email) await closePasswordResetJobs(tx, userId);
      return updated;
    });
    return { user };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'An account with this email already exists.');
    }
    throw error;
  }
}

export async function changeCurrentUserPassword(userId: string, input: unknown) {
  const payload = changePasswordSchema.parse(input);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, email: true, firstName: true },
  });
  if (!user || !(await bcrypt.compare(payload.currentPassword, user.passwordHash))) {
    throw new HttpError(401, 'Current password is incorrect.');
  }
  if (await bcrypt.compare(payload.newPassword, user.passwordHash)) {
    throw new HttpError(400, 'New password must differ from the current password.');
  }

  const passwordHash = await bcrypt.hash(payload.newPassword, 12);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });
    await closePasswordResetJobs(tx, user.id);
  });
  return { message: 'Your password has been changed.' };
}

function createAccessToken(user: Pick<SafeUser, 'id' | 'email'>, tokenVersion: number) {
  return jwt.sign({ sub: user.id, ver: tokenVersion }, env.jwtSecret, { expiresIn: '7d', algorithm: 'HS256' });
}
