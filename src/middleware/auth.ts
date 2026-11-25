import { AccountStatus } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

type AuthenticatedUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  accountStatus: AccountStatus;
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

  // Tokens issued before tokenVersion existed have no `ver` claim. Treat them as
  // generation 0 so a deployment does not log everyone out; a password change or
  // reset increments the stored version and rejects those tokens immediately.
  const tokenVersionClaim = payload.ver;
  if (tokenVersionClaim !== undefined && (!Number.isInteger(tokenVersionClaim) || tokenVersionClaim < 0)) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
  const tokenVersion = tokenVersionClaim ?? 0;

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        accountStatus: true,
        profileImageUrl: true,
        createdAt: true,
        updatedAt: true,
        tokenVersion: true,
      },
    });

    if (!user || user.tokenVersion !== tokenVersion) {
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
