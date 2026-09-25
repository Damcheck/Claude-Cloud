import { AGENTS } from "../../agents/registry";
import { bytesToBase64, runVision } from "../../ai/workers-ai";
import { LIMITS } from "../../config";
import type { Env } from "../../types";
import type { Skill, SkillContext } from "../types";
import { str } from "../types";
import { parseHttpUrl } from "./web";

/**
 * Cloudflare Browser Rendering (headless Chrome via Puppeteer). Imported lazily.
 * Screenshots are read by Moondream, so every browser skill can "see" the page.
 */

const available = (env: Env) => !!env.BROWSER;

interface PageReport {
  title: string;
  finalUrl: string;
  status: number | null;
  consoleErrors: string[];
  failedRequests: string[];
  text: string;
  screenshot: Uint8Array;
  steps: string[];
}

async function visit(ctx: SkillContext, url: URL, opts: { mobile: boolean; clicks?: string[] }): Promise<PageReport> {
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  const browser = await puppeteer.launch(ctx.env.BROWSER as any);
  try {
    const page = await browser.newPage();
    await page.setViewport(opts.mobile ? { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 } : { width: 1366, height: 900 });
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => consoleErrors.push(String((e as Error).message ?? e).slice(0, 300)));
    page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 150)} (${r.failure()?.errorText ?? "failed"})`));

    const response = await page.goto(url.toString(), { waitUntil: "networkidle2", timeout: 25_000 });
    const steps: string[] = [];
    for (const selector of opts.clicks ?? []) {
      const before = consoleErrors.length;
      try {
        await page.click(selector);
        await new Promise((r) => setTimeout(r, 1200));
        steps.push(`click ${selector}: ok → ${page.url()}${consoleErrors.length > before ? ` (${consoleErrors.length - before} new console errors)` : ""}`);
      } catch (err) {
        steps.push(`click ${selector}: FAILED (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const title = await page.title();
    const text = String(await page.evaluate("document.body ? document.body.innerText : \"\""));
    const screenshot = (await page.screenshot({ type: "png" })) as Uint8Array;
    return {
      title,
      finalUrl: page.url(),
      status: response?.status() ?? null,
      consoleErrors,
      failedRequests,
      text: text.slice(0, 2500),
      screenshot: new Uint8Array(screenshot),
      steps,
    };
  } finally {
    await browser.close();
  }
}

function describeScreenshot(ctx: SkillContext, png: Uint8Array, question: string): Promise<string> {
  return runVision(
    ctx.env.AI,
    AGENTS.iris.model,
    { task: "query", image: `data:image/png;base64,${bytesToBase64(png)}`, prompt: question, maxTokens: 500 },
    ctx.callOptions,
  );
}

function reportText(r: PageReport, vision: string): string {
  return [
    `Page: ${r.title} — ${r.finalUrl} (HTTP ${r.status ?? "?"})`,
    r.steps.length ? `Steps:\n${r.steps.join("\n")}` : "",
    `Console errors (${r.consoleErrors.length}): ${r.consoleErrors.slice(0, 8).join(" | ") || "none"}`,
    `Failed requests (${r.failedRequests.length}): ${r.failedRequests.slice(0, 6).join(" | ") || "none"}`,
    `What the screenshot shows: ${vision}`,
    `Visible text (start):\n${r.text}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, LIMITS.maxSkillResultChars);
}

export const browserInspect: Skill = {
  id: "browser.inspect",
  description:
    "Open a website in a real browser (desktop or mobile), look at it, and report layout, visible text, console errors and broken requests. Use for UX audits, competitor pages and checking what users actually see.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      question: { type: "string", description: "What to look for in the screenshot" },
      mobile: { type: "boolean" },
    },
    required: ["url"],
  },
  risk: "read",
  available,
  async run(args, ctx) {
    const url = parseHttpUrl(args.url);
    if (!url) return "Invalid URL.";
    const r = await visit(ctx, url, { mobile: !!args.mobile });
    const vision = await describeScreenshot(
      ctx,
      r.screenshot,
      str(args.question) || "Describe the layout, the visual hierarchy, and anything that looks broken, cluttered or confusing for a user.",
    );
    return reportText(r, vision);
  },
};

export const browserTest: Skill = {
  id: "browser.test",
  description:
    "Smoke-test a web page: load it, optionally click CSS selectors in order, and report HTTP status, console errors, failed requests and what the final screen looks like. Use after building or deploying a frontend.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      clicks: { type: "array", items: { type: "string" }, description: "CSS selectors to click, in order" },
      mobile: { type: "boolean" },
    },
    required: ["url"],
  },
  risk: "read",
  available,
  async run(args, ctx) {
    const url = parseHttpUrl(args.url);
    if (!url) return "Invalid URL.";
    const clicks = (Array.isArray(args.clicks) ? args.clicks : []).map((c) => str(c)).slice(0, 10);
    const r = await visit(ctx, url, { mobile: !!args.mobile, clicks });
    const vision = await describeScreenshot(ctx, r.screenshot, "Does this screen look broken? Describe errors, blank areas, overlapping elements or error messages.");
    return reportText(r, vision);
  },
};

export const browserScreenshot: Skill = {
  id: "browser.screenshot",
  description: "Take a screenshot of a web page, post it to the chat, and describe what it shows.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" }, mobile: { type: "boolean" } },
    required: ["url"],
  },
  risk: "read",
  available,
  async run(args, ctx) {
    const url = parseHttpUrl(args.url);
    if (!url) return "Invalid URL.";
    const r = await visit(ctx, url, { mobile: !!args.mobile });
    await ctx.hooks?.sendPhoto(ctx.agent, r.screenshot, `${r.title} — ${r.finalUrl}`);
    return describeScreenshot(ctx, r.screenshot, "Describe this web page: layout, key text, and anything that looks wrong.");
  },
};
