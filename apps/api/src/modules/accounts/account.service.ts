import type pg from 'pg';
import { pool, withTransaction, type DbClient } from '../../db/pool.js';
import { enqueueEvent } from '../../ledger/outbox.js';
import { audit, type Actor } from '../../lib/audit.js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../lib/errors.js';
import type { Paise } from '../../lib/money.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import { sentToOthersToday } from '../transactions/transfer.service.js';

export interface Account {
  id: string;
  customerId: string;
  accountNumber: string;
  product: 'SAVINGS' | 'CURRENT';
  currency: string;
  balance: Paise;
  dailyLimit: Paise;
  status: 'ACTIVE' | 'FROZEN';
  createdAt: Date;
}

export interface Customer {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  createdAt: Date;
}

const ACCOUNT_COLUMNS = `id, customer_id AS "customerId", account_number AS "accountNumber", product, currency,
  balance, daily_limit AS "dailyLimit", status, created_at AS "createdAt"`;
const CUSTOMER_COLUMNS = `id, full_name AS "fullName", email, phone, created_at AS "createdAt"`;

export const MAX_ACCOUNTS_PER_CUSTOMER = 3;
export const MAX_DAILY_LIMIT: Paise = 2_00_000_00;

// ─── customers ──────────────────────────────────────────────────────────────

export async function registerCustomer(
  input: { fullName: string; email: string; phone: string; password: string },
  ip?: string,
): Promise<{ customer: Customer; account: Account }> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<Customer>(
        `INSERT INTO customers (full_name, email, phone, password_hash) VALUES ($1, lower($2), $3, $4)
         RETURNING ${CUSTOMER_COLUMNS}`,
        [input.fullName, input.email, input.phone, passwordHash],
      );
      const customer = rows[0]!;
      const account = await insertAccount(client, customer.id, 'SAVINGS');
      await audit(client, { type: 'CUSTOMER', id: customer.id, ip }, 'CUSTOMER_REGISTERED', {
        type: 'customer',
        id: customer.id,
      });
      return { customer, account };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ConflictError('CUSTOMER_EXISTS', 'An account with this email or phone already exists');
    }
    throw error;
  }
}

export async function authenticateCustomer(email: string, password: string, ip?: string): Promise<Customer> {
  const { rows } = await pool.query<Customer & { passwordHash: string }>(
    `SELECT ${CUSTOMER_COLUMNS}, password_hash AS "passwordHash" FROM customers WHERE email = lower($1)`,
    [email],
  );
  const row = rows[0];
  const valid = await verifyPassword(password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !valid) {
    await audit(pool, { type: 'CUSTOMER', id: row?.id, ip }, 'LOGIN_FAILED', { type: 'customer', id: row?.id }, { email });
    // Same message either way, so the API does not reveal which emails are registered.
    throw new UnauthorizedError('Invalid email or password');
  }
  await audit(pool, { type: 'CUSTOMER', id: row.id, ip }, 'LOGIN_SUCCEEDED', { type: 'customer', id: row.id });
  const { passwordHash: _hash, ...customer } = row;
  return customer;
}

export async function getCustomer(customerId: string): Promise<Customer> {
  const { rows } = await pool.query<Customer>(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1`, [customerId]);
  if (!rows[0]) throw new UnauthorizedError('Customer no longer exists');
  return rows[0];
}

// ─── accounts ───────────────────────────────────────────────────────────────

export async function listAccounts(customerId: string): Promise<Account[]> {
  const { rows } = await pool.query<Account>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE customer_id = $1 ORDER BY created_at`,
    [customerId],
  );
  return rows;
}

export async function getOwnAccount(db: pg.Pool | DbClient, customerId: string, accountId: string): Promise<Account> {
  const { rows } = await db.query<Account>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND customer_id = $2`,
    [accountId, customerId],
  );
  if (!rows[0]) throw new NotFoundError('Account', accountId);
  return rows[0];
}

export async function openAccount(actor: Actor & { id: string }, product: 'SAVINGS' | 'CURRENT'): Promise<Account> {
  return withTransaction(async (client) => {
    // Lock the customer row so two parallel requests cannot both pass the count check.
    await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [actor.id]);
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM accounts WHERE customer_id = $1`,
      [actor.id],
    );
    if (rows[0]!.count >= MAX_ACCOUNTS_PER_CUSTOMER) {
      throw new ConflictError('ACCOUNT_LIMIT', `A customer can hold at most ${MAX_ACCOUNTS_PER_CUSTOMER} accounts`);
    }
    const account = await insertAccount(client, actor.id, product);
    await audit(client, actor, 'ACCOUNT_OPENED', { type: 'account', id: account.id }, { product });
    return account;
  });
}

export async function getLimitUsage(customerId: string, accountId: string) {
  const account = await getOwnAccount(pool, customerId, accountId);
  const usedToday = await sentToOthersToday(pool, account.id, customerId);
  return { dailyLimit: account.dailyLimit, usedToday, remaining: Math.max(account.dailyLimit - usedToday, 0) };
}

export async function setDailyLimit(actor: Actor & { id: string }, accountId: string, dailyLimit: Paise): Promise<Account> {
  if (dailyLimit > MAX_DAILY_LIMIT) {
    throw new ValidationError('LIMIT_TOO_HIGH', `The daily limit can be at most ${MAX_DAILY_LIMIT / 100} rupees`);
  }
  return withTransaction(async (client) => {
    const before = await getOwnAccount(client, actor.id, accountId);
    const { rows } = await client.query<Account>(
      `UPDATE accounts SET daily_limit = $2, updated_at = now() WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      [accountId, dailyLimit],
    );
    await audit(client, actor, 'DAILY_LIMIT_CHANGED', { type: 'account', id: accountId }, {
      from: before.dailyLimit,
      to: dailyLimit,
    });
    return rows[0]!;
  });
}

/** Admin: freeze stops money moving in or out; unfreeze restores it. */
export async function setAccountStatus(
  actor: Actor,
  accountId: string,
  status: 'ACTIVE' | 'FROZEN',
  reason: string,
): Promise<Account> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<Account>(
      `UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1 AND kind = 'CUSTOMER'
       RETURNING ${ACCOUNT_COLUMNS}`,
      [accountId, status],
    );
    const account = rows[0];
    if (!account) throw new NotFoundError('Account', accountId);
    await enqueueEvent(client, 'account.status_changed', account.id, {
      accountId: account.id,
      accountNumber: account.accountNumber,
      customerId: account.customerId,
      status,
      reason,
    });
    await audit(client, actor, 'ACCOUNT_STATUS_CHANGED', { type: 'account', id: account.id }, { status, reason });
    return account;
  });
}

async function insertAccount(client: DbClient, customerId: string, product: 'SAVINGS' | 'CURRENT'): Promise<Account> {
  const { rows } = await client.query<Account>(
    `INSERT INTO accounts (customer_id, account_number, kind, product)
     VALUES ($1, '5010' || lpad(nextval('account_number_seq')::text, 8, '0'), 'CUSTOMER', $2)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [customerId, product],
  );
  return rows[0]!;
}
