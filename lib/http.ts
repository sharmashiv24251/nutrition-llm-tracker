import "server-only";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { InputError } from "./data";
import { ConfigError } from "./env";
import { store } from "./server";
import { DbError } from "./store";

// Every API route shares one bucket: 2 requests per second in total, enforced in Postgres so it holds
// across serverless instances.
const RATE_LIMIT = { bucket: "api", limit: 2, windowMs: 1000 };
type RateLimit = typeof RATE_LIMIT;

async function rateLimited(limit: RateLimit): Promise<Response | null> {
  const r = await store.rpc<{ allowed: boolean; retry_after_ms: number }>("trk_rate_limit_hit", {
    p_bucket: limit.bucket, p_limit: limit.limit, p_window_ms: limit.windowMs,
  });
  if (r.allowed) return null;
  return Response.json(
    { error: "rate_limited", message: "Too many requests; retry shortly.", retry_after_s: r.retry_after_ms / 1000 },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(r.retry_after_ms / 1000))) } },
  );
}

/** Rate-limits (the shared bucket, or the one given), runs a route body, and maps validation and database errors to 4xx. Unknown errors are a bare 500. */
export async function handle(fn: () => Promise<Response>, opts: { rateLimit?: boolean | RateLimit } = {}): Promise<Response> {
  try {
    await connection(); // request-time only; never run at build
    if (opts.rateLimit !== false) {
      const limited = await rateLimited(typeof opts.rateLimit === "object" ? opts.rateLimit : RATE_LIMIT);
      if (limited) return limited;
    }
    return await fn();
  } catch (e) {
    unstable_rethrow(e); // let Next's own control-flow errors (prerender bailouts) through
    if (e instanceof z.ZodError) return Response.json({ error: "invalid_request", message: z.prettifyError(e) }, { status: 400 });
    if (e instanceof InputError || e instanceof DbError) return Response.json({ error: "rejected", message: e.message }, { status: 400 });
    if (e instanceof ConfigError) return Response.json({ error: "config", message: e.message }, { status: 500 });
    console.error(e);
    return Response.json({ error: "server_error", message: "Something went wrong." }, { status: 500 });
  }
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new InputError("body must be JSON");
  }
  return schema.parse(raw);
}

/** ?day=YYYY-MM-DD, or null when absent. */
export function dayParam(req: Request): string | null {
  const v = new URL(req.url).searchParams.get("day");
  return v ? z.iso.date().parse(v) : null;
}
