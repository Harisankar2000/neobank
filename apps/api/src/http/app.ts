import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { adminRoutes } from './routes/admin.routes.js';
import { customerRoutes } from './routes/customer.routes.js';

export interface BuildAppOptions {
  redis: Redis;
  /** Keep rate-limit counters in Redis so the limit holds across API instances. */
  sharedRateLimit?: boolean;
}

export async function buildApp({ redis, sharedRateLimit = true }: BuildAppOptions) {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    exposedHeaders: ['idempotent-replayed', 'x-request-id', 'content-disposition'],
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    ...(sharedRateLimit && { redis, nameSpace: 'neobank:ratelimit:' }),
  });
  await registerAuth(app, env.JWT_SECRET, env.ADMIN_API_KEY);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'NeoBank API',
        version: '1.0.0',
        description:
          'Simulated digital bank. Amounts are integer paise (₹1 = 100). Money-moving POSTs need an Idempotency-Key header.',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          adminKey: { type: 'apiKey', name: 'x-admin-key', in: 'header' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/health', { config: { rateLimit: false } }, async () => {
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    return { status: 'server is working fine!' };
  });

  await app.register(
    async (api) => {
      await api.register(customerRoutes, { redis });
      await api.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
