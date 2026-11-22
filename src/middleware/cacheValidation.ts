import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * Sends a safe organizer list response with a content-derived validator so clients
 * can poll with `If-None-Match` and avoid re-rendering unchanged tables. The ETag is
 * hashed from the public response body only; no tokens or credentials are included.
 */
export function sendWithEtag(req: Request, res: Response, payload: unknown) {
  const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.status(200).json(payload);
}
