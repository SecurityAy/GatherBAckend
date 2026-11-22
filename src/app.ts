import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import morgan from 'morgan';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import meRouter from './modules/account/account.routes.js';
import authRouter from './modules/auth/auth.routes.js';
import eventRouter from './modules/events/event.routes.js';
import ticketRouter from './modules/tickets/ticket.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

type RequestLogStream = { write(message: string): void };

const sensitiveQueryKeys = new Set([
  'qrtoken',
  'qrcode',
  'token',
  'confirmationtoken',
  'accesstoken',
  'authorization',
]);
const tokenLikePathSegment = /^[A-Za-z0-9._~-]{32,}$/;

let requestLogStream: RequestLogStream = process.stdout;
const requestLogDelegate: RequestLogStream = {
  write: (message) => requestLogStream.write(message),
};

/** Test-only hook: keeps request-log assertions in-process without changing the default stream. */
export function setRequestLogStreamForTests(stream: RequestLogStream | undefined) {
  requestLogStream = stream ?? process.stdout;
}

export function redactTicketUrl(rawUrl: string) {
  const questionMarkIndex = rawUrl.indexOf('?');
  const pathname = questionMarkIndex === -1 ? rawUrl : rawUrl.slice(0, questionMarkIndex);
  const queryString = questionMarkIndex === -1 ? '' : rawUrl.slice(questionMarkIndex + 1);

  const redactedPath = pathname.startsWith('/api/tickets/')
    ? pathname.split('/').map((segment, index) =>
      index > 1 && tokenLikePathSegment.test(segment) ? '[redacted]' : segment,
    ).join('/')
    : pathname;

  if (!queryString) {
    return redactedPath;
  }

  const redactedQuery = queryString.split('&').map((pair) => {
    const equalsIndex = pair.indexOf('=');
    const key = equalsIndex === -1 ? pair : pair.slice(0, equalsIndex);
    return sensitiveQueryKeys.has(key.toLowerCase()) ? `${key}=[redacted]` : pair;
  }).join('&');

  return `${redactedPath}?${redactedQuery}`;
}

/** Morgan token: redact credentials for logging only, without rewriting routing URLs. */
morgan.token('safe-url', (req) => redactTicketUrl((req as Request).originalUrl || req.url || ''));
morgan.token('request-id', (req) => (req as Request).requestId ?? '-');

function assignRequestId(req: Request, res: Response, next: NextFunction) {
  const header = req.header('x-request-id');
  req.requestId = header && /^[A-Za-z0-9._-]{1,64}$/.test(header) ? header : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  return next();
}

/** Baseline security headers for a JSON API; HSTS is enabled only for HTTPS deployments. */
function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (env.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(assignRequestId);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || env.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'x-device-id'],
  credentials: true,
  optionsSuccessStatus: 204,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length] req=:request-id', { stream: requestLogDelegate }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'gather-backend' });
});

app.get('/health/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({ status: 'ready' });
  } catch {
    return res.status(503).json({ status: 'not ready' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/events', eventRouter);
app.use('/api/tickets', ticketRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
