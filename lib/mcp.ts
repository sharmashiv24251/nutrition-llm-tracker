// The same tools the in-app chat uses, served over the Model Context Protocol so ChatGPT, Claude or any
// other MCP client can log and read my data. Stateless JSON-RPC over HTTP: every POST is answered with
// plain JSON, no sessions and no streams. The client's model does the thinking, so no Gemini call is made.
import { z } from "zod";
import { runTool, TOOLS, type ToolCtx } from "./tools";

/** Protocol revisions this server speaks, newest first. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const MCP_INSTRUCTIONS = `Swolify is my personal log for training, food, water, activity, sleep, body measurements, daily routines
(supplements, skincare) and notes about me. You are my trainer and nutrition coach working from it: log what I
tell you, answer from the data, and coach me. Be direct, specific and short.

HOW TO WORK
- The database is the only memory between conversations. Start with get_status (the date, what's logged today),
  and read get_notes before giving advice so it fits my profile, goals and what we already decided.
- Look things up instead of asking me. Ground every number in tool results; never invent a set, weight or total.
- If something is ambiguous in a way that changes what gets saved, ask one short question. Otherwise act.
- One message can hold several things ("2 eggs, a glass of water, took creatine, slept 7 hours"): save each
  with its own tool.
- After saving, say what was saved and give the updated totals the tool returned.
- Keep the log complete without nagging. get_status returns not_logged_today. After handling what I asked, end
  your reply by asking for one or two of those things, the check-in and sleep first, in one short friendly line
  ("How's your energy and mood today, 1 to 5?"). Don't repeat a question I skipped or said no to in this
  conversation, and don't ask when I'm mid-workout logging sets.

THE DATA
- A day runs 04:00 to 04:00 in my timezone; get_status says which day is today. Days can be marked complete,
  incomplete or missed; incomplete and missed days are left out of averages.
- Training: a session is one gym visit, tagged with the program day. Each set has an exercise, a variation
  (grip, stance, angle), a load and load type (added = bodyweight plus extra, assisted, bodyweight_only,
  total = bar or stack, per_side = plate-loaded, per_hand = dumbbells), full reps, partial reps, rest-pause
  reps and a warm-up flag. Loads with a different load type or variation aren't comparable. The plan is a
  guide; logged sets are what happened.
- Food: entries with grams, kcal, macros, sodium when known, and a confidence (label, saved, estimate); a
  library of saved foods per 100 g; household units (katori, roti, scoop). Kcal is a ceiling; protein, fibre
  and water are floors.
- Everything else: water in ml, activities, measurements by metric name, one sleep and one check-in per day,
  routine items ticked once a day, and notes (profile, goal, plan, decision, note).

RULES THAT KEEP THE DATA RIGHT
- Food totals come from the database; never add them up yourself.
- Pass my exact words as raw_text.
- Resolve names with find_exercise / find_food before logging; typos and plurals are the same thing. Grip or
  stance goes in variation, not a new exercise. Create one only when nothing close exists.
- Packaged food: find_food first. If it isn't saved, read the label photo or look it up, save_food with its
  source and serving size, then log_food by food_id with confidence "label". Home or cafe food: estimate,
  confidence "estimate", and the assumptions (portion, oil, milk type) in one sentence so I can correct them.
- Drinks count toward water: log the liquid in shakes, milk and electrolyte drinks with log_water as well as
  their calories with log_food.
- The first sets of a day: tag the session with the program day I'm doing. A one-off substitution is just
  logged; change the plan only when I ask.
- Before an edit or delete, fetch the rows with get_entries and say exactly what you're changing.
- When we decide something (a target, a plan change, a rule for me), save it with save_note as a decision
  with the reason. Change targets only with set_targets, and only when I ask.`;

const READ_ONLY = /^(get|find|list)_/;
const DESTRUCTIVE = new Set(["delete_entry", "set_program"]);

function title(name: string) {
  const words = name.replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

/** The tool list an MCP client sees: every tool, whatever in-app chat it belongs to, minus web search. */
export function mcpTools() {
  return TOOLS.filter((t) => t.name !== "web_search").map((t) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(t.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    void _;
    const readOnly = READ_ONLY.test(t.name);
    return {
      name: t.name,
      title: title(t.name),
      description: t.description,
      inputSchema,
      annotations: {
        title: title(t.name), readOnlyHint: readOnly, destructiveHint: !readOnly && DESTRUCTIVE.has(t.name),
        idempotentHint: readOnly, openWorldHint: false,
      },
    };
  });
}

type Id = string | number | null;
type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

const Message = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const fail = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Answers one JSON-RPC message. Notifications and client responses get no reply (null). */
export async function mcpRespond(raw: unknown, ctx: ToolCtx): Promise<RpcResponse | null> {
  const parsed = Message.safeParse(raw);
  if (!parsed.success) return fail(null, -32600, "Invalid Request");
  const { id, method, params = {} } = parsed.data;
  if (id === undefined || method === undefined) return null;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "swolify", title: "Swolify", version: "1.0.0" },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: mcpTools() });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "web_search" || !TOOLS.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      // Bad arguments and rejected writes come back as tool errors (isError), so the model can correct itself.
      const res = await runTool(name, args, ctx);
      return ok(res.ok
        ? { content: [{ type: "text", text: JSON.stringify(res.result) }], isError: false }
        : { content: [{ type: "text", text: res.error }], isError: true });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

/** Handles the body of one POST: a single message, or a batch. `null` means nothing to send back (HTTP 202). */
export async function mcpHandle(body: unknown, ctx: ToolCtx): Promise<RpcResponse | RpcResponse[] | null> {
  if (!Array.isArray(body)) return mcpRespond(body, ctx);
  if (!body.length) return fail(null, -32600, "Invalid Request");
  const out: RpcResponse[] = [];
  for (const m of body) {
    const r = await mcpRespond(m, ctx);
    if (r) out.push(r);
  }
  return out.length ? out : null;
}
