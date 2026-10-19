"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatSet } from "@/lib/format";
import {
  api, dublinTime, longDay, relativeDay, round0, round1, shiftDay, type DayReport, type FoodRow, type SetRow,
} from "./client";
import { ConfidenceBadge } from "./Chat";
import { UndoBar } from "./Common";
import { FoodEditor, SetEditor } from "./editors";
import { Card, CardTitle, CompletenessControl, Icon, Screen, TargetBar } from "./ui";

const MEAL_LABEL: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", snack: "Snacks", dinner: "Dinner", other: "Other" };

export function DayView() {
  const { day } = useParams<{ day: string }>();
  const [state, setState] = useState<{ day: string; report: DayReport; today: string } | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"status" | "summary" | "close" | null>(null);
  const [editingFood, setEditingFood] = useState<FoodRow | null>(null);
  const [editingSet, setEditingSet] = useState<SetRow | null>(null);

  useEffect(() => {
    let live = true;
    api.day(day)
      .then((r) => live && setState({ day, ...r }))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [day, version]);

  const reload = () => setVersion((v) => v + 1);
  const run = async (kind: "status" | "summary" | "close", action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const report = state?.day === day ? state.report : null;
  const today = state?.today ?? null;
  const isToday = today === day;
  const prefill = today ? (isToday ? "" : day === shiftDay(today, -1) ? "Yesterday " : `On ${longDay(day)}, `) : "";

  return (
    <Screen>
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-zinc-800/60 bg-zinc-950/90 px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] backdrop-blur-xl">
        <Link href="/" className="flex min-h-11 items-center gap-0.5 rounded-full pl-1 pr-3 text-sm text-zinc-300 active:bg-zinc-800">
          <Icon.back size={20} /> Home
        </Link>
        <div className="min-w-0 flex-1 text-center">
          <div className="text-[11px] uppercase tracking-widest text-zinc-500">{today ? relativeDay(day, today) : "\u00a0"}</div>
          <h1 className="truncate text-[15px] font-semibold">{longDay(day)}</h1>
        </div>
        <div className="flex rounded-full bg-zinc-900">
          <Link href={`/day/${shiftDay(day, -1)}`} aria-label="Previous day" className="grid size-10 place-items-center rounded-full text-zinc-300 active:bg-zinc-800">
            <Icon.back size={18} />
          </Link>
          {today && day < today ? (
            <Link href={`/day/${shiftDay(day, 1)}`} aria-label="Next day" className="grid size-10 place-items-center rounded-full text-zinc-300 active:bg-zinc-800">
              <Icon.chevron size={18} />
            </Link>
          ) : (
            <span className="grid size-10 place-items-center text-zinc-700" aria-hidden><Icon.chevron size={18} /></span>
          )}
        </div>
      </header>

      <div className="space-y-4 px-4 pt-4">
        {error && <p className="rounded-2xl bg-red-950/60 p-3 text-sm text-red-200">{error}</p>}
        {!report && !error && <div className="h-64 animate-pulse rounded-3xl bg-zinc-900" aria-busy="true" />}
        {report && today && (
          <>
            <div>
              <CompletenessControl
                value={report.completeness}
                busy={busy === "status"}
                onChange={(c) => run("status", () => api.setCompleteness(day, c))}
              />
              <p className="mt-1.5 px-1 text-[11px] text-zinc-500">
                {report.completeness_note
                  ? `Note: ${report.completeness_note}`
                  : "Incomplete and missed days are left out of averages and charts."}
              </p>
            </div>

            <RecapCard
              report={report}
              isToday={isToday}
              busy={busy === "summary"}
              onWrite={() => run("summary", () => api.writeSummary(day))}
            />

            <FoodCard report={report} onEdit={setEditingFood} prefill={prefill} />
            <TrainingCard report={report} onEdit={setEditingSet} prefill={prefill} />

            {report.bodyweight.length > 0 && (
              <Card className="flex items-center gap-3">
                <Icon.scale />
                <span className="text-sm text-zinc-300">Bodyweight</span>
                <span className="ml-auto font-mono tabular-nums">
                  {report.bodyweight.map((b) => `${round1(b.kg)} kg`).join(" · ")}
                </span>
              </Card>
            )}

            <UndoBar version={version} onUndone={reload} />

            {report.status === "open" && !isToday && (
              <button
                disabled={busy === "close"}
                onClick={() => run("close", () => api.endDay(day))}
                className="min-h-12 w-full rounded-2xl border border-zinc-800 text-sm font-medium text-zinc-300 disabled:opacity-50"
              >
                Close this day
              </button>
            )}
          </>
        )}
      </div>

      {editingFood && (
        <FoodEditor row={editingFood} onClose={() => setEditingFood(null)} onSaved={() => { setEditingFood(null); reload(); }} />
      )}
      {editingSet && (
        <SetEditor set={editingSet} onClose={() => setEditingSet(null)} onSaved={() => { setEditingSet(null); reload(); }} />
      )}
    </Screen>
  );
}

function RecapCard({ report, isToday, busy, onWrite }: { report: DayReport; isToday: boolean; busy: boolean; onWrite: () => void }) {
  const s = report.summary;
  return (
    <Card className="bg-gradient-to-b from-zinc-900 to-zinc-900/60">
      <CardTitle right={<span className="text-sky-300"><Icon.sparkle size={18} /></span>}>Day recap</CardTitle>
      {s ? (
        <>
          <p className="whitespace-pre-line text-[15px] leading-relaxed text-zinc-100">{s.prose}</p>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-500">
            <span>Written {s.source === "cron" ? "overnight" : "on request"} · {dublinTime(s.generated_at)}</span>
            <button onClick={onWrite} disabled={busy} className="ml-auto min-h-9 rounded-full px-3 text-xs text-zinc-300 active:bg-zinc-800 disabled:opacity-50">
              {busy ? "Writing…" : "Rewrite"}
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <p className="flex-1 text-sm text-zinc-400">
            {isToday ? "Your recap is written after the day ends, early tomorrow morning." : "No recap for this day yet."}
          </p>
          <button onClick={onWrite} disabled={busy}
            className="min-h-10 shrink-0 rounded-full bg-zinc-800 px-4 text-sm font-medium disabled:opacity-50">
            {busy ? "Writing…" : isToday ? "Write now" : "Write recap"}
          </button>
        </div>
      )}
    </Card>
  );
}

function FoodCard({ report, onEdit, prefill }: { report: DayReport; onEdit: (f: FoodRow) => void; prefill: string }) {
  const n = report.nutrition;
  const t = n.targets;
  return (
    <Card>
      <CardTitle right={<span className="font-mono text-sm tabular-nums text-zinc-300">{round0(n.totals.kcal)} kcal</span>}>
        Food
      </CardTitle>
      <div className="space-y-3">
        <TargetBar label="Calories" value={n.totals.kcal} target={t?.kcal} unit="" kind="ceiling" />
        <TargetBar label="Protein" value={n.totals.protein_g} target={t?.protein_g} unit=" g" kind="floor" />
        <TargetBar label="Fibre" value={n.totals.fibre_g} target={t?.fibre_g} unit=" g" kind="floor" />
      </div>
      <div className="mt-3 flex gap-2 text-xs">
        <span className="rounded-full bg-zinc-950/70 px-2.5 py-1 text-zinc-400">Carbs <b className="font-mono font-medium text-zinc-200">{round0(n.totals.carbs_g)} g</b></span>
        <span className="rounded-full bg-zinc-950/70 px-2.5 py-1 text-zinc-400">Fat <b className="font-mono font-medium text-zinc-200">{round0(n.totals.fat_g)} g</b></span>
      </div>

      {report.meals.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">No food logged.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {report.meals.map((m) => (
            <div key={m.meal}>
              <div className="mb-1 flex items-baseline text-xs text-zinc-500">
                <span className="font-semibold uppercase tracking-wider">{MEAL_LABEL[m.meal] ?? m.meal}</span>
                <span className="ml-auto font-mono tabular-nums">{round0(m.kcal)} kcal · {round0(m.protein_g)} g P</span>
              </div>
              <ul className="divide-y divide-zinc-800/70 overflow-hidden rounded-2xl bg-zinc-950/50">
                {m.items.map((f) => (
                  <li key={f.id}>
                    <button onClick={() => onEdit(f)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left active:bg-zinc-800/60">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[15px]">{f.display_name}</span>
                          <ConfidenceBadge c={f.confidence} />
                        </div>
                        <div className="text-xs text-zinc-500">
                          {dublinTime(f.eaten_at)} · {f.grams != null ? `${round1(f.grams)} g` : `${round1(f.quantity)} ${f.unit ?? ""}`}
                          {f.assumptions ? ` · ${f.assumptions}` : ""}
                        </div>
                      </div>
                      <div className="text-right font-mono text-sm tabular-nums">
                        <div>{round0(f.kcal)}</div>
                        <div className="text-[11px] text-zinc-500">{round1(f.protein_g)} P</div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <Link href={`/food?prefill=${encodeURIComponent(prefill ? `${prefill}I also had ` : "")}`}
        className="mt-3 flex min-h-11 items-center justify-center gap-1.5 rounded-2xl text-sm text-zinc-300 active:bg-zinc-800">
        <Icon.plus size={18} /> Add food to this day
      </Link>
    </Card>
  );
}

function TrainingCard({ report, onEdit, prefill }: { report: DayReport; onEdit: (s: SetRow) => void; prefill: string }) {
  return (
    <Card>
      <CardTitle
        right={report.workouts.length > 0 && (
          <span className="text-sm text-zinc-300">{report.workouts.reduce((n, w) => n + w.total_sets, 0)} sets</span>
        )}
      >
        Training
      </CardTitle>
      {report.workouts.length === 0 && <p className="text-sm text-zinc-500">No workout logged. Rest day?</p>}
      <div className="space-y-4">
        {report.workouts.map(({ session, exercises }) => (
          <div key={session.id}>
            <div className="mb-2 flex items-baseline gap-2 text-xs text-zinc-500">
              <span className="font-semibold uppercase tracking-wider">{session.program_day ?? "Workout"}</span>
              <span className="ml-auto">
                {dublinTime(session.started_at)}{session.ended_at ? `–${dublinTime(session.ended_at)}` : " · in progress"}
              </span>
            </div>
            <div className="space-y-2">
              {exercises.map((ex) => {
                const prev = report.previous_top_sets[ex.exercise_id];
                return (
                  <div key={ex.exercise_id} className="overflow-hidden rounded-2xl bg-zinc-950/50">
                    <Link href={`/exercise/${ex.exercise_id}`} className="flex min-h-11 items-center px-3 pt-1">
                      <span className="font-medium">{ex.name}</span>
                      <span className="ml-auto flex items-center text-xs text-zinc-500">Progress <Icon.chevron size={14} /></span>
                    </Link>
                    {prev && (
                      <p className="px-3 pb-1 text-[11px] text-zinc-500">
                        Last time ({relativeDay(prev.day, report.day)}): {formatSet(prev)}
                      </p>
                    )}
                    <ul>
                      {ex.sets.map((s) => (
                        <li key={s.id}>
                          <button onClick={() => onEdit({ ...s, exercise: ex.name })}
                            className="flex min-h-11 w-full items-center gap-3 px-3 text-left font-mono text-[15px] tabular-nums active:bg-zinc-800/60">
                            <span className="w-5 text-zinc-600">{s.set_index}</span>
                            <span className="flex-1">{formatSet(s)}</span>
                            {s.variation && <span className="max-w-[40%] truncate font-sans text-xs text-zinc-500">{s.variation}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <Link href={`/workout?prefill=${encodeURIComponent(prefill)}`}
        className="mt-3 flex min-h-11 items-center justify-center gap-1.5 rounded-2xl text-sm text-zinc-300 active:bg-zinc-800">
        <Icon.plus size={18} /> Add sets to this day
      </Link>
    </Card>
  );
}
