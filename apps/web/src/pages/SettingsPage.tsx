import { useState } from 'react';
import { useMe, useSetDailyLimit } from '../api/hooks';
import type { Account } from '../api/types';
import { Badge, Button, Card, ErrorText, Field, Input, Loading, PageHeader } from '../components/ui';
import { formatMoney, humanize, maskAccount, rupeesToPaise } from '../lib/format';

const MAX_LIMIT_RUPEES = 2_00_000;

export function SettingsPage() {
  const me = useMe();
  return (
    <>
      <PageHeader
        title="Daily limits"
        subtitle="The most each account can send to other people per day. Moving money between your own accounts does not count."
      />
      {me.isLoading && <Loading />}
      <div className="grid gap-4 md:grid-cols-2">
        {me.data?.accounts.map((account) => (
          <LimitForm key={account.id} account={account} />
        ))}
      </div>
    </>
  );
}

function LimitForm({ account }: { account: Account }) {
  const [value, setValue] = useState(String(account.dailyLimit / 100));
  const update = useSetDailyLimit();
  const paise = rupeesToPaise(value);
  const tooHigh = paise !== null && paise > MAX_LIMIT_RUPEES * 100;

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="font-semibold text-slate-900">
            {humanize(account.product)} {maskAccount(account.accountNumber)}
          </p>
          <p className="text-sm text-slate-500">Current limit {formatMoney(account.dailyLimit)}</p>
        </div>
        {update.isSuccess && <Badge tone="emerald">Saved</Badge>}
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (paise && !tooHigh) update.mutate({ accountId: account.id, dailyLimit: paise });
        }}
      >
        <Field label="New daily limit (₹)" hint={`Up to ₹${MAX_LIMIT_RUPEES.toLocaleString('en-IN')}`}>
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {tooHigh && <p className="text-sm text-rose-600">The limit can be at most ₹{MAX_LIMIT_RUPEES.toLocaleString('en-IN')}.</p>}
        <ErrorText error={update.error} />
        <Button type="submit" disabled={!paise || tooHigh || update.isPending}>
          Save limit
        </Button>
      </form>
    </Card>
  );
}
