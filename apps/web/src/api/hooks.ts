import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import type {
  Account,
  AdminAccount,
  AdminOverview,
  AuditLog,
  Beneficiary,
  Customer,
  JournalEntry,
  LimitUsage,
  Notification,
  Page,
  Paise,
  Product,
  ReconciliationRun,
  Statement,
  Transaction,
  TransactionStatus,
} from './types';

// ─── customer: reads ────────────────────────────────────────────────────────

export const useMe = () =>
  useQuery({ queryKey: ['me'], queryFn: () => request<{ customer: Customer; accounts: Account[] }>('/me') });

export const useAccount = (id: string | undefined) =>
  useQuery({
    queryKey: ['account', id],
    queryFn: () => request<{ account: Account; limits: LimitUsage }>(`/accounts/${id}`),
    enabled: Boolean(id),
  });

export const useTransactions = (filters: { accountId?: string; status?: TransactionStatus | ''; page?: number; pageSize?: number }) =>
  useQuery({
    queryKey: ['transactions', filters],
    queryFn: () =>
      request<Page<Transaction>>('/transactions', {
        query: { accountId: filters.accountId, status: filters.status, page: filters.page, pageSize: filters.pageSize },
      }),
  });

export const useTransaction = (id: string | null) =>
  useQuery({
    queryKey: ['transaction', id],
    queryFn: () => request<{ transaction: Transaction; entries: JournalEntry[] }>(`/transactions/${id}`),
    enabled: Boolean(id),
  });

export const useBeneficiaries = () =>
  useQuery({ queryKey: ['beneficiaries'], queryFn: () => request<Beneficiary[]>('/beneficiaries') });

export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () => request<{ items: Notification[]; unread: number }>('/notifications'),
    refetchInterval: 10_000, // the Kafka consumer writes them in the background
  });

export const useStatement = (accountId: string, from: string, to: string) =>
  useQuery({
    queryKey: ['statement', accountId, from, to],
    queryFn: () => request<Statement>(`/accounts/${accountId}/statement`, { query: { from, to } }),
    enabled: Boolean(accountId && from && to && from <= to),
  });

// ─── customer: writes ───────────────────────────────────────────────────────

/** After money moves, balances, history, limits and notifications may all change. */
function useInvalidateMoney() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ['me', 'account', 'transactions', 'transaction', 'notifications', 'statement'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
}

export function useTransfer() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (input: { fromAccountId: string; toAccountNumber: string; amount: Paise; note?: string; idempotencyKey: string }) => {
      const { idempotencyKey, ...body } = input;
      return request<{ transaction: Transaction }>('/transfers', { method: 'POST', body, idempotencyKey });
    },
    onSettled: invalidate, // a FAILED transfer is also saved, so refresh either way
  });
}

export function useDeposit() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (input: { accountId: string; amount: Paise; idempotencyKey: string }) =>
      request<{ transaction: Transaction }>(`/accounts/${input.accountId}/deposits`, {
        method: 'POST',
        body: { amount: input.amount },
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: invalidate,
  });
}

export function useOpenAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (product: Product) => request<Account>('/accounts', { method: 'POST', body: { product } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useSetDailyLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; dailyLimit: Paise }) =>
      request<Account>(`/accounts/${input.accountId}/daily-limit`, { method: 'PATCH', body: { dailyLimit: input.dailyLimit } }),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: ['me'] }), queryClient.invalidateQueries({ queryKey: ['account'] })]),
  });
}

export function useAddBeneficiary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountNumber: string; nickname: string }) =>
      request<Beneficiary>('/beneficiaries', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['beneficiaries'] }),
  });
}

export function useRemoveBeneficiary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/beneficiaries/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['beneficiaries'] }),
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

// ─── admin ──────────────────────────────────────────────────────────────────

const admin = { as: 'admin' as const };

export const useAdminOverview = () =>
  useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => request<AdminOverview>('/admin/overview', admin),
    refetchInterval: 10_000,
  });

export const useAdminTransactions = (filters: { status?: TransactionStatus | ''; reference?: string; page?: number }) =>
  useQuery({
    queryKey: ['admin', 'transactions', filters],
    queryFn: () =>
      request<Page<Transaction>>('/admin/transactions', {
        ...admin,
        query: { status: filters.status, reference: filters.reference, page: filters.page, pageSize: 25 },
      }),
  });

export const useAdminAccounts = (search: string) =>
  useQuery({
    queryKey: ['admin', 'accounts', search],
    queryFn: () => request<AdminAccount[]>('/admin/accounts', { ...admin, query: { search } }),
  });

export const useReconciliationRuns = () =>
  useQuery({ queryKey: ['admin', 'reconciliation'], queryFn: () => request<ReconciliationRun[]>('/admin/reconciliation/runs', admin) });

export const useAuditLogs = (page: number) =>
  useQuery({
    queryKey: ['admin', 'audit', page],
    queryFn: () => request<Page<AuditLog>>('/admin/audit-logs', { ...admin, query: { page, pageSize: 50 } }),
  });

function useAdminMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }) });
}

export const useApproveTransfer = () =>
  useAdminMutation((id: string) => request<Transaction>(`/admin/transactions/${id}/approve`, { ...admin, method: 'POST' }));

export const useRejectTransfer = () =>
  useAdminMutation((input: { id: string; reason: string }) =>
    request<Transaction>(`/admin/transactions/${input.id}/reject`, { ...admin, method: 'POST', body: { reason: input.reason } }),
  );

export const useReverseTransfer = () =>
  useAdminMutation((input: { id: string; reason: string }) =>
    request<Transaction>(`/admin/transactions/${input.id}/reverse`, { ...admin, method: 'POST', body: { reason: input.reason } }),
  );

export const useSetAccountStatus = () =>
  useAdminMutation((input: { id: string; status: 'ACTIVE' | 'FROZEN'; reason: string }) =>
    request<Account>(`/admin/accounts/${input.id}/status`, {
      ...admin,
      method: 'PATCH',
      body: { status: input.status, reason: input.reason },
    }),
  );

export const useRunReconciliation = () =>
  useAdminMutation(() => request<ReconciliationRun>('/admin/reconciliation/runs', { ...admin, method: 'POST' }));
