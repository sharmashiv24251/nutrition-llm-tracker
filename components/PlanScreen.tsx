"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, shortDay, type PlanBrief, type Program, type TrendStatus } from "./client";
import { Card, Icon, Screen } from "./ui";

const TREND: Record<TrendStatus, { label: string; cls: string }> = {
  progressing: { label: "Progressing", cls: "bg-emerald-500/15 text-emerald-300" },
  holding: { label: "Holding", cls: "bg-sky-500/15 text-sky-300" },
  stalled: { label: "Stalled", cls: "bg-amber-500/15 text-amber-300" },
  dipping: { label: "Dipping", cls: "bg-rose-500/15 text-rose-300" },
  new: { label: "New", cls: "bg-zinc-800 text-zinc-400" },
};

export function PlanScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const [state, setState] = useState<{ program: Program | null; next: { id: string; name: string } | null } | null>(null);
  const [briefs, setBriefs] = useState<Record<string, PlanBrief>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.program()
      .then((r) => live && setState({ program: r.program, next: r.next }))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const selected = params.get("day") ?? state?.next?.id ?? state?.program?.days[0]?.id ?? null;
  const brief = selected ? briefs[selected] : undefined;

  useEffect(() => {
    if (!selected || briefs[selected]) return;
    let live = true;
    api.planDay(selected)
      .then((r) => live && setBriefs((b) => ({ ...b, [selected]: r.brief })))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [selected, briefs]);

  const program = state?.program;
  const day = program?.days.find((d) => d.id === selected);
  const isNext = state?.next?.id === selected;

  return (
    <Screen>
      <header className="sticky top-0 z-20 border-b border-zinc-800/60 bg-zinc-950/90 px-4 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <Link href="/workout" aria-label="Back" className="-ml-2 grid size-10 place-items-center rounded-full text-zinc-300 active:bg-zinc-800">
            <Icon.back />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">Plan</h1>
            {program && <p className="text-xs text-zinc-500">{program.name}</p>}
          </div>
          <Link href="/exercises" className="rounded-full border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300">Exercises</Link>
        </div>
        {program && (
          <div className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-0.5" role="tablist" aria-label="Program days">
            {program.days.map((d) => {
              const on = d.id === selected;
              return (
                <button
                  key={d.id}
                  role="tab"
                  aria-selected={on}
                  onClick={() => router.replace(`/plan?day=${d.id}`, { scroll: false })}
                  className={`relative min-h-10 shrink-0 rounded-full px-4 text-sm font-medium ${
                    on ? "bg-zinc-100 text-zinc-950" : "bg-zinc-900 text-zinc-300"
                  }`}
                >
                  {d.name}
                  {state?.next?.id === d.id && (
                    <span className={`ml-1.5 text-[10px] font-semibold uppercase ${on ? "text-emerald-700" : "text-emerald-400"}`}>next</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div className="space-y-3 px-4 pt-4">
        {error && <p className="rounded-2xl bg-red-950/60 p-3 text-sm text-red-200">{error}</p>}
        {state && !program && (
          <Card>
            <p className="text-sm text-zinc-300">No plan yet. Paste your split into Workout chat and ask the AI to save it.</p>
          </Card>
        )}
        {day && (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">{day.name}</h2>
              <p className="text-xs text-zinc-500">
                {isNext ? "Next in your rotation" : `Day ${day.order_index} of ${program?.days.length}`} · {day.exercises.length} exercises
              </p>
            </div>
            <Link
              href={`/workout?prefill=${encodeURIComponent(`Starting ${day.name}. `)}`}
              className="flex min-h-11 items-center gap-1.5 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950"
            >
              <Icon.dumbbell size={18} /> Start
            </Link>
          </div>
        )}
        {day && !brief && !error && <div className="h-64 animate-pulse rounded-3xl bg-zinc-900" aria-busy="true" />}
        {brief?.exercises.map((ex, i) => (
          <Card key={ex.program_exercise_id} className="!p-0">
            <Link href={`/exercise/${ex.exercise_id}`} className="flex items-start gap-3 px-4 pt-3.5">
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-zinc-800 text-xs text-zinc-400">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{ex.exercise}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TREND[ex.trend.status].cls}`}>
                    {TREND[ex.trend.status].label}
                  </span>
                </div>
                <p className="text-xs text-zinc-500">
                  {[ex.variation, ex.plan.note].filter(Boolean).join(" · ") || " "}
                </p>
              </div>
              <span className="mt-1 text-zinc-600"><Icon.chevron size={16} /></span>
            </Link>
            <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden border-t border-zinc-800/70 bg-zinc-800/70">
              <div className="bg-zinc-900 px-4 py-2.5">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Plan</div>
                <div className="font-mono text-sm tabular-nums">{ex.plan.sets} × {ex.plan.reps}</div>
                <div className="font-mono text-xs tabular-nums text-zinc-400">{ex.plan.weight ?? "–"}</div>
              </div>
              <div className="bg-zinc-900 px-4 py-2.5">
                <div className="text-[11px] uppercase tracking-wide text-emerald-400/80">
                  {ex.done_today.length ? "Next set" : "Next time"}
                </div>
                <div className="font-mono text-sm tabular-nums text-zinc-100">{ex.suggestion.load}</div>
                <div className="font-mono text-xs tabular-nums text-zinc-400">reps {ex.suggestion.reps}</div>
              </div>
            </div>
            <div className="space-y-1 px-4 py-3 text-xs">
              <p className="text-zinc-300">{ex.suggestion.why}</p>
              {ex.done_today.length > 0 && <p className="text-zinc-500">Today: {ex.done_today.join(" · ")}</p>}
              {ex.last_sessions[0] ? (
                <p className="text-zinc-500">
                  Last ({shortDay(ex.last_sessions[0].day)}): {ex.last_sessions[0].sets.join(" · ")}
                </p>
              ) : (
                <p className="text-zinc-500">Not logged yet.</p>
              )}
              {ex.trend.status !== "new" && <p className="text-zinc-500">{ex.trend.detail.replace(/\d{4}-\d{2}-\d{2}/g, (d) => shortDay(d))}</p>}
            </div>
          </Card>
        ))}
        {brief && (
          <p className="px-1 pb-2 text-[11px] text-zinc-500">
            Suggestions follow double progression: once every set reaches the top of the rep range, the weight goes up a
            step. Ask the trainer in Workout chat to swap or change exercises.
          </p>
        )}
      </div>
    </Screen>
  );
}
