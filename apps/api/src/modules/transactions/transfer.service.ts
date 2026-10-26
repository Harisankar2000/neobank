import type { Redis } from 'ioredis';
import { pool, withTransaction, type DbClient } from '../../db/pool.js';
import { hashRequest, runIdempotent, type IdempotentResponse } from '../../ledger/idempotency.js';
import {
  generateReference,
  lockAccounts,
  moveMoney,
  SYSTEM_ACCOUNT_NUMBERS,
  systemAccountId,
} from '../../ledger/ledger.js';
import { enqueueEvent } from '../../ledger/outbox.js';
import { audit, type Actor } from '../../lib/audit.js';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { startOfIstDay, type Paise } from '../../lib/money.js';
import { evaluateTransferRisk, recordTransferAttempt } from '../../risk/rules.js';
import { eventPayload, getTransactionView, type TransactionView } from './transaction.view.js';

export interface TransferInput {
  fromAccountId: string;
  toAccountNumber: string;
  amount: Paise;
  note?: string;
}

export interface DepositInput {
  accountId: string;
  amount: Paise;
}

/**
 * Customer transfer. The whole request is one database transaction:
 *
 *   1. claim the Idempotency-Key            (a retry replays the stored answer)
 *   2. validate: own source account, recipient exists, recipient is a saved payee
 *   3. run the risk rules                   (flagged → money waits in suspense)
 *   4. insert the transaction row
 *   5. SAVEPOINT, lock accounts, check the daily limit, move the money
 *   6. on a money rule failure: roll back to the savepoint, keep the row as FAILED
 *   7. write the outbox event and the audit log, COMMIT
 */
export async function createTransfer(
  redis: Redis,
  actor: Actor & { id: string },
  input: TransferInput,
  idempotencyKey: string,
): Promise<IdempotentResponse> {
  // Counted per customer before the database work, so refused attempts count too.
  const recentAttempts = await recordTransferAttempt(redis, actor.id);

  return withTransaction((client) =>
    runIdempotent(client, `customer:${actor.id}`, idempotencyKey, hashRequest({ op: 'transfer', ...input }), async () => {
      const from = await findOwnAccount(client, actor.id, input.fromAccountId);
      const to = await findAccountByNumber(client, input.toAccountNumber);
      if (to.id === from.id) throw new ValidationError('SAME_ACCOUNT', 'Choose a different account to send to');

      const ownTransfer = to.customerId === actor.id;
      let riskReasons: string[] = [];
      if (!ownTransfer) {
        const beneficiary = await client.query<{ createdAt: Date }>(
          `SELECT created_at AS "createdAt" FROM beneficiaries WHERE customer_id = $1 AND account_id = $2`,
          [actor.id, to.id],
        );
        if (!beneficiary.rows[0]) {
          throw new ValidationError('BENEFICIARY_REQUIRED', 'Add this account as a beneficiary before sending money');
        }
        riskReasons = evaluateTransferRisk({
          amount: input.amount,
          beneficiaryAddedAt: beneficiary.rows[0].createdAt,
          recentAttempts,
        });
      }
      const flagged = riskReasons.length > 0;

      const transactionId = await insertTransaction(client, {
        type: 'TRANSFER',
        amount: input.amount,
        fromAccountId: from.id,
        toAccountId: to.id,
        initiatedBy: actor.id,
        description: input.note ?? null,
        riskReasons,
      });

      // A savepoint is a bookmark inside the transaction. If a money rule fails
      // we undo everything after it, but keep the transaction row as FAILED.
      await client.query('SAVEPOINT money_movement');
      try {
        // Flagged money goes to the bank's suspense account, not the recipient.
        const destinationId = flagged ? await systemAccountId(client, SYSTEM_ACCOUNT_NUMBERS.suspense) : to.id;
        const locked = await lockAccounts(client, [from.id, destinationId]);
        if (!ownTransfer) await enforceDailyLimit(client, locked.get(from.id)!, input.amount, actor.id, transactionId);

        await moveMoney(client, { transactionId, fromAccountId: from.id, toAccountId: destinationId, amount: input.amount });
        await client.query(
          `UPDATE transactions SET status = $2, completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() END WHERE id = $1`,
          [transactionId, flagged ? 'PENDING' : 'COMPLETED'],
        );
      } catch (error) {
        if (!(error instanceof BusinessRuleError)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT money_movement');
        await client.query(`UPDATE transactions SET status = 'FAILED', failure_reason = $2 WHERE id = $1`, [
          transactionId,
          error.code,
        ]);
        const view = await getTransactionView(client, transactionId);
        await enqueueEvent(client, 'transfer.failed', transactionId, eventPayload(view));
        await audit(client, actor, 'TRANSFER_FAILED', { type: 'transaction', id: transactionId }, { reason: error.code });
        return {
          statusCode: 422,
          body: { error: { code: error.code, message: error.message, details: error.details }, transaction: view },
        };
      }

      const view = await getTransactionView(client, transactionId);
      await enqueueEvent(client, flagged ? 'transfer.pending_review' : 'transfer.completed', transactionId, eventPayload(view));
      await audit(client, actor, 'TRANSFER_CREATED', { type: 'transaction', id: transactionId }, {
        status: view.status,
        amount: view.amount,
        riskReasons,
      });
      return { statusCode: flagged ? 202 : 201, body: { transaction: view } };
    }),
  );
}

/** "Add money": simulates a top-up from outside the bank (UPI, card, cash). */
export async function createDeposit(
  actor: Actor & { id: string },
  input: DepositInput,
  idempotencyKey: string,
): Promise<IdempotentResponse> {
  return withTransaction((client) =>
    runIdempotent(client, `customer:${actor.id}`, idempotencyKey, hashRequest({ op: 'deposit', ...input }), async () => {
      const account = await findOwnAccount(client, actor.id, input.accountId);
      const cashId = await systemAccountId(client, SYSTEM_ACCOUNT_NUMBERS.cash);

      const transactionId = await insertTransaction(client, {
        type: 'DEPOSIT',
        amount: input.amount,
        fromAccountId: cashId,
        toAccountId: account.id,
        initiatedBy: actor.id,
        description: 'Money added',
        riskReasons: [],
      });
      await moveMoney(client, { transactionId, fromAccountId: cashId, toAccountId: account.id, amount: input.amount });
      await client.query(`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [transactionId]);

      const view = await getTransactionView(client, transactionId);
      await enqueueEvent(client, 'deposit.completed', transactionId, eventPayload(view));
      await audit(client, actor, 'DEPOSIT', { type: 'transaction', id: transactionId }, { amount: input.amount });
      return { statusCode: 201, body: { transaction: view } };
    }),
  );
}

/**
 * Review approve: suspense → recipient. If the recipient was frozen in the
 * meantime, the money goes back to the sender and the transfer fails.
 * The status check under a row lock makes a double click harmless.
 */
export async function approveTransfer(actor: Actor, transactionId: string): Promise<TransactionView> {
  return withTransaction(async (client) => {
    const txn = await lockTransaction(client, transactionId, 'PENDING');
    const suspenseId = await systemAccountId(client, SYSTEM_ACCOUNT_NUMBERS.suspense);

    await client.query('SAVEPOINT approve');
    try {
      await moveMoney(client, { transactionId, fromAccountId: suspenseId, toAccountId: txn.toAccountId, amount: txn.amount });
      await client.query(`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [transactionId]);
      const view = await getTransactionView(client, transactionId);
      await enqueueEvent(client, 'transfer.completed', transactionId, eventPayload(view));
      await audit(client, actor, 'TRANSFER_APPROVED', { type: 'transaction', id: transactionId });
      return view;
    } catch (error) {
      if (!(error instanceof BusinessRuleError)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT approve');
      return returnHeldMoney(client, actor, txn, `APPROVAL_FAILED_${error.code}`);
    }
  });
}

/** Review reject: suspense → back to the sender, transfer FAILED. */
export async function rejectTransfer(actor: Actor, transactionId: string, reason: string): Promise<TransactionView> {
  return withTransaction(async (client) => {
    const txn = await lockTransaction(client, transactionId, 'PENDING');
    return returnHeldMoney(client, actor, txn, `REJECTED_IN_REVIEW: ${reason}`);
  });
}

/**
 * Undo a completed transfer. History is never edited: we post a new REVERSAL
 * transaction that moves the money back, and mark the original REVERSED.
 * Fails if the recipient has already spent the money.
 */
export async function reverseTransfer(actor: Actor, transactionId: string, reason: string): Promise<TransactionView> {
  return withTransaction(async (client) => {
    const original = await lockTransaction(client, transactionId, 'COMPLETED');
    if (original.type !== 'TRANSFER') {
      throw new ConflictError('NOT_REVERSIBLE', 'Only completed transfers can be reversed');
    }

    const reversalId = await insertTransaction(client, {
      type: 'REVERSAL',
      amount: original.amount,
      fromAccountId: original.toAccountId,
      toAccountId: original.fromAccountId,
      initiatedBy: null,
      description: `Reversal of ${original.reference}: ${reason}`,
      riskReasons: [],
      reversesId: original.id,
    });
    await moveMoney(client, {
      transactionId: reversalId,
      fromAccountId: original.toAccountId,
      toAccountId: original.fromAccountId,
      amount: original.amount,
      enforceStatus: false,
    });
    await client.query(`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [reversalId]);
    await client.query(`UPDATE transactions SET status = 'REVERSED' WHERE id = $1`, [original.id]);

    const view = await getTransactionView(client, original.id);
    await enqueueEvent(client, 'transfer.reversed', original.id, eventPayload(view, { reason }));
    await audit(client, actor, 'TRANSFER_REVERSED', { type: 'transaction', id: original.id }, { reason, reversalId });
    return view;
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface LockedTransaction {
  id: string;
  reference: string;
  type: string;
  status: string;
  amount: Paise;
  fromAccountId: string;
  toAccountId: string;
}

async function lockTransaction(client: DbClient, id: string, expectedStatus: string): Promise<LockedTransaction> {
  const { rows } = await client.query<LockedTransaction>(
    `SELECT id, reference, type, status, amount, from_account_id AS "fromAccountId", to_account_id AS "toAccountId"
       FROM transactions WHERE id = $1 FOR NO KEY UPDATE`,
    [id],
  );
  const txn = rows[0];
  if (!txn) throw new NotFoundError('Transaction', id);
  if (txn.status !== expectedStatus) {
    throw new ConflictError('INVALID_STATUS', `Transaction is ${txn.status}, expected ${expectedStatus}`, {
      status: txn.status,
    });
  }
  return txn;
}

async function returnHeldMoney(
  client: DbClient,
  actor: Actor,
  txn: LockedTransaction,
  failureReason: string,
): Promise<TransactionView> {
  const suspenseId = await systemAccountId(client, SYSTEM_ACCOUNT_NUMBERS.suspense);
  await moveMoney(client, {
    transactionId: txn.id,
    fromAccountId: suspenseId,
    toAccountId: txn.fromAccountId,
    amount: txn.amount,
    enforceStatus: false,
  });
  await client.query(`UPDATE transactions SET status = 'FAILED', failure_reason = $2 WHERE id = $1`, [
    txn.id,
    failureReason,
  ]);
  const view = await getTransactionView(client, txn.id);
  await enqueueEvent(client, 'transfer.failed', txn.id, eventPayload(view));
  await audit(client, actor, 'TRANSFER_REJECTED', { type: 'transaction', id: txn.id }, { reason: failureReason });
  return view;
}

/**
 * Today's outgoing transfers to other people (pending or completed) plus this
 * one must stay within the account's daily limit. Runs after the source
 * account is locked, so two transfers cannot both squeeze under the limit.
 */
async function enforceDailyLimit(
  client: DbClient,
  account: { id: string; dailyLimit: Paise },
  amount: Paise,
  customerId: string,
  excludeTransactionId: string,
): Promise<void> {
  const used = await sentToOthersToday(client, account.id, customerId, excludeTransactionId);
  if (used + amount > account.dailyLimit) {
    throw new BusinessRuleError('DAILY_LIMIT_EXCEEDED', 'This transfer would exceed your daily limit', {
      dailyLimit: account.dailyLimit,
      usedToday: used,
      remaining: Math.max(account.dailyLimit - used, 0),
    });
  }
}

export async function sentToOthersToday(
  db: DbClient | typeof pool,
  accountId: string,
  customerId: string,
  excludeTransactionId: string | null = null,
): Promise<Paise> {
  const { rows } = await db.query<{ used: Paise }>(
    `SELECT COALESCE(SUM(t.amount), 0)::bigint AS used
       FROM transactions t
       JOIN accounts dest ON dest.id = t.to_account_id
      WHERE t.from_account_id = $1
        AND t.type = 'TRANSFER'
        AND t.status IN ('PENDING', 'COMPLETED')
        AND t.created_at >= $2
        AND dest.customer_id IS DISTINCT FROM $3
        AND t.id IS DISTINCT FROM $4`,
    [accountId, startOfIstDay(), customerId, excludeTransactionId],
  );
  return rows[0]!.used;
}

async function findOwnAccount(client: DbClient, customerId: string, accountId: string) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE id = $1 AND customer_id = $2`,
    [accountId, customerId],
  );
  // Same 404 whether the account does not exist or belongs to someone else.
  if (!rows[0]) throw new NotFoundError('Account', accountId);
  return rows[0];
}

async function findAccountByNumber(client: DbClient, accountNumber: string) {
  const { rows } = await client.query<{ id: string; customerId: string }>(
    `SELECT id, customer_id AS "customerId" FROM accounts WHERE account_number = $1 AND kind = 'CUSTOMER'`,
    [accountNumber],
  );
  if (!rows[0]) throw new NotFoundError('Recipient account', accountNumber);
  return rows[0];
}

async function insertTransaction(
  client: DbClient,
  t: {
    type: 'DEPOSIT' | 'TRANSFER' | 'REVERSAL';
    amount: Paise;
    fromAccountId: string;
    toAccountId: string;
    initiatedBy: string | null;
    description: string | null;
    riskReasons: string[];
    reversesId?: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO transactions
       (reference, type, status, amount, from_account_id, to_account_id, initiated_by, description, risk_reasons, reverses_id)
     VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      generateReference(),
      t.type,
      t.amount,
      t.fromAccountId,
      t.toAccountId,
      t.initiatedBy,
      t.description,
      t.riskReasons,
      t.reversesId ?? null,
    ],
  );
  return rows[0]!.id;
}
