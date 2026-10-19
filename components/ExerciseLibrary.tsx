"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { normalize } from "@/lib/fuzzy";
import { api, LOAD_TYPE_LABEL, shortDay, type LibraryExercise } from "./client";
import { ExerciseEditor } from "./ExerciseEditor";
import { inputClass } from "./Sheet";
import { Icon, Screen } from "./ui";

export function ExerciseLibrary() {
  const router = useRouter();
  const [list, setList] = useState<LibraryExercise[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    api.exercises()
      .then((r) => live && setList(r.exercises))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const q = normalize(query);
  const shown = (list ?? []).filter((e) =>
    !q || [e.name, ...e.aliases, e.equipment ?? "", e.notes ?? ""].some((t) => normalize(t).includes(q)));

  return (
    <Screen>
      <header className="sticky top-0 z-20 border-b border-zinc-800/60 bg-zinc-950/90 px-4 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <Link href="/workout" aria-label="Back" className="-ml-2 grid size-10 place-items-center rounded-full text-zinc-300 active:bg-zinc-800">
            <Icon.back />
          </Link>
          <h1 className="flex-1 text-xl font-semibold tracking-tight">Exercises</h1>
          <button onClick={() => setAdding(true)}
            className="flex min-h-10 items-center gap-1 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950">
            <Icon.plus size={18} /> Add
          </button>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, other names or notes"
          className={`${inputClass} mt-3 rounded-full px-4`}
        />
      </header>

      <div className="px-4 pt-3">
        {error && <p className="rounded-2xl bg-red-950/60 p-3 text-sm text-red-200">{error}</p>}
        {!list && !error && <div className="h-40 animate-pulse rounded-3xl bg-zinc-900" aria-busy="true" />}
        {list && shown.length === 0 && (
          <p className="py-10 text-center text-sm text-zinc-500">
            {query ? "No exercise matches that." : "No exercises yet."}
          </p>
        )}
        <ul className="space-y-2">
          {shown.map((e) => (
            <li key={e.id}>
              <Link href={`/exercise/${e.id}`}
                className="flex items-center gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-3.5 active:bg-zinc-900">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{e.name}</div>
                  <div className="text-xs text-zinc-500">
                    {LOAD_TYPE_LABEL[e.default_load_type]}{e.equipment ? ` · ${e.equipment}` : ""}
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {e.last_day
                      ? `Last ${shortDay(e.last_day)} · ${e.sessions} ${e.sessions === 1 ? "session" : "sessions"} · ${e.working_sets} sets`
                      : "Not logged yet"}
                  </div>
                  {e.notes && <p className="mt-1 line-clamp-1 text-xs italic text-zinc-500">{e.notes}</p>}
                </div>
                <span className="text-zinc-600"><Icon.chevron size={18} /></span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-4 px-1 text-[11px] text-zinc-500">
          You can also tell the AI in Workout chat, e.g. &ldquo;I do machine rows on the Hammer Strength, seat 4&rdquo;
          or &ldquo;rename lat pulldown to wide-grip pulldown&rdquo;.
        </p>
      </div>

      {adding && (
        <ExerciseEditor exercise={null} onClose={() => setAdding(false)} onSaved={(id) => router.push(`/exercise/${id}`)} />
      )}
    </Screen>
  );
}
