import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { redis } from './lib/redis.js';

try {
  await redis.connect();
  await migrate();
  const app = await buildApp({ redis });
  await app.listen({ host: env.HOST, port: env.PORT });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await app.close();
      await Promise.all([pool.end(), redis.quit()]);
      process.exit(0);
    });
  }
} catch (error) {
  console.error('Failed to start API:', error);
  process.exit(1);
}
