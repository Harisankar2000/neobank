import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import type { IdempotentResponse } from '../../ledger/idempotency.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  authenticateCustomer,
  getCustomer,
  getLimitUsage,
  getOwnAccount,
  listAccounts,
  openAccount,
  registerCustomer,
  setDailyLimit,
} from '../../modules/accounts/account.service.js';
import { addBeneficiary, listBeneficiaries, removeBeneficiary } from '../../modules/beneficiaries/beneficiary.service.js';
import { buildStatement, statementToCsv, statementToPdf } from '../../modules/statements/statement.service.js';
import { TRANSACTION_VIEW_SQL, type TransactionView } from '../../modules/transactions/transaction.view.js';
import { createDeposit, createTransfer } from '../../modules/transactions/transfer.service.js';
import { customerActor } from '../plugins/auth.js';
import { accountNumber, idempotencyHeaders, idParam, isoDate, pagination, paise } from '../schemas.js';

function sendIdempotent(reply: import('fastify').FastifyReply, result: IdempotentResponse) {
  if (result.replayed) reply.header('idempotent-replayed', 'true');
  return reply.code(result.statusCode).send(result.body);
}

export async function customerRoutes(fastify: FastifyInstance, { redis }: { redis: Redis }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ─── auth (public) ──────────────────────────────────────────────────────

  // Stricter limit on auth routes to slow down password guessing.
  const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post(
    '/auth/register',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        body: z.object({
          fullName: z.string().trim().min(2).max(80),
          email: z.email().max(120),
          phone: z.string().regex(/^[6-9]\d{9}$/, 'Use a 10-digit Indian mobile number'),
          password: z.string().min(8).max(72),
        }),
      },
    },
    async (request, reply) => {
      const { customer, account } = await registerCustomer(request.body, request.ip);
      const token = await reply.jwtSign({ sub: customer.id });
      return reply.code(201).send({ token, customer, accounts: [account] });
    },
  );

  app.post(
    '/auth/login',
    {
      config: authRateLimit,
      schema: { tags: ['auth'], body: z.object({ email: z.email(), password: z.string().min(1).max(72) }) },
    },
    async (request, reply) => {
      const customer = await authenticateCustomer(request.body.email, request.body.password, request.ip);
      const token = await reply.jwtSign({ sub: customer.id });
      return { token, customer };
    },
  );

  // ─── everything below needs a logged-in customer ───────────────────────

  app.register(async (secured) => {
    const api = secured.withTypeProvider<ZodTypeProvider>();
    api.addHook('onRequest', fastify.authenticate);
    const security = [{ bearerAuth: [] }];

    api.get('/me', { schema: { tags: ['accounts'], security } }, async (request) => {
      const customer = await getCustomer(request.user.sub);
      return { customer, accounts: await listAccounts(customer.id) };
    });

    // Accounts

    api.post(
      '/accounts',
      { schema: { tags: ['accounts'], security, body: z.object({ product: z.enum(['SAVINGS', 'CURRENT']) }) } },
      async (request, reply) => reply.code(201).send(await openAccount(customerActor(request), request.body.product)),
    );

    api.get('/accounts/:id', { schema: { tags: ['accounts'], security, params: idParam } }, async (request) => {
      const account = await getOwnAccount(pool, request.user.sub, request.params.id);
      return { account, limits: await getLimitUsage(request.user.sub, account.id) };
    });

    api.patch(
      '/accounts/:id/daily-limit',
      {
        schema: { tags: ['accounts'], security, params: idParam, body: z.object({ dailyLimit: paise(2_00_000) }) },
      },
      async (request) => setDailyLimit(customerActor(request), request.params.id, request.body.dailyLimit),
    );

    api.post(
      '/accounts/:id/deposits',
      {
        schema: {
          tags: ['money'],
          security,
          params: idParam,
          headers: idempotencyHeaders,
          body: z.object({ amount: paise(1_00_000) }),
        },
      },
      async (request, reply) => {
        const result = await createDeposit(
          customerActor(request),
          { accountId: request.params.id, amount: request.body.amount },
          request.headers['idempotency-key'],
        );
        return sendIdempotent(reply, result);
      },
    );

    // Statements

    const statementQuery = z.object({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, {
      message: '`from` must be on or before `to`',
    });

    api.get(
      '/accounts/:id/statement',
      { schema: { tags: ['statements'], security, params: idParam, querystring: statementQuery } },
      async (request) => buildStatement(request.user.sub, request.params.id, request.query.from, request.query.to),
    );

    api.get(
      '/accounts/:id/statement.csv',
      { schema: { tags: ['statements'], security, params: idParam, querystring: statementQuery } },
      async (request, reply) => {
        const statement = await buildStatement(request.user.sub, request.params.id, request.query.from, request.query.to);
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="statement-${statement.account.accountNumber}.csv"`)
          .send(statementToCsv(statement));
      },
    );

    api.get(
      '/accounts/:id/statement.pdf',
      { schema: { tags: ['statements'], security, params: idParam, querystring: statementQuery } },
      async (request, reply) => {
        const statement = await buildStatement(request.user.sub, request.params.id, request.query.from, request.query.to);
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="statement-${statement.account.accountNumber}.pdf"`)
          .send(await statementToPdf(statement));
      },
    );

    // Transfers and transaction history

    api.post(
      '/transfers',
      {
        schema: {
          tags: ['money'],
          security,
          headers: idempotencyHeaders,
          body: z.object({
            fromAccountId: z.uuid(),
            toAccountNumber: accountNumber,
            amount: paise(2_00_000),
            note: z.string().trim().max(140).optional(),
          }),
        },
      },
      async (request, reply) => {
        const result = await createTransfer(redis, customerActor(request), request.body, request.headers['idempotency-key']);
        return sendIdempotent(reply, result);
      },
    );

    api.get(
      '/transactions',
      {
        schema: {
          tags: ['money'],
          security,
          querystring: pagination.extend({
            accountId: z.uuid().optional(),
            status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REVERSED']).optional(),
          }),
        },
      },
      async (request) => {
        const { page, pageSize, accountId, status } = request.query;
        const where = `WHERE (fa.customer_id = $1 OR ta.customer_id = $1)
                         AND ($2::uuid IS NULL OR t.from_account_id = $2 OR t.to_account_id = $2)
                         AND ($3::text IS NULL OR t.status = $3)`;
        const params = [request.user.sub, accountId ?? null, status ?? null];
        const [items, total] = await Promise.all([
          pool.query<TransactionView>(
            `${TRANSACTION_VIEW_SQL} ${where} ORDER BY t.created_at DESC LIMIT $4 OFFSET $5`,
            [...params, pageSize, (page - 1) * pageSize],
          ),
          pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM transactions t
               JOIN accounts fa ON fa.id = t.from_account_id JOIN accounts ta ON ta.id = t.to_account_id ${where}`,
            params,
          ),
        ]);
        return { items: items.rows, page, pageSize, total: total.rows[0]!.count };
      },
    );

    api.get('/transactions/:id', { schema: { tags: ['money'], security, params: idParam } }, async (request) => {
      const { rows } = await pool.query<TransactionView>(
        `${TRANSACTION_VIEW_SQL} WHERE t.id = $1 AND (fa.customer_id = $2 OR ta.customer_id = $2)`,
        [request.params.id, request.user.sub],
      );
      if (!rows[0]) throw new NotFoundError('Transaction', request.params.id);
      const entries = await pool.query(
        `SELECT e.id, a.account_number AS "accountNumber", e.direction, e.amount, e.created_at AS "createdAt"
           FROM entries e JOIN accounts a ON a.id = e.account_id
          WHERE e.transaction_id = $1 ORDER BY e.id`,
        [request.params.id],
      );
      return { transaction: rows[0], entries: entries.rows };
    });

    // Beneficiaries

    api.get('/beneficiaries', { schema: { tags: ['beneficiaries'], security } }, async (request) =>
      listBeneficiaries(request.user.sub),
    );

    api.post(
      '/beneficiaries',
      {
        schema: {
          tags: ['beneficiaries'],
          security,
          body: z.object({ accountNumber, nickname: z.string().trim().min(1).max(40) }),
        },
      },
      async (request, reply) => reply.code(201).send(await addBeneficiary(customerActor(request), request.body)),
    );

    api.delete(
      '/beneficiaries/:id',
      { schema: { tags: ['beneficiaries'], security, params: idParam } },
      async (request, reply) => {
        await removeBeneficiary(customerActor(request), request.params.id);
        return reply.code(204).send();
      },
    );

    // Notifications (written by the Kafka consumer)

    api.get('/notifications', { schema: { tags: ['notifications'], security } }, async (request) => {
      const [items, unread] = await Promise.all([
        pool.query(
          `SELECT id, title, body, read_at AS "readAt", created_at AS "createdAt"
             FROM notifications WHERE customer_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`,
          [request.user.sub],
        ),
        pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM notifications WHERE customer_id = $1 AND read_at IS NULL`,
          [request.user.sub],
        ),
      ]);
      return { items: items.rows, unread: unread.rows[0]!.count };
    });

    api.post('/notifications/read-all', { schema: { tags: ['notifications'], security } }, async (request, reply) => {
      await pool.query(`UPDATE notifications SET read_at = now() WHERE customer_id = $1 AND read_at IS NULL`, [
        request.user.sub,
      ]);
      return reply.code(204).send();
    });
  });
}
