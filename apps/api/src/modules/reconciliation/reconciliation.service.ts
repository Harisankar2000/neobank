import { pool } from '../../db/pool.js';
import { audit, type Actor } from '../../lib/audit.js';

export interface ReconciliationCheck {
  name: string;
  description: string;
  passed: boolean;
  /** Up to 20 offending rows, to start the investigation. */
  mismatches: unknown[];
}

export interface ReconciliationRun {
  id: string;
  status: 'BALANCED' | 'MISMATCH';
  checks: ReconciliationCheck[];
  createdAt: Date;
}

const CHECKS: Array<{ name: string; description: string; sql: string }> = [
  {
    name: 'transactions_balanced',
    description: 'Every transaction has equal debits and credits',
    sql: `SELECT transaction_id AS "transactionId",
                 SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::bigint AS difference
            FROM entries GROUP BY transaction_id
          HAVING SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) <> 0`,
  },
  {
    name: 'balances_match_entries',
    description: 'Every account balance equals the sum of its entries',
    sql: `SELECT a.account_number AS "accountNumber", a.balance AS cached, COALESCE(e.total, 0)::bigint AS "fromEntries"
            FROM accounts a
            LEFT JOIN (SELECT account_id, SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS total
                         FROM entries GROUP BY account_id) e ON e.account_id = a.id
           WHERE a.balance <> COALESCE(e.total, 0)`,
  },
  {
    name: 'books_sum_to_zero',
    description: 'All balances together add up to zero (money is only moved, never created)',
    sql: `SELECT currency, SUM(balance)::bigint AS total FROM accounts GROUP BY currency HAVING SUM(balance) <> 0`,
  },
  {
    name: 'suspense_matches_pending',
    description: 'The suspense account holds exactly the money of transfers waiting for review',
    sql: `SELECT s.balance AS suspense, COALESCE(p.total, 0)::bigint AS "pendingTotal"
            FROM accounts s
            LEFT JOIN (SELECT SUM(amount) AS total FROM transactions WHERE status = 'PENDING') p ON true
           WHERE s.account_number = 'TRANSFER-SUSPENSE-INR' AND s.balance <> COALESCE(p.total, 0)`,
  },
  {
    name: 'reversals_consistent',
    description: 'Every REVERSED transfer has exactly one completed reversal, and vice versa',
    sql: `SELECT t.reference, t.status, r.reference AS "reversalReference"
            FROM transactions t
            LEFT JOIN transactions r ON r.reverses_id = t.id AND r.status = 'COMPLETED'
           WHERE (t.status = 'REVERSED') <> (r.id IS NOT NULL) AND t.type = 'TRANSFER'`,
  },
];

/**
 * Re-checks the books with independent SQL. All checks run in one
 * REPEATABLE READ snapshot, so payments happening meanwhile cannot make
 * the numbers disagree with each other.
 */
export async function runReconciliation(actor: Actor): Promise<ReconciliationRun> {
  const client = await pool.connect();
  const checks: ReconciliationCheck[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const check of CHECKS) {
      const { rows } = await client.query(`${check.sql} LIMIT 20`);
      checks.push({ name: check.name, description: check.description, passed: rows.length === 0, mismatches: rows });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const status = checks.every((c) => c.passed) ? 'BALANCED' : 'MISMATCH';
  const { rows } = await pool.query<ReconciliationRun>(
    `INSERT INTO reconciliation_runs (status, checks) VALUES ($1, $2)
     RETURNING id, status, checks, created_at AS "createdAt"`,
    [status, JSON.stringify(checks)],
  );
  await audit(pool, actor, 'RECONCILIATION_RUN', { type: 'reconciliation_run', id: rows[0]!.id }, { status });
  return rows[0]!;
}

export async function listReconciliationRuns(limit = 20): Promise<ReconciliationRun[]> {
  const { rows } = await pool.query<ReconciliationRun>(
    `SELECT id, status, checks, created_at AS "createdAt" FROM reconciliation_runs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
