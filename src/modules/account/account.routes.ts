import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import {
  deleteAccount,
  getAccountDataExport,
  getAccountPreferences,
  updateAccountPreferences,
} from './account.service.js';

const meRouter = Router();

const limitAccountDeletion = createRateLimiter({
  maxRequests: 5, windowMs: 60 * 60 * 1000, keyPrefix: 'account-delete', keySelector: (req) => req.user?.id,
});
const limitPreferenceMutation = createRateLimiter({
  maxRequests: 30, windowMs: 15 * 60 * 1000, keyPrefix: 'account-preferences', keySelector: (req) => req.user?.id,
});

meRouter.use(requireAuth);

meRouter.get('/data-export', async (req, res, next) => {
  try {
    const result = await getAccountDataExport(req.user!.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

meRouter.delete('/', limitAccountDeletion, async (req, res, next) => {
  try {
    const result = await deleteAccount(req.user!.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

meRouter.get('/preferences', async (req, res, next) => {
  try {
    const preferences = await getAccountPreferences(req.user!.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ preferences });
  } catch (error) {
    next(error);
  }
});

meRouter.put('/preferences', limitPreferenceMutation, async (req, res, next) => {
  try {
    const preferences = await updateAccountPreferences(req.user!.id, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ preferences });
  } catch (error) {
    next(error);
  }
});

export default meRouter;
