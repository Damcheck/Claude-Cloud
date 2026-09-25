import type { Skill } from "../skills/types";
import type { AgentId, Env } from "../types";
import { McpClient, parseServers, type McpServerConfig, type McpTool } from "./client";

/**
 * Every tool on every configured MCP server becomes a skill `mcp.<server>.<tool>`,
 * available to the agents listed for that server. Read-only tools (annotation
 * readOnlyHint) run freely; others need approval by default. Output is untrusted.
 */

const cache = new Map<string, { at: number; tools: McpTool[] }>();
const TTL_MS = 10 * 60_000;

function tokenFor(env: Env, server: McpServerConfig): string | undefined {
  const key = server.tokenSecret ?? `MCP_TOKEN_${server.name.toUpperCase()}`;
  return (env as unknown as Record<string, string | undefined>)[key];
}

async function toolsOf(env: Env, server: McpServerConfig): Promise<McpTool[]> {
  const hit = cache.get(server.name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tools;
  try {
    let tools = await new McpClient(server, tokenFor(env, server)).listTools();
    if (server.tools?.length) tools = tools.filter((t) => server.tools!.includes(t.name));
    cache.set(server.name, { at: Date.now(), tools });
    return tools;
  } catch (err) {
    console.warn(`MCP ${server.name} tools/list failed`, err);
    cache.set(server.name, { at: Date.now() - TTL_MS + 60_000, tools: [] }); // retry in a minute
    return [];
  }
}

function toSkill(env: Env, server: McpServerConfig, tool: McpTool): Skill {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const policy = server.approval ?? "writes";
  return {
    id: `mcp.${server.name}.${tool.name}`,
    description: `[${server.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`.slice(0, 1000),
    parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
    risk: readOnly ? "read" : "write",
    scope: "external",
    untrusted: true,
    requiresApproval: policy === "all" || (policy === "writes" && (!readOnly || tool.annotations?.destructiveHint === true)),
    describeCall: (args) => `call ${server.name} tool ${tool.name} with ${JSON.stringify(args).slice(0, 200)}`,
    run: (args) => new McpClient(server, tokenFor(env, server)).callTool(tool.name, args),
  };
}

export async function mcpSkillsFor(agent: AgentId, env: Env): Promise<Skill[]> {
  const servers = parseServers(env.MCP_SERVERS).filter((s) => s.agents.includes(agent) || s.agents.includes("*"));
  const lists = await Promise.all(servers.map(async (s) => (await toolsOf(env, s)).map((t) => toSkill(env, s, t))));
  return lists.flat();
}

export async function mcpSkillById(env: Env, id: string): Promise<Skill | undefined> {
  const [, serverName, ...rest] = id.split(".");
  const toolName = rest.join(".");
  const server = parseServers(env.MCP_SERVERS).find((s) => s.name === serverName);
  if (!server) return undefined;
  const tool = (await toolsOf(env, server)).find((t) => t.name === toolName);
  return tool ? toSkill(env, server, tool) : undefined;
}
