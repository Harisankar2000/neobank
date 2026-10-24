import { config } from 'dotenv';
import { z } from 'zod';

// Works from the repo root and from apps/api (npm workspaces run scripts there).
config({ path: ['.env', '../../.env'], quiet: true });

const csvList = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

// Defaults match docker-compose.yml, so local development needs no .env file.
// Production must set real secrets: see the check at the bottom.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgresql://neobank:neobank@localhost:5435/neobank'),
  REDIS_URL: z.string().default('redis://localhost:6382'),
  KAFKA_BROKERS: csvList.default(['localhost:29093']),
  KAFKA_TOPIC: z.string().default('bank.events'),
  JWT_SECRET: z.string().min(16).default('dev-only-jwt-secret-change-me'),
  ADMIN_API_KEY: z.string().min(8).default('dev-admin-key'),
  CORS_ORIGINS: csvList.default(['http://localhost:5175']),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

if (env.NODE_ENV === 'production' && (env.JWT_SECRET.startsWith('dev-') || env.ADMIN_API_KEY.startsWith('dev-'))) {
  throw new Error('Set JWT_SECRET and ADMIN_API_KEY before running in production');
}
