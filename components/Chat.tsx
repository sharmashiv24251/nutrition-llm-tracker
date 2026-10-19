"use client";
import { useEffect, useRef, useState } from "react";
import { formatSet } from "@/lib/format";
import { newId, sendChat, usd, type FoodRow, type Mode, type SetRow, type Spend, type Turn } from "./client";
import { preparePhoto, type PreparedPhoto } from "./photo";

/** preview is an object URL shown instantly; ready resolves once the browser has shrunk the photo. */
type Photo = { preview: string; ready: Promise<PreparedPhoto> };
type Pending = { client_message_id: string; text: string; photo: Photo | null; state: "sending" | "failed"; error?: string };

export function Chat({
  mode, turns, onTurn, placeholder, initialText = "",
}: {
  mode: Mode;
  turns: Turn[];
  onTurn: (turn: Turn, spend?: Spend) => void;
  placeholder: string;
  initialText?: string;
}) {
  const [text, setText] = useState(initialText);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns.length, pending.length]);

  // Grow the box with long dictated messages, up to about 8 lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  async function send(p: Pending) {
    setPending((ps) => [...ps.filter((x) => x.client_message_id !== p.client_message_id), { ...p, state: "sending" }]);
    try {
      const prepared = p.photo ? await p.photo.ready : null;
      const image = prepared ? { mime_type: prepared.mime_type, data: prepared.data } : null;
      const { body } = await sendChat({ mode, text: p.text, client_message_id: p.client_message_id, image });
      if (body.turn) {
        onTurn(body.turn, body.spend);
        setPending((ps) => ps.filter((x) => x.client_message_id !== p.client_message_id));
        if (p.photo) URL.revokeObjectURL(p.photo.preview);
      } else {
        throw new Error(body.message ?? "No reply");
      }
    } catch (e) {
      setPending((ps) => ps.map((x) => x.client_message_id === p.client_message_id
        ? { ...x, state: "failed", error: e instanceof Error ? e.message : String(e) } : x));
    }
  }

  function submit() {
    const t = text.trim();
    if (!t && !photo) return;
    setText("");
    setPhoto(null);
    void send({ client_message_id: newId(), text: t, photo, state: "sending" });
  }

  function pickPhoto(file: File | undefined) {
    setPhotoError(null);
    if (!file) return;
    // Show it straight away; shrinking runs in the background and Send just waits for it.
    const ready = preparePhoto(file);
    ready.catch((e) => {
      setPhoto(null);
      setPhotoError(e instanceof Error ? e.message : "Couldn't read that photo");
    });
    setPhoto({ preview: URL.createObjectURL(file), ready });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {turns.length === 0 && pending.length === 0 && (
          <p className="pt-10 text-center text-sm text-zinc-500">{placeholder}</p>
        )}
        {turns.map((t) => <TurnView key={t.user.id} turn={t} />)}
        {pending.map((p) => (
          <div key={p.client_message_id} className="space-y-2">
            <UserBubble text={p.text} preview={p.photo?.preview} />
            {p.state === "sending" ? (
              <p className="animate-pulse text-sm text-zinc-500">{p.photo ? "Sending photo…" : "Working…"}</p>
            ) : (
              <div className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm">
                <p className="text-red-300">Not sent: {p.error}</p>
                <button className="mt-2 min-h-10 rounded-lg bg-zinc-800 px-4" onClick={() => send(p)}>
                  Retry
                </button>
              </div>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form
        className="border-t border-zinc-800/60 bg-zinc-950 px-3 pb-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {(photo || photoError) && (
          <div className="mb-2 flex items-center gap-2 text-sm">
            {photo && (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
              <img src={photo.preview} alt="Photo to send" className="size-14 rounded-lg object-cover" />
            )}
            {photoError && <span className="text-red-400">{photoError}</span>}
            <button type="button" className="ml-auto min-h-10 px-3 text-zinc-400" onClick={() => {
                if (photo) URL.revokeObjectURL(photo.preview);
                setPhoto(null);
                setPhotoError(null);
              }}>
              Remove
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              pickPhoto(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Add photo"
            onClick={() => fileInput.current?.click()}
            className="grid min-h-12 min-w-12 place-items-center rounded-2xl border border-zinc-700 text-zinc-300 active:bg-zinc-800"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 4000))}
            rows={1}
            placeholder="Type or dictate…"
            className="max-h-[200px] min-h-12 min-w-0 flex-1 resize-none rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 outline-none focus:border-zinc-500"
          />
          <button
            type="submit"
            disabled={!text.trim() && !photo}
            className="min-h-12 min-w-16 rounded-2xl bg-zinc-100 px-4 font-semibold text-zinc-950 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function UserBubble({ text, preview, hasImage }: { text: string; preview?: string; hasImage?: boolean }) {
  return (
    <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-800 px-4 py-2.5">
      {preview && (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
        <img src={preview} alt="" className="mb-2 max-h-40 rounded-lg" />
      )}
      {!preview && hasImage && <div className="mb-1 text-xs text-zinc-400">[photo]</div>}
      {text}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="space-y-2">
      <UserBubble text={turn.user.content} hasImage={turn.user.has_image} />
      {turn.reply && (
        <div className="max-w-[92%] space-y-2">
          <div className="whitespace-pre-wrap rounded-2xl rounded-bl-md border border-zinc-800 bg-zinc-900 px-4 py-2.5">
            {turn.reply.content}
          </div>
          {turn.sets.length > 0 && <SetCards sets={turn.sets} />}
          {turn.food_entries.length > 0 && <FoodCards rows={turn.food_entries} />}
          {turn.cost.calls > 0 && (
            <p className="pl-1 font-mono text-[11px] text-zinc-600">
              tokens {usd(turn.cost.token_usd)} · search {usd(turn.cost.search_usd)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SetCards({ sets }: { sets: SetRow[] }) {
  const groups = new Map<string, SetRow[]>();
  for (const s of sets) {
    const key = `${s.exercise}${s.variation ? ` · ${s.variation}` : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return (
    <div className="space-y-1.5">
      {[...groups].map(([name, rows]) => (
        <div key={name} className="rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-sm">
          <div className="font-medium text-emerald-200">{name}</div>
          {rows.map((s) => (
            <div key={s.id} className="flex gap-3 font-mono text-zinc-300">
              <span className="w-5 text-zinc-500">{s.set_index}</span>
              {formatSet(s)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ConfidenceBadge({ c }: { c: FoodRow["confidence"] }) {
  const style = { label: "bg-sky-900/60 text-sky-200", saved: "bg-emerald-900/60 text-emerald-200", estimate: "bg-amber-900/60 text-amber-200" }[c];
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${style}`}>{c}</span>;
}

function FoodCards({ rows }: { rows: FoodRow[] }) {
  return (
    <div className="space-y-1.5">
      {rows.map((f) => (
        <div key={f.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="flex-1 font-medium">{f.display_name}</span>
            <ConfidenceBadge c={f.confidence} />
          </div>
          <div className="font-mono text-zinc-400">
            {f.grams != null ? `${Number(f.grams)} g · ` : ""}{Number(f.kcal)} kcal · {Number(f.protein_g)} g protein
          </div>
          {f.assumptions && <div className="text-xs text-zinc-500">{f.assumptions}</div>}
        </div>
      ))}
    </div>
  );
}
