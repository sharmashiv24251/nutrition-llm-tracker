import { z } from "zod";
import { handleChat } from "@/lib/chat";
import { body, handle } from "@/lib/http";
import { chatDeps, data, store } from "@/lib/server";

export const maxDuration = 60;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ChatBody = z
  .object({
    mode: z.enum(["workout", "food"]),
    text: z.string().max(4000).default(""),
    image: z
      .object({
        mime_type: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]),
        data: z.base64().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4, "image is over 5 MB"),
      })
      .optional(),
    client_message_id: z.string().min(8).max(100),
  })
  .refine((b) => b.text.trim() || b.image, "send text or a photo");

export async function POST(req: Request) {
  return handle(async () => {
    const input = await body(req, ChatBody);
    const { status, body: res } = await handleChat(input, chatDeps());
    return Response.json(res, { status });
  });
}

/** Today's turns for one mode, today's spend, and status (active session, open days). */
export async function GET(req: Request) {
  return handle(async () => {
    const mode = z.enum(["workout", "food"]).parse(new URL(req.url).searchParams.get("mode"));
    const status = await data.getStatus();
    const [turns, spend] = await Promise.all([
      store.rpc("trk_chat_turns", { p_mode: mode, p_day: status.today }),
      store.rpc("trk_spend_today", {}),
    ]);
    return Response.json({ day: status.today, turns, spend, status });
  });
}
