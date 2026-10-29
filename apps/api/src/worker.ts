/**
 * Background process: publishes the outbox and builds customer notifications.
 * Runs separately from the API, so a slow or broken Kafka never slows down
 * payments. On hosts without background workers, set RUN_WORKER_IN_API=true
 * instead and the API starts the same worker itself.
 */
import { pool } from './db/pool.js';
import { startBackgroundWorker } from './workers/background.js';

try {
  const worker = await startBackgroundWorker();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await worker.stop();
      await pool.end();
      process.exit(0);
    });
  }
} catch (error) {
  console.error('worker failed to start', error);
  process.exit(1);
}
