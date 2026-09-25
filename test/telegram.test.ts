import { describe, expect, it } from "vitest";
import { dmConvId, parseCallback, parseIncoming, type TelegramMessage } from "../src/telegram/api";

const human = { id: 42, is_bot: false, first_name: "Dam" };
const group = { id: -100123, type: "supergroup" };

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
    expect(parseIncoming(msg, "nexus", "nexus")?.replyToAgent).toBe("forge");
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
