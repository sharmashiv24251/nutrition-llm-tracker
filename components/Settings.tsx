"use client";
import { useEffect, useState } from "react";
import { api, type SettingsData } from "./client";
import { PageHeader } from "./Header";
import { Field, inputClass, Sheet } from "./Sheet";

type FieldSpec = { key: string; label: string; type: "number" | "text" | "date" | "datetime" | "list"; optional?: boolean };

const TARGET_FIELDS: FieldSpec[] = [
  { key: "effective_from", label: "Effective from", type: "date" },
  { key: "kcal", label: "kcal (ceiling)", type: "number" },
  { key: "protein_g", label: "Protein g (floor)", type: "number" },
  { key: "fibre_g", label: "Fibre g (floor)", type: "number" },
  { key: "carbs_g", label: "Carbs g (optional)", type: "number", optional: true },
  { key: "fat_g", label: "Fat g (optional)", type: "number", optional: true },
];
const UNIT_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", type: "text" },
  { key: "default_g", label: "Grams per unit", type: "number" },
  { key: "aliases", label: "Aliases (comma separated)", type: "list" },
];
const PRICING_FIELDS: FieldSpec[] = [
  { key: "model", label: "Model", type: "text" },
  { key: "effective_from", label: "Effective from", type: "datetime" },
  { key: "input_per_m", label: "Input $ / 1M tokens", type: "number" },
  { key: "output_per_m", label: "Output $ / 1M (incl. thinking)", type: "number" },
  { key: "cached_per_m", label: "Cached input $ / 1M", type: "number" },
  { key: "search_per_1k", label: "Search $ / 1k queries", type: "number" },
];

type Editing = { table: string; title: string; fields: FieldSpec[]; row: Record<string, unknown>; id?: string };

const todayDublin = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date());

export function Settings() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.settings()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [version]);

  const reload = () => setVersion((v) => v + 1);
  const current = data?.targets.find((t) => t.effective_from <= todayDublin());

  return (
    <div className="mx-auto min-h-dvh max-w-md pb-12">
      <PageHeader title="Settings" />
      <div className="space-y-7 px-3 pt-4">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!data && !error && <p className="py-10 text-center text-sm text-zinc-500">Loading…</p>}
        {data && (
          <>
            <Section
              title="Nutrition targets"
              action={() => setEditing({
                table: "trk_targets", title: "New targets", fields: TARGET_FIELDS,
                row: { ...current, effective_from: todayDublin() },
              })}
            >
              {data.targets.map((t) => (
                <Row
                  key={t.id}
                  onClick={() => setEditing({ table: "trk_targets", title: `Targets from ${t.effective_from}`, fields: TARGET_FIELDS, row: t, id: t.id })}
                  left={<>{t.effective_from}{t === current && <span className="ml-2 text-xs text-emerald-400">current</span>}</>}
                  right={`${t.kcal} kcal · ${t.protein_g}+ P · ${t.fibre_g}+ fibre`}
                />
              ))}
              {data.targets.length === 0 && <p className="text-sm text-zinc-500">No targets yet.</p>}
            </Section>

            {data.settings && (
              <Section title="Day cutoff">
                <div className="flex items-end gap-2">
                  <Field label="A new day starts at (hour, Dublin time)">
                    <input
                      inputMode="numeric"
                      className={inputClass}
                      value={cutoff ?? String(data.settings.day_cutoff_hour)}
                      onChange={(e) => setCutoff(e.target.value)}
                    />
                  </Field>
                  <button
                    className="min-h-11 rounded-lg bg-zinc-100 px-4 font-semibold text-zinc-950 disabled:opacity-40"
                    disabled={cutoff == null || Number(cutoff) === data.settings.day_cutoff_hour}
                    onClick={async () => {
                      try {
                        await api.editSetting("trk_settings", data.settings!.id, { day_cutoff_hour: Math.round(Number(cutoff)) });
                        setCutoff(null);
                        reload();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
                <p className="mt-1 text-xs text-zinc-500">Anything logged before this hour counts as the previous day.</p>
              </Section>
            )}

            <Section
              title="Household units"
              action={() => setEditing({ table: "trk_household_units", title: "New unit", fields: UNIT_FIELDS, row: { aliases: [] } })}
            >
              {data.units.map((u) => (
                <Row
                  key={u.id}
                  onClick={() => setEditing({ table: "trk_household_units", title: u.name, fields: UNIT_FIELDS, row: u, id: u.id })}
                  left={u.name}
                  right={`${Number(u.default_g)} g${u.aliases.length ? ` · ${u.aliases.slice(0, 3).join(", ")}` : ""}`}
                />
              ))}
            </Section>

            <Section
              title="Gemini pricing"
              action={() => setEditing({
                table: "trk_pricing", title: "New price row", fields: PRICING_FIELDS,
                row: { ...data.pricing[0], effective_from: new Date().toISOString() },
              })}
            >
              {data.pricing.map((p) => (
                <Row
                  key={p.id}
                  onClick={() => setEditing({ table: "trk_pricing", title: `${p.model} pricing`, fields: PRICING_FIELDS, row: p, id: p.id })}
                  left={<>{p.model}<span className="block text-xs text-zinc-500">from {p.effective_from.slice(0, 10)}</span></>}
                  right={`in $${Number(p.input_per_m)} · out $${Number(p.output_per_m)} · search $${Number(p.search_per_1k)}/1k`}
                />
              ))}
            </Section>
          </>
        )}
      </div>
      {editing && (
        <RowEditor
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: () => void; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center">
        <h2 className="text-sm font-semibold text-zinc-300">{title}</h2>
        {action && (
          <button className="ml-auto min-h-9 rounded-lg bg-zinc-800 px-3 text-sm" onClick={action}>
            Add
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Row({ left, right, onClick }: { left: React.ReactNode; right: string; onClick: () => void }) {
  return (
    <button
      className="flex min-h-12 w-full items-center gap-3 border-b border-zinc-800 py-2 text-left text-sm active:bg-zinc-900"
      onClick={onClick}
    >
      <span className="min-w-0 shrink-0">{left}</span>
      <span className="ml-auto truncate text-right font-mono text-xs text-zinc-400">{right}</span>
    </button>
  );
}

function toInput(v: unknown, type: FieldSpec["type"]): string {
  if (v == null) return "";
  if (type === "list") return (v as string[]).join(", ");
  if (type === "datetime") return String(v).slice(0, 16);
  return String(type === "number" ? Number(v) : v);
}

function fromInput(s: string, f: FieldSpec): unknown {
  if (f.type === "number") return s.trim() === "" ? (f.optional ? null : NaN) : Number(s);
  if (f.type === "list") return s.split(",").map((x) => x.trim()).filter(Boolean);
  if (f.type === "datetime") return new Date(s).toISOString();
  return s.trim();
}

function RowEditor({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: () => void }) {
  const initial = Object.fromEntries(editing.fields.map((f) => [f.key, toInput(editing.row[f.key], f.type)]));
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const values: Record<string, unknown> = {};
    for (const f of editing.fields) {
      if (editing.id && form[f.key] === initial[f.key]) continue; // edits send only what changed
      const v = fromInput(form[f.key], f);
      if (typeof v === "number" && Number.isNaN(v)) return setError(`${f.label} is required`);
      values[f.key] = v;
    }
    if (editing.id && !Object.keys(values).length) return onClose();
    setBusy(true);
    setError(null);
    try {
      if (editing.id) await api.editSetting(editing.table, editing.id, values);
      else await api.addSetting(editing.table, values);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title={editing.title} onClose={onClose}>
      <div className="grid max-h-[60dvh] grid-cols-2 gap-3 overflow-y-auto">
        {editing.fields.map((f) => (
          <div key={f.key} className={f.type === "text" || f.type === "list" || f.type === "datetime" ? "col-span-2" : ""}>
            <Field label={f.label}>
              <input
                className={inputClass}
                type={f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : "text"}
                inputMode={f.type === "number" ? "decimal" : undefined}
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </Field>
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <button
        disabled={busy}
        className="mt-4 min-h-12 w-full rounded-xl bg-zinc-100 font-semibold text-zinc-950 disabled:opacity-50"
        onClick={save}
      >
        {busy ? "Saving…" : editing.id ? "Save" : "Add"}
      </button>
    </Sheet>
  );
}
