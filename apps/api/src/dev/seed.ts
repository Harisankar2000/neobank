/**
 * Demo data: three customers with deposits, payees and a mix of completed,
 * pending, failed and reversed transfers. Every login uses NeoBank@2026.
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

const PASSWORD = 'NeoBank@2026';
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

  const harisankar = await registerCustomer({ fullName: 'Harisankar Sahoo', email: 'harisankar@neobank.dev', phone: '9876500001', password: PASSWORD });
  const ratnamanjari = await registerCustomer({ fullName: 'Choudhury Ratnamanjari Mohapatra', email: 'ratnamanjari@neobank.dev', phone: '9876500002', password: PASSWORD });
  const priya = await registerCustomer({ fullName: 'Priya Nair', email: 'priya@neobank.dev', phone: '9876500003', password: PASSWORD });

  const actor = (c: typeof harisankar) => ({ type: 'CUSTOMER' as const, id: c.customer.id });
  const savings = (c: typeof harisankar) => c.account;

  const harisankarCurrent = await openAccount(actor(harisankar), 'CURRENT');

  for (const [customer, amounts] of [
    [harisankar, [1_00_000, 60_000]],
    [ratnamanjari, [40_000]],
    [priya, [25_000]],
  ] as const) {
    for (const amount of amounts) {
      await createDeposit(actor(customer), { accountId: savings(customer).id, amount: rupees(amount) }, randomUUID());
    }
  }

  await addBeneficiary(actor(harisankar), { accountNumber: savings(ratnamanjari).accountNumber, nickname: 'Ratnamanjari' });
  await addBeneficiary(actor(harisankar), { accountNumber: savings(priya).accountNumber, nickname: 'Priya (rent)' });
  await addBeneficiary(actor(ratnamanjari), { accountNumber: savings(harisankar).accountNumber, nickname: 'Harisankar' });
  // Seed only: age the payees so the "new beneficiary" risk rule does not flag every demo transfer.
  await pool.query(`UPDATE beneficiaries SET created_at = now() - interval '3 days'`);

  const transfer = async (from: typeof harisankar, fromAccountId: string, toAccountNumber: string, amount: number, note: string) => {
    const result = await createTransfer(redis, actor(from), { fromAccountId, toAccountNumber, amount: rupees(amount), note }, randomUUID());
    const body = result.body as { transaction: { id: string; status: string } };
    console.log(`  ${note}: ${body.transaction.status}`);
    return body.transaction;
  };

  console.log('Transfers:');
  await transfer(harisankar, savings(harisankar).id, savings(ratnamanjari).accountNumber, 2_500, 'Dinner split');
  await transfer(ratnamanjari, savings(ratnamanjari).id, savings(harisankar).accountNumber, 800, 'Movie tickets');
  await transfer(harisankar, savings(harisankar).id, harisankarCurrent.accountNumber, 15_000, 'Move to current account');
  const mistaken = await transfer(harisankar, savings(harisankar).id, savings(ratnamanjari).accountNumber, 1_200, 'Electricity bill share');
  await reverseTransfer(admin, mistaken.id, 'Customer complaint: sent twice');
  await transfer(harisankar, savings(harisankar).id, savings(priya).accountNumber, 55_000, 'Quarterly rent'); // ≥ ₹50,000 → review
  await transfer(ratnamanjari, savings(ratnamanjari).id, savings(harisankar).accountNumber, 90_000, 'Bike down payment'); // > balance → FAILED

  const run = await runReconciliation(admin);
  console.log(`Reconciliation: ${run.status}`);
  console.log(`\nLog in with harisankar@neobank.dev or ratnamanjari@neobank.dev and password ${PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
  });
