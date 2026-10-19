"use client";
import Link from "next/link";

/** Back link header for the costs, settings and exercise pages. */
export function PageHeader({ title, back = "/" }: { title: string; back?: string }) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] backdrop-blur">
      <Link href={back} className="grid min-h-11 min-w-11 place-items-center rounded-lg text-2xl text-zinc-300 active:bg-zinc-800" aria-label="Back">
        ‹
      </Link>
      <h1 className="text-lg font-semibold">{title}</h1>
    </header>
  );
}
