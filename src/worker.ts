import { prisma } from './lib/prisma.js';
import { startNotificationWorker, stopNotificationWorker } from './modules/notifications/notification-outbox.service.js';

startNotificationWorker();
console.log('Gather notification worker started.');

async function shutdown() {
  await stopNotificationWorker();
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
