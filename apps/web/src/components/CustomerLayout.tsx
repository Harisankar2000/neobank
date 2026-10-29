import { useQueryClient } from '@tanstack/react-query';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router';
import { getToken, setToken } from '../api/client';
import { useMe } from '../api/hooks';
import { Brand } from './Brand';
import { NotificationBell } from './NotificationBell';
import { cx } from './ui';

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/transactions', label: 'Transactions' },
  { to: '/beneficiaries', label: 'Beneficiaries' },
  { to: '/statements', label: 'Statements' },
  { to: '/settings', label: 'Limits' },
];

export function CustomerLayout() {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Shell />;
}

function Shell() {
  const { data } = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const initials = (data?.customer.fullName ?? '')
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2);

  function logout() {
    setToken(null);
    queryClient.clear();
    navigate('/login');
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Brand />
          <nav className="hidden flex-1 justify-center gap-1 md:flex">
            {links.map((link) => (
              <NavItem key={link.to} {...link} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <NotificationBell />
            <span className="hidden text-sm font-medium text-slate-700 sm:block">{data?.customer.fullName}</span>
            <button
              type="button"
              onClick={logout}
              title="Log out"
              className="grid h-9 w-9 place-items-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700 hover:bg-indigo-200"
            >
              {initials || '·'}
            </button>
          </div>
        </div>
        {/* On phones the nav scrolls sideways under the header. */}
        <nav className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          {links.map((link) => (
            <NavItem key={link.to} {...link} />
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'shrink-0 rounded-xl px-3 py-2 text-sm font-medium transition',
          isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100',
        )
      }
    >
      {label}
    </NavLink>
  );
}
