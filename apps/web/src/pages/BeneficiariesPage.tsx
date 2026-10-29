import { useState } from 'react';
import { useAddBeneficiary, useBeneficiaries, useMe, useRemoveBeneficiary } from '../api/hooks';
import { SendMoneyDialog } from '../components/MoneyDialogs';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Loading, PageHeader } from '../components/ui';
import { formatDateTime, maskAccount } from '../lib/format';

const NEW_PAYEE_HOURS = 24;

export function BeneficiariesPage() {
  const me = useMe();
  const list = useBeneficiaries();
  const add = useAddBeneficiary();
  const remove = useRemoveBeneficiary();
  const [sendTo, setSendTo] = useState<string | null>(null);

  const isNew = (createdAt: string) => Date.now() - new Date(createdAt).getTime() < NEW_PAYEE_HOURS * 3_600_000;

  return (
    <>
      <PageHeader title="Beneficiaries" subtitle="You can send money to your own accounts and to the people saved here." />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          {list.isLoading && <Loading />}
          <ErrorText error={list.error ?? remove.error} />
          {list.data?.length === 0 && <Empty>No beneficiaries yet. Add one to start sending money.</Empty>}
          <ul className="divide-y divide-slate-100">
            {list.data?.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-slate-800 text-sm font-semibold text-white">
                  {b.nickname.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-800">
                    {b.nickname} {isNew(b.createdAt) && <Badge tone="amber">New</Badge>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {b.holderName} · {maskAccount(b.accountNumber)} · added {formatDateTime(b.createdAt)}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setSendTo(b.accountNumber)}>
                  Send
                </Button>
                <Button
                  variant="ghost"
                  className="text-rose-600 hover:bg-rose-50"
                  disabled={remove.isPending}
                  onClick={() => window.confirm(`Remove ${b.nickname}?`) && remove.mutate(b.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-4 font-semibold text-slate-900">Add a beneficiary</h2>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              add.mutate(
                { accountNumber: String(data.get('accountNumber')).trim(), nickname: String(data.get('nickname')).trim() },
                { onSuccess: () => form.reset() },
              );
            }}
          >
            <Field label="Account number" hint="12 digits starting with 5010">
              <Input name="accountNumber" inputMode="numeric" pattern="5010[0-9]{8}" placeholder="501000000002" required />
            </Field>
            <Field label="Nickname">
              <Input name="nickname" maxLength={40} required />
            </Field>
            <ErrorText error={add.error} />
            <Button type="submit" className="w-full" disabled={add.isPending}>
              Add beneficiary
            </Button>
          </form>
          <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Safety rule: for the first {NEW_PAYEE_HOURS} hours, transfers of ₹10,000 or more to a new beneficiary are held for review
            before the money is released.
          </p>
        </Card>
      </div>

      {sendTo && me.data && (
        <SendMoneyDialog
          accounts={me.data.accounts}
          beneficiaries={list.data ?? []}
          defaultTo={sendTo}
          onClose={() => setSendTo(null)}
        />
      )}
    </>
  );
}
