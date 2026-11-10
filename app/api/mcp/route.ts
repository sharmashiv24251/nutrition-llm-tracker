// MCP endpoint (streamable HTTP, stateless): add <site>/api/mcp as a custom connector in ChatGPT or Claude.
// It serves the tools in lib/tools.ts straight from the data layer. No model call, so no token spend here.
// There is no login: anyone who has the URL can read and change the log.
import { handle } from "@/lib/http";
import { mcpHandle } from "@/lib/mcp";
import { data } from "@/lib/server";

// Clients send tool calls in parallel, so this gets its own, roomier bucket than the app's routes.
const RATE_LIMIT = { bucket: "mcp", limit: 20, windowMs: 1000 };

export async function POST(req: Request) {
  return handle(async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }
    const res = await mcpHandle(body, { data, source: "mcp" });
    return res === null ? new Response(null, { status: 202 }) : Response.json(res);
  }, { rateLimit: RATE_LIMIT });
}

// No server-initiated stream and no sessions to end.
const notAllowed = () =>
  handle(async () => new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } }), { rateLimit: false });

export const GET = notAllowed;
export const DELETE = notAllowed;
