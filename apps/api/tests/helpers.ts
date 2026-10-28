import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { SYSTEM_ACCOUNT_NUMBERS } from '../src/ledger/ledger.js';
import { redis } from '../src/lib/redis.js';
import { registerCustomer } from '../src/modules/accounts/account.service.js';
import { addBeneficiary } from '../src/modules/beneficiaries/beneficiary.service.js';
import { createDeposit, createTransfer } from '../src/modules/transactions/transfer.service.js';
import type { TransactionView } from '../src/modules/transactions/transaction.view.js';

export const rupees = (amount: number) => amount * 100;

/** Empties every table except the bank's system accounts, and clears Redis db 1. */
export async function resetDatabase(): Promise<void> {
  // TRUNCATE skips row triggers, so it can clear the append-only tables.
  await pool.query(`TRUNCATE entries, transactions, beneficiaries, idempotency_keys, outbox_events,
                             notifications, audit_logs, reconciliation_runs`);
  await pool.query(`DELETE FROM accounts WHERE kind = 'CUSTOMER'`);
  await pool.query(`DELETE FROM customers`);
  await pool.query(`UPDATE accounts SET balance = 0`);
  if (redis.status === 'wait') await redis.connect();
  await redis.flushdb();
}

let counter = 0;

export async function createCustomer(name: string, depositRupees = 0) {
  counter++;
  const { customer, account } = await registerCustomer({
    fullName: name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}.${counter}@test.dev`,
    phone: `9${String(100000000 + counter).padStart(9, '0')}`,
    password: 'Password@123',
  });
  const actor = { type: 'CUSTOMER' as const, id: customer.id };
  if (depositRupees > 0) {
    // Deposits are capped at ₹1,00,000 each.
    for (let left = depositRupees; left > 0; left -= 1_00_000) {
      await createDeposit(actor, { accountId: account.id, amount: rupees(Math.min(left, 1_00_000)) }, randomUUID());
    }
  }
  return { customer, account, actor };
}

export type TestCustomer = Awaited<ReturnType<typeof createCustomer>>;

/** Adds a payee; by default backdated so the "new beneficiary" rule does not fire. */
export async function addPayee(from: TestCustomer, to: TestCustomer, { fresh = false } = {}) {
  const beneficiary = await addBeneficiary(from.actor, { accountNumber: to.account.accountNumber, nickname: to.customer.fullName });
  if (!fresh) {
    await pool.query(`UPDATE beneficiaries SET created_at = now() - interval '2 days' WHERE id = $1`, [beneficiary.id]);
  }
  return beneficiary;
}

export async function send(from: TestCustomer, to: { account: { accountNumber: string } }, amountRupees: number, key = randomUUID()) {
  const result = await createTransfer(
    redis,
    from.actor,
    { fromAccountId: from.account.id, toAccountNumber: to.account.accountNumber, amount: rupees(amountRupees) },
    key,
  );
  const body = result.body as { transaction: TransactionView; error?: { code: string } };
  return { ...result, transaction: body.transaction, error: body.error };
}

export async function balanceOf(accountId: string): Promise<number> {
  const { rows } = await pool.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = $1', [accountId]);
  return rows[0]!.balance;
}

export async function suspenseBalance(): Promise<number> {
  const { rows } = await pool.query<{ balance: number }>('SELECT balance FROM accounts WHERE account_number = $1', [
    SYSTEM_ACCOUNT_NUMBERS.suspense,
  ]);
  return rows[0]!.balance;
}

export const admin = { type: 'ADMIN' as const, id: 'test-admin' };
