# AI Council — v1 Technical Specification

A Telegram group where eight independent AI agents, each running on its own
Cloudflare Workers AI model, discuss topics with the human owner and with each
other. One orchestrator decides who speaks, stops loops and controls cost.

> Status: **v1 foundation** (phases 1–7 below are implemented in this repo;
> 8–12 are designed here and built next).

---

## 1. Design principles

1. **Independent brains, central orchestration.** Each agent has its own model,
   system prompt, private memory and Telegram identity. Only the orchestrator
   decides whose turn it is. Agents never trigger each other directly.
2. **Silence is allowed.** An agent that has nothing new to add replies
   `[PASS]` and is not posted. This is what keeps it from becoming eight
   chatbots agreeing with each other.
3. **Blind first round.** In council mode the core agents answer round 1
   without seeing each other's answers. They see everything in round 2.
4. **Human always wins.** Any human message interrupts the running discussion.
   `/stop` ends it.
5. **Hard budgets.** Max rounds, max posts per discussion, max tool calls per
   turn, per-chat cooldown. No path can loop forever.
6. **One brain, many surfaces.** Text (Telegram) and voice (Mini App, later)
   call the same council engine and the same memory. There is one Atlas.
7. **Skills are typed capabilities, never raw repos.** A GitHub repo or MCP
   server is wrapped behind a typed skill with a manifest, a permission list
   and a risk level. Agents choose skills themselves; they cannot run arbitrary
   code they find.

---

## 2. The council

All model IDs were checked against the Workers AI catalog/changelog on
2026-09-25.

| # | Agent | Model ID | Role | Tier |
|---|-------|----------|------|------|
| 1 | 🧠 Atlas | `@cf/deepseek-ai/deepseek-v4-pro-0813` | Deep reasoning, second-order consequences, "are we solving the right problem" | Core |
| 2 | 🌙 Nova | `@cf/moonshotai/kimi-k2.6` | Unconventional strategy, alternatives nobody raised | Core |
| 3 | ⚡ Sage | `@cf/zai-org/glm-5.3-flash` | Fast challenger, attacks weak claims | Core |
| 4 | 🔮 Nexus | `@cf/qwen/qwen3.8-27b` | Balanced, objective synthesis; moderator for summaries | Core |
| 5 | 💠 Axiom | `@cf/google/gemma-4-26b-a4b-it` | Product/UX pragmatist — who wants this, what's simpler | Core |
| 6 | 💻 Cipher | `@cf/moonshotai/kimi-k2.7-code` | Hands-on programmer: writes, runs, fixes code | Specialist |
| 7 | 🏗️ Forge | `@cf/zai-org/glm-5.3` | Principal engineer: architecture, review, CI | Specialist |
| 8 | 👁️ Iris | `@cf/moondream/moondream3.1-9B-A2B` | The council's eyes: OCR, objects, UI, charts | Specialist |

Notes:

- **Why not Nemotron 3 Super.** Dropped in favour of Gemma 4 for model-family
  diversity (Google) and vision; parameter count alone is not the criterion.
- **Gemma 4 context.** Cloudflare's page says 256K, but an open docs issue
  (cloudflare/cloudflare-docs#29731) reports the deployed limit as 128K. We
  budget Axiom's context at 120K.
- **Iris pipeline.** Moondream answers "what is visible" (objects, text,
  coordinates). Axiom (Gemma 4, vision-capable) then interprets "what it means".
- **Cost.** DeepSeek V4 Pro, Kimi and GLM-5.3 require the Workers Paid plan.
  Specialists are dormant by default, which is the main cost control.

### 2.1 Speech (phase 11)

| Purpose | Model |
|---|---|
| Speech → text | `@cf/openai/whisper-large-v3-turbo` |
| Text → speech (Cloudflare-hosted) | `@cf/myshell-ai/melotts` |
| Text → speech (many voices, partner) | `@cf/deepgram/aura-2-en` |

---

## 3. Architecture

```
            Telegram group
                  │  (only the "host" bot has a webhook)
                  ▼
   ┌──────────── Worker (src/index.ts) ────────────┐
   │ verify secret → parse update → forward to DO  │
   └───────────────────────┬───────────────────────┘
                           ▼
       CouncilRoom Durable Object (one per chat)
       ┌──────────────────────────────────────────┐
       │ Router      → which agents, which mode   │
       │ Director    → turn plan, budgets, stop   │
       │ Agent runner→ model + skills tool loop   │
       │ alarm()     → executes one step per tick │
       └───────┬──────────────┬─────────────┬─────┘
               ▼              ▼             ▼
          Workers AI      D1 (memory)   Telegram sendMessage
                                         (each agent's own bot token)
```

**Why only one bot has a webhook.** Every agent has its own Telegram bot for
identity (name, avatar), but the orchestrator posts on its behalf using that
bot's token. The agents never need to *receive* each other's messages through
Telegram because the orchestrator already has the full transcript. This
removes the bot-to-bot loop problem at the root instead of patching it with
rate limits.

**Why a Durable Object with alarms.** One DO per chat serialises everything
for that chat (no two turns race). Each LLM turn runs in its own `alarm()`
invocation, so a discussion of 15 turns is 15 short invocations rather than
one long request. A human message bumps a `generation` counter; any step from
an older generation is dropped. That is how interruption works.

### 3.1 Request flow

1. Telegram → `POST /telegram/webhook` with `X-Telegram-Bot-Api-Secret-Token`.
2. Worker ignores bot senders and non-allowed chats, then forwards the update
   to `CouncilRoom(chatId)`.
3. DO stores the message (D1), bumps `generation`, asks the **Router** for a
   plan, stores the plan, sets an alarm for "now".
4. `alarm()` pops the next step, runs the agent(s), posts the reply with the
   agent's bot token, stores it, and sets the next alarm (with cooldown).
5. When the plan is empty or budgets are hit, the discussion ends.

---

## 4. Routing and turn-taking

### 4.1 Modes

| Trigger | Mode | Behaviour |
|---|---|---|
| plain message | `chat` | 1–3 most relevant core agents, sequential, each may PASS |
| `@Atlas …` / `Atlas, …` | `direct` | only the named agent(s) |
| `/council <topic>` | `council` | round 1 blind parallel (all 5 core) → round 2 sequential debate → Nexus summary |
| `/debate <topic>` | `debate` | like council, prompts push for disagreement, 3 rounds |
| `/brainstorm <topic>` | `brainstorm` | cooperative, build on each other |
| `/critic` | `critic` | everyone attacks the last idea |
| `/stop` | — | cancels current discussion |
| `/status` | — | shows who's active/dormant and remaining budget |

### 4.2 Specialist wake-up

The router scores the message per domain with a keyword/regex scorer (cheap,
deterministic, testable):

- **coding** (code, bug, error, stack trace, API, TS/JS/Python, SQL, deploy, …)
  → Cipher wakes; if score is high also Forge.
- **architecture** (architecture, scale, race condition, schema, infra,
  Durable Objects, queue, …) → Forge wakes.
- **vision** (message has a photo/image document, or words like
  screenshot/look at/see this) → Iris wakes and goes first; Axiom follows.

A later version can replace the scorer with a small classifier model; the
interface (`route(message) → Plan`) stays the same.

### 4.3 Budgets (defaults, all in `src/config.ts`)

| Limit | Default |
|---|---|
| Max posts per discussion | 15 |
| Max rounds (debate) | 3 |
| Cooldown between agent posts | 1.5 s |
| Max tool calls per agent turn | 4 |
| Max output tokens per turn | 700 |
| Recent transcript given to agents | last 40 messages |

---

## 5. Agent prompt contract

Every agent's system prompt = shared council rules + its personality + its
skill list + its private memories + shared group facts.

Shared rules (abridged):

- You are one independent member of a council. Other members are different
  AI models.
- Never agree just because someone else said it. Evaluate independently.
- Challenge factual, logical, technical or strategic weaknesses, by name.
- Change your position when someone gives stronger evidence, and say so.
- Don't manufacture disagreement when there is real consensus.
- Don't repeat points already made.
- If you have nothing meaningful to add, reply exactly `[PASS]`.
- Keep it conversational: 1–5 short paragraphs, no headers.

---

## 6. Memory

| Level | Store | Contents | Used by |
|---|---|---|---|
| Conversation | D1 `messages` | last N messages of the chat | all agents |
| Group | D1 `group_facts` | projects, decisions, constraints | all agents |
| Private | D1 `agent_memories` | what *this* agent argued/learnt | that agent only |
| Semantic | Vectorize (phase 8) | embeddings of older messages/memories | retrieval into context |

Agents write memory through skills (`memory.remember`, `group.record_fact`),
so memory writes are their own decision, like any other skill.

Schema: `migrations/0001_init.sql`.

---

## 7. Skills

### 7.1 Model

```
src/skills/
  types.ts        Skill interface: id, description, parameters (JSON schema),
                  risk: read|write|exec, agents: [...], run(args, ctx)
  registry.ts     all skills + per-agent permission lookup
  builtin/*.ts    implementations
```

At each agent turn the runner passes that agent's permitted skills to the
model as function-calling tools. The model decides whether to call them. The
runner executes the call, feeds the result back, and loops up to the per-turn
limit. Skills with risk `write`/`exec` that are listed in
`requiresApproval` are never auto-executed; the agent is told approval is
needed and the human can approve with a reply (phase 9).

### 7.2 Three primary skills per agent

Shared by everyone: `memory.search`, `memory.remember`, `web.fetch`.

| Agent | Skill 1 | Skill 2 | Skill 3 |
|---|---|---|---|
| Atlas | `web.search` (deep research) | `web.fetch` (source cross-check) | `memory.search` (long-term) |
| Nova | `web.search` (trends/competitors) | `browser.inspect` | `group.record_fact` |
| Sage | `web.search` (fact check) | `github.read` | `web.fetch` |
| Nexus | `doc.parse` | `web.fetch` | `group.record_fact` (decisions) |
| Axiom | `browser.inspect` (UX audit) | `web.search` (customer research) | `doc.parse` |
| Cipher | `github.read` / `github.write` | `sandbox.exec` | `browser.test` |
| Forge | `github.read` | `sandbox.exec` | `github.ci_status` |
| Iris | `vision.inspect` (Moondream) | `doc.parse` (OCR) | `browser.screenshot` |

### 7.3 Providers behind the skills

| Skill | Provider | Phase |
|---|---|---|
| `memory.*`, `group.record_fact` | D1 | ✅ v1 |
| `web.fetch` | Worker `fetch` + HTML→text | ✅ v1 |
| `vision.inspect` | Workers AI Moondream 3.1 | ✅ v1 |
| `web.search` | Firecrawl API (or Brave Search API) | 8 |
| `github.read`, `github.write`, `github.ci_status` | GitHub REST API with a fine-grained token (same surface as GitHub's official MCP server) | 9 |
| `sandbox.exec` | Cloudflare Sandbox SDK (Containers) | 9 |
| `browser.inspect` / `browser.test` / `browser.screenshot` | Cloudflare Browser Rendering (Playwright) | 9 |
| `doc.parse` | Workers AI `toMarkdown` → Docling service later | 8 |

Risk policy for write/exec skills: `github.write` may create branches and PRs
but never merge; `sandbox.exec` runs only inside the Sandbox container;
production deploys always require human approval.

---

## 8. Telegram setup

- Create 8 bots with @BotFather (Atlas, Nova, …). Give each its avatar.
- Choose one as the **host** (recommend Nexus). Only it gets the webhook.
- Host bot: disable privacy mode (`/setprivacy → Disable`) so it sees every
  group message.
- Add all 8 bots to the group. The other 7 only need permission to post.
- Secrets per bot: `BOT_TOKEN_ATLAS`, `BOT_TOKEN_NOVA`, … (`wrangler secret put`).

---

## 9. Voice (phases 10–12, designed, not built)

Telegram's `phone.joinGroupCall` is user-only, so bots cannot speak in native
Telegram voice chats. Instead:

Telegram Mini App → WebRTC mic via Cloudflare Realtime SFU → Whisper STT →
**same CouncilRoom DO** → per-agent TTS voice → WebRTC back to the user.

In voice mode the director uses **speak bids**: each candidate agent returns
`{want_to_speak, importance, interrupt}` from a short, cheap call; the
highest bid gets the floor. Agent UI states: available / thinking / speaking /
listening / dormant.

---

## 10. Build phases

| # | Phase | Status |
|---|---|---|
| 1 | Worker + DO orchestration engine | ✅ |
| 2 | Telegram webhook end to end | ✅ |
| 3 | Five independent core agents | ✅ |
| 4 | Turn-taking, PASS, budgets, /stop, interruption | ✅ |
| 5 | Per-agent Telegram bot identities | ✅ |
| 6 | Cipher / Forge specialist routing | ✅ |
| 7 | Iris image pipeline (Moondream → Axiom) | ✅ |
| 8 | Vectorize memory, web.search, doc.parse | next |
| 9 | GitHub / Sandbox / Browser skills + approvals | |
| 10 | Telegram Mini App | |
| 11 | Realtime voice room | |
| 12 | Speak bids and natural interruptions | |

---

## 11. Tooling

Build with Claude Code (this repo) as the primary builder; GitHub is the
source of truth. Using several coding agents on the same branch at once
causes conflicts. Pick one per branch. None of the coding tools are council
members; the council runs entirely on Workers AI.
