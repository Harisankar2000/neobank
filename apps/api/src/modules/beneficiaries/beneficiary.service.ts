import { pool, withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';

export interface Beneficiary {
  id: string;
  nickname: string;
  accountId: string;
  accountNumber: string;
  holderName: string;
  createdAt: Date;
}

const BENEFICIARY_SQL = `
  SELECT b.id, b.nickname, b.account_id AS "accountId", a.account_number AS "accountNumber",
         c.full_name AS "holderName", b.created_at AS "createdAt"
    FROM beneficiaries b
    JOIN accounts a ON a.id = b.account_id
    JOIN customers c ON c.id = a.customer_id`;

export async function listBeneficiaries(customerId: string): Promise<Beneficiary[]> {
  const { rows } = await pool.query<Beneficiary>(`${BENEFICIARY_SQL} WHERE b.customer_id = $1 ORDER BY b.nickname`, [
    customerId,
  ]);
  return rows;
}

export async function addBeneficiary(
  actor: Actor & { id: string },
  input: { accountNumber: string; nickname: string },
): Promise<Beneficiary> {
  return withTransaction(async (client) => {
    const { rows: accounts } = await client.query<{ id: string; customerId: string }>(
      `SELECT id, customer_id AS "customerId" FROM accounts WHERE account_number = $1 AND kind = 'CUSTOMER'`,
      [input.accountNumber],
    );
    const account = accounts[0];
    if (!account) throw new NotFoundError('Account', input.accountNumber);
    if (account.customerId === actor.id) {
      throw new ValidationError('OWN_ACCOUNT', 'Your own accounts are available for transfers without adding them');
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO beneficiaries (customer_id, account_id, nickname) VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, account_id) DO NOTHING RETURNING id`,
      [actor.id, account.id, input.nickname],
    );
    if (!inserted.rows[0]) throw new ConflictError('BENEFICIARY_EXISTS', 'This account is already a beneficiary');

    await audit(client, actor, 'BENEFICIARY_ADDED', { type: 'beneficiary', id: inserted.rows[0].id }, {
      accountNumber: input.accountNumber,
    });
    const { rows } = await client.query<Beneficiary>(`${BENEFICIARY_SQL} WHERE b.id = $1`, [inserted.rows[0].id]);
    return rows[0]!;
  });
}

export async function removeBeneficiary(actor: Actor & { id: string }, beneficiaryId: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(`DELETE FROM beneficiaries WHERE id = $1 AND customer_id = $2`, [
      beneficiaryId,
      actor.id,
    ]);
    if (!rowCount) throw new NotFoundError('Beneficiary', beneficiaryId);
    await audit(client, actor, 'BENEFICIARY_REMOVED', { type: 'beneficiary', id: beneficiaryId });
  });
}
