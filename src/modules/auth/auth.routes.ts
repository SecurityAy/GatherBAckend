import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import {
  changeCurrentUserPassword,
  loginUser,
  registerUser,
  requestPasswordReset,
  resetPassword,
  updateCurrentUser,
} from './auth.service.js';

const authRouter = Router();

const limitRegistration = createRateLimiter({ maxRequests: 5, windowMs: 60 * 60 * 1000, keyPrefix: 'auth-register' });
const limitLogin = createRateLimiter({ maxRequests: 10, windowMs: 15 * 60 * 1000, keyPrefix: 'auth-login' });
const limitPasswordResetRequest = createRateLimiter({ maxRequests: 5, windowMs: 60 * 60 * 1000, keyPrefix: 'auth-forgot-password' });
const limitPasswordResetConfirm = createRateLimiter({ maxRequests: 10, windowMs: 15 * 60 * 1000, keyPrefix: 'auth-reset-password' });
const limitAccountMutation = createRateLimiter({
  maxRequests: 20, windowMs: 15 * 60 * 1000, keyPrefix: 'auth-account-mutation', keySelector: (req) => req.user?.id,
});

authRouter.post('/register', limitRegistration, async (req, res, next) => {
  try {
    const result = await registerUser(req.body);
    // The response contains a bearer token; never allow intermediaries to cache it.
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', limitLogin, async (req, res, next) => {
  try {
    const result = await loginUser(req.body);
    // The response contains a bearer token; never allow intermediaries to cache it.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/forgot-password', limitPasswordResetRequest, async (req, res, next) => {
  try {
    const result = await requestPasswordReset(req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/reset-password', limitPasswordResetConfirm, async (req, res, next) => {
  try {
    const result = await resetPassword(req.body);
    res.setHeader('Cache-Control', 'no-store');
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

authRouter.patch('/me', requireAuth, limitAccountMutation, async (req, res, next) => {
  try {
    const result = await updateCurrentUser(req.user!.id, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/change-password', requireAuth, limitAccountMutation, async (req, res, next) => {
  try {
    const result = await changeCurrentUserPassword(req.user!.id, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

export default authRouter;
