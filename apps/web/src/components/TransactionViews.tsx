import { useTransaction } from '../api/hooks';
import type { Transaction } from '../api/types';
import { formatDateTime, formatMoney, formatTime, groupByDay, humanize, maskAccount } from '../lib/format';
import { Badge, cx, ErrorText, Loading, Modal, StatusBadge } from './ui';

/** How a transaction looks from the viewer's side: money in, money out, or between their own accounts. */
export function perspective(t: Transaction, customerId: string) {
  const fromMe = t.fromCustomerId === customerId;
  const toMe = t.toCustomerId === customerId;
  if (fromMe && toMe) return { sign: '', title: 'Between my accounts', subtitle: `${maskAccount(t.fromAccountNumber)} → ${maskAccount(t.toAccountNumber)}` };
  if (t.type === 'DEPOSIT') return { sign: '+', title: 'Money added', subtitle: 'Top-up' };
  if (t.type === 'REVERSAL') {
    return toMe
      ? { sign: '+', title: `Reversal from ${t.fromName}`, subtitle: t.description ?? 'Reversal' }
      : { sign: '-', title: `Reversal to ${t.toName}`, subtitle: t.description ?? 'Reversal' };
  }
  return toMe
    ? { sign: '+', title: t.fromName, subtitle: t.description ?? 'Received' }
    : { sign: '-', title: t.toName, subtitle: t.description ?? 'Sent' };
}

export function HistoryList({
  transactions,
  customerId,
  onSelect,
}: {
  transactions: Transaction[];
  customerId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-5">
      {groupByDay(transactions, (t) => t.createdAt).map((group) => (
        <div key={group.label}>
          <p className="mb-2 text-sm font-semibold text-slate-700">{group.label}</p>
          <ul className="space-y-1">
            {group.items.map((t) => {
              const view = perspective(t, customerId);
              const muted = t.status === 'FAILED' || t.status === 'REVERSED';
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50"
                  >
                    <span
                      className={cx(
                        'grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold',
                        view.sign === '+' ? 'bg-emerald-50 text-emerald-700' : 'bg-indigo-50 text-indigo-700',
                      )}
                    >
                      {view.title.charAt(0)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{view.title}</span>
                      <span className="block truncate text-xs text-slate-500">{view.subtitle}</span>
                    </span>
                    <span className="text-right">
                      <span
                        className={cx(
                          'block text-sm font-semibold',
                          muted ? 'text-slate-400 line-through' : view.sign === '+' ? 'text-emerald-600' : 'text-slate-800',
                        )}
                      >
                        {view.sign}
                        {formatMoney(t.amount)}
                      </span>
                      <span className="block text-xs text-slate-400">
                        {t.status === 'COMPLETED' ? formatTime(t.createdAt) : humanize(t.status)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Full transaction with its journal entries: the double-entry view. */
export function TransactionDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useTransaction(id);
  const t = data?.transaction;

  return (
    <Modal title="Transaction" onClose={onClose}>
      {isLoading && <Loading />}
      <ErrorText error={error} />
      {t && (
        <div className="space-y-4 text-sm">
          <div className="text-center">
            <p className="text-2xl font-semibold text-slate-900">{formatMoney(t.amount)}</p>
            <div className="mt-1 flex justify-center gap-2">
              <StatusBadge status={t.status} />
              <Badge tone="indigo">{humanize(t.type)}</Badge>
            </div>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-slate-500">Reference</dt>
            <dd className="font-mono text-xs">{t.reference}</dd>
            <dt className="text-slate-500">From</dt>
            <dd>
              {t.fromName} · {maskAccount(t.fromAccountNumber)}
            </dd>
            <dt className="text-slate-500">To</dt>
            <dd>
              {t.toName} · {maskAccount(t.toAccountNumber)}
            </dd>
            <dt className="text-slate-500">Created</dt>
            <dd>{formatDateTime(t.createdAt)}</dd>
            {t.completedAt && (
              <>
                <dt className="text-slate-500">Completed</dt>
                <dd>{formatDateTime(t.completedAt)}</dd>
              </>
            )}
            {t.description && (
              <>
                <dt className="text-slate-500">Note</dt>
                <dd>{t.description}</dd>
              </>
            )}
            {t.failureReason && (
              <>
                <dt className="text-slate-500">Failure</dt>
                <dd className="text-rose-700">{humanize(t.failureReason)}</dd>
              </>
            )}
            {t.riskReasons.length > 0 && (
              <>
                <dt className="text-slate-500">Risk flags</dt>
                <dd className="flex flex-wrap gap-1">
                  {t.riskReasons.map((r) => (
                    <Badge key={r} tone="amber">
                      {humanize(r)}
                    </Badge>
                  ))}
                </dd>
              </>
            )}
          </dl>

          <div>
            <p className="mb-2 font-semibold text-slate-800">Journal entries</p>
            {data.entries.length === 0 ? (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-slate-500">No entries: no money moved.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">Account</th>
                    <th className="py-1 font-medium">Debit</th>
                    <th className="py-1 font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id} className="border-t border-slate-100">
                      <td className="py-1.5 font-mono">{e.accountNumber}</td>
                      <td className="py-1.5">{e.direction === 'DEBIT' ? formatMoney(e.amount) : ''}</td>
                      <td className="py-1.5">{e.direction === 'CREDIT' ? formatMoney(e.amount) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-slate-400">Every step debits one account and credits another by the same amount.</p>
          </div>
        </div>
      )}
    </Modal>
  );
}
