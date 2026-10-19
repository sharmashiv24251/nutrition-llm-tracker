// Fuzzy matching for exercise and food names. The catalogs are small (hundreds of rows at most),
// so we score everything in memory instead of adding pg_trgm to the database.

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

/** Light stemming so "rows", "rowing" and "row" compare equal: plural -s and -ing (squatting -> squat). */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) {
    const base = t.slice(0, -3);
    // undo a doubled final consonant (squatting, dipping), but keep real doubles like pull, press
    return /([tpgbdmn])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  return t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

export function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean).map(stem);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let k = 1; k <= b.length; k++) {
      cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len;
}

const TOKEN_MATCH = 0.75;

export type NameScore = { score: number; leftover: string[] };

/** How well `query` names `name`. Extra words in the query (grip, stance, brand) cost little
 *  and come back in `leftover` so the caller can keep them as a variation. */
export function scoreName(query: string, name: string): NameScore {
  const qt = tokens(query);
  const nt = tokens(name);
  if (qt.length === 0 || nt.length === 0) return { score: 0, leftover: qt };

  const compact = similarity(qt.join(""), nt.join(""));

  const used = new Set<number>();
  let total = 0;
  for (const n of nt) {
    let best = 0;
    let bestIdx = -1;
    qt.forEach((q, i) => {
      if (used.has(i)) return;
      const s = similarity(q, n);
      if (s > best) [best, bestIdx] = [s, i];
    });
    if (best >= TOKEN_MATCH) used.add(bestIdx);
    total += best;
  }
  const coverage = total / nt.length;
  const precision = used.size / qt.length;
  const tokenScore = coverage * (0.85 + 0.15 * precision);

  const leftover = normalize(query).split(" ").filter((_, i) => !used.has(i));
  if (compact >= tokenScore) return { score: compact, leftover: compact === 1 ? [] : leftover };
  return { score: tokenScore, leftover };
}

export type Match<T> = { item: T; score: number; matched: string; leftover: string[] };

/** Best name/alias per item, highest score first. */
export function rank<T>(query: string, items: T[], names: (item: T) => string[], limit = 5): Match<T>[] {
  return items
    .map((item) => {
      let best: Match<T> = { item, score: 0, matched: "", leftover: [] };
      for (const n of names(item)) {
        const s = scoreName(query, n);
        if (s.score > best.score) best = { item, score: s.score, matched: n, leftover: s.leftover };
      }
      return { ...best, score: Math.round(best.score * 1000) / 1000 };
    })
    .filter((m) => m.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** A match at or above this is "the same thing"; below it, the model may create a new entry. */
export const CLOSE_MATCH = 0.72;
