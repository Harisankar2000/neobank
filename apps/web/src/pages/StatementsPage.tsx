import { useState } from 'react';
import { downloadFile } from '../api/client';
import { useMe, useStatement } from '../api/hooks';
import { Button, Card, cx, Empty, ErrorText, Field, Input, Loading, PageHeader, Select } from '../components/ui';
import { formatDateTime, formatMoney, humanize, isoDate, maskAccount } from '../lib/format';

export function StatementsPage() {
  const me = useMe();
  const today = new Date();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(isoDate(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(isoDate(today));
  const [downloadError, setDownloadError] = useState<unknown>(null);

  const selectedId = accountId || me.data?.accounts[0]?.id || '';
  const statement = useStatement(selectedId, from, to);
  const accountNumber = me.data?.accounts.find((a) => a.id === selectedId)?.accountNumber ?? 'account';

  async function download(format: 'csv' | 'pdf') {
    setDownloadError(null);
    try {
      await downloadFile(`/accounts/${selectedId}/statement.${format}`, { from, to }, `statement-${accountNumber}-${from}-${to}.${format}`);
    } catch (error) {
      setDownloadError(error);
    }
  }

  return (
    <>
      <PageHeader title="Statements" subtitle="Built straight from the journal: every line is one ledger entry." />

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
          <Field label="Account">
            <Select value={selectedId} onChange={(e) => setAccountId(e.target.value)}>
              {me.data?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {humanize(a.product)} {maskAccount(a.accountNumber)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!selectedId} onClick={() => download('csv')}>
              CSV
            </Button>
            <Button disabled={!selectedId} onClick={() => download('pdf')}>
              PDF
            </Button>
          </div>
        </div>
        <div className="mt-3">
          <ErrorText error={downloadError} />
        </div>
      </Card>

      {statement.isLoading && <Loading />}
      <ErrorText error={statement.error} />
      {statement.data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Summary label="Opening balance" value={statement.data.openingBalance} />
            <Summary label="Money in" value={statement.data.totalCredits} tone="text-emerald-600" />
            <Summary label="Money out" value={statement.data.totalDebits} />
            <Summary label="Closing balance" value={statement.data.closingBalance} />
          </div>

          <Card>
            {statement.data.lines.length === 0 ? (
              <Empty>No entries in this period.</Empty>
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-xs text-slate-500 uppercase">
                    <tr>
                      <th className="px-5 py-2 font-medium">Date</th>
                      <th className="px-5 py-2 font-medium">Description</th>
                      <th className="px-5 py-2 font-medium">Counterparty</th>
                      <th className="px-5 py-2 text-right font-medium">Amount</th>
                      <th className="px-5 py-2 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.data.lines.map((line) => (
                      <tr key={line.entryId} className="border-t border-slate-100">
                        <td className="px-5 py-2.5 whitespace-nowrap text-slate-500">{formatDateTime(line.date)}</td>
                        <td className="px-5 py-2.5">
                          <p className="text-slate-800">{line.description}</p>
                          <p className="font-mono text-xs text-slate-400">{line.reference}</p>
                        </td>
                        <td className="px-5 py-2.5 text-slate-600">{line.counterparty}</td>
                        <td
                          className={cx(
                            'px-5 py-2.5 text-right font-medium whitespace-nowrap',
                            line.direction === 'CREDIT' ? 'text-emerald-600' : 'text-slate-800',
                          )}
                        >
                          {line.direction === 'CREDIT' ? '+' : '-'}
                          {formatMoney(line.amount)}
                        </td>
                        <td className="px-5 py-2.5 text-right whitespace-nowrap text-slate-600">{formatMoney(line.balanceAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cx('mt-1 text-lg font-semibold text-slate-900', tone)}>{formatMoney(value)}</p>
    </Card>
  );
}
