import { useId } from 'react';

/** The NeoBank mark: an "N" whose right stroke rises into an arrow. Keep in sync with public/favicon.svg. */
export function Logo({ className = 'h-9 w-9' }: { className?: string }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="NeoBank">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <path
        d="M9 23V9.5l12 13.5V9M17.5 12.5 21 9l3.5 3.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
