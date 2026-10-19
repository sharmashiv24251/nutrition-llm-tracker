"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  api, dayParts, longDay, relativeDay, round0, round1, usd, type HistoryDay, type Spend, type Status,
} from "./client";
import { OpenDayBanner } from "./Common";
import { DayBars, DayBarsLegend } from "./DayBars";
import { Card, CardTitle, Icon, Screen, StatusPill, TargetBar } from "./ui";

type Data = { history: HistoryDay[]; status: Status; spend: Spend };

export function Home() {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [bannerHidden, setBannerHidden] = useState(false);

  useEffect(() => {
    let live = true;
    api.history(30)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [version]);

  const today = data?.history.find((d) => d.is_today) ?? null;
  const yesterday = data?.status.yesterday;

  return (
    <Screen>
      <header className="flex items-start gap-3 px-4 pb-2 pt-[max(env(safe-area-inset-top),1rem)]">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">Swolify</p>
          <h1 className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight">
            {data ? longDay(data.status.today) : " "}
          </h1>
        </div>
        <Link href="/costs" className="mt-1 rounded-full border border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300">
          {data ? usd(data.spend.total_usd) : "–"} today
        </Link>
        <Link href="/settings" aria-label="Settings" className="mt-0.5 grid size-9 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
          <Icon.gear />
        </Link>
      </header>

      {!bannerHidden && data && yesterday && data.status.open_days.includes(yesterday) && (
        <div className="px-4 pb-2">
          <div className="overflow-hidden rounded-2xl">
            <OpenDayBanner
              day={yesterday}
              onAdd={() => router.push(`/food?prefill=${encodeURIComponent("Yesterday I also had ")}`)}
              onClosed={() => {
                setBannerHidden(true);
                setVersion((v) => v + 1);
              }}
            />
          </div>
        </div>
      )}

      <div className="space-y-4 px-4 pt-2">
        {error && <p className="rounded-2xl bg-red-950/60 p-3 text-sm text-red-200">{error}</p>}
        {!data && !error && <Skeleton />}
        {data && today && <TodayCard day={today} next={data.status.today_program_day} />}
        {data && <Averages history={data.history} />}
        {data && <Trends history={data.history} />}
        {data && (
          <Link href="/exercises" className="flex min-h-14 items-center gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/70 px-4 active:bg-zinc-900">
            <Icon.dumbbell />
            <span className="flex-1">
              <span className="block text-sm font-medium">Exercise library</span>
              <span className="block text-xs text-zinc-500">Add exercises, notes on how you do them, progress</span>
            </span>
            <Icon.chevron size={18} />
          </Link>
        )}
        {data && <RecentDays history={data.history} today={data.status.today} />}
      </div>
    </Screen>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      {[180, 90, 230].map((h) => <div key={h} className="animate-pulse rounded-3xl bg-zinc-900" style={{ height: h }} />)}
    </div>
  );
}

function TodayCard({ day, next }: { day: HistoryDay; next: Status["today_program_day"] }) {
  const t = day.targets;
  return (
    <Card>
      <Link href={`/day/${day.day}`} className="block">
        <CardTitle right={<span className="flex items-center text-xs text-zinc-400">Open day <Icon.chevron size={16} /></span>}>
          Today
        </CardTitle>
        <div className="space-y-3">
          <TargetBar label="Calories" value={Number(day.kcal ?? 0)} target={t?.kcal} unit="" kind="ceiling" />
          <TargetBar label="Protein" value={Number(day.protein_g ?? 0)} target={t?.protein_g} unit=" g" kind="floor" />
          <TargetBar label="Fibre" value={Number(day.fibre_g ?? 0)} target={t?.fibre_g} unit=" g" kind="floor" />
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-2xl bg-zinc-950/60 px-3 py-2.5">
          <Icon.dumbbell size={20} />
          <span className="text-sm text-zinc-300">
            {day.sessions > 0
              ? `${day.program_days[0] ?? "Workout"} · ${day.working_sets} sets`
              : "No workout logged yet"}
          </span>
        </div>
      </Link>
      {next && day.sessions === 0 && (
        <Link href={`/plan?day=${next.id}`} className="mt-2 flex items-center gap-2 rounded-2xl bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-200">
          <span className="flex-1">Up next: <b className="font-semibold">{next.name}</b> · see weights</span>
          <Icon.chevron size={16} />
        </Link>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Link href="/food" className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-zinc-100 font-semibold text-zinc-950">
          <Icon.bowl size={18} /> Log food
        </Link>
        <Link href="/workout" className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-zinc-800 font-semibold text-zinc-100">
          <Icon.dumbbell size={18} /> Log workout
        </Link>
      </div>
    </Card>
  );
}

/** Last 7 finished days that count (not today, not incomplete or missed). */
function Averages({ history }: { history: HistoryDay[] }) {
  const week = history.filter((d) => !d.is_today).slice(0, 7);
  const counted = week.filter((d) => d.counts);
  const avg = (k: "kcal" | "protein_g") =>
    counted.length ? counted.reduce((s, d) => s + Number(d[k] ?? 0), 0) / counted.length : null;
  const workouts = history.slice(0, 7).filter((d) => d.sessions > 0).length;
  const tiles = [
    { label: "Avg calories", value: round0(avg("kcal")), sub: "kcal / day" },
    { label: "Avg protein", value: round0(avg("protein_g")), sub: "g / day" },
    { label: "Workouts", value: String(workouts), sub: "last 7 days" },
  ];
  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-2xl border border-zinc-800/80 bg-zinc-900/70 px-3 py-3">
            <div className="text-[11px] text-zinc-500">{t.label}</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{t.value}</div>
            <div className="text-[11px] text-zinc-500">{t.sub}</div>
          </div>
        ))}
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-zinc-500">
        Averages use {counted.length} of the last 7 days; incomplete and missed days are left out.
      </p>
    </div>
  );
}

function Trends({ history }: { history: HistoryDay[] }) {
  const [metric, setMetric] = useState<"kcal" | "protein_g">("kcal");
  const [range, setRange] = useState<14 | 30>(14);
  const [selected, setSelected] = useState<string | null>(null);
  const days = useMemo(() => history.slice(0, range).reverse(), [history, range]);
  const latestTarget = history.find((d) => d.targets)?.targets ?? null;
  const target = metric === "kcal" ? latestTarget?.kcal ?? null : latestTarget?.protein_g ?? null;
  const sel = days.find((d) => d.day === selected) ?? null;

  return (
    <Card>
      <CardTitle
        right={
          <div className="flex gap-1 rounded-full bg-zinc-950/70 p-0.5 text-xs">
            {([14, 30] as const).map((r) => (
              <button key={r} onClick={() => setRange(r)}
                className={`min-h-7 rounded-full px-2.5 ${range === r ? "bg-zinc-700 text-white" : "text-zinc-400"}`}>
                {r}d
              </button>
            ))}
          </div>
        }
      >
        Trends
      </CardTitle>
      <div className="mb-2 grid grid-cols-2 rounded-xl bg-zinc-950/70 p-0.5 text-sm">
        {([["kcal", "Calories"], ["protein_g", "Protein"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setMetric(k)}
            className={`min-h-9 rounded-lg ${metric === k ? "bg-zinc-800 font-medium text-white" : "text-zinc-400"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="h-6 text-sm" aria-live="polite">
        {sel ? (
          <Link href={`/day/${sel.day}`} className="flex items-center gap-2">
            <span className="text-zinc-400">{dayParts(sel.day).weekday} {dayParts(sel.day).date} {dayParts(sel.day).month}</span>
            <span className="font-mono tabular-nums">
              {metric === "kcal" ? `${round0(sel.kcal)} kcal` : `${round1(sel.protein_g)} g protein`}
            </span>
            <StatusPill completeness={sel.completeness} isToday={sel.is_today} />
            <Icon.chevron size={14} />
          </Link>
        ) : (
          <span className="text-zinc-500">Tap a day to see it</span>
        )}
      </div>
      <DayBars days={days} metric={metric} target={target} selected={selected} onSelect={setSelected} />
      <DayBarsLegend />
    </Card>
  );
}

function RecentDays({ history, today }: { history: HistoryDay[]; today: string }) {
  const [showAll, setShowAll] = useState(false);
  const list = history.filter((d) => !d.is_today);
  const shown = showAll ? list : list.slice(0, 10);
  return (
    <section>
      <h2 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-400">Past days</h2>
      <ul className="space-y-2">
        {shown.map((d) => <li key={d.day}><DayRow day={d} today={today} /></li>)}
      </ul>
      {!showAll && list.length > shown.length && (
        <button onClick={() => setShowAll(true)} className="mt-2 min-h-11 w-full rounded-2xl text-sm text-zinc-400 active:bg-zinc-900">
          Show all {list.length} days
        </button>
      )}
    </section>
  );
}

function DayRow({ day, today }: { day: HistoryDay; today: string }) {
  const { weekday, date, month } = dayParts(day.day);
  const empty = day.food_entries === 0 && day.sessions === 0;
  return (
    <Link
      href={`/day/${day.day}`}
      className="flex items-stretch gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-3 active:bg-zinc-900"
    >
      <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-zinc-950/70 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">{weekday}</span>
        <span className="text-xl font-semibold leading-tight tabular-nums">{date}</span>
        <span className="text-[10px] text-zinc-500">{month}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{relativeDay(day.day, today)}</span>
          <StatusPill completeness={day.completeness} />
        </div>
        {empty ? (
          <p className="mt-1 text-sm text-zinc-500">Nothing logged</p>
        ) : (
          <>
            <p className="mt-1 font-mono text-[13px] tabular-nums text-zinc-300">
              {day.food_entries > 0 ? `${round0(day.kcal)} kcal · ${round0(day.protein_g)} g protein` : "No food logged"}
            </p>
            <p className="text-[13px] text-zinc-400">
              {day.sessions > 0
                ? `${day.program_days[0] ?? "Workout"} · ${day.working_sets} sets · ${day.exercises.slice(0, 2).join(", ")}${day.exercises.length > 2 ? "…" : ""}`
                : "Rest day"}
            </p>
            {day.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-zinc-500">{day.summary}</p>}
          </>
        )}
      </div>
      <span className="self-center text-zinc-600"><Icon.chevron size={18} /></span>
    </Link>
  );
}
