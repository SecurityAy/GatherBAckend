import app from './app.js';
import { env } from './config/env.js';
import { stopNotificationWorker, startNotificationWorker } from './modules/notifications/notification-outbox.service.js';

const server = app.listen(env.port, () => {
  console.log(`Gather backend listening on http://localhost:${env.port}`);
  startNotificationWorker();
});

async function shutdown() {
  await stopNotificationWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
