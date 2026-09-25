import { formatTrackRecord } from "../agents/prompts";
import { effectiveAgent } from "../agents/overrides";
import { AGENTS, AGENT_IDS, displayName, isAgentId } from "../agents/registry";
import { AUTONOMY_LEVELS } from "../autonomy/policy";
import { startJob, parseMissionFlags, startMission } from "../jobs/start";
import type { AutonomyLevel } from "../memory/ops";
import type { MemoryStore } from "../memory/store";
import { adminSecret } from "../ops/admin";
import { runBackup } from "../ops/backup";
import { runSelftest } from "../ops/selftest";
import { allowedRepo } from "../skills/builtin/github";
import { graphQuery } from "../skills/builtin/v3";
import { parseHttpUrl } from "../skills/builtin/web";
import { parseIds, sendSystem, sendSystemHtml, type InlineKeyboard } from "../telegram/api";
import type { AgentId, Env, Identity, Mode } from "../types";
import { encodeRoom, signRoomToken } from "../voice/auth";
import { calibrationReport, runForecast } from "./forecast";
import type { Step, SystemCommand } from "./router";

/** What a command needs from the room it runs in. */
export interface CommandHost {
  env: Env;
  store: MemoryStore;
  identity: Identity;
  sharedConvIds: number[];
  startPlan(mode: Mode, topic: string, steps: Step[]): Promise<void>;
  interrupt(status: "stopped" | "interrupted"): Promise<boolean>;
  /** File id of an image sent recently in this conversation. */
  recentImage(): Promise<string | undefined>;
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const when = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

export async function runSystemCommand(h: CommandHost, name: SystemCommand, arg: string): Promise<void> {
  const { env, store, identity } = h;
  const via = identity.dmAgent;
  const send = (text: string) => sendSystem(env, identity.chatId, text, via);
  const shared = h.sharedConvIds;
  const words = arg.split(/\s+/).filter(Boolean);

  switch (name) {
    // ------------------------------------------------------------ records
    case "actions": {
      const items = await store.openActions(shared);
      return send(items.length ? `📋 Open action items\n\n${items.map((a) => `#${a.id} ${a.text} (${a.owner}${a.due_at ? `, due ${day(a.due_at)}` : ""})`).join("\n")}` : "No open action items.");
    }
    case "claims": {
      const claims = await store.recentClaims(identity.convId, 15);
      const mark = (v: string) => (v === "true" ? "✅" : v === "false" ? "❌" : "❓");
      return send(claims.length ? `🔎 Claim ledger\n\n${claims.map((c) => `${mark(c.verdict)} #${c.id} "${c.claim}" (${c.claimed_by})${c.source ? `\n   ${c.source}` : ""}`).join("\n")}` : "No checked claims yet.");
    }
    case "ideas": {
      const ideas = arg ? await store.searchIdeas(arg, 15) : await store.recentIdeas(15);
      return send(ideas.length ? `💡 Idea bank\n\n${ideas.map((i) => `#${i.id} ${i.idea}${i.tags ? ` [${i.tags}]` : ""}`).join("\n")}` : "The idea bank is empty.");
    }
    case "record": {
      const lines = await Promise.all(
        AGENT_IDS.filter((id) => AGENTS[id].kind === "chat").map(async (id) => `${displayName(id)}: ${formatTrackRecord(await store.trackRecord(id))}`),
      );
      const calibration = await calibrationReport(store);
      return send(`🎯 Prediction track record\n\n${lines.join("\n")}${calibration ? `\n\n${calibration}` : ""}`);
    }
    case "followups": {
      const f = await store.pendingFollowups(identity.convId);
      return send(f.length ? `⏰ Scheduled follow-ups\n\n${f.map((x) => `${when(x.due_at)} ${displayName(x.agent)}: ${x.note}`).join("\n")}` : "No follow-ups scheduled.");
    }
    case "decisions": {
      const d = await store.ops.decisions(shared, 15);
      return send(d.length ? `🧭 Decisions\n\n${d.map((x) => `#${x.id} ${x.title}: ${x.chosen} [${x.status}]${x.review_at ? ` review ${day(x.review_at)}` : ""}`).join("\n")}` : "No decisions recorded yet.");
    }
    case "lessons": {
      const agents = words[0] && isAgentId(words[0].toLowerCase()) ? [words[0].toLowerCase() as AgentId] : AGENT_IDS.filter((a) => AGENTS[a].kind === "chat");
      const lines = await Promise.all(agents.map(async (a) => `${displayName(a)}\n${(await store.ops.lessons(a)).map((l) => `  • ${l}`).join("\n") || "  (none yet)"}`));
      return send(`📓 Lessons learned from your feedback\n\n${lines.join("\n\n")}`);
    }
    case "graph": {
      if (!arg) return send("Usage: /graph <project, person, company…>");
      return send(`🕸️ ${await graphQuery.run({ name: arg }, { env, store, convId: identity.convId, chatId: identity.chatId, agent: "nexus", sharedConvIds: shared, transcript: [], consultDepth: 0, callOptions: {} })}`);
    }
    case "cost": {
      const rows = await store.usageReport(7);
      const today = new Date().toISOString().slice(0, 10);
      const budget = Number(env.DAILY_TOKEN_BUDGET_PER_AGENT) || 0;
      const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
      const byAgent = new Map<string, { today: number; week: number; calls: number }>();
      for (const r of rows) {
        const e = byAgent.get(r.agent) ?? { today: 0, week: 0, calls: 0 };
        const t = r.prompt + r.completion;
        e.week += t;
        e.calls += r.calls;
        if (r.day === today) e.today += t;
        byAgent.set(r.agent, e);
      }
      const lines = [...byAgent.entries()]
        .sort((a, b) => b[1].week - a[1].week)
        .map(([a, e]) => `${isAgentId(a) ? displayName(a) : a}: ${fmt(e.today)} today${budget ? ` / ${fmt(budget)}` : ""}, ${fmt(e.week)} in 7 days (${e.calls} calls)`);
      const gw = env.AI_GATEWAY_ID ? "\n\nCosts in dollars: AI Gateway dashboard." : "";
      return send(lines.length ? `💸 Token usage\n\n${lines.join("\n")}${gw}` : "No usage recorded yet.");
    }

    // ------------------------------------------------------------ voice
    case "voice": {
      const on = !/^off$/i.test(arg);
      await store.setChatFlag(identity.convId, "voice_replies", on);
      return send(on ? "🔊 Members will answer with voice notes." : "Voice replies off (voice notes you send still get voice answers).");
    }
    case "call":
      return sendCallLink(h);

    // ------------------------------------------------------------ autonomy
    case "freeze": {
      await store.ops.setSetting("frozen", "1");
      await h.interrupt("stopped");
      return send("🧊 Council frozen. No agent will act, speak, run missions or watchers until /unfreeze.");
    }
    case "unfreeze":
      await store.ops.setSetting("frozen", null);
      return send("🔥 Council unfrozen.");
    case "dryrun": {
      const on = !/^off$/i.test(arg);
      await store.ops.setSetting(`dry_run:${identity.convId}`, on ? "1" : null);
      return send(on ? "🧪 Dry run ON here: agents describe changes instead of making them." : "Dry run off.");
    }
    case "autonomy":
      return autonomyCommand(h, words, send);
    case "audit": {
      const calls = await store.ops.recentSkillCalls(identity.convId, Math.min(40, Number(words[0]) || 20));
      return send(
        calls.length
          ? `🧾 Recent skill calls\n\n${calls.map((c) => `${when(c.created_at)} ${c.agent} ${c.skill} → ${c.decision}${c.tainted ? " (tainted)" : ""}${c.ok === 0 ? " ✗" : ""}\n   ${c.args_summary.slice(0, 120)}`).join("\n")}`
          : "No skill calls yet.",
      );
    }
    case "why": {
      const agent = words[0] && isAgentId(words[0].toLowerCase()) ? (words[0].toLowerCase() as AgentId) : undefined;
      const trace = await store.ops.lastTrace(identity.convId, agent);
      if (!trace) return send("No recorded turns yet.");
      const who = (identity.dmAgent ?? trace.agent) as AgentId;
      return h.startPlan("direct", "why", [
        {
          agents: [who],
          parallel: false,
          turn: "normal",
          instruction: `The founder asks why you did what you did in your last turn. Here is the record of that turn (models, skill calls with the policy decision for each, and your reply):\n${String(trace.detail_json).slice(0, 5000)}\nExplain your reasoning plainly in a few sentences: what you were trying to do, why you used (or didn't use) each skill, and anything you'd do differently.`,
        },
      ]);
    }
    case "admin": {
      if (!env.PUBLIC_URL) return send("Set PUBLIC_URL to use the admin page.");
      const token = await signRoomToken(adminSecret(env), identity.convId, 2 * 3600_000);
      await sendSystemHtml(env, identity.chatId, "🛠️ <b>Admin dashboard</b> (link valid 2 hours)", via, {
        inline_keyboard: [[{ text: "Open dashboard", url: `${env.PUBLIC_URL.replace(/\/$/, "")}/admin?t=${encodeURIComponent(token)}` }]],
      });
      return;
    }
    case "selftest":
      await send("🩺 Running self-test (about a minute)…");
      return send(await runSelftest(env));
    case "backup":
      return send(await runBackup(env));

    // ------------------------------------------------------------ jobs
    case "mission": {
      const { goal, budget, days } = parseMissionFlags(arg);
      if (goal.length < 10) return send("Usage: /mission <goal> [--budget 300k] [--days 3]");
      const id = await startMission(env, store, identity, goal, { budget, days });
      return send(`🎯 Mission #${id} started (budget ${budget.toLocaleString()} tokens, ${days} days). Nexus is planning it now.`);
    }
    case "missions": {
      const list = await store.ops.missions(shared, 10);
      return send(list.length ? `🎯 Missions\n\n${list.map((m) => `#${m.id} [${m.status}] ${m.goal.slice(0, 120)} (due ${day(m.deadline_at)})`).join("\n")}` : "No missions yet. Start one with /mission <goal>.");
    }
    case "mission_stop": {
      const m = await store.ops.getMission(Number(words[0]));
      if (!m || !shared.includes(m.conv_id)) return send("No such mission.");
      await store.ops.updateMission(m.id, { status: "stopped", result: "Stopped by the founder." });
      if (m.instance_id && env.JOBS) await (await env.JOBS.get(m.instance_id)).terminate().catch(() => {});
      return send(`⏹ Mission #${m.id} stopped.`);
    }
    case "mission_reply": {
      const m = await store.ops.getMission(Number(words[0]));
      const text = words.slice(1).join(" ");
      if (!m || !shared.includes(m.conv_id) || !text) return send("Usage: /mission_reply <id> <your answer>");
      if (!m.instance_id || !env.JOBS) return send("That mission isn't running.");
      await (await env.JOBS.get(m.instance_id)).sendEvent({ type: "founder_input", payload: { text } });
      return send(`↩️ Sent to mission #${m.id}.`);
    }
    case "research": {
      if (arg.length < 5) return send("Usage: /research <topic>");
      const id = await startJob(env, store, { kind: "research", identity, topic: arg });
      return send(`🔎 Research job #${id} started. The cited report arrives here when it's done.`);
    }
    case "build": {
      const repo = /--repo\s+(\S+)/.exec(arg)?.[1];
      const description = arg.replace(/--repo\s+\S+/, "").trim();
      if (description.length < 5) return send("Usage: /build <what the section should be> [--repo owner/name]. Attach or send a mockup image first to build from it.");
      if (repo && !allowedRepo(env, repo)) return send("That repo isn't in GITHUB_REPOS.");
      const mockupFileId = await h.recentImage();
      const id = await startJob(env, store, { kind: "design", identity, description, mockupFileId, repo });
      return send(`🎨 Design loop #${id} started${mockupFileId ? " from your mockup" : " (I'll generate a mockup first)"}.`);
    }
    case "eval": {
      const agents = words[0] && isAgentId(words[0].toLowerCase()) ? [words[0].toLowerCase() as AgentId] : AGENT_IDS.filter((a) => AGENTS[a].kind === "chat");
      const model = words.find((w) => w.startsWith("@cf/"));
      const id = await startJob(env, store, { kind: "eval", identity, agents, model });
      return send(`🧪 Eval job #${id} started for ${agents.map((a) => AGENTS[a].name).join(", ")}${model ? ` on ${model}` : ""}.`);
    }
    case "reflect": {
      const id = await startJob(env, store, { kind: "reflect", identity });
      return send(`🪞 Reflection job #${id} started.`);
    }
    case "scout": {
      const id = await startJob(env, store, { kind: "scout", identity });
      return send(`🛰️ Model scouting job #${id} started.`);
    }
    case "models": {
      const overrides = await store.ops.overrides();
      const lines = await Promise.all(
        AGENT_IDS.map(async (a) => {
          const eff = await effectiveAgent(store, a);
          const o = overrides.get(a);
          const ev = await store.ops.latestEval(a, eff.model, 60 * 86400_000);
          return `${displayName(a)}: ${eff.model}${o?.model ? " (swapped)" : ""}${o?.personality ? " · custom personality" : ""}${ev ? ` · eval ${Math.round(ev.score * 100)}` : ""}`;
        }),
      );
      return send(`🧠 Models\n\n${lines.join("\n")}`);
    }

    // ------------------------------------------------------------ watchers
    case "watch": {
      const target = words[0] ?? "";
      const agentWord = words.find((w) => isAgentId(w.toLowerCase()));
      const agent = (identity.dmAgent ?? (agentWord ? agentWord.toLowerCase() : "nova")) as AgentId;
      const hours = Number(words.find((w) => /^\d+(\.\d+)?h$/i.test(w))?.slice(0, -1)) || 24;
      let kind: "url" | "rss" | "github";
      if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
        if (!allowedRepo(env, target)) return send("Repo isn't in GITHUB_REPOS.");
        kind = "github";
      } else if (parseHttpUrl(target)) {
        kind = /rss|atom|feed|\.xml($|\?)/i.test(target) ? "rss" : "url";
      } else {
        return send("Usage: /watch <url | feed url | owner/repo> [agent] [6h]");
      }
      const minutes = Math.round(Math.min(168, Math.max(0.25, hours)) * 60);
      const id = await store.ops.addWatcher({ convId: identity.convId, chatId: identity.chatId, agent: kind === "github" ? "forge" : agent, kind, target, everyMinutes: minutes, createdBy: "founder" });
      return send(`👀 Watcher #${id}: ${kind === "github" ? "Forge" : AGENTS[agent].name} checks ${target} every ${hours}h.`);
    }
    case "watchers": {
      const ws = await store.ops.watchers(identity.convId);
      return send(ws.length ? `👀 Watchers\n\n${ws.map((w) => `#${w.id} ${AGENTS[w.agent].emoji} ${w.kind} ${w.target} every ${Math.round(w.every_minutes / 60)}h (last ${w.last_checked_at ? when(w.last_checked_at) : "never"})`).join("\n")}` : "No watchers. Add one with /watch <url>.");
    }
    case "unwatch":
      return send((await store.ops.removeWatcher(Number(words[0]), identity.convId)) ? "Watcher removed." : "No such watcher.");

    // ------------------------------------------------------------ forecasts
    case "forecast":
      if (arg.length < 8) return send("Usage: /forecast <a yes/no question about the future>");
      return runForecast(env, store, identity, arg);
    case "resolve": {
      const group = Number(words[0]);
      const answer = (words[1] ?? "").toLowerCase();
      if (!group || !["yes", "no"].includes(answer)) return send("Usage: /resolve <forecast #> yes|no");
      const n = await store.ops.resolveForecastGroup(group, answer === "yes");
      return send(`Resolved forecast #${group} as ${answer.toUpperCase()} (${n} predictions).\n\n${await calibrationReport(store)}`);
    }

    // ------------------------------------------------------------ tools
    case "tools": {
      const tools = await store.ops.allTools();
      return send(
        tools.length
          ? `🧰 Council-built tools\n\n${tools.map((t) => `#${t.id} ${t.name} v${t.version} [${t.status}] by ${t.created_by}; domains: ${(JSON.parse(t.allowed_domains) as string[]).join(", ") || "none"}`).join("\n")}${env.LOADER ? "" : "\n\n(Worker Loader binding missing: tools can't run.)"}`
          : "No council-built tools yet. Ask Cipher to build one.",
      );
    }
  }
}

async function autonomyCommand(h: CommandHost, words: string[], send: (t: string) => Promise<void>): Promise<void> {
  const { store } = h;
  const levels = AUTONOMY_LEVELS as string[];
  if (!words.length) {
    const rules = await store.ops.allAutonomy();
    const table = rules.length ? rules.map((r) => `${r.agent === "*" ? "everyone" : r.agent} · ${r.skill === "*" ? "all skills" : r.skill} → ${r.level}`).join("\n") : "(no rules: everyone acts on their own, within the approval rules)";
    return send(
      `🎚️ Autonomy\n\n${table}\n\nLevels: suggest (describe only) · approve (needs your ✅) · act (does it).\nReading is always allowed; PRs, deploys and pushes always need ✅; after reading outside content, outside actions need ✅.\n\nSet: /autonomy <agent|all> <level>\n     /autonomy <agent|all> <skill or group.*> <level|reset>`,
    );
  }
  const who = words[0]!.toLowerCase();
  const agent = who === "all" || who === "everyone" ? "*" : isAgentId(who) ? who : null;
  if (!agent) return send("First word must be an agent name or 'all'.");
  if (words.length === 2) {
    const level = words[1]!.toLowerCase();
    if (level === "reset") {
      await store.ops.setAutonomy(agent as AgentId | "*", "*", null);
      return send("Reset.");
    }
    if (!levels.includes(level)) return send(`Level must be one of: ${levels.join(", ")}`);
    await store.ops.setAutonomy(agent as AgentId | "*", "*", level as AutonomyLevel);
    return send(`${agent === "*" ? "Everyone" : AGENTS[agent as AgentId].name} → ${level}.`);
  }
  const skill = words[1]!.toLowerCase();
  const level = words[2]!.toLowerCase();
  if (level === "reset") {
    await store.ops.setAutonomy(agent as AgentId | "*", skill, null);
    return send("Reset.");
  }
  if (!levels.includes(level)) return send(`Level must be one of: ${levels.join(", ")}`);
  await store.ops.setAutonomy(agent as AgentId | "*", skill, level as AutonomyLevel);
  return send(`${agent === "*" ? "Everyone" : AGENTS[agent as AgentId].name} · ${skill} → ${level}.`);
}

async function sendCallLink(h: CommandHost): Promise<void> {
  const { env, identity } = h;
  const via = identity.dmAgent;
  const buttons: InlineKeyboard = [];
  if (env.MINIAPP_URL && !identity.dmAgent) {
    buttons.push([{ text: "🎙️ Join in Telegram", url: `${env.MINIAPP_URL}?startapp=${encodeRoom(identity.convId)}` }]);
  }
  if (env.PUBLIC_URL) {
    const token = await signRoomToken(env.TELEGRAM_WEBHOOK_SECRET, identity.convId);
    buttons.push([{ text: "🌐 Join in browser", url: `${env.PUBLIC_URL.replace(/\/$/, "")}/app?t=${encodeURIComponent(token)}` }]);
  }
  if (!buttons.length) return sendSystem(env, identity.chatId, "Set PUBLIC_URL (and optionally MINIAPP_URL) in wrangler.jsonc to enable calls.", via);
  const phone = parseIds(env.OWNER_PHONE_NUMBERS ?? "").length && env.TWILIO_AUTH_TOKEN ? "\nOr call the council's phone number from your phone." : "";
  await sendSystemHtml(env, identity.chatId, `🎙️ <b>AI Council Live</b>\nTap to join the voice room. Links expire in 6 hours.${phone}`, via, { inline_keyboard: buttons });
}
