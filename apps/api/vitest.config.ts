import { defineConfig } from 'vitest/config';

export const TEST_DATABASE_URL = 'postgresql://neobank:neobank@localhost:5435/neobank_test';

export default defineConfig({
  test: {
    // Every database URL points at the local test database, so values in .env
    // (for example a Neon DATABASE_URL_UNPOOLED) can never be reached by tests.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_URL_UNPOOLED: TEST_DATABASE_URL,
      REDIS_URL: 'redis://localhost:6382/1',
    },
    testTimeout: 20_000,
    globalSetup: ['tests/global-setup.ts'],
    // Tests share one database, so run files one at a time.
    fileParallelism: false,
  },
});
