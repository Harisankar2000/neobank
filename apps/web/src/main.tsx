import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AdminLayout } from './admin/AdminLayout';
import {
  AdminAccountsPage,
  AdminAuditPage,
  AdminOverviewPage,
  AdminReconciliationPage,
  AdminReviewsPage,
  AdminTransactionsPage,
} from './admin/AdminPages';
import { ApiError } from './api/client';
import { CustomerLayout } from './components/CustomerLayout';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { BeneficiariesPage } from './pages/BeneficiariesPage';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatementsPage } from './pages/StatementsPage';
import { TransactionsPage } from './pages/TransactionsPage';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Do not retry client errors (401, 404, 422): they will not fix themselves.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />

          <Route element={<CustomerLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="beneficiaries" element={<BeneficiariesPage />} />
            <Route path="statements" element={<StatementsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<AdminOverviewPage />} />
            <Route path="reviews" element={<AdminReviewsPage />} />
            <Route path="transactions" element={<AdminTransactionsPage />} />
            <Route path="accounts" element={<AdminAccountsPage />} />
            <Route path="reconciliation" element={<AdminReconciliationPage />} />
            <Route path="audit" element={<AdminAuditPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
