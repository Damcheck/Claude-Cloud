import { AGENTS } from "../../agents/registry";
import { LIMITS } from "../../config";
import { parseIds } from "../../telegram/api";
import type { Env } from "../../types";
import type { Skill, SkillContext } from "../types";
import { num, str } from "../types";

/**
 * GitHub skills over the REST API with a fine-grained token.
 * Scope rules: only repos listed in GITHUB_REPOS; writes only to `council/*` branches;
 * opening a PR needs the founder's approval; there is no merge skill at all.
 */

const API = "https://api.github.com";
export const BRANCH_PREFIX = "council/";

export function allowedRepo(env: Env, repo: string): boolean {
  const allowed = parseIds(env.GITHUB_REPOS).map((r) => r.toLowerCase());
  return /^[\w.-]+\/[\w.-]+$/.test(repo) && allowed.includes(repo.toLowerCase());
}

export function councilBranch(name: string): string {
  const clean = name
    .replace(/^refs\/heads\//, "")
    .replace(/[^\w./-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.startsWith(BRANCH_PREFIX) ? clean : BRANCH_PREFIX + clean;
}

async function gh<T = any>(env: Env, path: string, init: RequestInit & { accept?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: init.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ai-council",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (res.status === 404) throw new GitHubNotFound(path);
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
}

class GitHubNotFound extends Error {
  constructor(path: string) {
    super(`Not found: ${path}`);
  }
}

function repoArg(args: Record<string, unknown>, ctx: SkillContext): string {
  const repo = str(args.repo).trim();
  if (!repo) return "";
  return allowedRepo(ctx.env, repo) ? repo : "";
}

function scopeError(ctx: SkillContext): string {
  return `Repo not allowed. Allowed repos: ${parseIds(ctx.env.GITHUB_REPOS).join(", ") || "(none configured)"}`;
}

async function defaultBranch(env: Env, repo: string): Promise<string> {
  const r = await gh<{ default_branch: string }>(env, `/repos/${repo}`);
  return r.default_branch;
}

const available = (env: Env) => !!env.GITHUB_TOKEN;
const clip = (s: string, n: number = LIMITS.maxSkillResultChars) => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

export const githubRead: Skill = {
  id: "github.read",
  description:
    "Read a GitHub repository: action=tree (file list), file (contents at path), search (code search), commits, issues, prs (open PRs), pr (one PR with changed files), pr_diff (the PR's diff). Use before making claims about code.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      action: { type: "string", enum: ["tree", "file", "search", "commits", "issues", "prs", "pr", "pr_diff"] },
      path: { type: "string" },
      ref: { type: "string", description: "Branch, tag or commit (default: default branch)" },
      query: { type: "string" },
      number: { type: "number", description: "PR or issue number" },
    },
    required: ["repo", "action"],
  },
  risk: "read",
  untrusted: true,
  available,
  async run(args, ctx) {
    const repo = repoArg(args, ctx);
    if (!repo) return scopeError(ctx);
    const env = ctx.env;
    try {
      const ref = str(args.ref) || (await defaultBranch(env, repo));
      switch (str(args.action)) {
        case "tree": {
          const t = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
            env,
            `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
          );
          const files = t.tree.filter((e) => e.type === "blob").map((e) => e.path);
          return clip(`${files.length} files on ${ref}${t.truncated ? " (truncated)" : ""}:\n${files.slice(0, 500).join("\n")}`);
        }
        case "file": {
          const path = str(args.path).replace(/^\/+/, "");
          const text = await gh<string>(env, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
            accept: "application/vnd.github.raw+json",
          });
          return clip(`${path} @ ${ref}:\n${typeof text === "string" ? text : JSON.stringify(text)}`, 12_000);
        }
        case "search": {
          const q = `${str(args.query)} repo:${repo}`;
          const r = await gh<{ items: { path: string }[] }>(env, `/search/code?q=${encodeURIComponent(q)}&per_page=20`);
          return r.items.length ? r.items.map((i) => i.path).join("\n") : "No matches.";
        }
        case "commits": {
          const r = await gh<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>(
            env,
            `/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=10`,
          );
          return r.map((c) => `${c.sha.slice(0, 7)} ${c.commit.author.date.slice(0, 10)} ${c.commit.author.name}: ${c.commit.message.split("\n")[0]}`).join("\n");
        }
        case "issues": {
          const r = await gh<{ number: number; title: string; pull_request?: unknown; labels: { name: string }[] }[]>(
            env,
            `/repos/${repo}/issues?state=open&per_page=20`,
          );
          const issues = r.filter((i) => !i.pull_request);
          return issues.length ? issues.map((i) => `#${i.number} ${i.title} ${i.labels.map((l) => `[${l.name}]`).join("")}`).join("\n") : "No open issues.";
        }
        case "prs": {
          const r = await gh<{ number: number; title: string; head: { ref: string }; draft: boolean }[]>(env, `/repos/${repo}/pulls?state=open&per_page=20`);
          return r.length ? r.map((p) => `#${p.number} ${p.draft ? "[draft] " : ""}${p.title} (${p.head.ref})`).join("\n") : "No open PRs.";
        }
        case "pr": {
          const n = num(args.number, 0);
          const [pr, files] = await Promise.all([
            gh<{ title: string; body: string | null; state: string; head: { ref: string }; base: { ref: string }; html_url: string }>(env, `/repos/${repo}/pulls/${n}`),
            gh<{ filename: string; status: string; additions: number; deletions: number }[]>(env, `/repos/${repo}/pulls/${n}/files?per_page=100`),
          ]);
          return clip(
            `#${n} ${pr.title} [${pr.state}] ${pr.head.ref} → ${pr.base.ref}\n${pr.html_url}\n\n${pr.body ?? ""}\n\nFiles:\n` +
              files.map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n"),
          );
        }
        case "pr_diff": {
          const diff = await gh<string>(env, `/repos/${repo}/pulls/${num(args.number, 0)}`, { accept: "application/vnd.github.diff" });
          return clip(String(diff), 14_000);
        }
        default:
          return "Unknown action.";
      }
    } catch (err) {
      return err instanceof GitHubNotFound ? "Not found (check the path, ref or number)." : String(err instanceof Error ? err.message : err);
    }
  },
};

export const githubWrite: Skill = {
  id: "github.write",
  description:
    "Commit files to a council/ branch of an allowed repo (created from the default branch if new). Never touches the default branch. Test your change in the sandbox first. Returns the commit URL.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      branch: { type: "string", description: "Branch name; council/ is added if missing" },
      message: { type: "string", description: "Commit message" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string", description: "Full new file content" } },
          required: ["path", "content"],
        },
      },
    },
    required: ["repo", "branch", "message", "files"],
  },
  risk: "write",
  scope: "external",
  available,
  async run(args, ctx) {
    const repo = repoArg(args, ctx);
    if (!repo) return scopeError(ctx);
    const env = ctx.env;
    const branch = councilBranch(str(args.branch));
    const files = (Array.isArray(args.files) ? args.files : []) as { path?: unknown; content?: unknown }[];
    if (!files.length) return "No files given.";
    if (files.length > 30) return "Too many files in one commit (max 30).";

    let headSha: string;
    try {
      headSha = (await gh<{ object: { sha: string } }>(env, `/repos/${repo}/git/ref/heads/${branch}`)).object.sha;
    } catch (err) {
      if (!(err instanceof GitHubNotFound)) throw err;
      const base = await defaultBranch(env, repo);
      const baseSha = (await gh<{ object: { sha: string } }>(env, `/repos/${repo}/git/ref/heads/${base}`)).object.sha;
      await gh(env, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) });
      headSha = baseSha;
    }
    const commit = await gh<{ tree: { sha: string } }>(env, `/repos/${repo}/git/commits/${headSha}`);
    const tree = await gh<{ sha: string }>(env, `/repos/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: commit.tree.sha,
        tree: files.map((f) => ({ path: str(f.path).replace(/^\/+/, ""), mode: "100644", type: "blob", content: str(f.content) })),
      }),
    });
    const author = AGENTS[ctx.agent].name;
    const created = await gh<{ sha: string; html_url: string }>(env, `/repos/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: `${str(args.message)}\n\nCommitted by ${author} (AI Council)`, tree: tree.sha, parents: [headSha] }),
    });
    await gh(env, `/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: created.sha }) });
    return `Committed ${files.length} file(s) to ${repo}@${branch}: ${created.html_url}`;
  },
};

export const githubOpenPr: Skill = {
  id: "github.open_pr",
  description:
    "Open a draft pull request from a council/ branch. Needs the founder's approval: the founder gets ✅/❌ buttons. Forge automatically reviews every PR Cipher opens.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["repo", "branch", "title"],
  },
  risk: "write",
  scope: "external",
  requiresApproval: true,
  available,
  describeCall: (args) => `open a draft PR on ${str(args.repo)} from ${councilBranch(str(args.branch))}: “${str(args.title)}”`,
  async run(args, ctx) {
    const repo = repoArg(args, ctx);
    if (!repo) return scopeError(ctx);
    const env = ctx.env;
    const pr = await gh<{ number: number; html_url: string }>(env, `/repos/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: str(args.title),
        head: councilBranch(str(args.branch)),
        base: await defaultBranch(env, repo),
        body: `${str(args.body)}\n\n---\nOpened by ${AGENTS[ctx.agent].emoji} ${AGENTS[ctx.agent].name} (AI Council) with the founder's approval.`,
        draft: true,
      }),
    });
    if (ctx.agent === "cipher") {
      await ctx.store.addFollowup({
        convId: ctx.convId,
        agent: "forge",
        kind: "pr_review",
        note: `Review ${repo} PR #${pr.number} that Cipher just opened: ${pr.html_url}`,
        refId: pr.number,
        dueAt: Date.now(),
      });
      await ctx.hooks?.scheduleNext();
    }
    return `Opened draft PR #${pr.number}: ${pr.html_url}`;
  },
};

export const githubCiStatus: Skill = {
  id: "github.ci_status",
  description: "Check GitHub Actions runs for a branch or PR head, and read the failing job's log tail. Use when a build or test is failing.",
  parameters: {
    type: "object",
    properties: { repo: { type: "string" }, ref: { type: "string", description: "Branch name (default: default branch)" } },
    required: ["repo"],
  },
  risk: "read",
  untrusted: true,
  available,
  async run(args, ctx) {
    const repo = repoArg(args, ctx);
    if (!repo) return scopeError(ctx);
    const env = ctx.env;
    const branch = str(args.ref) || (await defaultBranch(env, repo));
    const runs = await gh<{ workflow_runs: { id: number; name: string; status: string; conclusion: string | null; head_sha: string; html_url: string }[] }>(
      env,
      `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`,
    );
    if (!runs.workflow_runs.length) return `No workflow runs on ${branch}.`;
    const lines = runs.workflow_runs.map((r) => `${r.name}: ${r.conclusion ?? r.status} (${r.head_sha.slice(0, 7)}) ${r.html_url}`);
    const failed = runs.workflow_runs.find((r) => r.conclusion === "failure");
    if (failed) {
      const jobs = await gh<{ jobs: { id: number; name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }[] }>(
        env,
        `/repos/${repo}/actions/runs/${failed.id}/jobs`,
      );
      const job = jobs.jobs.find((j) => j.conclusion === "failure");
      if (job) {
        const step = job.steps?.find((s) => s.conclusion === "failure")?.name ?? "?";
        let log = "";
        try {
          log = tail(String(await gh<string>(env, `/repos/${repo}/actions/jobs/${job.id}/logs`, { accept: "application/vnd.github.v3.raw" })), 3000);
        } catch {
          log = "(log not available)";
        }
        lines.push(`\nFailing job: ${job.name}, step: ${step}\nLog tail:\n${log}`);
      }
    }
    return clip(lines.join("\n"));
  },
};

export const githubComment: Skill = {
  id: "github.comment",
  description: "Post a comment on a PR or issue in an allowed repo, e.g. your code review of a PR.",
  parameters: {
    type: "object",
    properties: { repo: { type: "string" }, number: { type: "number" }, body: { type: "string" } },
    required: ["repo", "number", "body"],
  },
  risk: "write",
  scope: "external",
  available,
  async run(args, ctx) {
    const repo = repoArg(args, ctx);
    if (!repo) return scopeError(ctx);
    const a = AGENTS[ctx.agent];
    const res = await gh<{ html_url: string }>(ctx.env, `/repos/${repo}/issues/${num(args.number, 0)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `${str(args.body)}\n\n— ${a.emoji} ${a.name} (AI Council)` }),
    });
    return `Commented: ${res.html_url}`;
  },
};
