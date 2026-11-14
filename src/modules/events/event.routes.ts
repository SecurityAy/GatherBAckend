import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import {
  createEvent,
  getEventById,
  getPublicEventBySlug,
  listEventsByUser,
  publishEvent,
  softDeleteEvent,
  unpublishEvent,
  updateEvent,
} from './event.service.js';
import {
  getEventRegistration,
  decideEventRegistration,
  getRsvpConfirmation,
  listEventRegistrations,
  parseRegistrationPagination,
  submitRsvp,
} from './rsvp.service.js';

const eventRouter = Router();

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

const limitRsvpSubmission = createRateLimiter(5, 60 * 60 * 1000);
const limitRsvpConfirmation = createRateLimiter(20, 15 * 60 * 1000);

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const decisionBodySchema = z.object({}).strict();

eventRouter.get('/public/:slug', async (req: Request<{ slug: string }>, res, next) => {
  try {
    const event = await getPublicEventBySlug(req.params.slug);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/public/:slug/rsvp', limitRsvpSubmission, async (req: Request<{ slug: string }>, res, next) => {
  try {
    const result = await submitRsvp(req.params.slug, req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/public/:slug/rsvp/confirmation', limitRsvpConfirmation, async (req: Request<{ slug: string }>, res, next) => {
  try {
    const confirmation = await getRsvpConfirmation(req.params.slug, req.body);
    res.status(200).json({ confirmation });
  } catch (error) {
    next(error);
  }
});

eventRouter.use(requireAuth);

eventRouter.get('/', async (req, res, next) => {
  try {
    const pagination = paginationSchema.parse(req.query);
    const result = await listEventsByUser(req.user!.id, pagination.page, pagination.pageSize);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/', async (req, res, next) => {
  try {
    const event = await createEvent(req.user!.id, req.body);
    res.status(201).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.get('/:id', async (req, res, next) => {
  try {
    const event = await getEventById(req.params.id, req.user!.id);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

const listRsvps = async (req: Request<{ eventId: string }>, res: Response, next: NextFunction) => {
  try {
    const pagination = parseRegistrationPagination(req.query);
    const result = await listEventRegistrations(
      req.params.eventId,
      req.user!.id,
      pagination.page,
      pagination.pageSize,
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const getRsvp = async (
  req: Request<{ eventId: string; registrationId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const registration = await getEventRegistration(
      req.params.eventId,
      req.params.registrationId,
      req.user!.id,
    );
    res.status(200).json({ registration });
  } catch (error) {
    next(error);
  }
};

const decideRsvp = (decision: 'approve' | 'reject') => async (
  req: Request<{ eventId: string; registrationId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    decisionBodySchema.parse(req.body ?? {});
    const registration = await decideEventRegistration(
      req.params.eventId,
      req.params.registrationId,
      req.user!.id,
      decision,
    );
    res.status(200).json({ registration });
  } catch (error) {
    next(error);
  }
};

eventRouter.get('/:eventId/rsvps', listRsvps);
eventRouter.get('/:eventId/rsvps/:registrationId', getRsvp);
eventRouter.post('/:eventId/rsvps/:registrationId/approve', decideRsvp('approve'));
eventRouter.post('/:eventId/rsvps/:registrationId/reject', decideRsvp('reject'));

eventRouter.patch('/:id', async (req, res, next) => {
  try {
    const event = await updateEvent(req.params.id, req.user!.id, req.body);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const event = await publishEvent(req.params.id, req.user!.id);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:id/unpublish', async (req, res, next) => {
  try {
    const event = await unpublishEvent(req.params.id, req.user!.id);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.delete('/:id', async (req, res, next) => {
  try {
    const event = await softDeleteEvent(req.params.id, req.user!.id);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

export default eventRouter;
