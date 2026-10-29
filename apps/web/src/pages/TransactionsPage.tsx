import { useState } from 'react';
import { useMe, useTransactions } from '../api/hooks';
import type { TransactionStatus } from '../api/types';
import { perspective, TransactionDetail } from '../components/TransactionViews';
import { Card, cx, Empty, ErrorText, Loading, PageHeader, Pager, Select, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney, humanize, maskAccount } from '../lib/format';

const PAGE_SIZE = 20;

export function TransactionsPage() {
  const me = useMe();
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState<TransactionStatus | ''>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useTransactions({ accountId: accountId || undefined, status, page, pageSize: PAGE_SIZE });

  const customerId = me.data?.customer.id ?? '';
  const total = list.data?.total ?? 0;

  return (
    <>
      <PageHeader title="Transactions" subtitle="Every money movement on your accounts, including failed and reversed ones." />

      <Card>
        <div className="mb-4 flex flex-wrap gap-3">
          <Select
            className="w-auto"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All accounts</option>
            {me.data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {humanize(a.product)} {maskAccount(a.accountNumber)}
              </option>
            ))}
          </Select>
          <Select
            className="w-auto"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as TransactionStatus | '');
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {(['COMPLETED', 'PENDING', 'FAILED', 'REVERSED'] as const).map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>

        {list.isLoading && <Loading />}
        <ErrorText error={list.error} />
        {list.data?.items.length === 0 && <Empty>No transactions match these filters.</Empty>}

        {list.data && list.data.items.length > 0 && (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-2 font-medium">Date</th>
                  <th className="px-5 py-2 font-medium">Details</th>
                  <th className="px-5 py-2 font-medium">Reference</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((t) => {
                  const view = perspective(t, customerId);
                  return (
                    <tr key={t.id} onClick={() => setSelected(t.id)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-5 py-3 whitespace-nowrap text-slate-500">{formatDateTime(t.createdAt)}</td>
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-800">{view.title}</p>
                        <p className="text-xs text-slate-500">{view.subtitle}</p>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-500">{t.reference}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={t.status} />
                      </td>
                      <td
                        className={cx(
                          'px-5 py-3 text-right font-semibold whitespace-nowrap',
                          t.status === 'FAILED' || t.status === 'REVERSED'
                            ? 'text-slate-400 line-through'
                            : view.sign === '+'
                              ? 'text-emerald-600'
                              : 'text-slate-800',
                        )}
                      >
                        {view.sign}
                        {formatMoney(t.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} hasNext={page * PAGE_SIZE < total} onChange={setPage} />
      </Card>

      {selected && <TransactionDetail id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
