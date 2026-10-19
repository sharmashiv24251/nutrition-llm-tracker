import "server-only";
import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { toModelTurn, withRetry, type GenerateRequest, type Model } from "./llm";

// https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash (checked 2026-10-19)
export const GEMINI_MODEL = "gemini-3.8-flash";

export function geminiModel(apiKey: string, model = GEMINI_MODEL): Model {
  const ai = new GoogleGenAI({ apiKey });
  return {
    name: model,
    async generate({ system, contents, tools, allowTools = true, googleSearch }: GenerateRequest) {
      const res = await withRetry(() => ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: system,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          ...(googleSearch
            ? { tools: [{ googleSearch: {} }] }
            : tools?.length
              ? {
                  tools: [{ functionDeclarations: tools }],
                  toolConfig: {
                    functionCallingConfig: {
                      mode: allowTools ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.NONE,
                    },
                  },
                }
              : {}),
        },
      }));
      return toModelTurn(res, model);
    },
  };
}
