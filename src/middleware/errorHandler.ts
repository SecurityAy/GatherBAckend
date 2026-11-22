import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFoundHandler(_req: Request, res: Response) {
  // Never reflect the request URL: it may contain QR tokens or other bearer credentials.
  res.status(404).json({ message: 'Route not found.' });
}

export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      message: 'Request validation failed.',
      errors: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return res.status(409).json({ message: 'A record with this value already exists.' });
  }

  console.error('Request failed:', {
    requestId: req.requestId ?? '-',
    name: error.name,
    ...(error instanceof Prisma.PrismaClientKnownRequestError ? { code: error.code } : {}),
  });
  return res.status(500).json({ message: 'Unexpected server error.' });
}
