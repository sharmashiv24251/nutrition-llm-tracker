"use client";
// Add or edit an exercise: name, load type, equipment, aliases, and free-text notes on how I do it.
import Link from "next/link";
import { useState } from "react";
import type { LoadType } from "@/lib/format";
import { LOAD_TYPES } from "@/lib/schemas";
import { api, ApiError, LOAD_TYPE_LABEL, type ExerciseFields } from "./client";
import { Field, inputClass, Sheet } from "./Sheet";

type Existing = ExerciseFields & { id: string };
type CloseMatch = { id: string; name: string; score: number };

export function ExerciseEditor({
  exercise, onClose, onSaved,
}: {
  exercise: Existing | null; // null = new exercise
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState({
    name: exercise?.name ?? "",
    default_load_type: (exercise?.default_load_type ?? "total") as LoadType,
    equipment: exercise?.equipment ?? "",
    aliases: (exercise?.aliases ?? []).join(", "),
    notes: exercise?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<CloseMatch[] | null>(null);

  const values = (): ExerciseFields => ({
    name: f.name.trim(),
    default_load_type: f.default_load_type,
    equipment: f.equipment.trim() || null,
    aliases: f.aliases.split(",").map((a) => a.trim()).filter(Boolean),
    notes: f.notes.trim() || null,
  });

  async function save(distinctFrom?: string) {
    const v = values();
    if (!v.name) return setError("Give it a name");
    setBusy(true);
    setError(null);
    try {
      if (exercise) {
        // send only what changed, so the edit log shows exactly what was edited
        const changed = Object.fromEntries(
          Object.entries(v).filter(([k, val]) => JSON.stringify(val) !== JSON.stringify(exercise[k as keyof Existing] ?? null)),
        );
        if (Object.keys(changed).length) await api.updateExercise(exercise.id, changed);
        onSaved(exercise.id);
      } else {
        const res = await api.createExercise({ ...v, distinct_from: distinctFrom });
        onSaved(res.exercise.id);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSimilar((e.body as { existing: CloseMatch[] }).existing);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }
  }

  return (
    <Sheet title={exercise ? `Edit ${exercise.name}` : "New exercise"} onClose={onClose}>
      <div className="max-h-[65dvh] space-y-3 overflow-y-auto pb-1">
        <Field label="Name">
          <input className={inputClass} value={f.name} autoFocus={!exercise} placeholder="e.g. Incline dumbbell press"
            onChange={(e) => { setF({ ...f, name: e.target.value }); setSimilar(null); }} />
        </Field>
        <Field label="How the weight is counted">
          <select className={inputClass} value={f.default_load_type}
            onChange={(e) => setF({ ...f, default_load_type: e.target.value as LoadType })}>
            {LOAD_TYPES.map((t) => <option key={t} value={t}>{LOAD_TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        <Field label="Equipment (optional)">
          <input className={inputClass} value={f.equipment} placeholder="e.g. Hammer Strength plate-loaded"
            onChange={(e) => setF({ ...f, equipment: e.target.value })} />
        </Field>
        <Field label="Other names you use (comma separated)">
          <input className={inputClass} value={f.aliases} placeholder="e.g. incline db press, incline press"
            onChange={(e) => setF({ ...f, aliases: e.target.value })} />
        </Field>
        <Field label="How you do it">
          <textarea
            rows={5}
            className={`${inputClass} min-h-28 resize-y py-2.5 leading-relaxed`}
            value={f.notes}
            maxLength={2000}
            placeholder="Machine, seat or pin setting, grip, range of motion, tempo, cues…"
            onChange={(e) => setF({ ...f, notes: e.target.value })}
          />
        </Field>
        {exercise && f.name.trim() && f.name.trim() !== exercise.name && (
          <p className="text-xs text-zinc-500">Renaming keeps all history. &ldquo;{exercise.name}&rdquo; stays as another name.</p>
        )}
      </div>

      {similar && (
        <div className="mt-3 rounded-xl border border-amber-800/60 bg-amber-950/40 p-3 text-sm">
          <p className="text-amber-100">This looks like an exercise you already have:</p>
          <ul className="mt-1.5 space-y-1">
            {similar.map((m) => (
              <li key={m.id}>
                <Link href={`/exercise/${m.id}`} className="font-medium underline underline-offset-2">{m.name}</Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-400">Log grip or stance differences as a variation instead of a new exercise.</p>
          <button disabled={busy} onClick={() => save(similar[0].id)}
            className="mt-2 min-h-10 rounded-lg bg-zinc-800 px-3 text-sm disabled:opacity-50">
            It&apos;s different, create it anyway
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <button
        disabled={busy}
        onClick={() => save()}
        className="mt-4 min-h-12 w-full rounded-xl bg-zinc-100 font-semibold text-zinc-950 disabled:opacity-50"
      >
        {busy ? "Saving…" : exercise ? "Save" : "Add exercise"}
      </button>
    </Sheet>
  );
}
