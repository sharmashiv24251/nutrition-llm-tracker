// The model interface the agent depends on, and conversion from a Gemini response.
// The real client lives in lib/gemini.ts; tests pass a scripted Model.
import type { Content, FunctionDeclaration, GenerateContentResponse } from "@google/genai";
import type { Usage } from "./pricing";

export type ToolCall = { id?: string; name: string; args: Record<string, unknown> };

export type ModelTurn = {
  /** The model's message exactly as returned, so thought signatures go back unchanged. */
  content: Content;
  calls: ToolCall[];
  text: string;
  usage: Usage;
  searchQueries: string[];
  sources: { uri: string; title?: string }[];
  model: string;
};

export type GenerateRequest = {
  system: string;
  contents: Content[];
  tools?: FunctionDeclaration[];
  /** false forces a text answer even when tools are declared (used after the last tool round). */
  allowTools?: boolean;
  /** Google Search grounding, used alone (the web_search tool's separate call). */
  googleSearch?: boolean;
};

export interface Model {
  name: string;
  generate(req: GenerateRequest): Promise<ModelTurn>;
}

export function toModelTurn(res: GenerateContentResponse, model: string): ModelTurn {
  const candidate = res.candidates?.[0];
  const content: Content = candidate?.content ?? { role: "model", parts: [] };
  const parts = content.parts ?? [];
  const u = res.usageMetadata;
  const grounding = candidate?.groundingMetadata;
  return {
    content: { role: "model", parts },
    calls: parts
      .filter((p) => p.functionCall?.name)
      .map((p) => ({ id: p.functionCall!.id, name: p.functionCall!.name!, args: p.functionCall!.args ?? {} })),
    text: parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim(),
    usage: {
      input: u?.promptTokenCount ?? 0,
      output: u?.candidatesTokenCount ?? 0,
      thinking: u?.thoughtsTokenCount ?? 0,
      cached: u?.cachedContentTokenCount ?? 0,
      toolUse: u?.toolUsePromptTokenCount ?? 0,
    },
    searchQueries: grounding?.webSearchQueries ?? [],
    sources: (grounding?.groundingChunks ?? [])
      .filter((c) => c.web?.uri)
      .map((c) => ({ uri: c.web!.uri!, title: c.web!.title })),
    model: res.modelVersion ?? model,
  };
}

// Gemini sometimes answers 503 "service unavailable" (or 500/429) for a moment; those are worth retrying.
const RETRYABLE = /\b(429|500|503|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL)\b/;
const BACKOFF_MS = [800, 2000];

export async function withRetry<T>(call: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= BACKOFF_MS.length || !RETRYABLE.test(String(e instanceof Error ? e.message : e))) throw e;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
}
