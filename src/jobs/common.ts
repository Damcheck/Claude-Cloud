import { remoteHooks } from "../council/post";
import type { MemoryStore } from "../memory/store";
import type { SkillContext } from "../skills/types";
import { parseIds } from "../telegram/api";
import type { AgentId, Env, Identity, TranscriptMessage } from "../types";

/** Conversation id used for evals: never posts, always dry-run. */
export const EVAL_CONV = -1;

export function sharedConvIds(env: Env, convId: number): number[] {
  const home = Number(env.HOME_CHAT_ID || parseIds(env.ALLOWED_CHAT_IDS)[0]);
  return home && home !== convId ? [convId, home] : [convId];
}

export function callOptions(env: Env, convId: number) {
  return { gatewayId: env.AI_GATEWAY_ID || undefined, metadata: { conv: convId } };
}

/** A skill context for work done outside the room (jobs, watchers). */
export function jobContext(
  env: Env,
  store: MemoryStore,
  identity: Identity,
  agent: AgentId,
  opts: { transcript?: TranscriptMessage[]; tag?: string; missionId?: number; loopback?: unknown; image?: string } = {},
): SkillContext {
  return {
    env,
    store,
    convId: identity.convId,
    chatId: identity.chatId,
    agent,
    sharedConvIds: sharedConvIds(env, identity.convId),
    transcript: opts.transcript ?? [],
    consultDepth: 0,
    callOptions: callOptions(env, identity.convId),
    hooks: identity.convId === EVAL_CONV ? undefined : remoteHooks(env, store, identity),
    usageTag: opts.tag,
    missionId: opts.missionId,
    loopback: opts.loopback,
    image: opts.image,
    discussionId: null,
  };
}
