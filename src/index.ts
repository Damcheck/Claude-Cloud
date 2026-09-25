import { isAgentId } from "./agents/registry";
import { LIMITS } from "./config";
import { consolidateMemories } from "./knowledge/consolidate";
import { startJob } from "./jobs/start";
import { MemoryStore } from "./memory/store";
import { adminData, adminSecret, renderAdmin } from "./ops/admin";
import { runBackup } from "./ops/backup";
import { dueRoutines } from "./ops/schedule";
import {
  answerCallback,
  botToken,
  hostAgent,
  isOwner,
  parseCallback,
  parseIds,
  parseIncoming,
  parseReactions,
  sendSystem,
  type TelegramUpdate,
} from "./telegram/api";
import type { AgentId, Env, Identity } from "./types";
import { decodeRoom, signRoomToken, validateInitData, verifyRoomToken } from "./voice/auth";
import { renderApp } from "./voice/app";
import { normalizePhone, twiml, twimlReject, validateTwilioSignature } from "./voice/phone";
import { handleGithubWebhook, runDueWatchers } from "./watchers/watchers";

export { CouncilRoom } from "./council/room";
export { CouncilJob } from "./jobs/workflow";
export { ToolEgress } from "./tools/egress";
export { Sandbox } from "@cloudflare/sandbox";

function groupAllowed(env: Env, chatId: number): boolean {
  const allowed = parseIds(env.ALLOWED_CHAT_IDS);
  return allowed.length === 0 || allowed.includes(String(chatId));
}

function room(env: Env, convId: number) {
  return env.COUNCIL_ROOM.get(env.COUNCIL_ROOM.idFromName(String(convId)));
}

/** The group the council calls home: shared memory, phone calls, global reports. */
function homeIdentity(env: Env): Identity | null {
  const id = Number(env.HOME_CHAT_ID || parseIds(env.ALLOWED_CHAT_IDS)[0]);
  return id ? { convId: id, chatId: id } : null;
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
      ctx.waitUntil(answerCallback(env, agent, cb.callbackId, "Only the founder can do this."));
      return new Response("ok");
    }
    ctx.waitUntil(room(env, cb.convId).handleCallback(cb).catch((err) => console.error("handleCallback failed", err)));
    return new Response("ok");
  }

  // Reactions on an agent's message are feedback for that agent (the bot must be a group admin to see them).
  if (update.message_reaction) {
    ctx.waitUntil(
      (async () => {
        for (const r of parseReactions(update, agent)) {
          if (!isOwner(env, r.fromId)) continue;
          const msg = await store.messageByTelegramId(r.convId, r.messageId);
          if (msg && isAgentId(msg.speaker)) await store.ops.addFeedback(r.convId, msg.speaker, msg.id, r.emoji, r.score);
        }
      })().catch((err) => console.error("reaction failed", err)),
    );
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

/** Twilio calls the council: only the founder's numbers get through, into the home group's room. */
async function handleTwilioVoice(request: Request, env: Env): Promise<Response> {
  const xml = (body: string) => new Response(body, { headers: { "content-type": "text/xml" } });
  const home = homeIdentity(env);
  if (!env.TWILIO_AUTH_TOKEN || !home) return xml(twimlReject());
  const form = await request.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => (params[k] = String(v)));
  const url = env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/$/, "")}/twilio/voice` : request.url;
  if (!(await validateTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params, request.headers.get("X-Twilio-Signature")))) {
    return new Response("bad signature", { status: 403 });
  }
  const allowed = parseIds(env.OWNER_PHONE_NUMBERS ?? "").map(normalizePhone);
  if (!allowed.includes(normalizePhone(params.From ?? ""))) return xml(twimlReject());
  const host = new URL(url).host;
  const token = await signRoomToken(env.TELEGRAM_WEBHOOK_SECRET, home.convId, 10 * 60_000);
  return xml(twiml(`wss://${host}/twilio/stream`, token));
}

async function handleTwilioStream(request: Request, env: Env): Promise<Response> {
  const home = homeIdentity(env);
  if (!home || request.headers.get("Upgrade") !== "websocket") return new Response("no", { status: 400 });
  // The room verifies the signed token Twilio passes in the stream's start message.
  const headers = new Headers(request.headers);
  headers.set("x-socket-kind", "phone");
  return room(env, home.convId).fetch(new Request(request.url, { headers, method: "GET" }));
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  if (url.pathname === "/admin") {
    return new Response(renderAdmin(), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" } });
  }
  if ((await verifyRoomToken(adminSecret(env), token)) === null) return new Response("unauthorized", { status: 401 });
  return Response.json(await adminData(env));
}

async function runScheduled(env: Env, ctx: ExecutionContext, at: Date): Promise<void> {
  const store = new MemoryStore(env.DB, env.AI, env.VECTORIZE);
  const frozen = await store.ops.isFrozen();
  const home = homeIdentity(env);
  for (const routine of dueRoutines(at)) {
    switch (routine) {
      case "watchers":
        if (!frozen) ctx.waitUntil(runDueWatchers(env));
        break;
      case "cleanup":
        ctx.waitUntil(store.cleanupSeenUpdates(Date.now() - LIMITS.seenUpdatesTtlMs));
        break;
      case "consolidate":
        if (home) ctx.waitUntil(consolidateMemories(env, store, home.convId).catch((err) => console.error("consolidation failed", err)));
        break;
      case "backup":
        ctx.waitUntil(runBackup(env).then((r) => (home ? sendSystem(env, home.chatId, r) : undefined)).catch((err) => console.error("backup failed", err)));
        break;
      case "brief":
      case "weekly_plan":
      case "weekly_retro":
        if (frozen) break;
        for (const chat of await store.chatsWithBrief()) {
          const r = room(env, chat.conv_id);
          ctx.waitUntil((routine === "brief" ? r.startBrief() : r.startRoutine(routine)).catch((err) => console.error(`${routine} failed`, err)));
        }
        break;
      case "reflection":
      case "scout":
        if (!frozen && home && env.JOBS) ctx.waitUntil(startJob(env, store, { kind: routine === "reflection" ? "reflect" : "scout", identity: home }).catch((err) => console.error(`${routine} failed`, err)));
        break;
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") return new Response("AI Council is running.");
    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(renderApp(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://${url.host}; media-src 'self' blob: data:; img-src 'self' data:`,
        },
      });
    }
    if (url.pathname === "/voice/ws") return handleVoiceSocket(request, env);
    if (url.pathname === "/admin" || url.pathname === "/admin/api") return handleAdmin(request, env, url);
    if (request.method === "POST" && url.pathname === "/twilio/voice") return handleTwilioVoice(request, env);
    if (url.pathname === "/twilio/stream") return handleTwilioStream(request, env);
    if (request.method === "POST" && url.pathname === "/github/webhook") return handleGithubWebhook(request, env);

    const webhook = /^\/telegram\/webhook(?:\/([a-z]+))?$/.exec(url.pathname);
    if (request.method === "POST" && webhook) {
      const agent = webhook[1] ?? hostAgent(env);
      if (!isAgentId(agent)) return new Response("not found", { status: 404 });
      return handleTelegram(request, env, ctx, agent);
    }

    return new Response("not found", { status: 404 });
  },

  /** One cron every 15 minutes; ops/schedule.ts decides what's due. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runScheduled(env, ctx, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
