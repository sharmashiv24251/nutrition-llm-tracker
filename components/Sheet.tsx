"use client";
import { useEffect } from "react";

/** Bottom sheet for editing one row. Tapping the backdrop or Escape closes it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <button className="absolute inset-0 bg-black/60" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-2xl border-t border-zinc-800 bg-zinc-900 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-700" />
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}

export const inputClass =
  "min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-zinc-400";
