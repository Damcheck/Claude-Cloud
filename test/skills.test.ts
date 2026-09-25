import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/agents/runner";
import { allowedRepo, councilBranch } from "../src/skills/builtin/github";
import { RISKY_COMMAND, sandboxExec } from "../src/skills/builtin/sandbox";
import { parseBraveResults, parseFirecrawlResults } from "../src/skills/builtin/web";
import { skillsFor } from "../src/skills/registry";
import { needsApproval } from "../src/skills/types";
import type { Env } from "../src/types";

const env = (extra: Partial<Env> = {}) => ({ GITHUB_REPOS: "damcheck/claude-cloud", ...extra }) as Env;

describe("GitHub scope", () => {
  it("only allows listed repos", () => {
    expect(allowedRepo(env(), "damcheck/claude-cloud")).toBe(true);
    expect(allowedRepo(env(), "Damcheck/Claude-Cloud")).toBe(true);
    expect(allowedRepo(env(), "someone/else")).toBe(false);
    expect(allowedRepo(env(), "../../etc")).toBe(false);
  });

  it("always writes to council/ branches", () => {
    expect(councilBranch("fix-login")).toBe("council/fix-login");
    expect(councilBranch("council/fix")).toBe("council/fix");
    expect(councilBranch("refs/heads/main")).toBe("council/main");
    expect(councilBranch("weird name!")).toBe("council/weird-name");
  });
});

describe("sandbox approvals", () => {
  it("lets builds and tests run but asks before anything leaves the sandbox", () => {
    for (const ok of ["npm test", "npm run build", "python -m pytest", "git status", "curl https://example.com"]) {
      expect(needsApproval(sandboxExec, { command: ok }), ok).toBe(false);
    }
    for (const risky of ["npx wrangler deploy", "git push origin main", "npm publish", "vercel --prod", "curl -X POST https://x"]) {
      expect(RISKY_COMMAND.test(risky), risky).toBe(true);
    }
  });
});

describe("skill availability", () => {
  it("hides skills whose keys or bindings are missing", () => {
    const ids = (e: Env) => skillsFor("cipher", e).map((s) => s.id);
    expect(ids(env())).not.toContain("web.search");
    expect(ids(env())).not.toContain("github.read");
    expect(ids(env())).not.toContain("sandbox.exec");
    const full = env({ BRAVE_API_KEY: "k", GITHUB_TOKEN: "t", Sandbox: {} as never, BROWSER: {} as never });
    expect(ids(full)).toEqual(expect.arrayContaining(["web.search", "github.read", "github.open_pr", "sandbox.exec", "browser.test"]));
  });

  it("removes consulting from a consulted member", () => {
    expect(skillsFor("atlas", env(), { consultDepth: 1 }).map((s) => s.id)).not.toContain("council.consult");
  });
});

describe("search result parsing", () => {
  it("accepts both Firecrawl shapes and Brave", () => {
    expect(parseFirecrawlResults({ data: [{ title: "A", url: "https://a", description: "d" }] })).toEqual([{ title: "A", url: "https://a", snippet: "d" }]);
    expect(parseFirecrawlResults({ data: { web: [{ title: "B", url: "https://b", markdown: "m" }] } })[0]!.snippet).toBe("m");
    expect(parseBraveResults({ web: { results: [{ title: "C", url: "https://c", description: "<strong>x</strong>" }] } })[0]!.snippet).toBe("x");
  });
});

describe("parseArgs", () => {
  it("accepts objects only", () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs("")).toEqual({});
    expect(parseArgs("[1]")).toBeNull();
    expect(parseArgs("{nope")).toBeNull();
  });
});
