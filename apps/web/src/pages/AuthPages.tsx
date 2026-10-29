import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { request, setToken } from '../api/client';
import { Brand } from '../components/Brand';
import { Button, Card, ErrorText, Field, Input } from '../components/ui';

function useAuth(path: '/auth/login' | '/auth/register') {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, string>) => request<{ token: string }>(path, { method: 'POST', body, as: 'public' }),
    onSuccess: ({ token }) => {
      setToken(token);
      queryClient.clear(); // drop any data from a previous user
      navigate('/');
    },
  });
}

function formValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v)]));
}

function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <Card className="p-6">
          <h1 className="mb-5 text-xl font-semibold text-slate-900">{title}</h1>
          {children}
        </Card>
        <p className="mt-4 text-center text-sm text-slate-500">{footer}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const login = useAuth('/auth/login');
  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="font-medium text-indigo-600">
            Open an account
          </Link>{' '}
          · <Link to="/admin" className="font-medium text-indigo-600">Admin console</Link>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate(formValues(event.currentTarget));
        }}
      >
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" defaultValue="asha@neobank.dev" required />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" defaultValue="Password@123" required />
        </Field>
        <ErrorText error={login.error} />
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? 'Logging in…' : 'Log in'}
        </Button>
        <p className="rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
          Demo: asha@neobank.dev, rahul@neobank.dev or priya@neobank.dev with password Password@123
        </p>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const register = useAuth('/auth/register');
  return (
    <AuthShell
      title="Open your account"
      footer={
        <>
          Already a customer?{' '}
          <Link to="/login" className="font-medium text-indigo-600">
            Log in
          </Link>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          register.mutate(formValues(event.currentTarget));
        }}
      >
        <Field label="Full name">
          <Input name="fullName" autoComplete="name" required minLength={2} />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Mobile number" hint="10 digits, starting with 6–9">
          <Input name="phone" inputMode="numeric" pattern="[6-9][0-9]{9}" required />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <Input name="password" type="password" autoComplete="new-password" minLength={8} required />
        </Field>
        <ErrorText error={register.error} />
        <Button type="submit" className="w-full" disabled={register.isPending}>
          {register.isPending ? 'Creating…' : 'Create account'}
        </Button>
        <p className="text-xs text-slate-500">A savings account is opened for you straight away.</p>
      </form>
    </AuthShell>
  );
}
