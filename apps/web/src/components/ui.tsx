import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ApiError } from '../api/client';
import type { TransactionStatus } from '../api/types';
import { humanize } from '../lib/format';

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70', className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 disabled:bg-rose-300',
  ghost: 'text-indigo-600 hover:bg-indigo-50 disabled:text-slate-400',
};

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed',
        buttonStyles[variant],
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const controlStyles =
  'w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(controlStyles, className)} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(controlStyles, className)} />;
}

const statusStyles: Record<TransactionStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-200',
  REVERSED: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function StatusBadge({ status }: { status: TransactionStatus }) {
  return (
    <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1', statusStyles[status])}>
      {humanize(status)}
    </span>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'amber' | 'rose' | 'emerald' | 'indigo' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
  };
  return <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

/** Shows an API error as "Message (CODE)". */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? `${error.message} (${error.code})` : (error as Error).message;
  return <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{message}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
}

export function Loading() {
  return <p className="py-8 text-center text-sm text-slate-400">Loading…</p>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-6 shadow-xl sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Small "type a reason, then confirm" dialog used by admin actions. */
export function ReasonDialog({
  title,
  confirmLabel,
  danger,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  error: unknown;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm(String(new FormData(event.currentTarget).get('reason') ?? ''));
        }}
      >
        <Field label="Reason" hint="Saved in the audit log and shown to the customer.">
          <Input name="reason" required minLength={3} maxLength={200} autoFocus />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Pager({ page, hasNext, onChange }: { page: number; hasNext: boolean; onChange: (page: number) => void }) {
  return (
    <div className="mt-4 flex items-center justify-end gap-2 text-sm">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </Button>
      <span className="text-slate-500">Page {page}</span>
      <Button variant="secondary" disabled={!hasNext} onClick={() => onChange(page + 1)}>
        Next
      </Button>
    </div>
  );
}
