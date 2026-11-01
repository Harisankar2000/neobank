import { config } from 'dotenv';
import { z } from 'zod';

// Works from the repo root and from apps/api (npm workspaces run scripts there).
config({ path: ['.env', '../../.env'], quiet: true });

const csvList = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const flag = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

// PEM certificates pasted into a hosting dashboard often arrive with literal "\n".
const pem = z
  .string()
  .optional()
  .transform((value) => value?.replaceAll('\\n', '\n') || undefined);

// Defaults match docker-compose.yml, so local development needs no .env file.
// Production must set real secrets: see the check at the bottom.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgresql://neobank:neobank@localhost:5435/neobank'),
  // Direct (non-pooled) connection for migrations, e.g. Neon's DATABASE_URL_UNPOOLED.
  DATABASE_URL_UNPOOLED: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6382'),
  // How the outbox relay delivers events: through Kafka, or straight to the notifier
  // in the same process ("direct", for hosts without a Kafka cluster).
  EVENT_TRANSPORT: z.enum(['kafka', 'direct']).default('kafka'),
  KAFKA_BROKERS: csvList.default(['localhost:29093']),
  KAFKA_TOPIC: z.string().default('bank.events'),
  KAFKA_TOPIC_PARTITIONS: z.coerce.number().int().positive().default(3),
  KAFKA_TOPIC_REPLICATION: z.coerce.number().int().positive().default(1),
  // Managed Kafka (e.g. Aiven) needs TLS, with a client certificate or SASL credentials.
  KAFKA_SSL: flag,
  KAFKA_SSL_CA: pem,
  KAFKA_SSL_CERT: pem,
  KAFKA_SSL_KEY: pem,
  KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).default('scram-sha-256'),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  // Run the outbox relay and notifier inside the API process, for hosts whose free
  // tier has no separate background workers.
  RUN_WORKER_IN_API: flag,
  JWT_SECRET: z.string().min(16).default('dev-only-jwt-secret-change-me'),
  ADMIN_API_KEY: z.string().min(8).default('dev-admin-key'),
  CORS_ORIGINS: csvList.default(['http://localhost:5175']),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  // Behind a reverse proxy (nginx, Coolify) the client IP comes from X-Forwarded-For.
  // Without this, every request looks like it came from the proxy and shares one rate limit.
  TRUST_PROXY: flag,
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
