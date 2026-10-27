import PDFDocument from 'pdfkit';
import { pool } from '../../db/pool.js';
import { formatInr, type Paise } from '../../lib/money.js';
import { getCustomer, getOwnAccount, type Account } from '../accounts/account.service.js';

export interface StatementLine {
  entryId: number;
  date: Date;
  reference: string;
  type: string;
  description: string;
  counterparty: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: Paise;
  balanceAfter: Paise;
}

export interface Statement {
  account: Account;
  holderName: string;
  from: string;
  to: string;
  openingBalance: Paise;
  closingBalance: Paise;
  totalCredits: Paise;
  totalDebits: Paise;
  lines: StatementLine[];
}

/**
 * Builds a statement straight from the journal. Each entry stores the balance
 * right after it was posted, so the opening balance is simply the
 * balance_after of the last entry before the period.
 * `from` and `to` are inclusive IST calendar dates (YYYY-MM-DD).
 */
export async function buildStatement(customerId: string, accountId: string, from: string, to: string): Promise<Statement> {
  const account = await getOwnAccount(pool, customerId, accountId);
  const customer = await getCustomer(customerId);
  const start = `${from}T00:00:00+05:30`;
  const end = `${to}T23:59:59.999+05:30`;

  const opening = await pool.query<{ balance: Paise }>(
    `SELECT balance_after AS balance FROM entries
      WHERE account_id = $1 AND created_at < $2 ORDER BY id DESC LIMIT 1`,
    [accountId, start],
  );

  // The counterparty is the other side of the transaction. A CREDIT back to the
  // sender of a transfer is held money being returned after a review.
  const { rows: lines } = await pool.query<StatementLine>(
    `SELECT e.id AS "entryId", e.created_at AS date, t.reference, t.type,
            CASE WHEN t.type = 'TRANSFER' AND e.account_id = t.from_account_id AND e.direction = 'CREDIT'
                 THEN 'Held transfer returned'
                 ELSE COALESCE(t.description, initcap(t.type)) END AS description,
            CASE WHEN e.account_id = t.from_account_id
                 THEN COALESCE(tc.full_name, 'NeoBank')
                 ELSE COALESCE(fc.full_name, 'Cash / UPI top-up') END AS counterparty,
            e.direction, e.amount, e.balance_after AS "balanceAfter"
       FROM entries e
       JOIN transactions t ON t.id = e.transaction_id
       JOIN accounts fa ON fa.id = t.from_account_id
       LEFT JOIN customers fc ON fc.id = fa.customer_id
       JOIN accounts ta ON ta.id = t.to_account_id
       LEFT JOIN customers tc ON tc.id = ta.customer_id
      WHERE e.account_id = $1 AND e.created_at BETWEEN $2 AND $3
      ORDER BY e.id`,
    [accountId, start, end],
  );

  const openingBalance = opening.rows[0]?.balance ?? 0;
  const totalCredits = lines.filter((l) => l.direction === 'CREDIT').reduce((sum, l) => sum + l.amount, 0);
  const totalDebits = lines.filter((l) => l.direction === 'DEBIT').reduce((sum, l) => sum + l.amount, 0);

  return {
    account,
    holderName: customer.fullName,
    from,
    to,
    openingBalance,
    closingBalance: lines.at(-1)?.balanceAfter ?? openingBalance,
    totalCredits,
    totalDebits,
    lines,
  };
}

export function statementToCsv(statement: Statement): string {
  const escape = (value: string) => {
    // Quote every field, and neutralise spreadsheet formulas (=, +, -, @).
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rupees = (paise: Paise) => (paise / 100).toFixed(2);
  const header = ['Date', 'Reference', 'Description', 'Counterparty', 'Debit', 'Credit', 'Balance'];
  const rows = statement.lines.map((line) => [
    line.date.toISOString(),
    line.reference,
    line.description,
    line.counterparty,
    line.direction === 'DEBIT' ? rupees(line.amount) : '',
    line.direction === 'CREDIT' ? rupees(line.amount) : '',
    rupees(line.balanceAfter),
  ]);
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n') + '\n';
}

export function statementToPdf(statement: Statement): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // PDFKit's built-in fonts have no ₹ glyph, so the PDF writes "Rs.".
    const rs = (paise: Paise) => formatInr(paise).replace('₹', 'Rs. ');

    doc.fontSize(18).text('NeoBank account statement');
    doc.moveDown(0.5).fontSize(10);
    doc.text(`Account holder: ${statement.holderName}`);
    doc.text(`Account: ${statement.account.accountNumber} (${statement.account.product})`);
    doc.text(`Period: ${statement.from} to ${statement.to}`);
    doc.text(`Opening balance: ${rs(statement.openingBalance)}    Closing balance: ${rs(statement.closingBalance)}`);
    doc.text(`Total credits: ${rs(statement.totalCredits)}    Total debits: ${rs(statement.totalDebits)}`);
    doc.moveDown();

    const columns = [40, 115, 225, 345, 420, 490];
    const row = (cells: string[], bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      cells.forEach((cell, i) => doc.text(cell, columns[i]!, y, { width: (columns[i + 1] ?? 560) - columns[i]! - 5 }));
      doc.moveDown(0.6);
      if (doc.y > 780) doc.addPage();
    };

    row(['Date', 'Reference', 'Description', 'Counterparty', 'Amount', 'Balance'], true);
    for (const line of statement.lines) {
      row([
        line.date.toISOString().slice(0, 10),
        line.reference,
        line.description,
        line.counterparty,
        `${line.direction === 'DEBIT' ? '-' : '+'}${rs(line.amount)}`,
        rs(line.balanceAfter),
      ]);
    }
    if (statement.lines.length === 0) doc.text('No transactions in this period.', 40);
    doc.end();
  });
}
