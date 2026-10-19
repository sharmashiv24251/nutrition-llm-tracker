"use client";
// Shared building blocks: the app shell with its bottom tab bar, icons, status pills and target bars.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Completeness } from "./client";

// ───────────── icons (24px stroke icons, currentColor) ─────────────

const Svg = ({ children, size = 22 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const Icon = {
  home: (p: { size?: number }) => <Svg {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h5v-6h4v6h5V9.5" /></Svg>,
  dumbbell: (p: { size?: number }) => <Svg {...p}><path d="M6 7v10M3.5 9.5v5M18 7v10M20.5 9.5v5M6 12h12" /></Svg>,
  bowl: (p: { size?: number }) => <Svg {...p}><path d="M3 11h18a9 9 0 0 1-18 0z" /><path d="M8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M16 7c0-1.5 1-2 1-3.5" /></Svg>,
  gear: (p: { size?: number }) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></Svg>,
  chevron: (p: { size?: number }) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>,
  back: (p: { size?: number }) => <Svg {...p}><path d="m15 6-6 6 6 6" /></Svg>,
  check: (p: { size?: number }) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>,
  alert: (p: { size?: number }) => <Svg {...p}><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></Svg>,
  cross: (p: { size?: number }) => <Svg {...p}><path d="M7 7l10 10M17 7 7 17" /></Svg>,
  sparkle: (p: { size?: number }) => <Svg {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></Svg>,
  plus: (p: { size?: number }) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
  scale: (p: { size?: number }) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="4" /><path d="M9 9a3 3 0 0 1 6 0M12 9l1.5-1.5" /></Svg>,
};

// ───────────── shell ─────────────

const TABS = [
  { href: "/", label: "Home", icon: Icon.home },
  { href: "/workout", label: "Workout", icon: Icon.dumbbell },
  { href: "/food", label: "Food", icon: Icon.bowl },
] as const;

export function BottomNav() {
  const path = usePathname();
  const active = (href: string) =>
    href === "/" ? path === "/" || path.startsWith("/day")
    : href === "/workout" ? path.startsWith("/workout") || path.startsWith("/exercise") || path.startsWith("/plan")
    : path.startsWith(href);
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800/80 bg-zinc-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
      aria-label="Main"
    >
      <div className="mx-auto grid max-w-md grid-cols-3">
        {TABS.map((t) => {
          const on = active(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={on ? "page" : undefined}
              className={`flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
                on ? "text-white" : "text-zinc-500 active:text-zinc-300"
              }`}
            >
              <t.icon size={23} />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** Page frame with the bottom tab bar. Content scrolls; the bar stays put. */
export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <>
      <main className="mx-auto min-h-dvh max-w-md pb-[calc(5rem+env(safe-area-inset-bottom))]">{children}</main>
      <BottomNav />
    </>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 ${className}`}>{children}</section>;
}

export function CardTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400">{children}</h2>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

// ───────────── day status ─────────────

export const COMPLETENESS_META: Record<Completeness, { label: string; icon: (p: { size?: number }) => React.ReactElement; pill: string; on: string }> = {
  complete: { label: "Complete", icon: Icon.check, pill: "bg-emerald-500/15 text-emerald-300", on: "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40" },
  incomplete: { label: "Incomplete", icon: Icon.alert, pill: "bg-amber-500/15 text-amber-300", on: "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40" },
  missed: { label: "Missed", icon: Icon.cross, pill: "bg-rose-500/15 text-rose-300", on: "bg-rose-500/20 text-rose-200 ring-1 ring-rose-400/40" },
};

/** Status pill: icon + label, never colour alone. */
export function StatusPill({ completeness, isToday }: { completeness: Completeness | null; isToday?: boolean }) {
  if (!completeness) {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
        {isToday ? "In progress" : "Not marked"}
      </span>
    );
  }
  const m = COMPLETENESS_META[completeness];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.pill}`}>
      <m.icon size={12} />
      {m.label}
    </span>
  );
}

/** Three-way control: Complete / Incomplete / Missed. Tapping the active one clears it. */
export function CompletenessControl({
  value, onChange, busy,
}: { value: Completeness | null; onChange: (v: Completeness | null) => void; busy?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-zinc-900 p-1.5" role="radiogroup" aria-label="Day status">
      {(Object.keys(COMPLETENESS_META) as Completeness[]).map((k) => {
        const m = COMPLETENESS_META[k];
        const on = value === k;
        return (
          <button
            key={k}
            role="radio"
            aria-checked={on}
            disabled={busy}
            onClick={() => onChange(on ? null : k)}
            className={`flex min-h-12 items-center justify-center gap-1.5 rounded-xl text-sm font-medium transition disabled:opacity-60 ${
              on ? m.on : "text-zinc-400 active:bg-zinc-800"
            }`}
          >
            <m.icon size={16} />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

// ───────────── target bars ─────────────

/**
 * One nutrient against its target. kind "ceiling" (kcal): filling past the target is over.
 * kind "floor" (protein, fibre): reaching the target is the goal.
 */
export function TargetBar({
  label, value, target, unit, kind,
}: { label: string; value: number; target: number | null | undefined; unit: string; kind: "ceiling" | "floor" }) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  const over = kind === "ceiling" && target != null && value > target;
  const met = kind === "floor" && target != null && value >= target;
  const left = target != null ? target - value : null;
  const note = target == null ? "" : kind === "ceiling"
    ? over ? `${Math.round(-left!)} over` : `${Math.round(left!)} left`
    : met ? "target met" : `${Math.round(left!)} to go`;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-sm text-zinc-300">{label}</span>
        <span className="ml-auto font-mono text-sm tabular-nums text-zinc-100">
          {Math.round(value).toLocaleString("en-IE")}
          {target != null && <span className="text-zinc-500"> / {Math.round(target).toLocaleString("en-IE")}{unit}</span>}
        </span>
      </div>
      {target != null && <div className="h-2 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div
          className={`h-full rounded-full ${over ? "bg-rose-400" : met ? "bg-emerald-400" : "bg-sky-400"}`}
          style={{ width: `${pct}%` }}
        />
      </div>}
      {note && <div className={`mt-1 text-right text-[11px] ${over ? "text-rose-300" : met ? "text-emerald-300" : "text-zinc-500"}`}>{note}</div>}
    </div>
  );
}
