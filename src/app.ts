import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import morgan from 'morgan';
import { env } from './config/env.js';
import authRouter from './modules/auth/auth.routes.js';
import eventRouter from './modules/events/event.routes.js';
import ticketRouter from './modules/tickets/ticket.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();

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

  const redactedPath = pathname.split('/').map((segment, index) =>
    index > 1 && tokenLikePathSegment.test(segment) ? '[redacted]' : segment,
  ).join('/');

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

/** Must run before Morgan so bearer tokens in ticket URLs are never written to the log stream. */
export function redactTicketRequestUrl(req: Request, _res: Response, next: NextFunction) {
  const rawUrl = req.originalUrl || req.url;
  if (!rawUrl.startsWith('/api/tickets/')) {
    return next();
  }

  const safeUrl = redactTicketUrl(rawUrl);
  req.url = safeUrl;
  req.originalUrl = safeUrl;
  return next();
}

app.set('trust proxy', 1);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || env.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: false,
  optionsSuccessStatus: 204,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(redactTicketRequestUrl);
app.use(morgan('dev', { stream: requestLogDelegate }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'gather-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/events', eventRouter);
app.use('/api/tickets', ticketRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
