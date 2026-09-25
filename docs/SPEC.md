# AI Council — Technical Specification (v3)

Eight independent AI agents, each running on its own Cloudflare Workers AI model,
discuss with the founder and with each other in a Telegram group, in private DMs,
through voice notes and in a live voice room. One orchestrator decides who speaks,
stops loops and controls cost.

> Status: **v3**. Everything below is implemented. Model IDs were checked against the
> Workers AI catalog/changelog on 2026-09-25. None of it has been run against live
> Telegram / Workers AI yet: run `/selftest` first (§12). The v3 features (autonomy,
> missions, watchers, learning, …) are described in §13–§22.

---

## 1. Design principles

1. **Independent brains, central orchestration.** Each agent has its own model, backup
   model, voice, system prompt, private memory, skills and Telegram bot. Only the
   orchestrator decides whose turn it is.
2. **Silence is allowed.** An agent with nothing new replies `[PASS]` and isn't posted.
3. **Blind first round.** In `/council`, `/debate` and `/brainstorm` the members answer
   round 1 in parallel without seeing each other.
4. **Human always wins.** Any founder message (or talking over an agent in a call)
   interrupts the running discussion. `/stop` ends it.
5. **Hard budgets.** Rounds, posts per discussion, skill calls per turn, tokens per agent
   per day. No path can loop forever or spend without limit.
6. **One brain, many surfaces.** Group chat, DMs, voice notes and live calls all use the
   same Durable Object, memory and agents. There is one Atlas.
7. **Skills are typed capabilities.** External APIs are wrapped behind typed skills with a
   permission list, availability check and approval rule. Agents pick skills themselves;
   anything that leaves the council's sandbox needs the founder's ✅.

---

## 2. The council

| # | Agent | Model | Backup | Voice model | Aura-2 voice | Role |
|---|---|---|---|---|---|---|
| 1 | 🧠 Atlas | `@cf/deepseek-ai/deepseek-v4-pro-0813` | GLM-5.3 | GLM-5.3 Flash | zeus | Deep reasoning, pre-mortems, decision matrices, predictions |
| 2 | 🌙 Nova | `@cf/moonshotai/kimi-k2.6` | Qwen 3.8 | same | luna | Unconventional strategy, idea bank, trend research |
| 3 | ⚡ Sage | `@cf/zai-org/glm-5.3-flash` | Gemma 4 | same | hermes | Fast challenger, fact checks, claim ledger |
| 4 | 🔮 Nexus | `@cf/qwen/qwen3.8-27b` | GLM-5.3 Flash | same | athena | Synthesis, minutes, decisions, action items, daily brief (host bot) |
| 5 | 💠 Axiom | `@cf/google/gemma-4-26b-a4b-it` | Qwen 3.8 | same | thalia | Product/UX pragmatist, browser UX audits, customer personas |
| 6 | 💻 Cipher | `@cf/moonshotai/kimi-k2.7-code` | GLM-5.3 | GLM-5.3 Flash | arcas | Programmer: repo → sandbox → test → commit → PR |
| 7 | 🏗️ Forge | `@cf/zai-org/glm-5.3` | Kimi K2.7 Code | GLM-5.3 Flash | orion | Principal engineer: architecture, PR reviews, CI |
| 8 | 👁️ Iris | `@cf/moondream/moondream3.1-9B-A2B` | Gemma 4 (chat vision) | — | iris | Vision: images, OCR, objects, website screenshots |

Tiers: Atlas–Axiom are **core** (always available); Cipher, Forge and Iris are
**specialists** that wake up for code, architecture, images or links.

Vision: Nova, Sage, Nexus, Axiom and Cipher receive images directly. Atlas and Forge
(no vision) automatically get Moondream's description of the image instead.

Notes: Gemma 4's context budget is 120K (docs say 256K; cloudflare-docs#29731 reports
128K deployed). DeepSeek V4 Pro, Kimi and GLM-5.3 need the Workers Paid plan.

### 2.1 System models

| Purpose | Model |
|---|---|
| Speech → text | `@cf/openai/whisper-large-v3-turbo` |
| Text → speech | `@cf/deepgram/aura-2-en` (Opus/OGG for Telegram, MP3 for browsers) |
| Embeddings | `@cf/baai/bge-m3` (1024 dims, multilingual) |
| Summaries, speak bids | `@cf/zai-org/glm-5.3-flash` / each agent's voice model |
| Documents → Markdown | Workers AI `toMarkdown` |

---

## 3. Architecture

```
 Telegram (8 bots)            Browser / Mini App
   │ webhooks /telegram/webhook/<agent>   │ /app  +  WebSocket /voice/ws
   ▼                                      ▼
 ┌──────────────────── Worker (src/index.ts) ────────────────────┐
 │ secret check · de-dupe update_id · owner-only · chat allowlist │
 │ route to CouncilRoom(convId) · cron: daily brief, cleanup      │
 └───────────────────────────────┬───────────────────────────────┘
                                 ▼
          CouncilRoom Durable Object — one per conversation
 ┌─────────────────────────────────────────────────────────────────┐
 │ preprocess: voice note → Whisper · document → Markdown          │
 │ router → plan (steps)  ·  bids (live)  ·  one alarm drives both │
 │ plan steps and self-scheduled follow-ups                        │
 │ runner: prompt + memory + powers → model ↔ skills (tool loop)   │
 │ post: Telegram text / voice note / live audio over WebSocket    │
 │ approvals (✅/❌ buttons) · summaries → long-term memory         │
 └──────┬───────────┬────────────┬────────────┬────────────┬───────┘
        ▼           ▼            ▼            ▼            ▼
   Workers AI   D1 memory   Vectorize   Browser Rendering  Sandbox (Containers)
   (AI Gateway)                                            + GitHub API
```

**Conversations.** A group is one conversation (`convId = chatId`). A DM with an agent's
bot is its own conversation (`convId = userId*16 + agentIndex + 1`, because Telegram uses
the same chat id for a user's DMs with every bot). DMs read the home group's shared
memory, and every agent's private memory is global: DM Atlas and he still knows what the
group decided.

**Bots.** Every bot has its own webhook path. Group messages are only processed from the
host bot's webhook (privacy mode off); other bots' webhooks handle their DMs and their
approval buttons. Agents never receive each other's messages through Telegram, so there
is no bot-to-bot loop.

**Turns.** One alarm per room. Each tick runs one sequential agent turn, one blind
parallel round, or one live bidding round, then schedules the next tick (1.5 s cooldown,
or until the live client reports the audio finished). A founder message bumps a
`generation` counter; stale turns are dropped before posting.

---

## 4. Routing

| Input | Behaviour |
|---|---|
| plain message | 1–2 most relevant core members (+ woken specialists), each may PASS |
| `@Atlas`, `Atlas, …`, reply to a member, `/atlas …` | only that member (+ Iris first if there's an image) |
| DM with a member's bot | only that member; every command collapses to them |
| voice note | transcribed; members answer with voice notes in their own voices |
| image | Iris first, then others (vision models see the image, others her description) |
| document (PDF, Office, CSV…) | converted to Markdown, saved as `doc #N`, readable with `doc.read` |
| link + Iris | Iris screenshots the page and describes it |
| `/council <topic>` | blind round → follow-up round → Nexus summary (records decisions/actions) |
| `/debate <topic>` | blind round → 2 follow-up rounds → summary |
| `/brainstorm <topic>` | blind round → follow-up round, cooperative |
| `/critic` | every core member attacks the current idea |
| `/premortem <plan>` | Atlas pre-mortem (+ records a prediction) → Sage checks it |
| `/decide <question>` | Atlas decision matrix |
| `/personas <idea>` | Axiom role-plays 3 customer personas |
| `/minutes` | Nexus: minutes, `group.record_fact` decisions, `actions.add` next steps |
| `/brief`, `/brief on|off` | Nexus's brief now / every morning (cron) |
| `/actions` `/claims` `/ideas` `/record` `/followups` `/cost` | lists from the database, no model call |
| `/voice on|off` | always answer with voice notes |
| `/call` | links to the live voice room (Mini App and/or browser) |
| `/stop` `/status` `/help` | |

Specialist wake-up is a deterministic keyword scorer (`council/router.ts`): code terms
wake Cipher (and Forge if strongly technical), architecture terms wake Forge, images wake
Iris.

### 4.1 Budgets (`src/config.ts`, `wrangler.jsonc`)

| Limit | Default |
|---|---|
| Posts per discussion | 15 (the last slot is reserved for the summary) |
| Debate rounds | 3 |
| Cooldown between posts | 1.5 s |
| Skill calls per turn | 4 (specialists 8) |
| Output tokens per turn | 700 (speaking: 260) |
| Transcript window | last 40 messages + 5 semantically retrieved memories |
| Tokens per agent per UTC day | 400,000 (`DAILY_TOKEN_BUDGET_PER_AGENT`) |
| Live call speakers per utterance | 2, minimum bid importance 0.35 |

---

## 5. Agent turn (src/agents/runner.ts)

1. Refuse if the agent is over its daily token budget.
2. Build the prompt: persona + council rules (+ speaking rules) + skills + prediction
   track record + group facts + private memory; user message = transcript + retrieved
   older memory + the agent's own power context (Nova's idea bank, Sage's claim
   ledger, Nexus's open actions and follow-ups, engineers' repo/sandbox status) + image.
3. Call the model with the agent's permitted, configured skills as tools. On an error or
   empty answer, switch to the backup model for the rest of the turn.
4. Execute tool calls (bounded). Calls needing approval become an approval request
   instead. Feed results back; repeat; final answer without tools.
5. Strip reasoning / self-prefix; `[PASS]` → silence. Record token usage per model.

Live calls use the agent's voice model, speaking style, and no skills (latency).

---

## 6. Memory

| Level | Store | Contents | Visibility |
|---|---|---|---|
| Conversation | D1 `messages` | every message | that conversation |
| Group | D1 `group_facts` | decisions, projects, constraints | the group + DMs |
| Private | D1 `agent_memories` | an agent's own notes | that agent, everywhere |
| Semantic | Vectorize (namespace per conversation) | messages, memories, ideas, discussion summaries | retrieved by relevance; private memories only for their owner |
| Summaries | D1 `discussion_summaries` | 3–5 sentence summary of every discussion with ≥3 posts | via semantic search |
| Records | D1 `predictions`, `claims`, `ideas`, `action_items`, `followups` | agents' track records and work items | commands + agent context |

Schema: `migrations/0001_init.sql`, `migrations/0002_powers.sql`.

---

## 7. Skills

| Skill | What it does | Who | Needs | Approval |
|---|---|---|---|---|
| `memory.search` / `memory.remember` | semantic (or keyword) search; private notes | all chat agents | — | — |
| `group.record_fact` | shared decisions/facts | Atlas, Nova, Nexus, Forge | — | — |
| `web.search` | Firecrawl v2 or Brave search | all chat agents | `FIRECRAWL_API_KEY` or `BRAVE_API_KEY` | — |
| `web.fetch` | read a page as text | all chat agents | — | — |
| `doc.read` / `doc.parse` | read sent documents / convert a URL (PDF, Office…) | all / Nexus, Axiom | — | — |
| `council.consult` | ask another member privately (1 level deep) | all chat agents | — | — |
| `schedule.followup` | self-scheduled reminder turn | all chat agents | — | — |
| `prediction.record` / `.resolve` | track record with review reminders | all chat agents | — | — |
| `claims.record` | claim ledger ✅❌❓ with sources | Sage | — | — |
| `ideas.save` / `ideas.search` | idea bank | Nova | — | — |
| `actions.add` / `actions.complete` | action items with due-date follow-ups | Nexus | — | — |
| `github.read` | tree, file, search, commits, issues, PRs, diffs | Sage, Cipher, Forge | `GITHUB_TOKEN`, `GITHUB_REPOS` | — |
| `github.write` | commit files to a `council/*` branch | Cipher | same | — |
| `github.open_pr` | open a draft PR (Forge then reviews it automatically) | Cipher | same | **always** |
| `github.ci_status` | Actions runs + failing job log tail | Cipher, Forge | same | — |
| `github.comment` | comment on a PR/issue (reviews) | Forge | same | — |
| `sandbox.exec` / `sandbox.write_file` | shell in an isolated container, clone allowed repos | Cipher (+exec for Forge) | `Sandbox` binding | deploy / publish / push / mutating curl |
| `browser.inspect` | load a site, screenshot → Moondream, console errors | Nova, Axiom | `BROWSER` | — |
| `browser.test` | click-through smoke test | Cipher | `BROWSER` | — |
| `browser.screenshot` | post a screenshot + describe it | Iris | `BROWSER` | — |
| `vision.inspect` | Moondream query/caption/detect/point | Iris | — | — |

Skills whose binding or key is missing are not offered to the model at all.

**Safety model.** Writes are scoped: GitHub only to repos in `GITHUB_REPOS` and only to
`council/*` branches; there is no merge skill; PRs, deploys, publishes and pushes need
the founder's ✅. The sandbox checkout never keeps the GitHub token (the remote URL is
reset after cloning). Only `OWNER_USER_IDS` can talk to the council or press approval
buttons. Web content can try to steer an agent (prompt injection); the approval gate is
what bounds the damage, so keep `GITHUB_REPOS` narrow.

---

## 8. Agent powers

| Agent | Built-in powers |
|---|---|
| All | backup model, private memory, semantic recall, private consultations, self-scheduled follow-ups, prediction track record shown in their prompt, voice |
| 🧠 Atlas | `/premortem`, `/decide` matrices, records its key forecasts |
| 🌙 Nova | idea bank surfaced automatically when relevant; web trend research; browser |
| ⚡ Sage | fact checks with sources → claim ledger (`/claims`) |
| 🔮 Nexus | `/minutes`, decisions → group memory, action items with due-date follow-ups, daily brief |
| 💠 Axiom | browser UX audits (desktop/mobile), `/personas`, receives images directly |
| 💻 Cipher | GitHub read/write, sandbox build/test/fix loop, browser smoke tests, PRs with approval |
| 🏗️ Forge | reviews every PR Cipher opens (auto follow-up), CI logs, sandbox, mermaid diagrams |
| 👁️ Iris | Moondream detect/point/OCR, screenshots any link, Gemma fallback |

---

## 9. Voice

**Stage A — voice notes (Telegram).** Voice note → Whisper → the same discussion flow →
each member answers with an Opus voice note in its own Aura-2 voice (caption = text when
short, otherwise voice + formatted text). `/voice on` makes all replies voice.

**Stage B — live voice room.** `/call` posts a link. `/app` (Mini App or browser):
mic → energy-based voice activity detection (adaptive noise floor, higher threshold
while an agent is talking) → 16 kHz WAV per utterance → WebSocket → Whisper → the
room. Replies are synthesized sentence-group by sentence-group in parallel and streamed
in order, so the first sentence plays while the rest is generated. Everything said is
also posted to the Telegram chat, so the call has a transcript.

**Stage C — natural conversation.** Every relevant member privately bids
`{want_to_speak, importance, reason}` with its fast voice model; the top bids (max 2,
≥0.35) get the floor; a direct question is never left unanswered. Talking over an agent
stops playback and bumps the generation (barge-in). Agent cards show
listening / thinking / speaking / sleeping.

Auth: Mini App `initData` validated with the host bot token (owner only, group rooms),
or a signed room link from `/call` (HMAC, 6 h expiry). Native Telegram group voice chats
are not used: `phone.joinGroupCall` is user-only. Multi-human calls (Cloudflare Realtime
SFU) are a possible later step.

---

## 10. Operations

- **Cost:** `/cost` (tokens per agent, today / 7 days, against the daily budget); set
  `AI_GATEWAY_ID` to get dollar costs, logs, caching and per-agent metadata in AI Gateway.
- **Reliability:** backup model per agent; Telegram HTML falls back to plain text;
  duplicate webhook deliveries ignored; failed turns post a ⚠️ notice instead of
  stalling the discussion.
- **Cron:** one tick every 15 minutes drives watchers, briefs and routines (§22).
- **CI:** `.github/workflows/ci.yml` runs typecheck, tests and a bundle dry run.

---

## 11. Code map

```
src/index.ts              Worker: Telegram webhooks, reactions, /app, /voice/ws, /admin,
                          /twilio/*, /github/webhook, the 15-minute cron
src/council/room.ts       CouncilRoom Durable Object: plans, alarms, posting, voice, phone,
                          approvals, alerts queue, crux + groupthink steps, graph conflicts
src/council/commands.ts   every /command that doesn't start a discussion
src/council/router.ts     commands, mentions, specialist wake-up, plans
src/council/*.ts          bids, crux, diversity, forecast, post helpers
src/agents/               registry, prompts, per-agent context, runner, runtime overrides
src/autonomy/policy.ts    who may act: levels, freeze, dry-run, taint
src/skills/               skill interface, registry (built-in + MCP + council-built), builtin/*
src/jobs/                 CouncilJob Workflow: missions, research, design loop, evals,
                          reflection, model scouting
src/watchers/             watchers, relevance gate, GitHub webhook
src/mcp/                  MCP client + skill adapter
src/tools/                council-built tools (Worker Loader) + egress gateway
src/knowledge/            knowledge graph, memory consolidation
src/evals/                behavioural test scenarios and scoring
src/ops/                  selftest, admin dashboard, backups, schedule
src/voice/                Mini App page, auth, speech, Flux streaming, phone (Twilio)
src/memory/               D1 (store.ts, ops.ts) + Vectorize
migrations/               D1 schema 0001–0003
```

---

## 12. First live checks

Run **`/selftest`** in the group. It calls every model (plain reply and tool calling),
Moondream, an Aura → Whisper round trip, Opus voice notes, embeddings and D1, and lists
which bindings, keys and bot tokens are configured. Then check by hand:

1. A plain message and `/council` in the group.
2. An image (Moondream response shape; Gemma fallback).
3. A voice note (Whisper in, Aura-2 Opus out → Telegram voice bubble).
4. `/call` in a browser (Flux streaming or VAD fallback, playback, barge-in).
5. With keys set: `web.search`, a GitHub read, a sandbox `npm test`, `browser.inspect`.
6. `/mission` with a small goal and `--budget 50k`; `/research` on a narrow topic.

---

## 13. Autonomy and safety (v3)

Every skill call goes through one policy (`src/autonomy/policy.ts`):

| Check | Effect |
|---|---|
| `/freeze` | nothing acts or speaks; missions, watchers and routines pause |
| read-only skill | always runs |
| `/dryrun on` (per chat) | writes are simulated and described instead |
| level **suggest** | the agent describes what it would do |
| skill always needs approval (PRs, deploy/push commands, missions, tool activation, persona/model swaps) | ✅/❌ buttons |
| level **approve** | ✅/❌ buttons |
| **taint**: the agent read outside content this turn and the skill acts on the world | ✅/❌ buttons |
| otherwise | runs |

Levels are set per agent, per skill or per group (`github.*`) with `/autonomy`; the most
specific rule wins; the default is **act**. Outside content (web, documents, repos, MCP,
custom tools, OCR) is wrapped in `<untrusted_content>` and marked as data. Every call is
audited (`skill_calls`, `/audit`), every turn traced (`traces`, admin page, `/why`).
Overloaded models (429/capacity) are retried before switching to the backup model.

## 14. Missions

`/mission <goal> [--budget 300k] [--days 3]` (or an agent's `mission.propose`, which
needs ✅) starts a `CouncilJob` Workflow instance:

1. **Plan**: Nexus writes success criteria and 3–10 tasks with assignees and dependencies
   (validated: known agents, no cycles).
2. **Cycles**: up to 3 ready tasks run in parallel as agent turns with full skills and the
   mission's token tag. Results are posted and passed to dependent tasks. A task can answer
   `BLOCKED:`; the mission then asks the founder and waits (up to 24 h) for
   `/mission_reply`. Approvals requested inside a mission come back as new tasks.
3. **Evaluate**: when all tasks are done, Nexus checks the success criteria and adds up to
   3 tasks for gaps (twice at most).
4. **Finish**: final report, lessons saved to memory.

It stops on `/mission_stop`, the deadline, or the token budget, and pauses while frozen.
Every step is checkpointed, so missions survive restarts.

## 15. Watchers

`/watch <url | feed | owner/repo> [agent] [6h]` or an agent's `watch.add`. The cron checks
due watchers every 15 minutes:

- **url**: page text hash; on change, the added/removed lines.
- **rss/atom**: new items.
- **github**: latest completed Actions run; a new failure is urgent. With
  `GITHUB_WEBHOOK_SECRET`, `workflow_run` webhooks alert instantly.

The watching agent rates each change (importance, urgency) with its fast model: urgent or
≥0.8 → it speaks now (queued after any running discussion); ≥0.4 → the digest in the next
daily brief; otherwise ignored. A CI failure starts Forge investigating and Cipher fixing
(PR behind ✅).

## 16. Connectors and tools the council builds

**MCP** (`MCP_SERVERS`): every tool on each server becomes `mcp.<server>.<tool>` for the
listed agents. Read-only tools (`readOnlyHint`) run freely; others need ✅ (configurable).
Output is untrusted.

**Council-built tools**: Cipher writes one with `tools.create` (an ES module that
default-exports an async function, ≤20 KB, with declared domains). Forge reviews it
(`tools.review`), the founder approves it, and it becomes `custom.<name>` for the listed
agents. Each tool runs in its own isolate via the **Worker Loader**: no bindings, no
secrets, 2 s CPU, 20 subrequests, and network only through `ToolEgress`, which allows https
to the declared domains.

**Images**: `image.generate` (FLUX-1 schnell) for Nova, Axiom and Cipher.

## 17. Better deliberation

- **Crux**: after the blind round of `/council` and `/debate`, the discussion is mapped
  into positions and disagreements and the crux is posted; if it's empirical, Sage
  researches it (and logs claims) before the next round.
- **Groupthink guard**: blind-round answers are embedded; mean pairwise cosine ≥0.9 makes
  the most typical member re-answer as a declared devil's advocate.
- **Decision records**: `decision.record` (options, choice, dissent, rationale, review
  date) with a review follow-up; `/decisions`.
- **Forecasts**: `/forecast <question>`: each core member's probability, weighted by its
  Brier score (per domain with ≥3 resolved, else overall), extremized log-odds average;
  `/resolve <#> yes|no`; calibration in `/record`.

## 18. Knowledge graph and memory upkeep

After each summarized discussion, entities (projects, people, companies, products, tools,
markets, decisions), current facts and relations are extracted. A new fact that contradicts
a current one is not written: the founder gets "use the new one / keep the old one"
buttons. Agents see facts about entities mentioned in the latest message and can
`graph.query`. Nightly, an agent with more than 40 private notes has them merged into at
most 20 (old notes archived, not deleted).

## 19. Learning and self-improvement

- Founder reactions on an agent's message (👍 🔥 ❤️ … / 👎 💩 …) are stored as feedback
  (the host bot must be a group admin to receive reactions).
- **Weekly reflection** (Friday, or `/reflect`): each agent reviews its feedback and
  prediction record, writes up to 4 lessons (injected into its prompt; newest 10 kept) and
  may propose a new personality. The proposal runs through the eval suite; only if it
  scores at least as well does the founder get ✅/❌.
- **Evals** (`/eval [agent] [@cf/model]`): scenarios for challenging false claims,
  independence in blind rounds, brevity, passing when there's nothing to add, concrete
  plans, and resisting pressure. Deterministic checks plus an LLM judge; results stored.
- **Model scouting** (Wednesday, or `/scout`): new text models in the Workers AI catalog are
  tested as each agent on the quick suite; a ≥10-point win proposes a swap (✅). Swaps and
  personalities are runtime overrides (`/models`).

## 20. Research and design loops

- **`/research <topic>`**: plan 5–7 queries → search → read up to 24 sources and extract
  quoted evidence → Sage lists contradictions and gaps → Atlas writes a cited report → a
  summary is posted, and the full Markdown report is attached and saved as a document.
- **`/build <section> [--repo owner/name]`** (after sending a mockup, or FLUX makes one):
  Gemma turns the mockup into a build spec; Cipher writes a standalone HTML preview and the
  Liquid section; the preview is rendered with Browser Rendering and compared with the
  mockup (score + differences); up to 4 iterations until ≥85%. The Liquid file is posted,
  pushed to a development theme with Shopify CLI in the sandbox (if configured; the token
  goes in as an environment variable, never in the command), committed to a `council/`
  branch, and a PR is requested (✅).

## 21. Voice v3

- **Flux streaming**: the voice room streams 16 kHz PCM; Deepgram Flux reports
  StartOfTurn (barge-in) and EndOfTurn (transcript). While an agent speaks, the client
  sends silence unless the founder is clearly talking (echo guard). If Flux isn't
  available it falls back to on-device VAD + Whisper.
- **Phone**: a Twilio number's voice webhook → `/twilio/voice` (signature checked; the
  caller must be in `OWNER_PHONE_NUMBERS`) → TwiML `<Connect><Stream>` with a signed token
  → the home group's room. μ-law 8 kHz in (Flux, or server VAD + Whisper), Aura-2 μ-law out,
  `mark` events count as playback finished, `clear` on barge-in. The call is transcribed
  into the Telegram chat.

## 22. Operations v3

- **Schedule** (UTC, one cron every 15 min): watchers every tick; memory consolidation
  02:00; backups Sun 03:00; cleanup 04:00; daily brief 06:45; weekly plan Mon 07:00; model
  scouting Wed 09:00; retro Fri 16:00; reflection Fri 16:15. Brief, plan and retro run in
  chats with `/brief on`; the rest post to the home group.
- **`/selftest`**, **`/admin`** (turns, audit, usage, missions, jobs, approvals, watchers,
  autonomy, tools, errors), **`/why [agent]`**, **`/audit`**, **`/backup`** (R2 JSON export).
