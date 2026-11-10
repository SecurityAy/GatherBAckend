import { AccountStatus } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from './errorHandler.js';

type AuthenticatedUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  accountStatus: AccountStatus;
  emailVerifiedAt: Date | null;
  profileImageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authorization = req.headers.authorization;

  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authorization.replace(/^Bearer\s+/i, '');
  let payload: string | JwtPayload;

  try {
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }

  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        accountStatus: true,
        emailVerifiedAt: true,
        profileImageUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }

    if (user.accountStatus !== AccountStatus.ACTIVE) {
      return res.status(403).json({ message: 'This account is not active.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireOwnerOrSelf(req: Request, res: Response, next: NextFunction) {
  const resourceOwnerId = req.params.userId ?? req.params.id;

  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  if (req.user.id === resourceOwnerId) {
    return next();
  }

  return next(new HttpError(403, 'You do not have permission to access this resource.'));
}
