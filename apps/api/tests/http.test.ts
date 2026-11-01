import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { buildApp } from '../src/http/app.js';
import { redis } from '../src/lib/redis.js';
import { addPayee, createCustomer, resetDatabase, rupees, send } from './helpers.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  if (redis.status === 'wait') await redis.connect();
  app = await buildApp({ redis, sharedRateLimit: false });
});
beforeEach(resetDatabase);
afterAll(async () => {
  await app.close();
  await Promise.all([pool.end(), redis.quit()]);
});

async function login(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'Password@123' } });
  return { authorization: `Bearer ${response.json().token as string}` };
}

describe('auth', () => {
  it('registers, opens a savings account and logs in', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { fullName: 'Meera Iyer', email: 'meera@test.dev', phone: '9123456789', password: 'Password@123' },
    });
    expect(register.statusCode).toBe(201);
    expect(register.json().accounts[0].accountNumber).toMatch(/^5010\d{8}$/);

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: await login('meera@test.dev') });
    expect(me.json().customer.fullName).toBe('Meera Iyer');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await createCustomer('Asha');
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'asha.1@test.dev', password: 'nope' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@test.dev', password: 'nope' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(wrongPassword.json().error.message);
  });

  it('rejects requests without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode).toBe(401);
  });
});

describe('transfers over HTTP', () => {
  it('requires an Idempotency-Key and marks replays', async () => {
    const asha = await createCustomer('Asha', 5_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    const headers = await login(asha.customer.email);
    const payload = { fromAccountId: asha.account.id, toAccountNumber: rahul.account.accountNumber, amount: rupees(100) };

    const missing = await app.inject({ method: 'POST', url: '/api/v1/transfers', headers, payload });
    expect(missing.statusCode).toBe(400);

    const key = randomUUID();
    const first = await app.inject({ method: 'POST', url: '/api/v1/transfers', headers: { ...headers, 'idempotency-key': key }, payload });
    const second = await app.inject({ method: 'POST', url: '/api/v1/transfers', headers: { ...headers, 'idempotency-key': key }, payload });
    expect(first.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('hides other customers’ accounts and transactions', async () => {
    const asha = await createCustomer('Asha', 1_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    const { transaction } = await send(asha, rahul, 100);
    const priya = await createCustomer('Priya');
    const headers = await login(priya.customer.email);

    expect((await app.inject({ method: 'GET', url: `/api/v1/accounts/${asha.account.id}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/transactions/${transaction.id}`, headers })).statusCode).toBe(404);
  });
});

describe('statements', () => {
  it('reports opening and closing balances and exports CSV and PDF', async () => {
    const asha = await createCustomer('Asha', 5_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    await send(asha, rahul, 1_000);
    const headers = await login(asha.customer.email);
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const query = `from=${today}&to=${today}`;

    const json = await app.inject({ method: 'GET', url: `/api/v1/accounts/${asha.account.id}/statement?${query}`, headers });
    expect(json.json()).toMatchObject({
      openingBalance: 0,
      closingBalance: rupees(4_000),
      totalCredits: rupees(5_000),
      totalDebits: rupees(1_000),
    });

    const csv = await app.inject({ method: 'GET', url: `/api/v1/accounts/${asha.account.id}/statement.csv?${query}`, headers });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('"Date","Reference","Description","Counterparty","Debit","Credit","Balance"');

    const pdf = await app.inject({ method: 'GET', url: `/api/v1/accounts/${asha.account.id}/statement.pdf?${query}`, headers });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('admin', () => {
  it('needs the admin key', async () => {
    const without = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
    const withKey = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: { 'x-admin-key': env.ADMIN_API_KEY } });
    expect(without.statusCode).toBe(401);
    expect(withKey.statusCode).toBe(200);
  });
});

describe('health', () => {
  it('checks the database and Redis', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});
