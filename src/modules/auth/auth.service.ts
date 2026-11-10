import { AccountStatus, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { prisma } from '../../lib/prisma.js';

const registerSchema = z.object({
  firstName: z.string().trim().min(2).max(100),
  lastName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
    message: 'Password must not exceed 72 UTF-8 bytes.',
  }),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
    message: 'Password must not exceed 72 UTF-8 bytes.',
  }),
});

const safeUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  accountStatus: true,
  emailVerifiedAt: true,
  profileImageUrl: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;

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
    const user = await prisma.user.create({
      data: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        passwordHash,
      },
      select: safeUserSelect,
    });

    return {
      user,
      token: createAccessToken(user),
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
    select: { ...safeUserSelect, passwordHash: true },
  });

  if (!user || !(await bcrypt.compare(payload.password, user.passwordHash))) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  if (user.accountStatus !== AccountStatus.ACTIVE) {
    throw new HttpError(403, 'This account is not active.');
  }

  const { passwordHash: _passwordHash, ...safeUser } = user;

  return {
    user: safeUser,
    token: createAccessToken(safeUser),
  };
}

function createAccessToken(user: Pick<SafeUser, 'id' | 'email'>) {
  return jwt.sign({ sub: user.id }, env.jwtSecret, { expiresIn: '7d', algorithm: 'HS256' });
}
