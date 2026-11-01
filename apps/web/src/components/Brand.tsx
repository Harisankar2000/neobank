import { Logo } from './Logo';

export function Brand({ suffix }: { suffix?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Logo />
      <span className="text-lg font-semibold text-slate-900">
        NeoBank{suffix && <span className="ml-1 font-normal text-slate-400">{suffix}</span>}
      </span>
    </div>
  );
}
