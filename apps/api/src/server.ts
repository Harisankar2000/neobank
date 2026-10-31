import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { redis } from './lib/redis.js';
import { startBackgroundWorker } from './workers/background.js';

try {
  await redis.connect();
  await migrate();
  const app = await buildApp({ redis });
  await app.listen({ host: env.HOST, port: env.PORT });

  // Free hosting tiers often allow one process only: then the API runs the worker too.
  const worker = env.RUN_WORKER_IN_API ? await startBackgroundWorker(app.log) : null;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await app.close();
      await worker?.stop();
      await Promise.all([pool.end(), redis.quit()]);
      process.exit(0);
    });
  }
} catch (error) {
  console.error('Failed to start API:', error);
  process.exit(1);
}
