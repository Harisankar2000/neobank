import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { startOfIstDay } from '../../lib/money.js';
import { setAccountStatus } from '../../modules/accounts/account.service.js';
import { listReconciliationRuns, runReconciliation } from '../../modules/reconciliation/reconciliation.service.js';
import { TRANSACTION_VIEW_SQL, type TransactionView } from '../../modules/transactions/transaction.view.js';
import { approveTransfer, rejectTransfer, reverseTransfer } from '../../modules/transactions/transfer.service.js';
import { adminActor } from '../plugins/auth.js';
import { idParam, pagination } from '../schemas.js';

/** Back-office routes for bank staff, under /admin. */
export async function adminRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('onRequest', fastify.requireAdmin);
  const security = [{ adminKey: [] }];
  const tags = ['admin'];
  const reasonBody = z.object({ reason: z.string().trim().min(3).max(200) });

  app.get('/overview', { schema: { tags, security } }, async () => {
    // "Today" is the calendar day in India, the same as the daily transfer limit.
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM customers) AS customers,
        (SELECT count(*)::int FROM accounts WHERE kind = 'CUSTOMER') AS accounts,
        (SELECT COALESCE(SUM(balance), 0)::bigint FROM accounts WHERE kind = 'CUSTOMER') AS "customerDeposits",
        (SELECT count(*)::int FROM transactions WHERE status = 'PENDING') AS "pendingReviews",
        (SELECT count(*)::int FROM transactions WHERE type = 'TRANSFER' AND created_at >= $1) AS "transfersToday",
        (SELECT count(*)::int FROM transactions WHERE status = 'FAILED' AND created_at >= $1) AS "failedToday",
        (SELECT count(*)::int FROM outbox_events WHERE published_at IS NULL) AS "outboxBacklog"`, [startOfIstDay()]);
    return rows[0];
  });

  app.get(
    '/transactions',
    {
      schema: {
        tags,
        security,
        querystring: pagination.extend({
          status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REVERSED']).optional(),
          reference: z.string().trim().max(40).optional(),
        }),
      },
    },
    async (request) => {
      const { page, pageSize, status, reference } = request.query;
      const where = `WHERE ($1::text IS NULL OR t.status = $1) AND ($2::text IS NULL OR t.reference ILIKE $2 || '%')`;
      const params = [status ?? null, reference ?? null];
      const [items, total] = await Promise.all([
        pool.query<TransactionView>(`${TRANSACTION_VIEW_SQL} ${where} ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`, [
          ...params,
          pageSize,
          (page - 1) * pageSize,
        ]),
        pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM transactions t ${where}`, params),
      ]);
      return { items: items.rows, page, pageSize, total: total.rows[0]!.count };
    },
  );

  app.post('/transactions/:id/approve', { schema: { tags, security, params: idParam } }, async (request) =>
    approveTransfer(adminActor(request), request.params.id),
  );

  app.post(
    '/transactions/:id/reject',
    { schema: { tags, security, params: idParam, body: reasonBody } },
    async (request) => rejectTransfer(adminActor(request), request.params.id, request.body.reason),
  );

  app.post(
    '/transactions/:id/reverse',
    { schema: { tags, security, params: idParam, body: reasonBody } },
    async (request) => reverseTransfer(adminActor(request), request.params.id, request.body.reason),
  );

  app.get(
    '/accounts',
    { schema: { tags, security, querystring: z.object({ search: z.string().trim().max(80).optional() }) } },
    async (request) => {
      const { rows } = await pool.query(
        `SELECT a.id, a.account_number AS "accountNumber", a.product, a.balance, a.daily_limit AS "dailyLimit",
                a.status, c.full_name AS "holderName", c.email, a.created_at AS "createdAt"
           FROM accounts a JOIN customers c ON c.id = a.customer_id
          WHERE $1::text IS NULL OR c.full_name ILIKE '%' || $1 || '%' OR a.account_number LIKE $1 || '%'
          ORDER BY c.full_name, a.created_at LIMIT 100`,
        [request.query.search || null],
      );
      return rows;
    },
  );

  app.patch(
    '/accounts/:id/status',
    { schema: { tags, security, params: idParam, body: reasonBody.extend({ status: z.enum(['ACTIVE', 'FROZEN']) }) } },
    async (request) => setAccountStatus(adminActor(request), request.params.id, request.body.status, request.body.reason),
  );

  app.post('/reconciliation/runs', { schema: { tags, security } }, async (request, reply) =>
    reply.code(201).send(await runReconciliation(adminActor(request))),
  );

  app.get('/reconciliation/runs', { schema: { tags, security } }, async () => listReconciliationRuns());

  app.get('/audit-logs', { schema: { tags, security, querystring: pagination } }, async (request) => {
    const { page, pageSize } = request.query;
    const { rows } = await pool.query(
      `SELECT id, actor_type AS "actorType", actor_id AS "actorId", action, entity_type AS "entityType",
              entity_id AS "entityId", details, ip, created_at AS "createdAt"
         FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    );
    return { items: rows, page, pageSize };
  });
}
