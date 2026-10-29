import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import { pool } from './pool.js';

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * Applies each .sql file in migrations/ once, in filename order.
 * An advisory lock stops two processes migrating at the same time.
 *
 * The advisory lock belongs to a database session. A pooler in transaction
 * mode (Neon's -pooler endpoint, PgBouncer) can hand each statement a
 * different session, so the lock would not hold. When a direct connection
 * string is available (DATABASE_URL_UNPOOLED), migrations use it.
 */
export async function migrate(): Promise<string[]> {
  const direct = env.DATABASE_URL_UNPOOLED ? new pg.Client({ connectionString: env.DATABASE_URL_UNPOOLED }) : null;
  if (direct) await direct.connect();
  const client = direct ?? (await pool.connect());
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(migrationsDir + file, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)');
    if (direct) await direct.end();
    else (client as pg.PoolClient).release();
  }
}

// Run directly: npm run migrate
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
