import { LIMITS } from "../../config";
import type { Skill } from "../types";
import { num, str } from "../types";

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

export function parseHttpUrl(raw: unknown): URL | null {
  try {
    const url = new URL(str(raw));
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
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
    const url = parseHttpUrl(args.url);
    if (!url) return "Invalid URL: only http(s) URLs are allowed.";
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "AI-Council/0.2" },
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

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Firecrawl has returned both `data: [...]` and `data: { web: [...] }`; accept either. */
export function parseFirecrawlResults(json: unknown): SearchResult[] {
  const data = (json as { data?: unknown })?.data;
  const list = Array.isArray(data) ? data : ((data as { web?: unknown[] })?.web ?? []);
  return (list as Record<string, unknown>[]).map((r) => ({
    title: str(r.title),
    url: str(r.url),
    snippet: str(r.description ?? r.snippet ?? r.markdown).slice(0, 500),
  }));
}

export function parseBraveResults(json: unknown): SearchResult[] {
  const list = ((json as { web?: { results?: unknown[] } })?.web?.results ?? []) as Record<string, unknown>[];
  return list.map((r) => ({ title: str(r.title), url: str(r.url), snippet: htmlToText(str(r.description)).slice(0, 500) }));
}

export const webSearch: Skill = {
  id: "web.search",
  description:
    "Search the web for current information: news, competitors, prices, documentation, facts you're not sure about. Use it instead of guessing whenever recency or accuracy matters. Returns titles, URLs and snippets; use web.fetch to read a result in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "Results to return, 1-8 (default 5)" },
    },
    required: ["query"],
  },
  risk: "read",
  available: (env) => !!(env.FIRECRAWL_API_KEY || env.BRAVE_API_KEY),
  async run(args, ctx) {
    const query = str(args.query).trim();
    if (!query) return "Empty query.";
    const limit = Math.min(8, Math.max(1, num(args.limit, 5)));
    let results: SearchResult[];
    if (ctx.env.FIRECRAWL_API_KEY) {
      const res = await fetch("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.env.FIRECRAWL_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return `Search failed: HTTP ${res.status}`;
      results = parseFirecrawlResults(await res.json());
    } else {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
        headers: { accept: "application/json", "X-Subscription-Token": ctx.env.BRAVE_API_KEY! },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return `Search failed: HTTP ${res.status}`;
      results = parseBraveResults(await res.json());
    }
    if (!results.length) return "No results.";
    return results
      .slice(0, limit)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
      .join("\n\n");
  },
};
