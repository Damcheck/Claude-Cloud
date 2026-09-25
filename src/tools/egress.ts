import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../types";
import { hostAllowed } from "./custom";

/** Outbound gateway for custom tools: only https to the tool's declared domains. */
export class ToolEgress extends WorkerEntrypoint<Env, { allow: string[] }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || !hostAllowed(url.hostname, this.ctx.props.allow ?? [])) {
      return new Response(`Blocked: ${url.hostname} is not in this tool's allowed domains`, { status: 403 });
    }
    return fetch(request);
  }
}
