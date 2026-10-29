import { useState } from 'react';
import { Link } from 'react-router';
import { useAccount, useBeneficiaries, useMe, useOpenAccount, useTransactions } from '../api/hooks';
import type { Account, Product } from '../api/types';
import { AddMoneyDialog, SendMoneyDialog } from '../components/MoneyDialogs';
import { HistoryList, TransactionDetail } from '../components/TransactionViews';
import { Badge, Button, Card, cx, Empty, ErrorText, Loading, Modal, Select } from '../components/ui';
import { formatMoney, humanize, maskAccount } from '../lib/format';

type Dialog =
  | { kind: 'send'; to?: string; own?: boolean }
  | { kind: 'add'; accountId?: string }
  | { kind: 'open' }
  | { kind: 'detail'; id: string }
  | null;

const cardGradients = ['from-indigo-600 to-violet-500', 'from-sky-600 to-cyan-500', 'from-fuchsia-600 to-pink-500'];

export function DashboardPage() {
  const me = useMe();
  const beneficiaries = useBeneficiaries();
  const history = useTransactions({ pageSize: 15 });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [limitAccountId, setLimitAccountId] = useState<string>();

  if (me.isLoading) return <Loading />;
  if (!me.data) return <ErrorText error={me.error} />;

  const { customer, accounts } = me.data;
  const total = accounts.reduce((sum, a) => sum + a.balance, 0);
  const firstName = customer.fullName.split(' ')[0];
  const ownTarget = accounts.length > 1 ? accounts[1]?.accountNumber : undefined;

  return (
    <>
      <div className="mb-6">
        <p className="text-sm text-slate-500">Hello, {firstName}</p>
        <p className="text-3xl font-semibold tracking-tight text-slate-900">{formatMoney(total)}</p>
        <p className="text-sm text-slate-500">Total across {accounts.length} account{accounts.length === 1 ? '' : 's'}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr_360px]">
        {/* Accounts */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Accounts</h2>
            {accounts.length < 3 && (
              <button type="button" className="text-2xl leading-none text-indigo-600" title="Open account" onClick={() => setDialog({ kind: 'open' })}>
                +
              </button>
            )}
          </div>
          {accounts.map((account, i) => (
            <AccountCard
              key={account.id}
              account={account}
              gradient={cardGradients[i % cardGradients.length]!}
              onAddMoney={() => setDialog({ kind: 'add', accountId: account.id })}
            />
          ))}
        </section>

        {/* Actions + limits */}
        <section className="space-y-6">
          <div>
            <h2 className="mb-4 text-lg font-semibold text-slate-900">Actions</h2>
            <div className="grid grid-cols-2 gap-3">
              <ActionTile label="Send money" icon="↗" onClick={() => setDialog({ kind: 'send' })} />
              <ActionTile label="Add money" icon="＋" onClick={() => setDialog({ kind: 'add' })} />
              <ActionTile
                label="Between my accounts"
                icon="⇄"
                disabled={accounts.length < 2}
                hint={accounts.length < 2 ? 'Open a second account first' : undefined}
                onClick={() => setDialog({ kind: 'send', to: ownTarget, own: true })}
              />
              <Link to="/statements" className="block">
                <ActionTile label="Statements" icon="⎙" />
              </Link>
              {(beneficiaries.data ?? []).slice(0, 4).map((b) => (
                <ActionTile key={b.id} label={`Send to ${b.nickname}`} avatar={b.holderName} onClick={() => setDialog({ kind: 'send', to: b.accountNumber })} />
              ))}
            </div>
          </div>

          <LimitCard accounts={accounts} accountId={limitAccountId ?? accounts[0]?.id} onChange={setLimitAccountId} />

          <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-500 p-5 text-white">
            <p className="text-lg font-semibold">Your money is protected</p>
            <p className="mt-1 text-sm text-indigo-100">
              Large transfers and payments to new payees are checked before they leave. Held money stays safe until the review is done.
            </p>
          </div>
        </section>

        {/* History */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-slate-900">History</h2>
          <Card>
            {history.isLoading && <Loading />}
            {history.data?.items.length === 0 && <Empty>No transactions yet. Add money to get started.</Empty>}
            {history.data && (
              <HistoryList transactions={history.data.items} customerId={customer.id} onSelect={(id) => setDialog({ kind: 'detail', id })} />
            )}
            <Link to="/transactions" className="mt-4 block rounded-xl bg-indigo-50 py-2.5 text-center text-sm font-medium text-indigo-700 hover:bg-indigo-100">
              All transactions
            </Link>
          </Card>
        </section>
      </div>

      {dialog?.kind === 'send' && (
        <SendMoneyDialog
          accounts={accounts}
          beneficiaries={dialog.own ? [] : (beneficiaries.data ?? [])}
          defaultTo={dialog.to}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'add' && <AddMoneyDialog accounts={accounts} defaultAccountId={dialog.accountId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'open' && <OpenAccountDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'detail' && <TransactionDetail id={dialog.id} onClose={() => setDialog(null)} />}
    </>
  );
}

function AccountCard({ account, gradient, onAddMoney }: { account: Account; gradient: string; onAddMoney: () => void }) {
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xl font-semibold text-slate-900">{formatMoney(account.balance)}</p>
          <p className="text-xs text-slate-500">{humanize(account.product)} account</p>
        </div>
        {account.status === 'FROZEN' && <Badge tone="rose">Frozen</Badge>}
      </div>
      <div className={cx('mt-4 flex h-12 items-end justify-between rounded-xl bg-gradient-to-br px-3 pb-2 text-white', gradient)}>
        <span className="text-sm font-medium">{maskAccount(account.accountNumber)}</span>
        <span className="text-xs opacity-80">INR</span>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="font-mono text-xs text-slate-400">{account.accountNumber}</span>
        <Button variant="ghost" className="px-2 py-1" onClick={onAddMoney} disabled={account.status !== 'ACTIVE'}>
          Add money
        </Button>
      </div>
    </Card>
  );
}

function ActionTile({
  label,
  icon,
  avatar,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  icon?: string;
  avatar?: string;
  hint?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className="flex h-28 w-full flex-col justify-between rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200/70 transition hover:ring-indigo-300 disabled:opacity-50"
    >
      <span className="text-sm font-medium text-slate-800">{label}</span>
      {avatar ? (
        <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-800 text-xs font-semibold text-white">
          {avatar
            .split(' ')
            .map((p) => p[0])
            .join('')
            .slice(0, 2)}
        </span>
      ) : (
        <span className="grid h-8 w-8 place-items-center rounded-full ring-1 ring-slate-300 text-slate-600">{icon}</span>
      )}
    </button>
  );
}

function LimitCard({ accounts, accountId, onChange }: { accounts: Account[]; accountId?: string; onChange: (id: string) => void }) {
  const { data } = useAccount(accountId);
  const limits = data?.limits;
  const usedPercent = limits ? Math.min(100, (limits.usedToday / limits.dailyLimit) * 100) : 0;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="font-medium text-slate-800">Transfers to others today</p>
        <Link to="/settings" className="text-xs font-medium text-indigo-600">
          Change
        </Link>
      </div>
      {accounts.length > 1 && (
        <Select className="mb-3" value={accountId} onChange={(e) => onChange(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {humanize(a.product)} {maskAccount(a.accountNumber)}
            </option>
          ))}
        </Select>
      )}
      {limits ? (
        <>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-slate-900">{formatMoney(limits.usedToday)}</span>
            <span className="text-slate-500">of {formatMoney(limits.dailyLimit)}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cx('h-full rounded-full', usedPercent > 90 ? 'bg-rose-500' : 'bg-indigo-500')}
              style={{ width: `${usedPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">{formatMoney(limits.remaining)} left today. Resets at midnight IST.</p>
        </>
      ) : (
        <Loading />
      )}
    </Card>
  );
}

function OpenAccountDialog({ onClose }: { onClose: () => void }) {
  const [product, setProduct] = useState<Product>('CURRENT');
  const open = useOpenAccount();
  return (
    <Modal title="Open an account" onClose={onClose}>
      <div className="space-y-4">
        <Select value={product} onChange={(e) => setProduct(e.target.value as Product)}>
          <option value="SAVINGS">Savings</option>
          <option value="CURRENT">Current</option>
        </Select>
        <p className="text-xs text-slate-500">You can hold up to 3 accounts. Each gets its own account number and daily limit.</p>
        <ErrorText error={open.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={open.isPending} onClick={() => open.mutate(product, { onSuccess: onClose })}>
            Open account
          </Button>
        </div>
      </div>
    </Modal>
  );
}
