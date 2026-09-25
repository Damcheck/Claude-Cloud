# AI Council

Eight independent AI agents, each on its own Cloudflare Workers AI model, working with you
in a Telegram group, in DMs, by voice note, live in a voice room, and on the phone. They
debate, remember, watch things for you, run multi-day missions, build their own tools,
and learn from your feedback, all behind an autonomy policy you control.

| Agent | Model | Role |
|---|---|---|
| 🧠 Atlas | DeepSeek V4 Pro | Deep reasoning, pre-mortems, decision matrices, research reports |
| 🌙 Nova | Kimi K2.6 | Unconventional strategy, idea bank, trend watching |
| ⚡ Sage | GLM-5.3 Flash | Fast challenger, fact checks, claim ledger, crux research |
| 🔮 Nexus | Qwen 3.8 27B | Synthesis, minutes, missions planner, daily brief (host bot) |
| 💠 Axiom | Gemma 4 26B A4B | Product/UX, browser audits, customer personas |
| 💻 Cipher | Kimi K2.7 Code | Programmer: GitHub + sandbox + browser tests, builds tools |
| 🏗️ Forge | GLM-5.3 | Principal engineer: reviews PRs and tools, CI investigations |
| 👁️ Iris | Moondream 3.1 | Vision: images, OCR, screenshots, design comparisons |

Full design: [`docs/SPEC.md`](docs/SPEC.md).

## What it does

**Talk.** Group discussions with blind first rounds, crux finding and a groupthink guard;
DMs with any member; voice notes answered in each member's voice; a live voice room with
streaming turn detection; phone calls through Twilio.

**Work by itself.**
- `/mission <goal>`: Nexus plans, the members execute over hours or days, and it checks success.
- `/research <topic>`: reads up to 24 sources and produces a cited report.
- `/build <section>`: mockup → Liquid section → render → compare → iterate → PR.
- `/watch <url|feed|repo>`: members notice changes and CI failures and speak up, or save them for the brief.
- Daily brief, Monday plan, Friday retro, follow-ups the members schedule for themselves.

**Get better.** Your 👍/👎 reactions become lessons; weekly reflection with eval-gated
personality changes; model scouting that proposes better models; calibrated forecasts
(`/forecast`, Brier-weighted); a knowledge graph that flags contradictions.

**Stay safe.** `/autonomy` levels per agent and skill, `/freeze`, `/dryrun`, approval
buttons for PRs, deploys, missions, tools and model swaps, prompt-injection taint tracking,
a full audit log, `/why`, an admin dashboard, daily token budgets, and backups.

**Extend.** MCP connectors (Shopify, Supabase, Vercel, Sentry, …) and tools the council
writes, reviews and runs in locked-down isolates.

## Commands

| | |
|---|---|
| talk, voice note, image, document, `@Atlas …`, DM | the most relevant members reply |
| `/council` `/debate` `/brainstorm <topic>`, `/critic` | group discussion modes |
| `/premortem` `/decide` `/personas` `/forecast` `/resolve` | specials |
| `/mission` `/missions` `/mission_reply` `/mission_stop` | missions |
| `/research` `/build` `/watch` `/watchers` `/unwatch` | background work |
| `/minutes` `/brief [on\|off]` | Nexus |
| `/actions` `/claims` `/ideas` `/decisions` `/record` `/lessons` `/followups` `/graph` | records |
| `/autonomy` `/freeze` `/unfreeze` `/dryrun` `/audit` `/why` `/stop` | control |
| `/cost` `/models` `/tools` `/eval` `/reflect` `/scout` `/selftest` `/admin` `/backup` | operations |
| `/call` `/voice on\|off` | voice |

## Setup

Requires the Workers **Paid** plan. Docker must be running when you deploy (for the
sandbox container); without it, use `npm run deploy:no-sandbox`.

```bash
npm install

# 1. Storage
npx wrangler d1 create ai-council            # copy the id into wrangler.jsonc
npm run db:migrate                           # applies 0001–0003
npm run vectorize:create                     # semantic memory (1024-dim, cosine)
npx wrangler r2 bucket create ai-council-backups

# 2. Telegram: create 8 bots with @BotFather.
#    - Put the agent's name in each username (e.g. DamAtlasBot) so mentions resolve.
#    - Host bot (Nexus): /setprivacy -> Disable. Make it a group admin (to see reactions).
#    - Add all 8 bots to your group.
#    - Optional: /newapp on the Nexus bot (URL https://<worker>/app) for the in-Telegram call button.

# 3. Config (wrangler.jsonc "vars"): at least
#    OWNER_USER_IDS   your Telegram user id (message @userinfobot)
#    ALLOWED_CHAT_IDS your group id
#    PUBLIC_URL       https://ai-council.<your-subdomain>.workers.dev
#    Optional: GITHUB_REPOS, MCP_SERVERS, SHOPIFY_STORE + SHOPIFY_THEME_ID,
#              OWNER_PHONE_NUMBERS, MINIAPP_URL, AI_GATEWAY_ID

# 4. Secrets
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
for a in ATLAS NOVA SAGE NEXUS AXIOM CIPHER FORGE IRIS; do npx wrangler secret put BOT_TOKEN_$a; done
npx wrangler secret put FIRECRAWL_API_KEY          # or BRAVE_API_KEY (web search, research)
npx wrangler secret put GITHUB_TOKEN               # fine-grained: contents + PRs (rw), actions (r)
# optional: GITHUB_WEBHOOK_SECRET, MCP_TOKEN_<NAME>, SHOPIFY_CLI_THEME_TOKEN, TWILIO_AUTH_TOKEN

# 5. Deploy, connect the bots, verify
npm run deploy
WEBHOOK_SECRET=<same secret> WORKER_URL=https://ai-council.<your-subdomain>.workers.dev \
  BOT_TOKEN_NEXUS=... BOT_TOKEN_ATLAS=... BOT_TOKEN_NOVA=... BOT_TOKEN_SAGE=... \
  BOT_TOKEN_AXIOM=... BOT_TOKEN_CIPHER=... BOT_TOKEN_FORGE=... BOT_TOKEN_IRIS=... \
  npm run telegram:setup
# then in the group:  /selftest   and   /brief on
```

Optional integrations:
- **GitHub CI alerts**: repo webhook → `https://<worker>/github/webhook`, event
  `workflow_run`, secret `GITHUB_WEBHOOK_SECRET`; then `/watch owner/repo`.
- **Phone**: point a Twilio number's voice webhook (POST) at `https://<worker>/twilio/voice`;
  set `TWILIO_AUTH_TOKEN` and `OWNER_PHONE_NUMBERS`.
- **MCP**: `MCP_SERVERS='[{"name":"sentry","url":"https://…/mcp","agents":["forge","cipher"]}]'`
  plus `MCP_TOKEN_SENTRY`.

Anything optional that isn't configured simply switches off; `/status` and `/selftest`
show what's on.

**Important:** set `OWNER_USER_IDS`. If it's empty, anyone who can message the bots can use
the council and your credits.

## Development

```bash
npm test          # 115 tests: routing, policy, runner (fake AI), missions, forecasts,
                  # watchers, voice codecs, Twilio/initData auth, MCP, tools, schedule, …
npm run typecheck
cp .dev.vars.example .dev.vars && npm run dev
```
