import { Router } from 'express';
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
  getRsvpConfirmation,
  listEventRegistrations,
  parseRegistrationPagination,
  submitRsvp,
} from './rsvp.service.js';

const eventRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

eventRouter.get('/public/:slug', async (req, res, next) => {
  try {
    const event = await getPublicEventBySlug(req.params.slug);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/public/:slug/rsvp', async (req, res, next) => {
  try {
    const result = await submitRsvp(req.params.slug, req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

eventRouter.post('/public/:slug/rsvp/confirmation', async (req, res, next) => {
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

eventRouter.get('/:eventId/registrations', async (req, res, next) => {
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
});

eventRouter.get('/:eventId/registrations/:registrationId', async (req, res, next) => {
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

eventRouter.delete('/:id', async (req, res, next) => {
  try {
    const event = await softDeleteEvent(req.params.id, req.user!.id);
    res.status(200).json({ event });
  } catch (error) {
    next(error);
  }
});

export default eventRouter;
