import { LIMITS } from "../../config";
import type { Skill } from "../types";
import { num, str } from "../types";
import { parseHttpUrl } from "./web";

/** Convert any document Workers AI understands (PDF, Office, HTML, images, CSV…) to Markdown. */
export async function toMarkdown(ai: Ai, name: string, bytes: Uint8Array, mimeType?: string): Promise<string> {
  const blob = new Blob([bytes], mimeType ? { type: mimeType } : undefined);
  const res = await ai.toMarkdown({ name, blob });
  if (res.format === "error") throw new Error(res.error);
  return res.data;
}

export const docRead: Skill = {
  id: "doc.read",
  description:
    "Read a document the founder sent to the chat (shown in the transcript as [sent document … (doc #N)]). Use offset to read further into long documents.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number", description: "Document number" },
      offset: { type: "number", description: "Character offset to start from (default 0)" },
    },
    required: ["id"],
  },
  risk: "read",
  untrusted: true,
  async run(args, ctx) {
    const doc = await ctx.store.getDocument(num(args.id, -1));
    if (!doc || !ctx.sharedConvIds.includes(doc.conv_id)) return "No such document in this conversation.";
    const offset = Math.max(0, num(args.offset, 0));
    const part = doc.markdown.slice(offset, offset + LIMITS.maxSkillResultChars);
    const more = offset + part.length < doc.markdown.length ? `\n\n[${doc.markdown.length - offset - part.length} more characters: call again with offset ${offset + part.length}]` : "";
    return `# ${doc.name}\n\n${part}${more}`;
  },
};

export const docParse: Skill = {
  id: "doc.parse",
  description:
    "Download a document from a URL (PDF, Word, Excel, PowerPoint, CSV, HTML) and read it as structured text. Use for reports, specs, pitch decks and papers.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  risk: "read",
  untrusted: true,
  async run(args, ctx) {
    const url = parseHttpUrl(args.url);
    if (!url) return "Invalid URL.";
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return `Download failed: HTTP ${res.status}`;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) return "Document is larger than 20 MB.";
    const name = url.pathname.split("/").pop() || "document";
    const markdown = await toMarkdown(ctx.env.AI, name, bytes, res.headers.get("content-type") ?? undefined);
    const id = await ctx.store.saveDocument(ctx.convId, name, markdown);
    const head = markdown.slice(0, LIMITS.maxSkillResultChars);
    return `Saved as doc #${id} (${markdown.length} characters).\n\n${head}`;
  },
};
