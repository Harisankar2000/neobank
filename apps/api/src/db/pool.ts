import pg from 'pg';
import { env } from '../config/env.js';

// Postgres returns bigint as a string by default. Our money columns are bigint
// paise and stay far below 2^53, so it is safe to read them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });

export type DbClient = pg.PoolClient;

// 40P01 = deadlock detected, 40001 = serialization failure. Both mean "another
// transaction got in the way"; running the whole transaction again is safe.
const RETRYABLE = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 5;

/**
 * Runs `work` inside BEGIN … COMMIT. Any error rolls everything back, so a
 * money movement is saved completely or not at all. Deadlocks are retried
 * with a short random wait so the two transactions do not collide again.
 */
export async function withTransaction<T>(work: (client: DbClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (error as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
