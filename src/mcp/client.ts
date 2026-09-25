/**
 * Minimal MCP client over Streamable HTTP (JSON-RPC 2.0). Handles JSON and SSE responses
 * and the Mcp-Session-Id header. Enough for tools/list and tools/call.
 */

export interface McpServerConfig {
  /** Short id, used in skill ids: mcp.<name>.<tool> */
  name: string;
  url: string;
  /** Agents allowed to use this server's tools. */
  agents: string[];
  /** Secret holding the bearer token: MCP_TOKEN_<NAME> by default. */
  tokenSecret?: string;
  /** "writes" (default): tools that aren't read-only need approval; "all": every call; "none". */
  approval?: "writes" | "all" | "none";
  /** Optional allowlist of tool names. */
  tools?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

const PROTOCOL_VERSION = "2025-06-18";

export function parseServers(json: string | undefined): McpServerConfig[] {
  if (!json?.trim()) return [];
  try {
    const list = JSON.parse(json) as McpServerConfig[];
    return Array.isArray(list)
      ? list.filter((s) => s && /^[a-z0-9_]{1,20}$/i.test(s.name) && /^https:\/\//.test(s.url) && Array.isArray(s.agents))
      : [];
  } catch {
    console.warn("MCP_SERVERS is not valid JSON");
    return [];
  }
}

/** Parse a JSON-RPC response that may arrive as plain JSON or as an SSE stream. */
export function parseRpcBody(body: string, contentType: string, id: number): any {
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\n\n/)) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) return msg;
      } catch {
        // ignore keep-alives
      }
    }
    throw new Error("No JSON-RPC response in event stream");
  }
  return JSON.parse(body);
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(
    private server: McpServerConfig,
    private token?: string,
  ) {}

  private async post(method: string, params: unknown, notification = false): Promise<any> {
    const id = this.nextId++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
    const res = await fetch(this.server.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (notification) return null;
    if (!res.ok) throw new Error(`MCP ${this.server.name} ${method}: HTTP ${res.status}`);
    const msg = parseRpcBody(await res.text(), res.headers.get("content-type") ?? "", id);
    if (msg.error) throw new Error(`MCP ${this.server.name} ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.post("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ai-council", version: "0.3.0" } });
    await this.post("notifications/initialized", {}, true);
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.init();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.post("tools/list", cursor ? { cursor } : {});
      tools.push(...((r?.tools ?? []) as McpTool[]));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.init();
    const r = await this.post("tools/call", { name, arguments: args });
    const parts = (r?.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[];
    const text = parts
      .map((p) => (p.type === "text" ? p.text : p.type === "resource" ? (p.resource?.text ?? p.resource?.uri) : `[${p.type}${p.mimeType ? ` ${p.mimeType}` : ""}]`))
      .filter(Boolean)
      .join("\n");
    const structured = r?.structuredContent ? `\n${JSON.stringify(r.structuredContent).slice(0, 4000)}` : "";
    return `${r?.isError ? "Tool error: " : ""}${text}${structured}`.trim() || "(empty result)";
  }
}
