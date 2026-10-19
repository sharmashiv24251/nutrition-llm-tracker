"use client";
import { SERIES } from "@/lib/viz";
// A small single-series line chart in plain SVG: 2px line, 8px markers, recessive grid, the last value
// labelled directly, and a tap/hover target per point (wider than the mark) that selects it.

export type Point = { label: string; value: number };

const W = 360;
const PAD = { top: 14, right: 44, bottom: 22, left: 34 };

export function LineChart({
  title, points, unit, height = 150, selected, onSelect,
}: {
  title: string;
  points: Point[];
  unit: string;
  height?: number;
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  if (points.length === 0) return null;
  const values = points.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
  const span = hi - lo;
  lo -= span * 0.15;
  hi += span * 0.15;
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const ticks = [lo + span * 0.15, (lo + hi) / 2, hi - span * 0.15].map((v) => Math.round(v * 10) / 10);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points.length - 1;
  const step = points.length > 1 ? innerW / (points.length - 1) : innerW;

  return (
    <figure>
      <figcaption className="mb-1 text-sm font-medium text-zinc-300">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={`${title}, ${points.length} sessions`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#27272a" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#71717a">{t}</text>
          </g>
        ))}
        <text x={PAD.left} y={height - 6} fontSize="10" fill="#71717a">{points[0].label.slice(5)}</text>
        {last > 0 && <text x={x(last)} y={height - 6} textAnchor="end" fontSize="10" fill="#71717a">{points[last].label.slice(5)}</text>}
        {selected != null && <line x1={x(selected)} x2={x(selected)} y1={PAD.top} y2={PAD.top + innerH} stroke="#52525b" strokeWidth="1" />}
        <path d={path} fill="none" stroke={SERIES.primary} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={selected === i ? 5 : 4} fill={SERIES.primary} stroke="#18181b" strokeWidth="2" />
        ))}
        <text x={x(last) + 8} y={y(points[last].value) + 4} fontSize="11" fill="#e4e4e7">
          {points[last].value}{unit}
        </text>
        {points.map((p, i) => (
          <rect
            key={i}
            x={x(i) - step / 2}
            y={0}
            width={Math.max(step, 24)}
            height={height}
            fill="transparent"
            onClick={() => onSelect(i)}
            onMouseEnter={() => onSelect(i)}
          >
            <title>{`${p.label}: ${p.value}${unit}`}</title>
          </rect>
        ))}
      </svg>
    </figure>
  );
}
