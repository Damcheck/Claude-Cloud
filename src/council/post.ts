import { AGENTS, displayName } from "../agents/registry";
import type { MemoryStore } from "../memory/store";
import type { RoomHooks } from "../skills/types";
import { botToken, escapeHtml, hostAgent, sendAs, sendPhotoAs, sendSystem, sendSystemHtml } from "../telegram/api";
import type { AgentId, Env, Identity } from "../types";

/**
 * Posting and approval plumbing shared by the room and by background jobs (Workflows),
 * so everything an agent says lands in the same Telegram chat and the same transcript.
 */

export async function postAs(
  env: Env,
  store: MemoryStore,
  identity: Identity,
  agent: AgentId,
  text: string,
  discussionId: number | null = null,
): Promise<number | undefined> {
  const telegramId = await sendAs(env, identity.dmAgent ?? agent, identity.chatId, text);
  const id = await store.addMessage(
    { chatId: identity.convId, discussionId, speaker: agent, speakerName: AGENTS[agent].name, text, createdAt: Date.now() },
    telegramId,
  );
  await store.index(identity.convId, `msg:${id}`, `${AGENTS[agent].name}: ${text}`, { kind: "message", speaker: agent });
  return telegramId;
}

export function postSystem(env: Env, identity: Identity, text: string): Promise<void> {
  return sendSystem(env, identity.chatId, text, identity.dmAgent);
}

export function approvalButtons(id: number) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `ap:${id}:y` },
        { text: "❌ Reject", callback_data: `ap:${id}:n` },
      ],
    ],
  };
}

/** Post an approval request from the requesting agent's bot, so the button press reaches its webhook. */
export async function postApprovalRequest(env: Env, store: MemoryStore, identity: Identity, id: number, agent: AgentId, summary: string): Promise<void> {
  const via = identity.dmAgent ?? (botToken(env, agent) ? agent : hostAgent(env));
  const html = `🔐 <b>${escapeHtml(displayName(agent))}</b> wants to ${escapeHtml(summary)}\n\nRequest #${id}`;
  const messageId = await sendSystemHtml(env, identity.chatId, html, via, approvalButtons(id));
  if (messageId) await store.setApprovalMessage(id, messageId);
}

export function makeHooks(env: Env, store: MemoryStore, identity: Identity, poke: () => Promise<void>): RoomHooks {
  return {
    scheduleNext: poke,
    sendPhoto: (agent, png, caption) => sendPhotoAs(env, identity.dmAgent ?? agent, identity.chatId, png, caption),
    requestApproval: (id, agent, summary) => postApprovalRequest(env, store, identity, id, agent, summary),
  };
}

/** Hooks for code running outside the room: re-arming alarms goes through the room's RPC. */
export function remoteHooks(env: Env, store: MemoryStore, identity: Identity): RoomHooks {
  return makeHooks(env, store, identity, async () => {
    await env.COUNCIL_ROOM.get(env.COUNCIL_ROOM.idFromName(String(identity.convId))).poke();
  });
}
