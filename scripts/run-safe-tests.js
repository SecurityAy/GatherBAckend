import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';

const config = dotenv.parse(readFileSync('.env.test.local'));
for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!config[key]) throw new Error(`Missing ${key} in .env.test.local`);
  const url = new URL(config[key]);
  if (!url.hostname.endsWith('.neon.tech') || decodeURIComponent(url.pathname.slice(1)) !== 'gather_rsvp_test') {
    throw new Error(`${key} must point to Neon database gather_rsvp_test`);
  }
  process.env[key] = config[key];
}
process.env.JWT_SECRET = config.JWT_SECRET?.length >= 32 ? config.JWT_SECRET : randomBytes(32).toString('hex');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const args of [['exec', '--', 'prisma', 'generate'], ['exec', '--', 'prisma', 'migrate', 'deploy'], ['test', '--', ...process.argv.slice(2)]]) {
  const result = spawnSync(npm, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
