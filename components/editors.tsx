"use client";
// Bottom-sheet editors for one logged row. Saves go straight to the database through /api/entries
// (no LLM) and land in the edit log, so Undo can revert them.
import { useState } from "react";
import { type LoadType } from "@/lib/format";
import { LOAD_TYPES, MEALS } from "@/lib/schemas";
import { api, type FoodRow, type SetRow } from "./client";
import { Field, inputClass, Sheet } from "./Sheet";

const fmt = (n: number | null | undefined) => (n == null ? "–" : String(Math.round(Number(n) * 10) / 10));

export function SetEditor({ set, onClose, onSaved }: { set: SetRow; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    load_kg: set.load_kg == null ? "" : String(Number(set.load_kg)),
    load_type: set.load_type,
    full_reps: String(set.full_reps),
    partial_reps: String(set.partial_reps),
    rest_pause_reps: String(set.rest_pause_reps),
    rpe: set.rpe == null ? "" : String(Number(set.rpe)),
    is_warmup: set.is_warmup,
    variation: set.variation ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const int = (v: string) => Math.max(0, Math.round(Number(v) || 0));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const save = () => run(() => api.editEntry("trk_sets", set.id, {
    load_kg: num(f.load_kg), load_type: f.load_type, full_reps: int(f.full_reps), partial_reps: int(f.partial_reps),
    rest_pause_reps: int(f.rest_pause_reps), rpe: num(f.rpe), is_warmup: f.is_warmup, variation: f.variation.trim() || null,
  }));

  return (
    <Sheet title={`${set.exercise} · set ${set.set_index}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Load (kg)">
          <input inputMode="decimal" className={inputClass} value={f.load_kg} onChange={(e) => setF({ ...f, load_kg: e.target.value })} />
        </Field>
        <Field label="Load type">
          <select className={inputClass} value={f.load_type} onChange={(e) => setF({ ...f, load_type: e.target.value as LoadType })}>
            {LOAD_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </select>
        </Field>
        <Field label="Full reps">
          <input inputMode="numeric" className={inputClass} value={f.full_reps} onChange={(e) => setF({ ...f, full_reps: e.target.value })} />
        </Field>
        <Field label="Partial reps">
          <input inputMode="numeric" className={inputClass} value={f.partial_reps} onChange={(e) => setF({ ...f, partial_reps: e.target.value })} />
        </Field>
        <Field label="Rest-pause reps">
          <input inputMode="numeric" className={inputClass} value={f.rest_pause_reps} onChange={(e) => setF({ ...f, rest_pause_reps: e.target.value })} />
        </Field>
        <Field label="RPE">
          <input inputMode="decimal" className={inputClass} value={f.rpe} onChange={(e) => setF({ ...f, rpe: e.target.value })} />
        </Field>
        <Field label="Variation">
          <input className={inputClass} value={f.variation} onChange={(e) => setF({ ...f, variation: e.target.value })} />
        </Field>
        <label className="flex min-h-11 items-center gap-2 self-end text-sm">
          <input type="checkbox" className="size-5" checked={f.is_warmup} onChange={(e) => setF({ ...f, is_warmup: e.target.checked })} />
          Warm-up
        </label>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button
          disabled={busy}
          className="min-h-12 rounded-xl border border-red-900 px-4 text-red-300 disabled:opacity-50"
          onClick={() => confirm("Delete this set?") && run(() => api.deleteEntry("trk_sets", set.id))}
        >
          Delete
        </button>
        <button disabled={busy} className="min-h-12 flex-1 rounded-xl bg-zinc-100 font-semibold text-zinc-950 disabled:opacity-50" onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Sheet>
  );
}

export const MACROS = ["kcal", "protein_g", "carbs_g", "fat_g", "fibre_g"] as const;

export function FoodEditor({ row, onClose, onSaved }: { row: FoodRow; onClose: () => void; onSaved: () => void }) {
  const initial = {
    display_name: row.display_name,
    meal: row.meal,
    grams: row.grams == null ? "" : fmt(row.grams),
    ...Object.fromEntries(MACROS.map((k) => [k, fmt(row[k])])),
  } as Record<string, string>;
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // Only changed fields are sent, so changing just the grams rescales the macros on the server.
  const save = () => run(() => {
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(f)) {
      if (f[k] === initial[k]) continue;
      if (k === "display_name" || k === "meal") changed[k] = f[k];
      else changed[k] = f[k].trim() === "" ? (k === "grams" ? null : 0) : Number(f[k]);
    }
    if (!Object.keys(changed).length) return Promise.resolve();
    return api.editEntry("trk_food_entries", row.id, changed);
  });

  const num = (k: string, label: string) => (
    <Field label={label}>
      <input inputMode="decimal" className={inputClass} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );

  return (
    <Sheet title={row.display_name} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="Name">
            <input className={inputClass} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
          </Field>
        </div>
        <Field label="Meal">
          <select className={inputClass} value={f.meal} onChange={(e) => setF({ ...f, meal: e.target.value })}>
            {MEALS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        {num("grams", "Grams")}
        {num("kcal", "kcal")}
        {num("protein_g", "Protein g")}
        {num("carbs_g", "Carbs g")}
        {num("fat_g", "Fat g")}
        {num("fibre_g", "Fibre g")}
      </div>
      <p className="mt-2 text-xs text-zinc-500">Change only the grams and the macros scale with it.</p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button
          disabled={busy}
          className="min-h-12 rounded-xl border border-red-900 px-4 text-red-300 disabled:opacity-50"
          onClick={() => confirm("Delete this entry?") && run(() => api.deleteEntry("trk_food_entries", row.id))}
        >
          Delete
        </button>
        <button disabled={busy} className="min-h-12 flex-1 rounded-xl bg-zinc-100 font-semibold text-zinc-950 disabled:opacity-50" onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Sheet>
  );
}
