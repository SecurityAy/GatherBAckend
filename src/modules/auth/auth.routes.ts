import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { loginUser, registerUser } from './auth.service.js';

const authRouter = Router();

function createRateLimiter(maxRequests: number, windowMs: number) {
  const requestsByIp = new Map<string, { count: number; resetAt: number }>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, window] of requestsByIp) {
      if (window.resetAt <= now) {
        requestsByIp.delete(ip);
      }
    }
  }, windowMs);
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const current = requestsByIp.get(key);
    const window = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;

    if (window.count >= maxRequests) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((window.resetAt - now) / 1000)));
      return res.status(429).json({ message: 'Too many requests. Please try again later.' });
    }

    window.count += 1;
    requestsByIp.set(key, window);
    return next();
  };
}

const limitRegistration = createRateLimiter(5, 60 * 60 * 1000);
const limitLogin = createRateLimiter(10, 15 * 60 * 1000);

authRouter.post('/register', limitRegistration, async (req, res, next) => {
  try {
    const result = await registerUser(req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', limitLogin, async (req, res, next) => {
  try {
    const result = await loginUser(req.body);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  return res.status(200).json({ user: req.user });
});

export default authRouter;
