import { useState } from 'react';
import { useMarkNotificationsRead, useNotifications } from '../api/hooks';
import { formatDateTime } from '../lib/format';
import { cx } from './ui';

/** Notifications are written by the Kafka consumer; we poll for them every 10 seconds. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const unread = data?.unread ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-10 w-10 place-items-center rounded-xl text-slate-600 hover:bg-slate-100"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-2 shadow-xl ring-1 ring-slate-200">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="font-semibold text-slate-900">Notifications</span>
              <button
                type="button"
                className="text-xs font-medium text-indigo-600 disabled:text-slate-400"
                disabled={unread === 0 || markRead.isPending}
                onClick={() => markRead.mutate()}
              >
                Mark all read
              </button>
            </div>
            <ul className="max-h-96 overflow-y-auto">
              {(data?.items ?? []).map((n) => (
                <li key={n.id} className={cx('rounded-xl px-3 py-2', !n.readAt && 'bg-indigo-50/60')}>
                  <p className="text-sm font-medium text-slate-800">{n.title}</p>
                  <p className="text-sm text-slate-600">{n.body}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{formatDateTime(n.createdAt)}</p>
                </li>
              ))}
              {data?.items.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-slate-500">
                  Nothing yet. Notifications appear when the worker is running.
                </li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
