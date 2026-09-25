import { LIMITS } from "../../config";
import type { Env } from "../../types";
import type { Skill, SkillContext } from "../types";
import { str } from "../types";
import { allowedRepo } from "./github";

/**
 * Cloudflare Sandbox (Containers): an isolated Linux box per conversation, shared by
 * Cipher and Forge so they can work on the same checkout. The SDK is imported lazily
 * so the rest of the Worker (and the unit tests) don't depend on it.
 */

/** Commands that leave the sandbox's blast radius need the founder's approval. */
export const RISKY_COMMAND = /\b(deploy|publish|git\s+push|wrangler\s+(deploy|publish|secret|d1\s+\S+\s+--remote)|vercel\s+(--prod|deploy)|npm\s+publish|curl\s+[^|]*-X\s*(POST|PUT|DELETE|PATCH))\b/i;

const available = (env: Env) => !!env.Sandbox;

async function sandboxFor(ctx: SkillContext) {
  const { getSandbox } = await import("@cloudflare/sandbox");
  return getSandbox(ctx.env.Sandbox!, `council-${ctx.convId}`, { sleepAfter: "20m" });
}

function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

export function repoDir(repo: string): string {
  return `/workspace/${repo.split("/")[1]}`;
}

export const sandboxExec: Skill = {
  id: "sandbox.exec",
  description:
    "Run a shell command in your isolated Linux sandbox (Node, Python, git available). Give repo=owner/name to clone an allowed repo (once) and run inside it. Use it to install, build, run tests, reproduce bugs and try fixes. Deploy/publish/push commands need the founder's approval.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      repo: { type: "string", description: "Optional owner/name; the command runs in its checkout" },
    },
    required: ["command"],
  },
  risk: "exec",
  scope: "external",
  untrusted: true,
  requiresApproval: (args) => RISKY_COMMAND.test(str(args.command)),
  describeCall: (args) => `run in the sandbox: \`${str(args.command).slice(0, 200)}\``,
  available,
  async run(args, ctx) {
    const command = str(args.command).trim();
    if (!command) return "Empty command.";
    const sandbox = await sandboxFor(ctx);
    let cwd = "/workspace";
    const repo = str(args.repo).trim();
    if (repo) {
      if (!allowedRepo(ctx.env, repo)) return "Repo not allowed.";
      cwd = repoDir(repo);
      const exists = await sandbox.exec(`test -d ${cwd}/.git && echo yes || echo no`);
      if (exists.stdout.trim() !== "yes") {
        const auth = ctx.env.GITHUB_TOKEN ? `x-access-token:${ctx.env.GITHUB_TOKEN}@` : "";
        await sandbox.gitCheckout(`https://${auth}github.com/${repo}.git`, { targetDir: cwd, depth: 20 });
        // Never leave the token in the checkout: pushes go through github.write, not git.
        await sandbox.exec(`git -C ${cwd} remote set-url origin https://github.com/${repo}.git`);
      }
    }
    const result = await sandbox.exec(command, { cwd, timeout: LIMITS.sandboxTimeoutMs });
    return [
      `$ ${command}  (in ${cwd})`,
      `exit code: ${result.exitCode}`,
      result.stdout ? `stdout:\n${tail(result.stdout, 3500)}` : "",
      result.stderr ? `stderr:\n${tail(result.stderr, 2000)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

/**
 * Run a command with secrets passed as environment variables (never in the command text,
 * which is audited). For internal jobs only; not exposed to agents.
 */
export async function execWithSecrets(ctx: SkillContext, command: string, secrets: Record<string, string>, cwd = "/workspace"): Promise<{ ok: boolean; output: string }> {
  const sandbox = await sandboxFor(ctx);
  const r = await sandbox.exec(command, { cwd, timeout: LIMITS.sandboxTimeoutMs, env: secrets });
  const redact = (t: string) => Object.values(secrets).reduce((acc, v) => (v ? acc.split(v).join("***") : acc), t);
  return { ok: r.exitCode === 0, output: redact(`${r.stdout}\n${r.stderr}`).trim() };
}

export const sandboxWriteFile: Skill = {
  id: "sandbox.write_file",
  description: "Write a file inside the sandbox (under /workspace), e.g. to apply a fix before running tests.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute path under /workspace" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  risk: "exec",
  scope: "external",
  available,
  async run(args, ctx) {
    const path = str(args.path);
    if (!path.startsWith("/workspace/") || path.includes("..")) return "Path must be under /workspace/.";
    const sandbox = await sandboxFor(ctx);
    await sandbox.writeFile(path, str(args.content));
    return `Wrote ${path} (${str(args.content).length} chars).`;
  },
};
