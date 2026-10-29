import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { getAdminKey, setAdminKey } from '../api/client';
import { Brand } from '../components/Brand';
import { Logo } from '../components/Logo';
import { Button, Card, cx, Field, Input } from '../components/ui';

const links = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/reviews', label: 'Review queue' },
  { to: '/admin/transactions', label: 'Transactions' },
  { to: '/admin/accounts', label: 'Accounts' },
  { to: '/admin/reconciliation', label: 'Reconciliation' },
  { to: '/admin/audit', label: 'Audit log' },
];

/** Back-office console. The admin key is asked for once and kept for this browser tab only. */
export function AdminLayout() {
  const [hasKey, setHasKey] = useState(Boolean(getAdminKey()));
  const queryClient = useQueryClient();

  // The API client fires this event when the key is rejected (401).
  useEffect(() => {
    const onLogout = () => setHasKey(false);
    window.addEventListener('neobank:admin-logout', onLogout);
    return () => window.removeEventListener('neobank:admin-logout', onLogout);
  }, []);

  if (!hasKey) {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        <Card className="w-full max-w-sm p-6">
          <div className="mb-5">
            <Brand suffix="Admin" />
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setAdminKey(String(new FormData(event.currentTarget).get('key') ?? ''));
              queryClient.removeQueries({ queryKey: ['admin'] });
              setHasKey(true);
            }}
          >
            <Field label="Admin key" hint="Local default: dev-admin-key (ADMIN_API_KEY on the API)">
              <Input name="key" type="password" defaultValue="dev-admin-key" required autoFocus />
            </Field>
            <Button type="submit" className="w-full">
              Open console
            </Button>
            <Link to="/login" className="block text-center text-sm text-indigo-600">
              Back to customer app
            </Link>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-900 text-white">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="font-semibold">
              NeoBank <span className="font-normal text-slate-400">Admin</span>
            </span>
          </div>
          <Button
            variant="secondary"
            className="ml-auto bg-slate-800 text-slate-200 ring-slate-700 hover:bg-slate-700"
            onClick={() => {
              setAdminKey(null);
              setHasKey(false);
            }}
          >
            Lock
          </Button>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                cx(
                  'shrink-0 rounded-xl px-3 py-1.5 text-sm font-medium',
                  isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white',
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
