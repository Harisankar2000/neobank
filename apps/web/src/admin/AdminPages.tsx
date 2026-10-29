import { useState } from 'react';
import { Link } from 'react-router';
import {
  useAdminAccounts,
  useAdminOverview,
  useAdminTransactions,
  useApproveTransfer,
  useAuditLogs,
  useReconciliationRuns,
  useRejectTransfer,
  useReverseTransfer,
  useRunReconciliation,
  useSetAccountStatus,
} from '../api/hooks';
import type { AdminAccount, Transaction, TransactionStatus } from '../api/types';
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorText,
  Input,
  Loading,
  PageHeader,
  Pager,
  ReasonDialog,
  Select,
  StatusBadge,
} from '../components/ui';
import { formatDateTime, formatMoney, humanize, maskAccount } from '../lib/format';

// ─── overview ───────────────────────────────────────────────────────────────

export function AdminOverviewPage() {
  const { data, error } = useAdminOverview();
  const tiles = data
    ? [
        { label: 'Customers', value: String(data.customers) },
        { label: 'Customer accounts', value: String(data.accounts) },
        { label: 'Customer deposits held', value: formatMoney(data.customerDeposits) },
        { label: 'Pending reviews', value: String(data.pendingReviews), link: '/admin/reviews', alert: data.pendingReviews > 0 },
        { label: 'Transfers today', value: String(data.transfersToday) },
        { label: 'Failed today', value: String(data.failedToday) },
        {
          label: 'Outbox backlog',
          value: String(data.outboxBacklog),
          hint: data.outboxBacklog > 0 ? 'Events waiting for Kafka. Is the worker running?' : 'All events published',
        },
      ]
    : [];

  return (
    <>
      <PageHeader title="Overview" subtitle="Refreshes every 10 seconds." />
      <ErrorText error={error} />
      {!data && !error && <Loading />}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((tile) => {
          const body = (
            <Card className={cx('h-full', tile.alert && 'ring-2 ring-amber-300')}>
              <p className="text-xs text-slate-500">{tile.label}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{tile.value}</p>
              {tile.hint && <p className="mt-1 text-xs text-slate-400">{tile.hint}</p>}
            </Card>
          );
          return tile.link ? (
            <Link key={tile.label} to={tile.link}>
              {body}
            </Link>
          ) : (
            <div key={tile.label}>{body}</div>
          );
        })}
      </div>
    </>
  );
}

// ─── review queue ───────────────────────────────────────────────────────────

export function AdminReviewsPage() {
  const list = useAdminTransactions({ status: 'PENDING' });
  const approve = useApproveTransfer();
  const reject = useRejectTransfer();
  const [rejecting, setRejecting] = useState<Transaction | null>(null);

  return (
    <>
      <PageHeader
        title="Review queue"
        subtitle="Transfers flagged by a risk rule. Their money sits in the suspense account until you decide."
      />
      <ErrorText error={list.error ?? approve.error} />
      {list.isLoading && <Loading />}
      {list.data?.items.length === 0 && (
        <Card>
          <Empty>Nothing to review.</Empty>
        </Card>
      )}
      <div className="space-y-3">
        {list.data?.items.map((t) => (
          <Card key={t.id}>
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold text-slate-900">{formatMoney(t.amount)}</p>
                <p className="text-sm text-slate-600">
                  {t.fromName} ({maskAccount(t.fromAccountNumber)}) → {t.toName} ({maskAccount(t.toAccountNumber)})
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {t.reference} · {formatDateTime(t.createdAt)}
                  {t.description && ` · “${t.description}”`}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.riskReasons.map((r) => (
                    <Badge key={r} tone="amber">
                      {humanize(r)}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setRejecting(t)}>
                  Reject
                </Button>
                <Button disabled={approve.isPending} onClick={() => approve.mutate(t.id)}>
                  Approve
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {rejecting && (
        <ReasonDialog
          title={`Reject ${formatMoney(rejecting.amount)} to ${rejecting.toName}`}
          confirmLabel="Reject and refund"
          danger
          pending={reject.isPending}
          error={reject.error}
          onClose={() => {
            reject.reset();
            setRejecting(null);
          }}
          onConfirm={(reason) => reject.mutate({ id: rejecting.id, reason }, { onSuccess: () => setRejecting(null) })}
        />
      )}
    </>
  );
}

// ─── transactions ───────────────────────────────────────────────────────────

export function AdminTransactionsPage() {
  const [status, setStatus] = useState<TransactionStatus | ''>('');
  const [reference, setReference] = useState('');
  const [page, setPage] = useState(1);
  const list = useAdminTransactions({ status, reference: reference.trim() || undefined, page });
  const reverse = useReverseTransfer();
  const [reversing, setReversing] = useState<Transaction | null>(null);

  return (
    <>
      <PageHeader title="Transactions" subtitle="Search all transactions. Completed transfers can be reversed." />
      <Card>
        <div className="mb-4 flex flex-wrap gap-3">
          <Input
            className="w-60"
            placeholder="Reference starts with…"
            value={reference}
            onChange={(e) => {
              setReference(e.target.value);
              setPage(1);
            }}
          />
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
        <ErrorText error={list.error} />
        {list.isLoading && <Loading />}
        {list.data?.items.length === 0 && <Empty>No transactions found.</Empty>}
        {list.data && list.data.items.length > 0 && (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-2 font-medium">Created</th>
                  <th className="px-5 py-2 font-medium">Reference</th>
                  <th className="px-5 py-2 font-medium">Type</th>
                  <th className="px-5 py-2 font-medium">From → To</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 text-right font-medium">Amount</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100">
                    <td className="px-5 py-2.5 whitespace-nowrap text-slate-500">{formatDateTime(t.createdAt)}</td>
                    <td className="px-5 py-2.5 font-mono text-xs">{t.reference}</td>
                    <td className="px-5 py-2.5">{humanize(t.type)}</td>
                    <td className="px-5 py-2.5">
                      {t.fromName} → {t.toName}
                      {t.failureReason && <p className="text-xs text-rose-600">{humanize(t.failureReason)}</p>}
                    </td>
                    <td className="px-5 py-2.5">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="px-5 py-2.5 text-right font-medium whitespace-nowrap">{formatMoney(t.amount)}</td>
                    <td className="px-5 py-2.5 text-right">
                      {t.type === 'TRANSFER' && t.status === 'COMPLETED' && (
                        <Button variant="ghost" className="px-2 py-1 text-rose-600 hover:bg-rose-50" onClick={() => setReversing(t)}>
                          Reverse
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} hasNext={page * 25 < (list.data?.total ?? 0)} onChange={setPage} />
      </Card>

      {reversing && (
        <ReasonDialog
          title={`Reverse ${formatMoney(reversing.amount)} (${reversing.reference})`}
          confirmLabel="Reverse transfer"
          danger
          pending={reverse.isPending}
          error={reverse.error}
          onClose={() => {
            reverse.reset();
            setReversing(null);
          }}
          onConfirm={(reason) => reverse.mutate({ id: reversing.id, reason }, { onSuccess: () => setReversing(null) })}
        />
      )}
    </>
  );
}

// ─── accounts ───────────────────────────────────────────────────────────────

export function AdminAccountsPage() {
  const [search, setSearch] = useState('');
  const list = useAdminAccounts(search.trim());
  const setStatus = useSetAccountStatus();
  const [changing, setChanging] = useState<AdminAccount | null>(null);
  const nextStatus = changing?.status === 'FROZEN' ? 'ACTIVE' : 'FROZEN';

  return (
    <>
      <PageHeader title="Accounts" subtitle="Freeze an account to stop all money moving in or out of it." />
      <Card>
        <Input className="mb-4 max-w-sm" placeholder="Search by name or account number" value={search} onChange={(e) => setSearch(e.target.value)} />
        <ErrorText error={list.error} />
        {list.isLoading && <Loading />}
        {list.data?.length === 0 && <Empty>No accounts found.</Empty>}
        {list.data && list.data.length > 0 && (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-2 font-medium">Holder</th>
                  <th className="px-5 py-2 font-medium">Account</th>
                  <th className="px-5 py-2 text-right font-medium">Balance</th>
                  <th className="px-5 py-2 text-right font-medium">Daily limit</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {list.data.map((a) => (
                  <tr key={a.id} className="border-t border-slate-100">
                    <td className="px-5 py-2.5">
                      <p className="font-medium text-slate-800">{a.holderName}</p>
                      <p className="text-xs text-slate-500">{a.email}</p>
                    </td>
                    <td className="px-5 py-2.5">
                      <p className="font-mono text-xs">{a.accountNumber}</p>
                      <p className="text-xs text-slate-500">{humanize(a.product)}</p>
                    </td>
                    <td className="px-5 py-2.5 text-right font-medium">{formatMoney(a.balance)}</td>
                    <td className="px-5 py-2.5 text-right text-slate-600">{formatMoney(a.dailyLimit)}</td>
                    <td className="px-5 py-2.5">
                      <Badge tone={a.status === 'FROZEN' ? 'rose' : 'emerald'}>{humanize(a.status)}</Badge>
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <Button variant="ghost" className="px-2 py-1" onClick={() => setChanging(a)}>
                        {a.status === 'FROZEN' ? 'Unfreeze' : 'Freeze'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {changing && (
        <ReasonDialog
          title={`${nextStatus === 'FROZEN' ? 'Freeze' : 'Unfreeze'} ${changing.accountNumber}`}
          confirmLabel={nextStatus === 'FROZEN' ? 'Freeze account' : 'Unfreeze account'}
          danger={nextStatus === 'FROZEN'}
          pending={setStatus.isPending}
          error={setStatus.error}
          onClose={() => {
            setStatus.reset();
            setChanging(null);
          }}
          onConfirm={(reason) =>
            setStatus.mutate({ id: changing.id, status: nextStatus, reason }, { onSuccess: () => setChanging(null) })
          }
        />
      )}
    </>
  );
}

// ─── reconciliation ─────────────────────────────────────────────────────────

export function AdminReconciliationPage() {
  const runs = useReconciliationRuns();
  const run = useRunReconciliation();

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Independent SQL checks that prove the books balance, run in one consistent snapshot."
        action={
          <Button disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Running…' : 'Run now'}
          </Button>
        }
      />
      <ErrorText error={runs.error ?? run.error} />
      {runs.isLoading && <Loading />}
      {runs.data?.length === 0 && (
        <Card>
          <Empty>No runs yet. Press “Run now”.</Empty>
        </Card>
      )}
      <div className="space-y-4">
        {runs.data?.map((r) => (
          <Card key={r.id}>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-slate-500">{formatDateTime(r.createdAt)}</p>
              <Badge tone={r.status === 'BALANCED' ? 'emerald' : 'rose'}>{humanize(r.status)}</Badge>
            </div>
            <ul className="space-y-2">
              {r.checks.map((check) => (
                <li key={check.name} className="text-sm">
                  <div className="flex items-start gap-2">
                    <span className={check.passed ? 'text-emerald-600' : 'text-rose-600'}>{check.passed ? '✓' : '✕'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-slate-800">{check.description}</p>
                      <p className="font-mono text-xs text-slate-400">{check.name}</p>
                      {!check.passed && (
                        <pre className="mt-1 overflow-x-auto rounded-lg bg-rose-50 p-2 text-xs text-rose-800">
                          {JSON.stringify(check.mismatches, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}

// ─── audit log ──────────────────────────────────────────────────────────────

export function AdminAuditPage() {
  const [page, setPage] = useState(1);
  const logs = useAuditLogs(page);

  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of who did what. Rows can never be edited or deleted." />
      <Card>
        <ErrorText error={logs.error} />
        {logs.isLoading && <Loading />}
        {logs.data && (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-2 font-medium">When</th>
                  <th className="px-5 py-2 font-medium">Actor</th>
                  <th className="px-5 py-2 font-medium">Action</th>
                  <th className="px-5 py-2 font-medium">Entity</th>
                  <th className="px-5 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.items.map((log) => (
                  <tr key={log.id} className="border-t border-slate-100 align-top">
                    <td className="px-5 py-2.5 whitespace-nowrap text-slate-500">{formatDateTime(log.createdAt)}</td>
                    <td className="px-5 py-2.5">
                      <Badge tone={log.actorType === 'ADMIN' ? 'indigo' : 'slate'}>{humanize(log.actorType)}</Badge>
                      {log.ip && <p className="mt-1 text-xs text-slate-400">{log.ip}</p>}
                    </td>
                    <td className="px-5 py-2.5 font-medium text-slate-800">{humanize(log.action)}</td>
                    <td className="px-5 py-2.5 text-xs text-slate-500">
                      {log.entityType}
                      {log.entityId && <p className="font-mono">{log.entityId.slice(0, 8)}…</p>}
                    </td>
                    <td className="max-w-xs px-5 py-2.5 font-mono text-xs break-all text-slate-500">
                      {Object.keys(log.details).length > 0 ? JSON.stringify(log.details) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} hasNext={(logs.data?.items.length ?? 0) === 50} onChange={setPage} />
      </Card>
    </>
  );
}
