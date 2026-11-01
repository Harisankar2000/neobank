import { timingSafeEqual } from 'node:crypto';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../../lib/audit.js';
import { UnauthorizedError } from '../../lib/errors.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const TOKEN_TTL = '12h';

/**
 * Customers log in and get a JWT (a signed token holding their customer id).
 * Each request sends it as `Authorization: Bearer <token>`; the signature
 * proves we issued it, so no session lookup is needed.
 *
 * The admin console uses a shared key in the `x-admin-key` header. A real
 * bank would use staff SSO with roles; a key keeps the demo simple.
 */
export async function registerAuth(app: FastifyInstance, jwtSecret: string, adminApiKey: string): Promise<void> {
  await app.register(jwt, { secret: jwtSecret, sign: { expiresIn: TOKEN_TTL } });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new UnauthorizedError('Log in again: your session is missing or expired');
    }
  });

  const expected = Buffer.from(adminApiKey);
  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    const provided = Buffer.from(String(request.headers['x-admin-key'] ?? ''));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedError('A valid x-admin-key header is required');
    }
  });
}

export function customerActor(request: FastifyRequest): Actor & { id: string } {
  return { type: 'CUSTOMER', id: request.user.sub, ip: request.ip };
}

export function adminActor(request: FastifyRequest): Actor {
  return { type: 'ADMIN', id: 'admin-console', ip: request.ip };
}
