import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';

const ticketRouter = Router();

const ticketStore: Array<{ id: string; qrCode: string; eventId: string; status: 'approved' | 'used'; ownerId: string }> = [];

ticketRouter.use(requireAuth);

ticketRouter.get('/validate/:qrCode', (req, res) => {
  const ticket = ticketStore.find((item) => item.qrCode === req.params.qrCode);

  if (!ticket) {
    return res.status(404).json({ message: 'Ticket not found.' });
  }

  if (ticket.status === 'used') {
    return res.status(409).json({ message: 'This ticket has already been used.' });
  }

  return res.status(200).json({ valid: true, ticket });
});

ticketRouter.post('/checkin', (req, res, next) => {
  try {
    const schema = z.object({
      qrCode: z.string().min(8),
      eventId: z.string().min(3),
    });

    const payload = schema.parse(req.body);
    const ticket = ticketStore.find((item) => item.qrCode === payload.qrCode && item.eventId === payload.eventId);

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found for this event.' });
    }

    if (ticket.ownerId !== req.user!.id) {
      return res.status(403).json({ message: 'This ticket is not linked to your account.' });
    }

    ticket.status = 'used';
    return res.status(200).json({ message: 'Guest checked in successfully.', ticket });
  } catch (error) {
    next(error);
  }
});

export function registerTicket(ticket: { id: string; qrCode: string; eventId: string; ownerId: string; status?: 'approved' | 'used' }) {
  ticketStore.push({
    id: ticket.id,
    qrCode: ticket.qrCode,
    eventId: ticket.eventId,
    status: ticket.status ?? 'approved',
    ownerId: ticket.ownerId,
  });
}

export default ticketRouter;
