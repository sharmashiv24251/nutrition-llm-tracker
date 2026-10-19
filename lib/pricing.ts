// Turns token usage and search counts into dollars using trk_pricing rows. No prices live in code.

export type PriceRow = {
  id: string;
  model: string;
  input_per_m: number;
  output_per_m: number;
  cached_per_m: number;
  search_per_1k: number;
  effective_from: string;
  deleted_at?: string | null;
};

export type Usage = {
  input: number; // promptTokenCount, includes cached tokens
  output: number; // candidatesTokenCount
  thinking: number; // thoughtsTokenCount, billed as output
  cached: number; // cachedContentTokenCount
  toolUse: number; // toolUsePromptTokenCount, billed as input
};

/** The price row in effect for `model` at `at`. */
export function priceAt(rows: PriceRow[], model: string, at: Date): PriceRow | null {
  return (
    rows
      .filter((r) => !r.deleted_at && r.model === model && new Date(r.effective_from) <= at)
      .sort((a, b) => +new Date(b.effective_from) - +new Date(a.effective_from))[0] ?? null
  );
}

export function costOf(usage: Usage, searchQueries: number, price: PriceRow) {
  const uncachedInput = Math.max(usage.input - usage.cached, 0) + usage.toolUse;
  const token =
    (uncachedInput * Number(price.input_per_m) +
      usage.cached * Number(price.cached_per_m) +
      (usage.output + usage.thinking) * Number(price.output_per_m)) /
    1_000_000;
  const search = (searchQueries * Number(price.search_per_1k)) / 1000;
  return { token_usd: round6(token), search_usd: round6(search) };
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
