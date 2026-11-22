import type { NextFunction, Request, Response } from 'express';

type RateWindow = { count: number; resetAt: number };

/** Bounds memory if a caller rotates identities; new keys fail closed once full. */
const MAX_TRACKED_KEYS = 10_000;

export type RateLimitOptions = {
  maxRequests: number;
  windowMs: number;
  /** Isolates counters so one route cannot consume another route's budget. */
  keyPrefix: string;
  /** Optional actor key (for authenticated routes); falls back to the request IP. */
  keySelector?: (req: Request) => string | undefined;
};

/**
 * Fixed-window, in-process limiter shared by all routers.
 *
 * Limitation: counters are per server instance and reset on restart. A multi-instance
 * deployment should replace the backing map with a shared store (for example Redis).
 */
export function createRateLimiter({ maxRequests, windowMs, keyPrefix, keySelector }: RateLimitOptions) {
  const requestsByKey = new Map<string, RateWindow>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of requestsByKey) {
      if (window.resetAt <= now) requestsByKey.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const identity = keySelector?.(req) ?? req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = `${keyPrefix}:${identity}`;
    const now = Date.now();
    let window = requestsByKey.get(key);

    if (!window || window.resetAt <= now) {
      // Do not evict an active bucket: a caller rotating spoofed IPs could otherwise
      // flush other clients' limits and bypass the cap.
      for (const [trackedKey, trackedWindow] of requestsByKey) {
        if (trackedWindow.resetAt <= now) requestsByKey.delete(trackedKey);
      }
      if (requestsByKey.size >= MAX_TRACKED_KEYS) {
        const oldest = requestsByKey.entries().next();
        const retryAfter = oldest.done
          ? 1
          : Math.max(1, Math.ceil((oldest.value[1].resetAt - now) / 1000));
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({ message: 'Too many requests. Please try again later.' });
      }
      window = { count: 0, resetAt: now + windowMs };
      requestsByKey.set(key, window);
    }

    if (window.count >= maxRequests) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((window.resetAt - now) / 1000)));
      return res.status(429).json({ message: 'Too many requests. Please try again later.' });
    }

    window.count += 1;
    return next();
  };
}
