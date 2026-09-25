import { isAgentId } from "./agents/registry";
import { LIMITS } from "./config";
import { MemoryStore } from "./memory/store";
import { answerCallback, botToken, hostAgent, isOwner, parseCallback, parseIds, parseIncoming, type TelegramUpdate } from "./telegram/api";
import type { AgentId, Env } from "./types";
import { decodeRoom, validateInitData, verifyRoomToken } from "./voice/auth";
import { renderApp } from "./voice/app";

export { CouncilRoom } from "./council/room";
export { Sandbox } from "@cloudflare/sandbox";

function groupAllowed(env: Env, chatId: number): boolean {
  const allowed = parseIds(env.ALLOWED_CHAT_IDS);
  return allowed.length === 0 || allowed.includes(String(chatId));
}

function room(env: Env, convId: number) {
  return env.COUNCIL_ROOM.get(env.COUNCIL_ROOM.idFromName(String(convId)));
}

async function handleTelegram(request: Request, env: Env, ctx: ExecutionContext, agent: AgentId): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await request.json()) as TelegramUpdate;
  const store = new MemoryStore(env.DB);

  // Telegram retries webhooks; process each update once.
  if (!(await store.markUpdateSeen(agent, update.update_id))) return new Response("ok");

  if (update.callback_query) {
    const cb = parseCallback(update, agent);
    if (!cb) return new Response("ok");
    if (!isOwner(env, cb.fromId)) {
      ctx.waitUntil(answerCallback(env, agent, cb.callbackId, "Only the founder can approve this."));
      return new Response("ok");
    }
    ctx.waitUntil(room(env, cb.convId).handleCallback(cb).catch((err) => console.error("handleCallback failed", err)));
    return new Response("ok");
  }

  const msg = update.message && parseIncoming(update.message, agent, hostAgent(env));
  if (!msg || !isOwner(env, msg.fromId)) return new Response("ok");
  if (!msg.dmAgent && !groupAllowed(env, msg.chatId)) return new Response("ok");
  // Acknowledge Telegram immediately; the room schedules the discussion with alarms.
  ctx.waitUntil(room(env, msg.convId).handleMessage(msg).catch((err) => console.error("handleMessage failed", err)));
  return new Response("ok");
}

/** Live voice room: authenticate (Mini App initData or signed link), then hand the socket to the room. */
async function handleVoiceSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
  const url = new URL(request.url);
  let convId: number | null = null;

  const token = url.searchParams.get("t");
  const initData = url.searchParams.get("initData");
  if (token) {
    convId = await verifyRoomToken(env.TELEGRAM_WEBHOOK_SECRET, token);
  } else if (initData) {
    const hostToken = botToken(env, hostAgent(env));
    const user = hostToken ? await validateInitData(initData, hostToken) : null;
    if (user && isOwner(env, user.userId) && user.startParam) {
      const decoded = decodeRoom(user.startParam);
      // Mini App links are only issued for group rooms.
      if (decoded !== null && decoded < 0 && groupAllowed(env, decoded)) convId = decoded;
    }
  }
  if (convId === null) return new Response("unauthorized", { status: 401 });
  return room(env, convId).fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") return new Response("AI Council is running.");
    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(renderApp(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            `default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://${url.host}; media-src 'self' blob: data:; img-src 'self' data:`,
        },
      });
    }
    if (url.pathname === "/voice/ws") return handleVoiceSocket(request, env);

    const webhook = /^\/telegram\/webhook(?:\/([a-z]+))?$/.exec(url.pathname);
    if (request.method === "POST" && webhook) {
      const agent = webhook[1] ?? hostAgent(env);
      if (!isAgentId(agent)) return new Response("not found", { status: 404 });
      return handleTelegram(request, env, ctx, agent);
    }

    return new Response("not found", { status: 404 });
  },

  /** Cron: morning briefs and housekeeping. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const store = new MemoryStore(env.DB);
    ctx.waitUntil(store.cleanupSeenUpdates(Date.now() - LIMITS.seenUpdatesTtlMs));
    for (const chat of await store.chatsWithBrief()) {
      ctx.waitUntil(room(env, chat.conv_id).startBrief().catch((err) => console.error("brief failed", err)));
    }
  },
} satisfies ExportedHandler<Env>;
