import { afterEach, describe, expect, it, vi } from "vitest";
import { dmConvId, isOwner, parseCallback, parseIncoming, sendAs, type TelegramMessage } from "../src/telegram/api";
import type { Env } from "../src/types";

const human = { id: 42, is_bot: false, first_name: "Dam" };
const group = { id: -100123, type: "supergroup" };

afterEach(() => vi.unstubAllGlobals());

describe("parseIncoming", () => {
  it("takes group messages only from the host bot", () => {
    const msg: TelegramMessage = { message_id: 1, chat: group, from: human, text: "hi" };
    expect(parseIncoming(msg, "nexus", "nexus")?.convId).toBe(-100123);
    expect(parseIncoming(msg, "atlas", "nexus")).toBeNull();
  });

  it("gives each agent's DM its own conversation", () => {
    const msg: TelegramMessage = { message_id: 1, chat: { id: 42, type: "private" }, from: human, text: "hey" };
    const atlas = parseIncoming(msg, "atlas", "nexus")!;
    const nova = parseIncoming(msg, "nova", "nexus")!;
    expect(atlas.dmAgent).toBe("atlas");
    expect(atlas.chatId).toBe(42);
    expect(atlas.convId).toBe(dmConvId(42, "atlas"));
    expect(atlas.convId).not.toBe(nova.convId);
  });

  it("ignores bots, and picks up voice notes, images and documents", () => {
    expect(parseIncoming({ message_id: 1, chat: group, from: { ...human, is_bot: true }, text: "x" }, "nexus", "nexus")).toBeNull();
    expect(parseIncoming({ message_id: 1, chat: group, from: human, voice: { file_id: "v1", duration: 3 } }, "nexus", "nexus")?.voiceFileId).toBe("v1");
    const photo = parseIncoming(
      {
        message_id: 1,
        chat: group,
        from: human,
        photo: [
          { file_id: "small", width: 90, height: 90 },
          { file_id: "big", width: 1280, height: 720 },
        ],
      },
      "nexus",
      "nexus",
    );
    expect(photo?.imageFileId).toBe("big");
    const doc = parseIncoming({ message_id: 1, chat: group, from: human, document: { file_id: "d1", file_name: "deck.pdf", mime_type: "application/pdf" } }, "nexus", "nexus");
    expect(doc?.document).toEqual({ fileId: "d1", name: "deck.pdf", mimeType: "application/pdf" });
  });

  it("maps replies to a bot back to its agent", () => {
    const msg: TelegramMessage = {
      message_id: 2,
      chat: group,
      from: human,
      text: "why?",
      reply_to_message: { message_id: 1, chat: group, from: { id: 7, is_bot: true, first_name: "Forge", username: "DamForgeBot" } },
    };
    expect(parseIncoming(msg, "nexus", "nexus")).toMatchObject({
      replyToAgent: "forge",
      replyToMessageId: 1,
      replyToSpeakerName: "Forge",
    });
  });

  it("preserves the quoted message text so the addressed agent understands context", () => {
    const parsed = parseIncoming(
      {
        message_id: 3,
        chat: group,
        from: human,
        text: "I disagree",
        reply_to_message: { message_id: 2, chat: group, from: { id: 9, is_bot: true, first_name: "Atlas", username: "AtlasBot" }, text: "The downside is larger than it looks." },
      },
      "nexus",
      "nexus",
    );
    expect(parsed).toMatchObject({ replyToAgent: "atlas", replyToMessageId: 2, replyToText: "The downside is larger than it looks." });
  });
});

describe("parseCallback", () => {
  it("routes button presses to the right conversation", () => {
    const cb = parseCallback(
      { update_id: 1, callback_query: { id: "c", from: human, data: "ap:3:y", message: { message_id: 9, chat: { id: 42, type: "private" } } } },
      "cipher",
    );
    expect(cb).toMatchObject({ convId: dmConvId(42, "cipher"), data: "ap:3:y", viaAgent: "cipher", messageId: 9 });
  });
});

describe("owner allowlist", () => {
  it("fails closed when OWNER_USER_IDS is empty", () => {
    expect(isOwner({ OWNER_USER_IDS: "" } as Env, 42)).toBe(false);
  });

  it("accepts only explicitly configured owners", () => {
    const env = { OWNER_USER_IDS: "7, 42" } as Env;
    expect(isOwner(env, 42)).toBe(true);
    expect(isOwner(env, 8)).toBe(false);
  });
});

describe("native Telegram replies", () => {
  it("falls back to the founder's native thread when a cross-bot target is unavailable", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const reply = body.reply_parameters as { message_id?: number } | undefined;
        return new Response(
          JSON.stringify(
            reply?.message_id === 99
              ? { ok: false, description: "Bad Request: message to be replied not found" }
              : { ok: true, result: { message_id: 101, reply_to_message: { message_id: reply?.message_id } } },
          ),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const env = { BOT_TOKEN_SAGE: "test-token", HOST_AGENT: "nexus" } as Env;
    await expect(sendAs(env, "sage", -100123, "Atlas, that claim is weak.", undefined, 99, 42)).resolves.toBe(101);
    expect((bodies[0]!.reply_parameters as { message_id: number; allow_sending_without_reply: boolean })).toEqual({ message_id: 99, allow_sending_without_reply: false });
    expect((bodies[1]!.reply_parameters as { message_id: number })).toMatchObject({ message_id: 42 });
  });
});
