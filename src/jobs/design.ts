import type { WorkflowStep } from "cloudflare:workers";
import { AGENTS } from "../agents/registry";
import { runAgentTurn } from "../agents/runner";
import { askJson } from "../ai/json";
import { base64ToBytes, runChat } from "../ai/workers-ai";
import { postAs, postSystem, remoteHooks } from "../council/post";
import { stripReasoning } from "../council/text";
import { MemoryStore } from "../memory/store";
import { screenshotHtml } from "../skills/builtin/browser";
import { councilBranch, githubWrite } from "../skills/builtin/github";
import { execWithSecrets, sandboxWriteFile } from "../skills/builtin/sandbox";
import { IMAGE_MODEL } from "../skills/builtin/v3";
import { downloadAsDataUri, sendDocumentAs, sendPhotoAs } from "../telegram/api";
import type { Env, Identity } from "../types";
import { callOptions, jobContext } from "./common";

const TARGET_SCORE = 0.85;

/** Pull fenced code blocks by language. */
export function extractCodeBlocks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/```([\w-]+)?\s*\n([\s\S]*?)```/g)) {
    const lang = (m[1] ?? "").toLowerCase();
    if (lang && !out[lang]) out[lang] = m[2]!.trim();
  }
  return out;
}

export function sectionSlug(description: string): string {
  return (
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-") || "section"
  );
}

interface Comparison {
  score: number;
  differences: string[];
}

export async function runDesignLoop(
  env: Env,
  step: WorkflowStep,
  p: { jobId: number; identity: Identity; description: string; mockupFileId?: string; repo?: string; maxIterations?: number },
): Promise<string> {
  const store = new MemoryStore(env.DB, env.AI, env.VECTORIZE);
  const { identity } = p;
  const tag = `job:${p.jobId}`;
  const opts = callOptions(env, identity.convId);
  const via = identity.dmAgent;
  const slug = `council-${sectionSlug(p.description)}`;
  if (!env.BROWSER) {
    await postSystem(env, identity, "🎨 The design loop needs the Browser Rendering binding.");
    return "no browser";
  }

  const mockupId = await step.do("mockup", async () => {
    if (p.mockupFileId) return p.mockupFileId;
    const out = (await (env.AI.run as unknown as (m: string, i: unknown) => Promise<{ image?: string }>)(IMAGE_MODEL, {
      prompt: `High-fidelity website section design mockup, flat UI screenshot, desktop: ${p.description}`,
      steps: 8,
    })) ?? {};
    if (!out.image) throw new Error("mockup generation failed");
    const id = await sendPhotoAs(env, via ?? "iris", identity.chatId, base64ToBytes(out.image), `🎨 Mockup for: ${p.description.slice(0, 150)}`);
    if (!id) throw new Error("couldn't store mockup");
    return id;
  });

  const spec = await step.do("spec", { timeout: "5 minutes" }, async () => {
    const image = await downloadAsDataUri(env, mockupId, via);
    const r = await runChat(
      env.AI,
      AGENTS.axiom.model,
      [
        {
          role: "user",
          content: [
            { type: "text", text: `Describe this design as a precise build spec for a developer: layout and grid, every text string, typography (sizes, weights), colors as hex estimates, spacing, buttons and states, images and their aspect ratios, and how it should adapt on mobile. Context: ${p.description}` },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      { maxTokens: 1200, ...opts },
    );
    await store.recordUsage(identity.convId, "axiom", AGENTS.axiom.model, r.usage.promptTokens, r.usage.completionTokens, tag);
    return stripReasoning(r.text);
  });

  await step.do("announce", () =>
    postAs(env, store, identity, "cipher", `🎨 Building **${slug}** from the mockup. I'll iterate until the render matches (target ${Math.round(TARGET_SCORE * 100)}%).`).then(() => "ok"),
  );

  const max = Math.min(6, Math.max(1, p.maxIterations ?? 4));
  let best = { iteration: -1, score: -1, docId: 0 };
  let feedback = "";
  for (let i = 0; i < max; i++) {
    const docId = await step.do(`build-${i}`, { retries: { limit: 1, delay: "20 seconds" }, timeout: "10 minutes" }, async () => {
      const ctx = jobContext(env, store, identity, "cipher", { tag });
      const reply = await runAgentTurn(
        {
          mode: "direct",
          turn: "normal",
          topic: p.description,
          transcript: [],
          instruction: `Build this design as a Shopify section. Spec:\n${spec}\n${feedback ? `\nThe previous render differed from the mockup:\n${feedback}\nFix these.` : ""}
Reply with exactly two fenced blocks and nothing else:
1. \`\`\`html — a complete standalone preview page (inline CSS, placeholder images via https://placehold.co), identical markup to the section.
2. \`\`\`liquid — sections/${slug}.liquid with scoped CSS (prefix classes with ${slug}), every text/color/image as a setting in {% schema %}, and a preset.`,
        },
        ctx,
      );
      const blocks = extractCodeBlocks(reply ?? "");
      if (!blocks.html || !blocks.liquid) throw new Error("Cipher didn't return both html and liquid blocks");
      return store.saveDocument(identity.convId, `${slug} v${i + 1}`, JSON.stringify({ html: blocks.html, liquid: blocks.liquid }));
    });

    const shotId = await step.do(`render-${i}`, { retries: { limit: 1, delay: "20 seconds" }, timeout: "5 minutes" }, async () => {
      const doc = await store.getDocument(docId);
      const { html } = JSON.parse(doc!.markdown) as { html: string };
      const png = await screenshotHtml(env, html);
      return (await sendPhotoAs(env, via ?? "cipher", identity.chatId, png, `Iteration ${i + 1}`)) ?? "";
    });

    const cmp = await step.do(`compare-${i}`, { timeout: "5 minutes" }, async (): Promise<Comparison> => {
      const [mock, shot] = await Promise.all([downloadAsDataUri(env, mockupId, via), downloadAsDataUri(env, shotId, via)]);
      const r = await askJson<Comparison>(
        env.AI,
        AGENTS.axiom.model,
        [
          {
            role: "user",
            content: [
              { type: "text", text: 'Image 1 is the target mockup, image 2 is the built page. Score how closely the build matches the mockup (layout, spacing, typography, colors, content) from 0 to 1, and list the most important differences to fix. Reply with only JSON: {"score": 0.0, "differences": ["..."]}' },
              { type: "image_url", image_url: { url: mock } },
              { type: "image_url", image_url: { url: shot } },
            ],
          },
        ],
        { maxTokens: 500, ...opts },
      );
      await store.recordUsage(identity.convId, "iris", AGENTS.axiom.model, r.promptTokens, r.completionTokens, tag);
      return { score: Math.min(1, Math.max(0, Number(r.value?.score) || 0)), differences: (r.value?.differences ?? []).map(String).slice(0, 8) };
    });

    await step.do(`report-${i}`, () =>
      postAs(env, store, identity, "iris", `👁️ Iteration ${i + 1}: **${Math.round(cmp.score * 100)}% match**${cmp.differences.length ? `\n${cmp.differences.map((d) => `• ${d}`).join("\n")}` : ""}`).then(() => "ok"),
    );
    if (cmp.score > best.score) best = { iteration: i, score: cmp.score, docId };
    if (cmp.score >= TARGET_SCORE) break;
    feedback = cmp.differences.join("\n");
  }

  return step.do("deliver", { timeout: "10 minutes" }, async () => {
    const doc = await store.getDocument(best.docId);
    const { liquid } = JSON.parse(doc!.markdown) as { liquid: string };
    const lines = [`✅ Best version: iteration ${best.iteration + 1} at ${Math.round(best.score * 100)}% match.`];
    await sendDocumentAs(env, via ?? "cipher", identity.chatId, `${slug}.liquid`, liquid, `sections/${slug}.liquid`).catch(() => {});
    const ctx = jobContext(env, store, identity, "cipher", { tag });

    // Real Shopify preview when a store, theme and CLI token are configured.
    if (env.Sandbox && env.SHOPIFY_STORE && env.SHOPIFY_THEME_ID && env.SHOPIFY_CLI_THEME_TOKEN) {
      const path = `/workspace/theme/sections/${slug}.liquid`;
      await sandboxWriteFile.run({ path, content: liquid }, ctx);
      const push = await execWithSecrets(
        ctx,
        `shopify theme push --path /workspace/theme --only sections/${slug}.liquid --nodelete --theme ${env.SHOPIFY_THEME_ID} --store ${env.SHOPIFY_STORE} --json`,
        { SHOPIFY_CLI_THEME_TOKEN: env.SHOPIFY_CLI_THEME_TOKEN },
      );
      lines.push(
        push.ok
          ? `🛍️ Pushed to your development theme. Section preview: https://${env.SHOPIFY_STORE}/?section_id=${slug}&preview_theme_id=${env.SHOPIFY_THEME_ID}`
          : `⚠️ Shopify push failed:\n${push.output.slice(-600)}`,
      );
    }

    // Commit to a council/ branch and ask to open a PR.
    if (p.repo && env.GITHUB_TOKEN && !(await store.ops.isDryRun(identity.convId))) {
      const branch = councilBranch(`design-${slug}`);
      const commit = await githubWrite.run({ repo: p.repo, branch, message: `Add ${slug} section (design loop, ${Math.round(best.score * 100)}% match)`, files: [{ path: `sections/${slug}.liquid`, content: liquid }] }, ctx);
      lines.push(commit);
      const summary = `open a draft PR on ${p.repo} from ${branch}: “Add ${slug} section”`;
      const approvalId = await store.createApproval({
        convId: identity.convId,
        chatId: identity.chatId,
        agent: "cipher",
        skill: "github.open_pr",
        args: { repo: p.repo, branch, title: `Add ${slug} section`, body: `Built by the design loop from a mockup. Best match ${Math.round(best.score * 100)}%.` },
        summary,
      });
      await remoteHooks(env, store, identity).requestApproval(approvalId, "cipher", summary);
    }
    await postAs(env, store, identity, "cipher", lines.join("\n\n"));
    return `best ${best.score}`;
  });
}

