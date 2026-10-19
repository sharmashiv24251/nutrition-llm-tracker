"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, shortDay, usd, type ActiveSession, type Mode, type Spend, type Turn } from "./client";
import { Chat } from "./Chat";
import { BottomNav, Icon } from "./ui";

const COPY: Record<Mode, { title: string; placeholder: string }> = {
  workout: {
    title: "Workout",
    placeholder: 'Log sets the way you\'d say them, e.g. "bw + 15 kg pull-ups, 7 full reps and 2 half reps". Ask about progress any time.',
  },
  food: {
    title: "Food",
    placeholder: 'Log food the way you\'d say it, e.g. "1.5 katori bhindi sabzi, very oily", or send a label photo.',
  },
};

export function ChatScreen({ mode }: { mode: Mode }) {
  const prefill = useSearchParams().get("prefill") ?? "";
  const [turns, setTurns] = useState<Turn[]>([]);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveSession>(null);
  const [nextDay, setNextDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.chatToday(mode)
      .then((r) => {
        if (!live) return;
        setTurns(r.turns);
        setSpend(r.spend);
        setToday(r.day);
        setActive(r.status.active_session);
        setNextDay(r.status.today_program_day?.name ?? null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [mode]);

  async function endWorkout() {
    if (!active || !confirm("End this workout?")) return;
    try {
      await api.endWorkout(active.id);
      setActive(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="mx-auto flex h-dvh max-w-md flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
        <header className="flex items-center gap-3 border-b border-zinc-800/60 px-4 pb-2.5 pt-[max(env(safe-area-inset-top),0.75rem)]">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">{COPY[mode].title}</h1>
            {today && (
              <Link href={`/day/${today}`} className="flex items-center text-xs text-zinc-400">
                Logging to today · {shortDay(today)} <Icon.chevron size={14} />
              </Link>
            )}
          </div>
          {mode === "workout" && active && (
            <button onClick={endWorkout} className="min-h-10 rounded-full bg-emerald-600 px-4 text-sm font-semibold text-white">
              End workout
            </button>
          )}
          <Link href="/costs" className="rounded-full border border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300">
            {spend ? usd(spend.total_usd) : "–"}
          </Link>
        </header>
        {mode === "workout" && (
          <nav className="flex gap-2 border-b border-zinc-800/60 px-4 py-2" aria-label="Workout">
            <Link href="/plan" className="flex min-h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-3.5 text-sm text-zinc-200">
              Plan{nextDay ? <span className="text-xs text-emerald-400">· next {nextDay}</span> : null}
            </Link>
            <Link href="/exercises" className="flex min-h-9 items-center rounded-full bg-zinc-900 px-3.5 text-sm text-zinc-200">
              Exercises
            </Link>
          </nav>
        )}
        {error && (
          <button className="bg-red-950 px-4 py-2 text-left text-sm text-red-200" onClick={() => setError(null)}>
            {error} (tap to dismiss)
          </button>
        )}
        <Chat
          mode={mode}
          turns={turns}
          initialText={prefill}
          placeholder={COPY[mode].placeholder}
          onTurn={(turn, s) => {
            setTurns((ts) => [...ts.filter((t) => t.user.id !== turn.user.id), turn]);
            if (s) setSpend(s);
            // a turn can start or end a session
            if (mode === "workout") api.chatToday("workout").then((r) => setActive(r.status.active_session)).catch(() => {});
          }}
        />
      </div>
      <BottomNav />
    </>
  );
}
