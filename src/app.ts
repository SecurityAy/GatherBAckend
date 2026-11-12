import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { env } from './config/env.js';
import authRouter from './modules/auth/auth.routes.js';
import eventRouter from './modules/events/event.routes.js';
import ticketRouter from './modules/tickets/ticket.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();

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
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'gather-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/events', eventRouter);
app.use('/api/tickets', ticketRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
