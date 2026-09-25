import { describe, expect, it } from "vitest";
import { renderApp } from "../src/voice/app";
import { renderAdmin } from "../src/ops/admin";
import { extractJson } from "../src/ai/json";
import { isRetryable } from "../src/ai/workers-ai";
import { checkScenario, scoreScenario, SCENARIOS } from "../src/evals/suite";
import { extractCodeBlocks, sectionSlug } from "../src/jobs/design";
import { urlsFromSearch } from "../src/jobs/research";
import { textModelIds } from "../src/jobs/scout";
import { cleanName, sameValue } from "../src/knowledge/graph";
import { parseRpcBody, parseServers } from "../src/mcp/client";
import { dueRoutines } from "../src/ops/schedule";
import { parseReactions, reactionScore, dmConvId } from "../src/telegram/api";
import { hostAllowed, validateTool } from "../src/tools/custom";

describe("JSON from models", () => {
  it("finds JSON inside reasoning, fences and prose", () => {
    expect(extractJson('<think>{"no":1}</think>Sure! ```json\n{"a": [1, {"b": "}"}]}\n``` done')).toEqual({ a: [1, { b: "}" }] });
    expect(extractJson("nothing here")).toBeNull();
    expect(extractJson("[1,2]")).toEqual([1, 2]);
  });

  it("knows which errors are worth retrying", () => {
    expect(isRetryable(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryable(new Error("AiError: 3040: Capacity temporarily exceeded"))).toBe(true);
    expect(isRetryable(new Error("model not found"))).toBe(false);
  });
});

describe("evals", () => {
  it("checks scenarios deterministically", () => {
    const brief = SCENARIOS.find((s) => s.id === "nothing-to-add")!;
    expect(checkScenario(brief, null).checks).toBe(1);
    expect(scoreScenario(brief, { passed: true, checks: 1 }, null)).toBe(1);
    const must = SCENARIOS.find((s) => s.id === "concrete-plan")!;
    expect(checkScenario(must, null).checks).toBe(0);
  });

  it("penalizes not challenging a false claim", () => {
    const s = SCENARIOS.find((x) => x.id === "false-claim")!;
    const good = scoreScenario(s, { passed: false, checks: 1 }, { independence: 5, usefulness: 5, accuracy: 5, challenged: true });
    const bad = scoreScenario(s, { passed: false, checks: 1 }, { independence: 5, usefulness: 5, accuracy: 5, challenged: false });
    expect(good).toBeGreaterThan(bad);
  });
});

describe("jobs helpers", () => {
  it("extracts code blocks and slugs", () => {
    expect(extractCodeBlocks("```html\n<div/>\n```\ntext\n```liquid\n{% schema %}{% endschema %}\n```")).toEqual({ html: "<div/>", liquid: "{% schema %}{% endschema %}" });
    expect(sectionSlug("A Hero banner with CTA!")).toBe("a-hero-banner-with");
  });

  it("reads URLs from search output", () => {
    expect(urlsFromSearch("1. Title A\nhttps://a.dev\nsnippet\n\n2. Title B\nhttps://b.dev\nx")).toEqual([
      { url: "https://a.dev", title: "Title A" },
      { url: "https://b.dev", title: "Title B" },
    ]);
  });

  it("picks text models from the catalog", () => {
    expect(textModelIds([{ name: "@cf/x/y", task: { name: "Text Generation" } }, { name: "@cf/x/z", task: { name: "Text-to-Image" } }, { name: "other", task: { name: "Text Generation" } }])).toEqual(["@cf/x/y"]);
  });
});

describe("knowledge graph", () => {
  it("treats trivially different values as the same", () => {
    expect(sameValue("Supabase", "supabase.")).toBe(true);
    expect(sameValue("Supabase Postgres", "Supabase")).toBe(true);
    expect(sameValue("Firebase", "Supabase")).toBe(false);
    expect(cleanName("  Open   Bloom ")).toBe("Open Bloom");
  });
});

describe("MCP", () => {
  it("parses configs and both response styles", () => {
    expect(parseServers('[{"name":"sentry","url":"https://mcp.sentry.dev/mcp","agents":["forge"]},{"name":"bad name","url":"http://x","agents":[]}]').map((s) => s.name)).toEqual(["sentry"]);
    expect(parseServers("not json")).toEqual([]);
    expect(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":{"ok":1}}', "application/json", 3).result).toEqual({ ok: 1 });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
    expect(parseRpcBody(sse, "text/event-stream", 2).result).toEqual({ tools: [] });
  });
});

describe("custom tools", () => {
  it("validates code and domains", () => {
    const ok = { name: "refund_rate", code: "export default async function (args) { return 1 }", allowed_domains: ["api.shopify.com", "*.myshopify.com"] };
    expect(validateTool(ok)).toBeNull();
    expect(validateTool({ ...ok, name: "Bad-Name" })).toContain("Name");
    expect(validateTool({ ...ok, code: "return 1" })).toContain("export default");
    expect(validateTool({ ...ok, code: 'import x from "evil"; export default () => x' })).toContain("import");
    expect(validateTool({ ...ok, allowed_domains: ["http://x"] })).toContain("Invalid domain");
  });

  it("enforces the egress allowlist", () => {
    expect(hostAllowed("api.shopify.com", ["api.shopify.com"])).toBe(true);
    expect(hostAllowed("shop.myshopify.com", ["*.myshopify.com"])).toBe(true);
    expect(hostAllowed("myshopify.com", ["*.myshopify.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["*.myshopify.com"])).toBe(false);
    expect(hostAllowed("myshopify.com.evil.com", ["*.myshopify.com"])).toBe(false);
  });
});

describe("schedule", () => {
  it("fires routines in their 15-minute bucket (UTC)", () => {
    expect(dueRoutines(new Date("2026-09-28T06:45:00Z"))).toEqual(["watchers", "brief"]); // Monday
    expect(dueRoutines(new Date("2026-09-28T07:05:00Z"))).toEqual(["watchers", "weekly_plan"]);
    expect(dueRoutines(new Date("2026-10-02T16:20:00Z"))).toEqual(["watchers", "reflection"]); // Friday
    expect(dueRoutines(new Date("2026-09-27T03:00:00Z"))).toEqual(["watchers", "backup"]); // Sunday
    expect(dueRoutines(new Date("2026-09-29T12:00:00Z"))).toEqual(["watchers"]);
  });
});

describe("reactions", () => {
  it("scores emoji and reports only newly added ones", () => {
    expect(reactionScore("👍")).toBe(1);
    expect(reactionScore("👎")).toBe(-1);
    expect(reactionScore("🤔")).toBe(0);
    const events = parseReactions(
      {
        update_id: 1,
        message_reaction: {
          chat: { id: 42, type: "private" },
          message_id: 9,
          user: { id: 42, is_bot: false },
          old_reaction: [{ type: "emoji", emoji: "🔥" }],
          new_reaction: [
            { type: "emoji", emoji: "🔥" },
            { type: "emoji", emoji: "👎" },
          ],
        },
      },
      "atlas",
    );
    expect(events).toEqual([{ convId: dmConvId(42, "atlas"), chatId: 42, fromId: 42, messageId: 9, emoji: "👎", score: -1 }]);
  });
});

describe("client pages", () => {
  it("ship scripts that parse", () => {
    for (const html of [renderApp(), renderAdmin()]) {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    }
  });
});
