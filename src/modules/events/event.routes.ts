import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { sendWithEtag } from '../../middleware/cacheValidation.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { resolveDeviceContext, setDeviceCookie } from './device.service.js';
import { createEventImageUploadSignature } from './image-upload.service.js';
import {
  cancelEvent,
  completeEvent,
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
  cancelEventRegistration,
  cancelRsvpByToken,
  getEventRegistration,
  decideEventRegistration,
  getRsvpConfirmation,
  listEventRegistrations,
  parseRegistrationPagination,
  submitRsvp,
} from './rsvp.service.js';
import {
  issueMissingEventTickets,
  listEventAttendees,
  listEventTickets,
  reissueTicketById,
  reissueTicketForAttendee,
  revokeTicketById,
  revokeTicketForAttendee,
} from '../tickets/ticket.service.js';

const eventRouter = Router();

const limitRsvpSubmission = createRateLimiter({ maxRequests: 5, windowMs: 60 * 60 * 1000, keyPrefix: 'rsvp-submit' });
const limitRsvpConfirmation = createRateLimiter({ maxRequests: 20, windowMs: 15 * 60 * 1000, keyPrefix: 'rsvp-confirm' });
const limitUploadSigning = createRateLimiter({
  maxRequests: 30, windowMs: 15 * 60 * 1000, keyPrefix: 'upload-sign', keySelector: (req) => req.user?.id,
});
const limitTicketMutation = createRateLimiter({
  maxRequests: 30, windowMs: 15 * 60 * 1000, keyPrefix: 'ticket-mutation', keySelector: (req) => req.user?.id,
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const decisionBodySchema = z.object({}).strict();
const imageUploadSignatureBodySchema = z.object({}).strict();
const attendeePaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

eventRouter.get('/public/:slug', async (req: Request<{ slug: string }>, res, next) => {
  try {
    const event = await getPublicEventBySlug(req.params.slug, resolveDeviceContext(req));
    // hasReserved is device-specific, so this response must never be cached for another visitor.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/public/:slug/rsvp', limitRsvpSubmission, async (req: Request<{ slug: string }>, res, next) => {
  try {
    const device = resolveDeviceContext(req);
    setDeviceCookie(res, device.deviceId);
    const result = await submitRsvp(req.params.slug, req.body, device);
    // This response carries a confirmation token and, for auto-approved events, QR tokens.
    res.setHeader('Cache-Control', 'no-store');
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

eventRouter.post('/public/:slug/rsvp/cancel', limitRsvpConfirmation, async (req: Request<{ slug: string }>, res, next) => {
  try {
    const result = await cancelRsvpByToken(req.params.slug, req.body);
    res.status(200).json(result);
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

eventRouter.post('/:eventId/image-upload-signature', limitUploadSigning, async (req: Request<{ eventId: string }>, res, next) => {
  try {
    imageUploadSignatureBodySchema.parse(req.body ?? {});
    const uploadSignature = await createEventImageUploadSignature(req.params.eventId, req.user!.id);
    res.status(200).json({ upload: uploadSignature });
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
    sendWithEtag(req, res, result);
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
    const result = await decideEventRegistration(
      req.params.eventId,
      req.params.registrationId,
      req.user!.id,
      decision,
    );
    if (decision === 'approve') res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

eventRouter.get('/:eventId/rsvps', listRsvps);
eventRouter.get('/:eventId/rsvps/:registrationId', getRsvp);
eventRouter.post('/:eventId/rsvps/:registrationId/approve', decideRsvp('approve'));
eventRouter.post('/:eventId/rsvps/:registrationId/reject', decideRsvp('reject'));

eventRouter.post('/:eventId/rsvps/:registrationId/cancel', async (
  req: Request<{ eventId: string; registrationId: string }>,
  res,
  next,
) => {
  try {
    decisionBodySchema.parse(req.body ?? {});
    const result = await cancelEventRegistration(req.params.eventId, req.params.registrationId, req.user!.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:eventId/tickets/issue', limitTicketMutation, async (req: Request<{ eventId: string }>, res, next) => {
  try {
    decisionBodySchema.parse(req.body ?? {});
    const result = await issueMissingEventTickets(req.params.eventId, req.user!.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:eventId/tickets/:ticketId/reissue', limitTicketMutation, async (
  req: Request<{ eventId: string; ticketId: string }>,
  res,
  next,
) => {
  try {
    decisionBodySchema.parse(req.body ?? {});
    const result = await reissueTicketById(req.params.eventId, req.params.ticketId, req.user!.id);
    // This response carries a raw QR token.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:eventId/tickets/:ticketId/revoke', limitTicketMutation, async (
  req: Request<{ eventId: string; ticketId: string }>,
  res,
  next,
) => {
  try {
    decisionBodySchema.parse(req.body ?? {});
    const result = await revokeTicketById(req.params.eventId, req.params.ticketId, req.user!.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:eventId/attendees/:attendeeId/tickets/reissue', limitTicketMutation, async (
  req: Request<{ eventId: string; attendeeId: string }>,
  res,
  next,
) => {
  try {
    decisionBodySchema.parse(req.body ?? {});
    const result = await reissueTicketForAttendee(req.params.eventId, req.params.attendeeId, req.user!.id);
    // This response carries a raw QR token.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:eventId/attendees/:attendeeId/tickets/revoke', limitTicketMutation, async (
  req: Request<{ eventId: string; attendeeId: string }>,
  res,
  next,
) => {
  try {
    decisionBodySchema.parse(req.body ?? {});
    const result = await revokeTicketForAttendee(req.params.eventId, req.params.attendeeId, req.user!.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.get('/:eventId/attendees', async (req: Request<{ eventId: string }>, res, next) => {
  try {
    const pagination = attendeePaginationSchema.parse(req.query);
    const result = await listEventAttendees(req.params.eventId, req.user!.id, pagination.page, pagination.pageSize);
    sendWithEtag(req, res, result);
  } catch (error) {
    next(error);
  }
});

eventRouter.get('/:eventId/tickets', async (req: Request<{ eventId: string }>, res, next) => {
  try {
    const pagination = attendeePaginationSchema.parse(req.query);
    const result = await listEventTickets(req.params.eventId, req.user!.id, pagination.page, pagination.pageSize);
    sendWithEtag(req, res, result);
  } catch (error) {
    next(error);
  }
});

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

eventRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const event = await cancelEvent(req.params.id, req.user!.id);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/:id/complete', async (req, res, next) => {
  try {
    const event = await completeEvent(req.params.id, req.user!.id);
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
