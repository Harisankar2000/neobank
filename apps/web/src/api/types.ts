/** Shapes returned by the NeoBank API. Money is always integer paise (₹1 = 100). */

export type Paise = number;
export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
export type TransactionType = 'DEPOSIT' | 'TRANSFER' | 'REVERSAL';
export type Product = 'SAVINGS' | 'CURRENT';

export interface Customer {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  createdAt: string;
}

export interface Account {
  id: string;
  customerId: string;
  accountNumber: string;
  product: Product;
  currency: string;
  balance: Paise;
  dailyLimit: Paise;
  status: 'ACTIVE' | 'FROZEN';
  createdAt: string;
}

export interface LimitUsage {
  dailyLimit: Paise;
  usedToday: Paise;
  remaining: Paise;
}

export interface Transaction {
  id: string;
  reference: string;
  type: TransactionType;
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
  createdAt: string;
  completedAt: string | null;
}

export interface JournalEntry {
  id: number;
  accountNumber: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: Paise;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total?: number;
}

export interface Beneficiary {
  id: string;
  nickname: string;
  accountId: string;
  accountNumber: string;
  holderName: string;
  createdAt: string;
}

export interface Notification {
  id: number;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface StatementLine {
  entryId: number;
  date: string;
  reference: string;
  type: TransactionType;
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

// ─── admin ──────────────────────────────────────────────────────────────────

export interface AdminOverview {
  customers: number;
  accounts: number;
  customerDeposits: Paise;
  pendingReviews: number;
  transfersToday: number;
  failedToday: number;
  outboxBacklog: number;
}

export interface AdminAccount {
  id: string;
  accountNumber: string;
  product: Product;
  balance: Paise;
  dailyLimit: Paise;
  status: 'ACTIVE' | 'FROZEN';
  holderName: string;
  email: string;
  createdAt: string;
}

export interface ReconciliationCheck {
  name: string;
  description: string;
  passed: boolean;
  mismatches: unknown[];
}

export interface ReconciliationRun {
  id: string;
  status: 'BALANCED' | 'MISMATCH';
  checks: ReconciliationCheck[];
  createdAt: string;
}

export interface AuditLog {
  id: number;
  actorType: 'CUSTOMER' | 'ADMIN' | 'SYSTEM';
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}
