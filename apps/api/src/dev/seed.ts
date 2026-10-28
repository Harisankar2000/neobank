/**
 * Demo data: three customers with deposits, payees and a mix of completed,
 * pending, failed and reversed transfers. Every login uses Password@123.
 * Run once on an empty database: npm run seed
 */
import { randomUUID } from 'node:crypto';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { redis } from '../lib/redis.js';
import { openAccount, registerCustomer } from '../modules/accounts/account.service.js';
import { addBeneficiary } from '../modules/beneficiaries/beneficiary.service.js';
import { runReconciliation } from '../modules/reconciliation/reconciliation.service.js';
import { createDeposit, createTransfer, reverseTransfer } from '../modules/transactions/transfer.service.js';

const PASSWORD = 'Password@123';
const rupees = (amount: number) => amount * 100;
const admin: Actor = { type: 'ADMIN', id: 'seed' };

async function main() {
  await redis.connect();
  await migrate();

  const { rows } = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM customers');
  if (rows[0]!.count > 0) {
    console.log('Database already has customers; skipping seed.');
    return;
  }

  const asha = await registerCustomer({ fullName: 'Asha Verma', email: 'asha@neobank.dev', phone: '9876500001', password: PASSWORD });
  const rahul = await registerCustomer({ fullName: 'Rahul Mehta', email: 'rahul@neobank.dev', phone: '9876500002', password: PASSWORD });
  const priya = await registerCustomer({ fullName: 'Priya Nair', email: 'priya@neobank.dev', phone: '9876500003', password: PASSWORD });

  const actor = (c: typeof asha) => ({ type: 'CUSTOMER' as const, id: c.customer.id });
  const savings = (c: typeof asha) => c.account;

  const ashaCurrent = await openAccount(actor(asha), 'CURRENT');

  for (const [customer, amounts] of [
    [asha, [1_00_000, 60_000]],
    [rahul, [40_000]],
    [priya, [25_000]],
  ] as const) {
    for (const amount of amounts) {
      await createDeposit(actor(customer), { accountId: savings(customer).id, amount: rupees(amount) }, randomUUID());
    }
  }

  await addBeneficiary(actor(asha), { accountNumber: savings(rahul).accountNumber, nickname: 'Rahul' });
  await addBeneficiary(actor(asha), { accountNumber: savings(priya).accountNumber, nickname: 'Priya (rent)' });
  await addBeneficiary(actor(rahul), { accountNumber: savings(asha).accountNumber, nickname: 'Asha' });
  // Seed only: age the payees so the "new beneficiary" risk rule does not flag every demo transfer.
  await pool.query(`UPDATE beneficiaries SET created_at = now() - interval '3 days'`);

  const transfer = async (from: typeof asha, fromAccountId: string, toAccountNumber: string, amount: number, note: string) => {
    const result = await createTransfer(redis, actor(from), { fromAccountId, toAccountNumber, amount: rupees(amount), note }, randomUUID());
    const body = result.body as { transaction: { id: string; status: string } };
    console.log(`  ${note}: ${body.transaction.status}`);
    return body.transaction;
  };

  console.log('Transfers:');
  await transfer(asha, savings(asha).id, savings(rahul).accountNumber, 2_500, 'Dinner split');
  await transfer(rahul, savings(rahul).id, savings(asha).accountNumber, 800, 'Movie tickets');
  await transfer(asha, savings(asha).id, ashaCurrent.accountNumber, 15_000, 'Move to current account');
  const mistaken = await transfer(asha, savings(asha).id, savings(rahul).accountNumber, 1_200, 'Electricity bill share');
  await reverseTransfer(admin, mistaken.id, 'Customer complaint: sent twice');
  await transfer(asha, savings(asha).id, savings(priya).accountNumber, 55_000, 'Quarterly rent'); // ≥ ₹50,000 → review
  await transfer(rahul, savings(rahul).id, savings(asha).accountNumber, 90_000, 'Bike down payment'); // > balance → FAILED

  const run = await runReconciliation(admin);
  console.log(`Reconciliation: ${run.status}`);
  console.log(`\nLog in with asha@neobank.dev, rahul@neobank.dev or priya@neobank.dev and password ${PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
  });
