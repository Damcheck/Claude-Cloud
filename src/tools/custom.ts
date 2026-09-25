import type { CustomToolRow } from "../memory/ops";
import type { MemoryStore } from "../memory/store";
import type { Skill } from "../skills/types";
import type { AgentId, Env } from "../types";

/**
 * Tools the council writes for itself.
 *
 * A tool is an ES module `export default async function (args) { ... }`. Once Forge has
 * reviewed it and the founder has approved it, it runs in its own isolate via the Worker
 * Loader: no bindings, no secrets, a CPU and subrequest cap, and network access only to
 * the domains it declared (enforced by the ToolEgress gateway below).
 */

export const TOOL_NAME = /^[a-z][a-z0-9_]{2,30}$/;
export const MAX_TOOL_CODE = 20_000;

export function validateTool(t: { name: string; code: string; allowed_domains: string[] }): string | null {
  if (!TOOL_NAME.test(t.name)) return "Name must be 3-31 chars: lowercase letters, digits, underscores, starting with a letter.";
  if (t.code.length > MAX_TOOL_CODE) return `Code is longer than ${MAX_TOOL_CODE} characters.`;
  if (!/export\s+default/.test(t.code)) return "Code must `export default` an async function (args) => result.";
  if (/\bimport\s*\(|\bimport\s+[^'"]*from\s+['"](?!\.\/)/.test(t.code)) return "Tools can't import modules.";
  for (const d of t.allowed_domains) {
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)) return `Invalid domain: ${d}`;
  }
  return null;
}

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((d) => {
    const dom = d.toLowerCase();
    return dom.startsWith("*.") ? h.endsWith(dom.slice(1)) || h === dom.slice(2) : h === dom;
  });
}

const WRAPPER = `import run from "./tool.js";
export default {
  async fetch(request) {
    try {
      const { args } = await request.json();
      const out = await run(args ?? {});
      return Response.json({ ok: true, out: typeof out === "string" ? out : JSON.stringify(out) });
    } catch (err) {
      return Response.json({ ok: false, error: String(err && err.message || err) });
    }
  }
};`;

export async function runCustomTool(env: Env, loopback: unknown, tool: CustomToolRow, args: Record<string, unknown>): Promise<string> {
  if (!env.LOADER) return "Custom tools need the Worker Loader binding (LOADER).";
  const allow = JSON.parse(tool.allowed_domains) as string[];
  const exportsObj = loopback as { ToolEgress?: (opts: { props: { allow: string[] } }) => Fetcher } | undefined;
  // Without the loopback gateway the tool gets no network at all.
  const egress = allow.length && exportsObj?.ToolEgress ? exportsObj.ToolEgress({ props: { allow } }) : null;
  const worker = env.LOADER.get(`tool-${tool.id}-v${tool.version}`, () => ({
    compatibilityDate: "2026-09-01",
    mainModule: "main.js",
    modules: { "main.js": WRAPPER, "tool.js": tool.code },
    globalOutbound: egress,
  }));
  const entry = worker.getEntrypoint(undefined, { limits: { cpuMs: 2000, subRequests: 20 } });
  const res = await entry.fetch("https://tool.internal/run", { method: "POST", body: JSON.stringify({ args }) });
  const json = (await res.json()) as { ok: boolean; out?: string; error?: string };
  return json.ok ? String(json.out ?? "").slice(0, 8000) : `Tool error: ${json.error}`;
}

function toSkill(env: Env, tool: CustomToolRow): Skill {
  let parameters: Record<string, unknown>;
  try {
    parameters = JSON.parse(tool.parameters_json);
  } catch {
    parameters = { type: "object", properties: {} };
  }
  return {
    id: `custom.${tool.name}`,
    description: `[council-built tool v${tool.version}] ${tool.description}`,
    parameters,
    risk: "write",
    scope: "external",
    untrusted: true,
    available: (e) => !!e.LOADER,
    run: (args, ctx) => runCustomTool(env, ctx.loopback, tool, args),
  };
}

export async function customSkillsFor(agent: AgentId, env: Env, store: MemoryStore): Promise<Skill[]> {
  if (!env.LOADER) return [];
  const tools = await store.ops.activeTools().catch(() => [] as CustomToolRow[]);
  return tools.filter((t) => (JSON.parse(t.agents) as string[]).some((a) => a === agent || a === "*")).map((t) => toSkill(env, t));
}

export async function customSkillById(env: Env, store: MemoryStore, id: string): Promise<Skill | undefined> {
  const name = id.slice("custom.".length);
  const tools = await store.ops.activeTools().catch(() => [] as CustomToolRow[]);
  const tool = tools.find((t) => t.name === name);
  return tool ? toSkill(env, tool) : undefined;
}
