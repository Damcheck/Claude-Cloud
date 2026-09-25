import { parseIncoming, type TelegramUpdate } from "./telegram/api";
import type { Env } from "./types";

export { CouncilRoom } from "./council/room";

function chatAllowed(env: Env, chatId: number): boolean {
  const allowed = env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(String(chatId));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("AI Council is running.");
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await request.json()) as TelegramUpdate;
      const msg = update.message && parseIncoming(update.message);
      if (msg && chatAllowed(env, msg.chatId)) {
        const room = env.COUNCIL_ROOM.get(env.COUNCIL_ROOM.idFromName(String(msg.chatId)));
        // Acknowledge Telegram immediately; the room schedules the discussion with alarms.
        ctx.waitUntil(room.handleMessage(msg).catch((err) => console.error("handleMessage failed", err)));
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
