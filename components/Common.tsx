"use client";
import { useEffect, useState } from "react";
import { api, describeEdit, type Edit } from "./client";

/** Shows the most recent edit or delete and reverts it on tap. `version` refetches after changes. */
export function UndoBar({ version, onUndone }: { version: number; onUndone: () => void }) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.lastEdit().then((r) => live && setEdit(r.edit)).catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);

  if (!edit) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate text-zinc-400" title={describeEdit(edit)}>
        Last: {describeEdit(edit)}
      </span>
      {error && <span className="text-red-400">{error}</span>}
      <button
        disabled={busy}
        className="min-h-10 shrink-0 rounded-lg bg-zinc-800 px-3 font-medium disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.undo(edit.id);
            onUndone();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Undo
      </button>
    </div>
  );
}

/** "Yesterday isn't closed. Anything missing?" with buttons to add something or close it. */
export function OpenDayBanner({ day, onAdd, onClosed }: { day: string; onAdd: () => void; onClosed: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="border-b border-amber-900/60 bg-amber-950/40 px-3 py-2.5 text-sm">
      <p className="text-amber-100">Yesterday isn&apos;t closed. Anything missing?</p>
      <div className="mt-2 flex gap-2">
        <button className="min-h-10 flex-1 rounded-lg bg-zinc-800 font-medium" onClick={onAdd}>
          Add something
        </button>
        <button
          disabled={busy}
          className="min-h-10 flex-1 rounded-lg bg-amber-700 font-medium text-white disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            try {
              await api.endDay(day);
              onClosed();
            } finally {
              setBusy(false);
            }
          }}
        >
          Close it
        </button>
      </div>
    </div>
  );
}
