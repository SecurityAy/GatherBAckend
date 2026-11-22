import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';

let envFile;
try {
  envFile = readFileSync('.env.test.local');
} catch {
  throw new Error('Missing .env.test.local. Create it with DATABASE_URL and DIRECT_URL pointing to the disposable gather_rsvp_test database.');
}
const config = dotenv.parse(envFile);
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
// Node test-runner flags must precede the test file; npm appends script args after
// it. Use the running node binary directly so a stray npm "node" package is never
// resolved and the name pattern actually filters tests.
const testArgs = process.argv.slice(2);
for (const [command, args] of [
  [npm, ['exec', '--', 'prisma', 'generate']],
  [npm, ['exec', '--', 'prisma', 'migrate', 'deploy']],
  [process.execPath, ['--import', 'tsx', '--test', ...testArgs, 'tests/rsvp.integration.test.ts']],
]) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
    shell: command === npm && process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
