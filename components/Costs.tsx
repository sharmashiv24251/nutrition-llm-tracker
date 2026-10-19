"use client";
import { useEffect, useState } from "react";
import { api, usd, type CostReport } from "./client";
import { SERIES } from "@/lib/viz";
import { PageHeader } from "./Header";

export function Costs() {
  const [report, setReport] = useState<CostReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.costs()
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const max = Math.max(0.0001, ...(report?.days ?? []).map((d) => d.token_usd + d.search_usd));
  const mtd = report?.month_to_date;

  return (
    <div className="mx-auto min-h-dvh max-w-md pb-10">
      <PageHeader title="Costs" />
      <div className="px-3 pt-4">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!report && !error && <p className="py-10 text-center text-sm text-zinc-500">Loading…</p>}
        {mtd && (
          <section className="mb-5">
            <div className="text-xs text-zinc-500">Month to date</div>
            <div className="font-mono text-4xl font-semibold">{usd(mtd.total_usd)}</div>
            <div className="mt-1 text-sm text-zinc-400">
              tokens {usd(mtd.token_usd)} · search {usd(mtd.search_usd)}
            </div>
          </section>
        )}
        {report && (
          <section>
            <div className="mb-2 flex items-center gap-4 text-xs text-zinc-400">
              <span className="font-medium text-zinc-300">Last 30 days</span>
              <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm" style={{ background: SERIES.primary }} />Tokens</span>
              <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm" style={{ background: SERIES.secondary }} />Search</span>
            </div>
            <ul className="space-y-0.5">
              {report.days.map((d) => {
                const total = d.token_usd + d.search_usd;
                const open = active === d.day;
                return (
                  <li key={d.day}>
                    <button
                      className={`grid min-h-9 w-full grid-cols-[3.5rem_1fr_4.5rem] items-center gap-2 rounded-md px-1 text-left text-sm ${open ? "bg-zinc-900" : ""}`}
                      onClick={() => setActive(open ? null : d.day)}
                      onMouseEnter={() => setActive(d.day)}
                      aria-expanded={open}
                    >
                      <span className={d.day === report.today ? "text-zinc-100" : "text-zinc-500"}>{d.day.slice(5)}</span>
                      <span className="flex h-3 items-center gap-[2px]">
                        {d.token_usd > 0 && (
                          <span className="h-full rounded-l-[4px] rounded-r-[1px]" style={{ width: `${(d.token_usd / max) * 100}%`, background: SERIES.primary }} />
                        )}
                        {d.search_usd > 0 && (
                          <span className="h-full rounded-r-[4px]" style={{ width: `${(d.search_usd / max) * 100}%`, background: SERIES.secondary }} />
                        )}
                      </span>
                      <span className="text-right font-mono text-zinc-300">{total > 0 ? usd(total) : "–"}</span>
                    </button>
                    {open && total > 0 && (
                      <div className="px-1 pb-1 pl-16 text-xs text-zinc-400">
                        tokens {usd(d.token_usd)} · search {usd(d.search_usd)} · {d.calls} calls · {d.searches} searches
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
