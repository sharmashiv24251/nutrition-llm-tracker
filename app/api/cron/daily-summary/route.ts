// Nightly job (vercel.json: "30 4 * * *" UTC, just after the 4 am Dublin day cutoff in both winter and summer).
// It summarises every finished day from the last week that has logs but no summary, so a missed or repeated
// run (Vercel delivery is best effort) is harmless. Locally: curl it with the same Authorization header.
import { env } from "@/lib/env";
import { handle } from "@/lib/http";
import { summaryDeps } from "@/lib/server";
import { summarizePending } from "@/lib/summary";

export const maxDuration = 60;

export async function GET(req: Request) {
  return handle(async () => {
    const secret = env().CRON_SECRET;
    if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
    if (req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
    return Response.json(await summarizePending(summaryDeps()));
  }, { rateLimit: false }); // authenticated by the secret; must not lose its slot to app traffic
}
