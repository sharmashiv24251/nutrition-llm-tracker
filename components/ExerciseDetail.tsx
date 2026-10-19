"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatSet } from "@/lib/format";
import { api, LOAD_TYPE_LABEL, type ExerciseHistory } from "./client";
import { ExerciseEditor } from "./ExerciseEditor";
import { LineChart } from "./LineChart";
import { Card, CardTitle, Icon, Screen } from "./ui";

const RANGES = [8, 26, 52, 260] as const;

export function ExerciseDetail() {
  const { id } = useParams<{ id: string }>();
  const [weeks, setWeeks] = useState<number>(26);
  const [data, setData] = useState<{ weeks: number; history: ExerciseHistory } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    api.exercise(id, weeks)
      .then((h) => live && setData({ weeks, history: h }))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [id, weeks, version]);

  const history = data?.weeks === weeks ? data.history : null;
  const ex = history?.exercise ?? data?.history.exercise ?? null;
  // Oldest first for the charts.
  const sessions = [...(history?.sessions ?? [])].reverse();
  const assisted = sessions.some((s) => s.top_set.load_type === "assisted");
  const sel = selected != null && selected < sessions.length ? selected : sessions.length - 1;

  return (
    <Screen>
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-zinc-800/60 bg-zinc-950/90 px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] backdrop-blur-xl">
        <Link href="/exercises" className="flex min-h-11 items-center gap-0.5 rounded-full pl-1 pr-3 text-sm text-zinc-300 active:bg-zinc-800">
          <Icon.back size={20} /> Exercises
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold">{ex?.name ?? "\u00a0"}</h1>
        <button onClick={() => setEditing(true)} disabled={!ex}
          className="min-h-10 rounded-full px-4 text-sm text-zinc-200 active:bg-zinc-800 disabled:opacity-40">
          Edit
        </button>
      </header>
      <div className="space-y-5 px-4 pt-4">
        {ex && (
          <Card>
            <CardTitle>About</CardTitle>
            {ex.notes ? (
              <p className="whitespace-pre-line text-[15px] leading-relaxed text-zinc-100">{ex.notes}</p>
            ) : (
              <button onClick={() => setEditing(true)} className="text-left text-sm text-zinc-400 underline-offset-2 active:underline">
                Add notes on how you do it: machine, seat setting, grip, range of motion…
              </button>
            )}
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-zinc-500">Weight</dt>
              <dd className="text-zinc-200">{LOAD_TYPE_LABEL[ex.default_load_type]}</dd>
              {ex.equipment && (<><dt className="text-zinc-500">Equipment</dt><dd className="text-zinc-200">{ex.equipment}</dd></>)}
              {ex.aliases.length > 0 && (
                <>
                  <dt className="text-zinc-500">Also called</dt>
                  <dd className="flex flex-wrap gap-1">
                    {ex.aliases.map((a) => <span key={a} className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{a}</span>)}
                  </dd>
                </>
              )}
            </dl>
          </Card>
        )}
        <h2 className="px-1 pt-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-400">Progress</h2>
        <div className="flex gap-1 rounded-lg bg-zinc-900 p-0.5 text-sm" role="group" aria-label="Range">
          {RANGES.map((w) => (
            <button
              key={w}
              onClick={() => { setWeeks(w); setSelected(null); }}
              className={`min-h-9 flex-1 rounded-md ${w === weeks ? "bg-zinc-700 text-white" : "text-zinc-400"}`}
            >
              {w === 260 ? "All" : `${w}w`}
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!history && !error && <p className="py-10 text-center text-sm text-zinc-500">Loading…</p>}
        {history && sessions.length === 0 && (
          <p className="py-10 text-center text-sm text-zinc-500">No sessions in this range.</p>
        )}
        {sessions.length > 0 && (
          <>
            <LineChart
              title={assisted ? "Top set assistance (kg, lower is harder)" : "Top set load (kg)"}
              points={sessions.map((s) => ({ label: s.day, value: Number(s.top_set.load_kg ?? 0) }))}
              unit=" kg"
              selected={sel}
              onSelect={setSelected}
            />
            <LineChart
              title="Top set reps (full)"
              points={sessions.map((s) => ({ label: s.day, value: s.top_set.full_reps }))}
              unit=""
              height={120}
              selected={sel}
              onSelect={setSelected}
            />
            <SessionDetail session={sessions[sel]} />
            <table className="w-full text-left text-sm">
              <caption className="mb-1 text-left text-sm font-medium text-zinc-300">All sessions</caption>
              <thead className="text-xs text-zinc-500">
                <tr><th className="py-1 font-normal">Day</th><th className="font-normal">Top set</th><th className="text-right font-normal">Sets</th></tr>
              </thead>
              <tbody>
                {[...sessions].reverse().map((s) => (
                  <tr
                    key={s.session_id}
                    className={`cursor-pointer border-t border-zinc-800 ${s === sessions[sel] ? "bg-zinc-900" : ""}`}
                    onClick={() => setSelected(sessions.indexOf(s))}
                  >
                    <td className="py-2 text-zinc-400">{s.day}</td>
                    <td className="font-mono">{formatSet(s.top_set)}</td>
                    <td className="text-right text-zinc-400">{s.sets.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {editing && ex && (
        <ExerciseEditor exercise={ex} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setVersion((v) => v + 1); }} />
      )}
    </Screen>
  );
}

function SessionDetail({ session }: { session: ExerciseHistory["sessions"][number] | undefined }) {
  if (!session) return null;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
      <div className="mb-1 text-zinc-400">
        {session.day}{session.program_day ? ` · ${session.program_day}` : ""}
      </div>
      {session.sets.map((s) => (
        <div key={s.id} className="flex gap-3 font-mono">
          <span className="w-5 text-zinc-500">{s.set_index}</span>
          <span className="flex-1">{formatSet(s)}</span>
          {s.variation && <span className="truncate font-sans text-xs text-zinc-500">{s.variation}</span>}
        </div>
      ))}
    </div>
  );
}
