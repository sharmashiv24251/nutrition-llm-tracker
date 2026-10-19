// The tool-calling loop: call the model, run the tools it asks for, feed results back, until it answers.
import type { Content, Part } from "@google/genai";
import type { Model, ModelTurn } from "./llm";
import type { Mode } from "./prompt";
import { runTool, toolDeclarations, type ToolCtx } from "./tools";

export const MAX_TOOL_ROUNDS = 8;

export type ToolLog = { name: string; args: Record<string, unknown>; ok: boolean; error?: string };

export type AgentHooks = {
  /** Runs before every model call; throw to stop (spend cap). */
  beforeCall: () => Promise<void>;
  /** Runs after every model call (cost logging). */
  afterCall: (turn: ModelTurn, round: number, latencyMs: number) => Promise<void>;
};

export async function runAgent(opts: {
  model: Model;
  mode?: Mode;
  ctx: ToolCtx;
  system: string;
  history: Content[];
  user: Content;
  hooks: AgentHooks;
}): Promise<{ text: string; tools: ToolLog[] }> {
  const { model, ctx, system, hooks } = opts;
  const tools = toolDeclarations(ctx, opts.mode);
  const contents: Content[] = [...opts.history, opts.user];
  const log: ToolLog[] = [];

  for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round++) {
    const allowTools = round <= MAX_TOOL_ROUNDS;
    await hooks.beforeCall();
    const started = Date.now();
    const turn = await model.generate({ system, contents, tools, allowTools });
    await hooks.afterCall(turn, round, Date.now() - started);

    if (!allowTools || turn.calls.length === 0) {
      return { text: turn.text || "Done.", tools: log };
    }

    contents.push(turn.content);
    const responses: Part[] = [];
    for (const call of turn.calls) {
      const r = await runTool(call.name, call.args, ctx);
      log.push({ name: call.name, args: call.args, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
      responses.push({
        functionResponse: { id: call.id, name: call.name, response: r.ok ? { result: r.result } : { error: r.error } },
      });
    }
    contents.push({ role: "user", parts: responses });
  }
  throw new Error("unreachable");
}
