import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { checkInEventTicket } from './ticket.service.js';

const limitCheckIn = createRateLimiter({
  maxRequests: 200, windowMs: 15 * 60 * 1000, keyPrefix: 'ticket-checkin', keySelector: (req) => req.user?.id,
});
const ticketRouter = Router();

ticketRouter.use(requireAuth);

ticketRouter.get('/validate/:qrCode', (req, res) => {
  // Defence in depth: Morgan redacts ticket-path tokens in logs; keep the retired
  // 410 handler from echoing or propagating the raw credential either.
  req.url = '/api/tickets/validate/[redacted]';
  req.originalUrl = req.url;
  res.status(410).json({
    message: 'The prototype validation route has been retired. Use POST /api/tickets/checkin with eventId and qrToken.',
  });
});

ticketRouter.post('/checkin', limitCheckIn, async (req, res, next) => {
  try {
    const payload = z.object({
      eventId: z.string().uuid(),
      qrToken: z.string().min(32).max(128).optional(),
      /** Legacy field name accepted during client migration; its value is now a secure bearer token. */
      qrCode: z.string().min(32).max(128).optional(),
    }).strict().refine((value) => Boolean(value.qrToken) !== Boolean(value.qrCode), {
      message: 'Provide exactly one of qrToken or qrCode.',
    }).parse(req.body);
    const qrToken = payload.qrToken ?? payload.qrCode!;
    const result = await checkInEventTicket(payload.eventId, req.user!.id, qrToken);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

export default ticketRouter;
