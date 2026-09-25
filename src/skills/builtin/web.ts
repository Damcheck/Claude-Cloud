import { LIMITS } from "../../config";
import type { Skill } from "../types";

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export const webFetch: Skill = {
  id: "web.fetch",
  description:
    "Read a web page and get its text. Use when someone shares a link, or when you need to check a specific page (docs, pricing, a competitor) instead of guessing.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Full https URL" } },
    required: ["url"],
  },
  risk: "read",
  async run(args) {
    let url: URL;
    try {
      url = new URL(String(args.url));
    } catch {
      return "Invalid URL.";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "Only http(s) URLs are allowed.";
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "AI-Council/0.1 (+https://github.com/damcheck/claude-cloud)" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `Fetch failed: HTTP ${res.status}`;
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = type.includes("html") ? htmlToText(body) : body;
    return text.slice(0, LIMITS.maxSkillResultChars);
  },
};
