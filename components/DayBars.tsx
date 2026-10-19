"use client";
// Daily bars for one nutrient with the target as a dashed reference line. Counted days are solid; days that are
// marked incomplete/missed, or today (still in progress), are hollow outlines, so status is shown by shape,
// not colour alone. Tap or hover a day to select it.
import { SERIES } from "@/lib/viz";
import { dayParts, type HistoryDay } from "./client";

const W = 360;
const H = 168;
const PAD = { top: 18, right: 8, bottom: 22, left: 8 };

export function DayBars({
  days, metric, target, selected, onSelect,
}: {
  days: HistoryDay[]; // oldest first
  metric: "kcal" | "protein_g";
  target: number | null;
  selected: string | null;
  onSelect: (day: string) => void;
}) {
  const values = days.map((d) => Number(d[metric] ?? 0));
  const max = Math.max(1, target ?? 0, ...values) * 1.08;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / days.length;
  const barW = Math.max(3, slot - 2); // 2px surface gap between bars
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const base = PAD.top + innerH;
  const labelEvery = days.length > 16 ? 7 : 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full touch-manipulation" role="img"
      aria-label={`${metric === "kcal" ? "Calories" : "Protein"} per day, last ${days.length} days`}>
      <line x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} stroke="#3f3f46" strokeWidth="1" />
      {days.map((d, i) => {
        const v = values[i];
        const x = PAD.left + i * slot + (slot - barW) / 2;
        const solid = d.counts && !d.is_today;
        const isSel = selected === d.day;
        const h = Math.max(0, base - y(v));
        const r = Math.min(4, barW / 2, h);
        const path = h > 0
          ? `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + barW - r} Q${x + barW},${base - h} ${x + barW},${base - h + r} V${base} Z`
          : "";
        const { weekday, date } = dayParts(d.day);
        return (
          <g key={d.day}>
            {isSel && <rect x={PAD.left + i * slot} y={PAD.top - 6} width={slot} height={innerH + 6} rx={6} fill="#27272a" />}
            {h > 0 && (solid ? (
              <path d={path} fill={SERIES.primary} />
            ) : (
              <path d={path} fill="none" stroke={d.is_today ? SERIES.primary : "#71717a"} strokeWidth="1.5"
                strokeDasharray={d.is_today ? undefined : "3 2"} transform="translate(0.75 0)" />
            ))}
            {(i % labelEvery === 0 || i === days.length - 1) && (
              <text x={PAD.left + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="9.5"
                fill={isSel ? "#fafafa" : "#71717a"}>
                {labelEvery === 1 ? weekday.slice(0, 1) : date}
              </text>
            )}
            <rect x={PAD.left + i * slot} y={0} width={slot} height={H} fill="transparent" className="cursor-pointer"
              onClick={() => onSelect(d.day)} onMouseEnter={() => onSelect(d.day)}>
              <title>{`${d.day}: ${Math.round(v)}${metric === "kcal" ? " kcal" : " g"}`}</title>
            </rect>
          </g>
        );
      })}
      {target != null && (
        <g pointerEvents="none">
          <line x1={PAD.left} x2={W - PAD.right} y1={y(target)} y2={y(target)} stroke="#e4e4e7" strokeWidth="1"
            strokeDasharray="4 3" opacity="0.7" />
          <text x={W - PAD.right} y={y(target) - 5} textAnchor="end" fontSize="10" fill="#d4d4d8">
            target {Math.round(target).toLocaleString("en-IE")}
          </text>
        </g>
      )}
    </svg>
  );
}

export function DayBarsLegend() {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SERIES.primary }} />Counted
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-2.5 w-2.5 rounded-sm border" style={{ borderColor: SERIES.primary }} />Today so far
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-zinc-500" />Incomplete or missed (not counted)
      </span>
    </div>
  );
}
