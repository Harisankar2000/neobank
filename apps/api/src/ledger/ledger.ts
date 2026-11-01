import { randomBytes } from 'node:crypto';
import type { DbClient } from '../db/pool.js';
import { BusinessRuleError, NotFoundError } from '../lib/errors.js';
import type { Paise } from '../lib/money.js';

export const SYSTEM_ACCOUNT_NUMBERS = {
  cash: 'BANK-CASH-INR',
  suspense: 'TRANSFER-SUSPENSE-INR',
} as const;

export interface LockedAccount {
  id: string;
  customerId: string | null;
  accountNumber: string;
  kind: 'CUSTOMER' | 'SYSTEM';
  status: 'ACTIVE' | 'FROZEN';
  balance: Paise;
  dailyLimit: Paise;
}

const systemAccountIds = new Map<string, string>();

/** Looks up a bank-owned account once, then serves it from memory. */
export async function systemAccountId(
  client: DbClient,
  accountNumber: (typeof SYSTEM_ACCOUNT_NUMBERS)[keyof typeof SYSTEM_ACCOUNT_NUMBERS],
): Promise<string> {
  const cached = systemAccountIds.get(accountNumber);
  if (cached) return cached;
  const { rows } = await client.query<{ id: string }>('SELECT id FROM accounts WHERE account_number = $1', [
    accountNumber,
  ]);
  if (!rows[0]) throw new Error(`System account ${accountNumber} is missing; run the migrations`);
  systemAccountIds.set(accountNumber, rows[0].id);
  return rows[0].id;
}

/**
 * Locks account rows until the transaction ends. Another transfer touching the
 * same account waits here, then sees the new balance.
 *
 * Rows are always locked in id order. If transfer 1 is A→B and transfer 2 is
 * B→A, both lock A first, so neither can hold B while waiting for A (no deadlock).
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: inserting a transaction or entry checks
 * its foreign keys with a KEY SHARE lock on the account rows. FOR UPDATE
 * conflicts with KEY SHARE, so two transfers that each inserted a row and then
 * tried to lock would wait on each other forever. NO KEY UPDATE is the lock an
 * UPDATE of non-key columns (like balance) takes anyway, and it does not conflict.
 */
export async function lockAccounts(client: DbClient, accountIds: string[]): Promise<Map<string, LockedAccount>> {
  const ids = [...new Set(accountIds)].sort();
  const { rows } = await client.query<LockedAccount>(
    `SELECT id, customer_id AS "customerId", account_number AS "accountNumber", kind, status,
            balance, daily_limit AS "dailyLimit"
       FROM accounts
      WHERE id = ANY($1::uuid[])
      ORDER BY id
        FOR NO KEY UPDATE`,
    [ids],
  );
  const accounts = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) if (!accounts.has(id)) throw new NotFoundError('Account', id);
  return accounts;
}

export interface MoneyMovement {
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: Paise;
  /**
   * Refuse frozen customer accounts. Bank operations (returning held money,
   * reversing fraud) turn this off: a frozen account must still be fixable.
   */
  enforceStatus?: boolean;
}

/**
 * The only code that changes a balance. One call = one DEBIT + one CREDIT of
 * the same amount, so every step of every transaction balances.
 * Must run inside a database transaction.
 */
export async function moveMoney(client: DbClient, movement: MoneyMovement): Promise<void> {
  const { transactionId, fromAccountId, toAccountId, amount, enforceStatus = true } = movement;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Amount must be a positive integer of paise');

  const accounts = await lockAccounts(client, [fromAccountId, toAccountId]);
  const from = accounts.get(fromAccountId)!;
  const to = accounts.get(toAccountId)!;

  if (enforceStatus) {
    for (const account of [from, to]) {
      if (account.kind === 'CUSTOMER' && account.status !== 'ACTIVE') {
        throw new BusinessRuleError('ACCOUNT_FROZEN', `Account ${account.accountNumber} is frozen`);
      }
    }
  }
  if (from.kind === 'CUSTOMER' && from.balance < amount) {
    throw new BusinessRuleError('INSUFFICIENT_FUNDS', 'Not enough balance for this transfer', {
      available: from.balance,
      required: amount,
    });
  }

  const debited = await updateBalance(client, fromAccountId, -amount);
  const credited = await updateBalance(client, toAccountId, amount);

  await client.query(
    `INSERT INTO entries (transaction_id, account_id, direction, amount, balance_after)
     VALUES ($1, $2, 'DEBIT', $4, $5), ($1, $3, 'CREDIT', $4, $6)`,
    [transactionId, fromAccountId, toAccountId, amount, debited, credited],
  );
}

async function updateBalance(client: DbClient, accountId: string, delta: Paise): Promise<Paise> {
  const { rows } = await client.query<{ balance: Paise }>(
    `UPDATE accounts SET balance = balance + $2, updated_at = now() WHERE id = $1 RETURNING balance`,
    [accountId, delta],
  );
  return rows[0]!.balance;
}

/** Human-readable transaction reference with the IST date, e.g. NB20261025K7Q2MX9A. */
export function generateReference(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const date = ist.toISOString().slice(0, 10).replaceAll('-', '');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const suffix = [...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `NB${date}${suffix}`;
}
