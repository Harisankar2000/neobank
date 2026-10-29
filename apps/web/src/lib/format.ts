import type { Paise } from '../api/types';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/** 123456 paise → "₹1,234.56" */
export const formatMoney = (paise: Paise) => inr.format(paise / 100);

/** What the user typed in rupees → integer paise. Returns null for anything that is not a positive amount. */
export function rupeesToPaise(input: string): Paise | null {
  const value = Number(input.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

/** 501000000001 → "•••• 0001" */
export const maskAccount = (accountNumber: string) => `•••• ${accountNumber.slice(-4)}`;

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Today, 25 Oct" / "Yesterday, 24 Oct" / "Mon, 20 Oct" */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const short = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const days = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
  if (days === 0) return `Today, ${short}`;
  if (days === 1) return `Yesterday, ${short}`;
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Groups items (already sorted newest first) by calendar day. */
export function groupByDay<T>(items: T[], getDate: (item: T) => string): Array<{ label: string; items: T[] }> {
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const label = dayLabel(getDate(item));
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** YYYY-MM-DD in the browser's local time zone (for <input type="date">). */
export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Turns API codes like DAILY_LIMIT_EXCEEDED into "Daily limit exceeded". */
export function humanize(code: string): string {
  const text = code.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
