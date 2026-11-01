import type pg from 'pg';
import { NotFoundError } from '../../lib/errors.js';
import type { Paise } from '../../lib/money.js';

export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

/** A transaction with both sides' account numbers and owner names, as the API returns it. */
export interface TransactionView {
  id: string;
  reference: string;
  type: 'DEPOSIT' | 'TRANSFER' | 'REVERSAL';
  status: TransactionStatus;
  amount: Paise;
  currency: string;
  fromAccountId: string;
  fromAccountNumber: string;
  fromCustomerId: string | null;
  fromName: string;
  toAccountId: string;
  toAccountNumber: string;
  toCustomerId: string | null;
  toName: string;
  initiatedBy: string | null;
  description: string | null;
  failureReason: string | null;
  riskReasons: string[];
  reversesId: string | null;
  reversedById: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export const TRANSACTION_VIEW_SQL = `
  SELECT t.id, t.reference, t.type, t.status, t.amount, t.currency,
         t.from_account_id AS "fromAccountId", fa.account_number AS "fromAccountNumber",
         fa.customer_id AS "fromCustomerId", COALESCE(fc.full_name, 'NeoBank') AS "fromName",
         t.to_account_id AS "toAccountId", ta.account_number AS "toAccountNumber",
         ta.customer_id AS "toCustomerId", COALESCE(tc.full_name, 'NeoBank') AS "toName",
         t.initiated_by AS "initiatedBy", t.description, t.failure_reason AS "failureReason",
         t.risk_reasons AS "riskReasons", t.reverses_id AS "reversesId", r.id AS "reversedById",
         t.created_at AS "createdAt", t.completed_at AS "completedAt"
    FROM transactions t
    JOIN accounts fa ON fa.id = t.from_account_id
    LEFT JOIN customers fc ON fc.id = fa.customer_id
    JOIN accounts ta ON ta.id = t.to_account_id
    LEFT JOIN customers tc ON tc.id = ta.customer_id
    LEFT JOIN transactions r ON r.reverses_id = t.id`;

export async function getTransactionView(db: pg.Pool | pg.PoolClient, id: string): Promise<TransactionView> {
  const { rows } = await db.query<TransactionView>(`${TRANSACTION_VIEW_SQL} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Transaction', id);
  return rows[0];
}

/** The fields Kafka consumers need, taken from the view. */
export function eventPayload(view: TransactionView, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: view.id,
    reference: view.reference,
    type: view.type,
    status: view.status,
    amount: view.amount,
    fromAccountNumber: view.fromAccountNumber,
    fromCustomerId: view.fromCustomerId,
    fromName: view.fromName,
    toAccountNumber: view.toAccountNumber,
    toCustomerId: view.toCustomerId,
    toName: view.toName,
    failureReason: view.failureReason,
    riskReasons: view.riskReasons,
    ...extra,
  };
}
