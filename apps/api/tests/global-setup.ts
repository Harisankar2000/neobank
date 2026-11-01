import pg from 'pg';
import { TEST_DATABASE_URL } from '../vitest.config.js';

/** Recreates neobank_test from scratch and migrates it before the test run. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL.replace(/\/neobank_test$/, '/neobank') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS neobank_test WITH (FORCE)');
  await admin.query('CREATE DATABASE neobank_test');
  await admin.end();

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DATABASE_URL_UNPOOLED = TEST_DATABASE_URL;
  const { migrate } = await import('../src/db/migrate.js');
  const { pool } = await import('../src/db/pool.js');
  await migrate();
  await pool.end();
}
