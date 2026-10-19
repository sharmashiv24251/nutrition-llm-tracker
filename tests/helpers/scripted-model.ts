// A Model that plays back scripted steps, standing in for Gemini. Each step sees the conversation so far
// and returns tool calls or a final text, so later steps can use ids from earlier tool results.
import type { Content, GenerateContentResponse } from "@google/genai";
import { toModelTurn, type GenerateRequest, type Model } from "../../lib/llm";

export type Step = (ctx: { contents: Content[]; system: string; lastResults: Record<string, any> }) =>
  | { calls: { name: string; args: Record<string, unknown> }[] }
  | { text: string; grounding?: { queries: string[]; sources: string[] } };

export const USAGE = { promptTokenCount: 2000, candidatesTokenCount: 100, thoughtsTokenCount: 50, cachedContentTokenCount: 0 };

export function scriptedModel(steps: Step[]) {
  const requests: GenerateRequest[] = [];
  let i = 0;
  const model: Model & { requests: GenerateRequest[]; remaining: () => number } = {
    name: "gemini-3.8-flash",
    requests,
    remaining: () => steps.length - i,
    async generate(req) {
      requests.push(structuredClone(req));
      const last = req.contents.at(-1);
      const lastResults: Record<string, any> = {};
      for (const p of last?.parts ?? []) {
        if (p.functionResponse?.name) lastResults[p.functionResponse.name] = p.functionResponse.response;
      }
      const step = steps[i++];
      if (!step) throw new Error(`scripted model ran out of steps (call ${i})`);
      const out = step({ contents: req.contents, system: req.system, lastResults });
      const parts = "text" in out
        ? [{ text: out.text }]
        : out.calls.map((c, n) => ({ functionCall: { id: `call_${i}_${n}`, name: c.name, args: c.args },
            ...(n === 0 ? { thoughtSignature: "sig" } : {}) }));
      const grounding = "text" in out && out.grounding
        ? { webSearchQueries: out.grounding.queries, groundingChunks: out.grounding.sources.map((uri) => ({ web: { uri } })) }
        : undefined;
      const res = { candidates: [{ content: { role: "model", parts }, groundingMetadata: grounding }], usageMetadata: USAGE } as unknown as GenerateContentResponse;
      return toModelTurn(res, "gemini-3.8-flash");
    },
  };
  return model;
}

export const call = (name: string, args: Record<string, unknown> = {}) => ({ calls: [{ name, args }] });
export const say = (text: string) => ({ text });
export const searchResult = (text: string, queries: string[], sources: string[]) => ({ text, grounding: { queries, sources } });
