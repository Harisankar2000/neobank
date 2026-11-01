import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTransaction } from '../src/db/pool.js';
import { redis } from '../src/lib/redis.js';
import { setAccountStatus } from '../src/modules/accounts/account.service.js';
import { runReconciliation } from '../src/modules/reconciliation/reconciliation.service.js';
import {
  approveTransfer,
  createTransfer,
  rejectTransfer,
  reverseTransfer,
} from '../src/modules/transactions/transfer.service.js';
import {
  addPayee,
  admin,
  balanceOf,
  createCustomer,
  resetDatabase,
  rupees,
  send,
  suspenseBalance,
} from './helpers.js';

beforeEach(resetDatabase);
afterAll(async () => {
  await Promise.all([pool.end(), redis.quit()]);
});

async function expectBooksBalanced() {
  const run = await runReconciliation(admin);
  expect(run.checks.filter((c) => !c.passed)).toEqual([]);
  expect(run.status).toBe('BALANCED');
}

describe('transfers', () => {
  it('moves money with one debit and one credit', async () => {
    const asha = await createCustomer('Asha', 10_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);

    const result = await send(asha, rahul, 2_500);

    expect(result.statusCode).toBe(201);
    expect(result.transaction.status).toBe('COMPLETED');
    expect(await balanceOf(asha.account.id)).toBe(rupees(7_500));
    expect(await balanceOf(rahul.account.id)).toBe(rupees(2_500));

    const { rows: entries } = await pool.query(
      `SELECT direction, amount FROM entries WHERE transaction_id = $1 ORDER BY direction`,
      [result.transaction.id],
    );
    expect(entries).toEqual([
      { direction: 'CREDIT', amount: rupees(2_500) },
      { direction: 'DEBIT', amount: rupees(2_500) },
    ]);

    const { rows: events } = await pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1`, [
      result.transaction.id,
    ]);
    expect(events).toEqual([{ event_type: 'transfer.completed' }]);
    await expectBooksBalanced();
  });

  it('records a FAILED transaction and moves nothing when funds are short', async () => {
    const asha = await createCustomer('Asha', 1_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);

    const result = await send(asha, rahul, 1_001);

    expect(result.statusCode).toBe(422);
    expect(result.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(result.transaction.status).toBe('FAILED');
    expect(result.transaction.failureReason).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(asha.account.id)).toBe(rupees(1_000));
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM entries WHERE transaction_id = $1`, [
      result.transaction.id,
    ]);
    expect(rows[0].n).toBe(0);
    await expectBooksBalanced();
  });

  it('requires a saved beneficiary for other people, but not for own accounts', async () => {
    const asha = await createCustomer('Asha', 5_000);
    const rahul = await createCustomer('Rahul');
    await expect(send(asha, rahul, 100)).rejects.toMatchObject({ code: 'BENEFICIARY_REQUIRED' });

    const { rows } = await pool.query<{ accountNumber: string }>(
      `INSERT INTO accounts (customer_id, account_number, kind, product)
       VALUES ($1, '501099999999', 'CUSTOMER', 'CURRENT') RETURNING account_number AS "accountNumber"`,
      [asha.customer.id],
    );
    const own = await send(asha, { account: rows[0]! }, 1_000);
    expect(own.transaction.status).toBe('COMPLETED');
  });

  it('refuses money out of a frozen account', async () => {
    const asha = await createCustomer('Asha', 5_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    await setAccountStatus(admin, asha.account.id, 'FROZEN', 'KYC review');

    const result = await send(asha, rahul, 100);
    expect(result.statusCode).toBe(422);
    expect(result.error?.code).toBe('ACCOUNT_FROZEN');
  });
});

describe('concurrency', () => {
  it('never overdraws: 50 parallel ₹100 transfers from ₹1,000 → exactly 10 go through', async () => {
    const asha = await createCustomer('Asha', 1_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);

    const results = await Promise.all(Array.from({ length: 50 }, () => send(asha, rahul, 100)));

    // After 5 attempts the velocity rule flags transfers, so "went through" is
    // COMPLETED (paid) or PENDING (held in suspense). Either way money left Asha.
    const moved = results.filter((r) => r.transaction.status !== 'FAILED');
    expect(moved).toHaveLength(10);
    expect(results.filter((r) => r.error?.code === 'INSUFFICIENT_FUNDS')).toHaveLength(40);
    expect(await balanceOf(asha.account.id)).toBe(0);
    await expectBooksBalanced();
  });

  it('does not deadlock when A→B and B→A run at the same time', async () => {
    const asha = await createCustomer('Asha', 10_000);
    const rahul = await createCustomer('Rahul', 10_000);
    await addPayee(asha, rahul);
    await addPayee(rahul, asha);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? send(asha, rahul, 100) : send(rahul, asha, 100))),
    );

    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 202)).toBe(true);
    await expectBooksBalanced();
  });
});

describe('idempotency', () => {
  it('turns 10 identical parallel requests into one transfer', async () => {
    const asha = await createCustomer('Asha', 10_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 10 }, () => send(asha, rahul, 500, key)));

    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await balanceOf(asha.account.id)).toBe(rupees(9_500));
  });

  it('rejects the same key with a different amount', async () => {
    const asha = await createCustomer('Asha', 10_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    const key = randomUUID();

    await send(asha, rahul, 500, key);
    await expect(send(asha, rahul, 600, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('replays a failed transfer instead of retrying it', async () => {
    const asha = await createCustomer('Asha', 100);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    const key = randomUUID();

    const first = await send(asha, rahul, 500, key);
    const again = await send(asha, rahul, 500, key);
    expect(again.replayed).toBe(true);
    expect(again.statusCode).toBe(422);
    expect(again.transaction.id).toBe(first.transaction.id);
  });
});

describe('daily limit', () => {
  it('counts today’s transfers to other people and stops at the limit', async () => {
    const asha = await createCustomer('Asha', 2_00_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);

    expect((await send(asha, rahul, 40_000)).transaction.status).toBe('COMPLETED');
    expect((await send(asha, rahul, 40_000)).transaction.status).toBe('COMPLETED');
    const third = await send(asha, rahul, 30_000);

    expect(third.error?.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(third.transaction.status).toBe('FAILED');
    expect((third.body as { error: { details: unknown } }).error.details).toMatchObject({
      dailyLimit: rupees(1_00_000),
      usedToday: rupees(80_000),
      remaining: rupees(20_000),
    });
  });
});

describe('risk review', () => {
  it('holds a large transfer in suspense until approved', async () => {
    const asha = await createCustomer('Asha', 80_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);

    const result = await send(asha, rahul, 60_000);
    expect(result.statusCode).toBe(202);
    expect(result.transaction.status).toBe('PENDING');
    expect(result.transaction.riskReasons).toEqual(['LARGE_AMOUNT']);
    expect(await balanceOf(asha.account.id)).toBe(rupees(20_000));
    expect(await balanceOf(rahul.account.id)).toBe(0);
    expect(await suspenseBalance()).toBe(rupees(60_000));
    await expectBooksBalanced();

    const approved = await approveTransfer(admin, result.transaction.id);
    expect(approved.status).toBe('COMPLETED');
    expect(await balanceOf(rahul.account.id)).toBe(rupees(60_000));
    expect(await suspenseBalance()).toBe(0);
    await expect(approveTransfer(admin, result.transaction.id)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await expectBooksBalanced();
  });

  it('returns the money to the sender when a review is rejected', async () => {
    const asha = await createCustomer('Asha', 80_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);

    const result = await send(asha, rahul, 60_000);
    const rejected = await rejectTransfer(admin, result.transaction.id, 'Customer did not confirm');

    expect(rejected.status).toBe('FAILED');
    expect(rejected.failureReason).toContain('REJECTED_IN_REVIEW');
    expect(await balanceOf(asha.account.id)).toBe(rupees(80_000));
    expect(await suspenseBalance()).toBe(0);
    await expectBooksBalanced();
  });

  it('flags a sizeable transfer to a payee added minutes ago', async () => {
    const asha = await createCustomer('Asha', 50_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul, { fresh: true });

    const result = await send(asha, rahul, 10_000);
    expect(result.transaction.status).toBe('PENDING');
    expect(result.transaction.riskReasons).toEqual(['NEW_BENEFICIARY']);
  });

  it('flags the sixth attempt within ten minutes', async () => {
    const asha = await createCustomer('Asha', 10_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await send(asha, rahul, 10)).transaction);
    expect(statuses.slice(0, 5).every((t) => t.status === 'COMPLETED')).toBe(true);
    expect(statuses[5]).toMatchObject({ status: 'PENDING', riskReasons: ['HIGH_VELOCITY'] });
  });
});

describe('reversals', () => {
  it('posts a new REVERSAL transaction and marks the original REVERSED', async () => {
    const asha = await createCustomer('Asha', 5_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    const { transaction } = await send(asha, rahul, 1_000);

    const reversed = await reverseTransfer(admin, transaction.id, 'Sent by mistake');

    expect(reversed.status).toBe('REVERSED');
    expect(reversed.reversedById).toBeTruthy();
    expect(await balanceOf(asha.account.id)).toBe(rupees(5_000));
    expect(await balanceOf(rahul.account.id)).toBe(0);
    // History is kept: the original entries are still there, plus two new ones.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM entries`);
    expect(rows[0].n).toBe(2 /* deposit */ + 2 /* transfer */ + 2 /* reversal */);
    await expect(reverseTransfer(admin, transaction.id, 'again')).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await expectBooksBalanced();
  });

  it('cannot reverse money the recipient has already spent', async () => {
    const asha = await createCustomer('Asha', 5_000);
    const rahul = await createCustomer('Rahul');
    const priya = await createCustomer('Priya');
    await addPayee(asha, rahul);
    await addPayee(rahul, priya);
    const { transaction } = await send(asha, rahul, 1_000);
    await send(rahul, priya, 1_000);

    await expect(reverseTransfer(admin, transaction.id, 'Fraud')).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expectBooksBalanced();
  });
});

describe('database guarantees', () => {
  it('rejects an unbalanced transaction at COMMIT', async () => {
    const asha = await createCustomer('Asha');
    const rahul = await createCustomer('Rahul');
    const attempt = withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO transactions (reference, type, status, amount, from_account_id, to_account_id)
         VALUES ('BROKEN', 'TRANSFER', 'COMPLETED', 500, $1, $2) RETURNING id`,
        [asha.account.id, rahul.account.id],
      );
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, direction, amount, balance_after)
         VALUES ($1, $2, 'DEBIT', 500, 0), ($1, $3, 'CREDIT', 400, 400)`,
        [rows[0]!.id, asha.account.id, rahul.account.id],
      );
    });
    await expect(attempt).rejects.toThrow(/unbalanced/);
  });

  it('keeps entries and audit logs append-only', async () => {
    await createCustomer('Asha', 100);
    await expect(pool.query('UPDATE entries SET amount = 1')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM entries')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
  });

  it('never lets a customer balance go negative', async () => {
    const asha = await createCustomer('Asha');
    await expect(pool.query('UPDATE accounts SET balance = -1 WHERE id = $1', [asha.account.id])).rejects.toThrow(
      /accounts_no_overdraft/,
    );
  });

  it('reconciliation catches a balance edited by hand', async () => {
    const asha = await createCustomer('Asha', 1_000);
    await pool.query('UPDATE accounts SET balance = balance + 100 WHERE id = $1', [asha.account.id]);

    const run = await runReconciliation(admin);
    expect(run.status).toBe('MISMATCH');
    const failed = run.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toEqual(['balances_match_entries', 'books_sum_to_zero']);
  });
});

describe('transfer requests that never reach the ledger', () => {
  it('returns 404 for an account the customer does not own', async () => {
    const asha = await createCustomer('Asha', 1_000);
    const rahul = await createCustomer('Rahul', 1_000);
    await addPayee(asha, rahul);
    await expect(
      createTransfer(redis, asha.actor, { fromAccountId: rahul.account.id, toAccountNumber: rahul.account.accountNumber, amount: 100 }, randomUUID()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
