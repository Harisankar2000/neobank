import { useState } from 'react';
import { ApiError } from '../api/client';
import { useDeposit, useTransfer } from '../api/hooks';
import type { Account, Beneficiary, Transaction } from '../api/types';
import { formatMoney, humanize, maskAccount, rupeesToPaise } from '../lib/format';
import { Button, ErrorText, Field, Input, Modal, Select } from './ui';

/**
 * Idempotency in the browser: one key per attempt at one request.
 * - The key is created when the dialog opens.
 * - Pressing "Retry" after a network error sends the SAME key, so if the first
 *   request did reach the server, the server replays it instead of paying twice.
 * - Editing the form makes it a different request, so a new key is created.
 */
function useIdempotencyKey() {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return { key, renew: () => setKey(crypto.randomUUID()) };
}

export interface SendMoneyDialogProps {
  accounts: Account[];
  beneficiaries: Beneficiary[];
  defaultFromId?: string;
  defaultTo?: string;
  onClose: () => void;
}

export function SendMoneyDialog({ accounts, beneficiaries, defaultFromId, defaultTo, onClose }: SendMoneyDialogProps) {
  const [fromAccountId, setFrom] = useState(defaultFromId ?? accounts[0]?.id ?? '');
  const [toAccountNumber, setTo] = useState(defaultTo ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const idempotency = useIdempotencyKey();
  const transfer = useTransfer();

  const ownTargets = accounts.filter((a) => a.id !== fromAccountId);
  const from = accounts.find((a) => a.id === fromAccountId);
  const paise = rupeesToPaise(amount);

  /** Any edit after an attempt starts a new request with a new key. */
  function edit(apply: () => void) {
    if (!transfer.isIdle) {
      transfer.reset();
      idempotency.renew();
    }
    apply();
  }

  function submit() {
    if (!paise || !toAccountNumber) return;
    transfer.mutate({
      fromAccountId,
      toAccountNumber,
      amount: paise,
      note: note.trim() || undefined,
      idempotencyKey: idempotency.key,
    });
  }

  // A failed transfer is still a saved transaction: the 422 body includes it.
  const failed =
    transfer.error instanceof ApiError && transfer.error.status === 422
      ? (transfer.error.body as { transaction?: Transaction } | undefined)?.transaction
      : undefined;
  const result = transfer.data?.transaction ?? failed;

  if (result) {
    return (
      <Modal title="Transfer" onClose={onClose}>
        <TransferOutcome transaction={result} error={transfer.error} />
        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }

  const networkError = transfer.error && !(transfer.error instanceof ApiError);

  return (
    <Modal title="Send money" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="From">
          <Select value={fromAccountId} onChange={(e) => edit(() => setFrom(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={a.status !== 'ACTIVE'}>
                {humanize(a.product)} {maskAccount(a.accountNumber)} · {formatMoney(a.balance)}
                {a.status !== 'ACTIVE' ? ' (frozen)' : ''}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="To">
          <Select value={toAccountNumber} required onChange={(e) => edit(() => setTo(e.target.value))}>
            <option value="">Choose a payee</option>
            {ownTargets.length > 0 && (
              <optgroup label="My accounts">
                {ownTargets.map((a) => (
                  <option key={a.id} value={a.accountNumber}>
                    {humanize(a.product)} {maskAccount(a.accountNumber)}
                  </option>
                ))}
              </optgroup>
            )}
            {beneficiaries.length > 0 && (
              <optgroup label="Beneficiaries">
                {beneficiaries.map((b) => (
                  <option key={b.id} value={b.accountNumber}>
                    {b.nickname} · {b.holderName} {maskAccount(b.accountNumber)}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>

        <Field label="Amount (₹)" hint={from ? `Available ${formatMoney(from.balance)}` : undefined}>
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => edit(() => setAmount(e.target.value))}
            required
          />
        </Field>

        <Field label="Note (optional)">
          <Input value={note} maxLength={140} onChange={(e) => edit(() => setNote(e.target.value))} />
        </Field>

        <ErrorText error={transfer.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!paise || !toAccountNumber || transfer.isPending}>
            {transfer.isPending ? 'Sending…' : networkError ? 'Retry' : `Send ${paise ? formatMoney(paise) : ''}`}
          </Button>
        </div>
        <p className="text-xs text-slate-400">Idempotency-Key: {idempotency.key}</p>
      </form>
    </Modal>
  );
}

function TransferOutcome({ transaction, error }: { transaction: Transaction; error: unknown }) {
  const amount = formatMoney(transaction.amount);

  if (transaction.status === 'COMPLETED') {
    return (
      <Outcome icon="✓" tone="bg-emerald-100 text-emerald-700" title={`${amount} sent`}>
        To {transaction.toName} ({maskAccount(transaction.toAccountNumber)}). Reference {transaction.reference}.
      </Outcome>
    );
  }

  if (transaction.status === 'PENDING') {
    return (
      <Outcome icon="⏳" tone="bg-amber-100 text-amber-700" title="Under review">
        Your transfer of {amount} matched a safety rule ({transaction.riskReasons.map(humanize).join(', ')}). The money is
        held safely and will reach {transaction.toName} once our team approves it, or come back to you if not.
      </Outcome>
    );
  }

  const details = error instanceof ApiError ? (error.details as { remaining?: number; available?: number } | undefined) : undefined;
  return (
    <Outcome icon="✕" tone="bg-rose-100 text-rose-700" title="Transfer failed">
      {error instanceof ApiError ? error.message : humanize(transaction.failureReason ?? 'Unknown error')}.
      {details?.remaining !== undefined && <> You can still send {formatMoney(details.remaining)} today.</>}
      {details?.available !== undefined && <> Available balance: {formatMoney(details.available)}.</>}
      <span className="mt-2 block text-xs text-slate-400">
        Saved as FAILED with reference {transaction.reference}. No money left your account.
      </span>
    </Outcome>
  );
}

function Outcome({ icon, tone, title, children }: { icon: string; tone: string; title: string; children: React.ReactNode }) {
  return (
    <div className="text-center">
      <div className={`mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full text-2xl ${tone}`}>{icon}</div>
      <p className="text-lg font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm text-slate-600">{children}</p>
    </div>
  );
}

export function AddMoneyDialog({ accounts, defaultAccountId, onClose }: { accounts: Account[]; defaultAccountId?: string; onClose: () => void }) {
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const idempotency = useIdempotencyKey();
  const deposit = useDeposit();
  const paise = rupeesToPaise(amount);

  function edit(apply: () => void) {
    if (!deposit.isIdle) {
      deposit.reset();
      idempotency.renew();
    }
    apply();
  }

  if (deposit.data) {
    return (
      <Modal title="Add money" onClose={onClose}>
        <Outcome icon="✓" tone="bg-emerald-100 text-emerald-700" title={`${formatMoney(deposit.data.transaction.amount)} added`}>
          Reference {deposit.data.transaction.reference}.
        </Outcome>
        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add money" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (paise) deposit.mutate({ accountId, amount: paise, idempotencyKey: idempotency.key });
        }}
      >
        <p className="text-sm text-slate-500">Simulates a top-up from outside the bank (UPI, card or cash). Up to ₹1,00,000 at a time.</p>
        <Field label="To account">
          <Select value={accountId} onChange={(e) => edit(() => setAccountId(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {humanize(a.product)} {maskAccount(a.accountNumber)} · {formatMoney(a.balance)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount (₹)">
          <Input inputMode="decimal" placeholder="0.00" value={amount} required onChange={(e) => edit(() => setAmount(e.target.value))} />
        </Field>
        <ErrorText error={deposit.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!paise || deposit.isPending}>
            {deposit.isPending ? 'Adding…' : 'Add money'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
