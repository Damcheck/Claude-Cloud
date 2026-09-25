# AI Council

Eight independent AI agents, each on its own Cloudflare Workers AI model, discussing with
you (and each other) in a Telegram group, in DMs, by voice note, and live in a voice room.
One orchestrator decides who speaks, stops loops, and keeps cost bounded.

| Agent | Model | Role |
|---|---|---|
| 🧠 Atlas | DeepSeek V4 Pro | Deep reasoning, pre-mortems, decision matrices |
| 🌙 Nova | Kimi K2.6 | Unconventional strategy, idea bank |
| ⚡ Sage | GLM-5.3 Flash | Fast challenger, fact checks, claim ledger |
| 🔮 Nexus | Qwen 3.8 27B | Synthesis, minutes, action items, daily brief (host bot) |
| 💠 Axiom | Gemma 4 26B A4B | Product/UX, browser audits, customer personas |
| 💻 Cipher | Kimi K2.7 Code | Programmer: GitHub + sandbox + browser tests (wakes for code) |
| 🏗️ Forge | GLM-5.3 | Principal engineer, reviews Cipher's PRs (wakes for architecture) |
| 👁️ Iris | Moondream 3.1 | Vision: images, OCR, website screenshots (wakes for images/links) |

Full design: [`docs/SPEC.md`](docs/SPEC.md).

## What it can do

- **Group discussions** with blind first rounds, debates, `[PASS]` silence, interruption, budgets.
- **DMs:** message any member's bot one-on-one; they still share the group's memory.
- **Voice notes:** send one and members answer with voice notes in their own voices.
- **Live voice room** (`/call`): talk naturally, members bid for the floor, talk over them to interrupt.
- **Skills the agents use on their own:** web search, page reading, documents, GitHub,
  an isolated code sandbox, a real browser, vision, memory, private consultations,
  follow-ups, predictions, claims, ideas, action items.
- **Approvals:** opening PRs and deploy/push commands ask you first with ✅ / ❌ buttons.
- **Memory:** conversation, group facts, private per-agent memory, semantic recall
  (Vectorize), automatic discussion summaries.
- **Hardening:** owner-only, duplicate-update filtering, backup model per agent, daily
  token budget per agent, `/cost`, AI Gateway support, Telegram formatting with plain-text fallback.

## Commands

| | |
|---|---|
| plain message / voice note / image / document | the most relevant members reply |
| `@Atlas …`, `Nova, …`, reply to a member, `/atlas …` | only that member |
| `/council` `/debate` `/brainstorm <topic>`, `/critic` | group discussion modes |
| `/premortem <plan>` `/decide <question>` `/personas <idea>` | Atlas / Atlas / Axiom specials |
| `/minutes`, `/brief`, `/brief on\|off` | Nexus |
| `/actions` `/claims` `/ideas` `/record` `/followups` `/cost` | records |
| `/call`, `/voice on\|off` | voice |
| `/stop` `/status` `/help` | |

## Setup

Requires the Workers **Paid** plan. Docker must be running when you deploy (for the
sandbox container); without it, use `npm run deploy:no-sandbox`.

```bash
npm install

# 1. Storage
npx wrangler d1 create ai-council            # copy the id into wrangler.jsonc
npm run db:migrate
npm run vectorize:create                     # semantic memory (1024-dim, cosine)

# 2. Telegram: create 8 bots with @BotFather.
#    - Put the agent's name in each username (e.g. DamAtlasBot) so mentions resolve.
#    - Host bot (Nexus): /setprivacy -> Disable.
#    - Add all 8 bots to your group.
#    - Optional: /newapp on the Nexus bot (URL: https://<worker>/app) for the in-Telegram call button.

# 3. Config (wrangler.jsonc "vars"): at least
#    OWNER_USER_IDS   your Telegram user id (message @userinfobot to find it)
#    ALLOWED_CHAT_IDS your group id
#    PUBLIC_URL       https://ai-council.<your-subdomain>.workers.dev
#    GITHUB_REPOS     repos Cipher/Forge may touch, e.g. damcheck/claude-cloud
#    MINIAPP_URL      https://t.me/<NexusBot>/<app> if you created the Mini App
#    AI_GATEWAY_ID    optional, for dollar costs and logs

# 4. Secrets
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
for a in ATLAS NOVA SAGE NEXUS AXIOM CIPHER FORGE IRIS; do npx wrangler secret put BOT_TOKEN_$a; done
npx wrangler secret put FIRECRAWL_API_KEY          # or BRAVE_API_KEY, for web.search
npx wrangler secret put GITHUB_TOKEN               # fine-grained: contents + pull requests (rw), actions (r)

# 5. Deploy and connect all bots
npm run deploy
WEBHOOK_SECRET=<same secret> WORKER_URL=https://ai-council.<your-subdomain>.workers.dev \
  BOT_TOKEN_NEXUS=... BOT_TOKEN_ATLAS=... BOT_TOKEN_NOVA=... BOT_TOKEN_SAGE=... \
  BOT_TOKEN_AXIOM=... BOT_TOKEN_CIPHER=... BOT_TOKEN_FORGE=... BOT_TOKEN_IRIS=... \
  npm run telegram:setup
```

Anything optional that isn't configured simply switches off: skills without their key or
binding aren't offered to the agents, and `/status` shows what's on. A bot without a
token still works; its replies go through the host bot with a name prefix.

**Important:** set `OWNER_USER_IDS`. If it's empty, anyone who can message the bots can
use the council and your credits.

## Development

```bash
npm test          # routing, prompts, runner (fake AI), skills, Telegram parsing, formatting, voice auth, bids
npm run typecheck
cp .dev.vars.example .dev.vars && npm run dev
```
