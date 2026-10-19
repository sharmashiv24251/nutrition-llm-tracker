import "server-only";
import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "SUPABASE_SERVICE_ROLE_KEY is missing"),
  GEMINI_API_KEY: z.string().min(20, "GEMINI_API_KEY is missing"),
  DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(1),
  CRON_SECRET: z.string().min(16).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export class ConfigError extends Error {}

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    // GOOGLE_GENERATIVE_AI_API_KEY is accepted as an alias for the same key.
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    DAILY_SPEND_CAP_USD: process.env.DAILY_SPEND_CAP_USD || undefined,
    CRON_SECRET: process.env.CRON_SECRET || undefined,
  });
  if (!parsed.success) {
    throw new ConfigError(`Server config is incomplete: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  cached = parsed.data;
  return cached;
}
