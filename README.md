# AI Council

Eight independent AI agents, each on its own Cloudflare Workers AI model, discussing
with you (and each other) in a Telegram group. One orchestrator decides who speaks,
stops loops, and keeps cost bounded.

| Agent | Model | Role |
|---|---|---|
| 🧠 Atlas | DeepSeek V4 Pro | Deep reasoning |
| 🌙 Nova | Kimi K2.6 | Unconventional strategy |
| ⚡ Sage | GLM-5.3 Flash | Fast challenger |
| 🔮 Nexus | Qwen 3.8 27B | Synthesis and summaries (host bot) |
| 💠 Axiom | Gemma 4 26B A4B | Product pragmatist |
| 💻 Cipher | Kimi K2.7 Code | Programmer (wakes for code) |
| 🏗️ Forge | GLM-5.3 | Principal engineer (wakes for architecture) |
| 👁️ Iris | Moondream 3.1 | Vision (wakes for images) |

Full design: [`docs/SPEC.md`](docs/SPEC.md).

## How it works

- Only the **host bot** (Nexus) receives the Telegram webhook. The orchestrator posts
  each agent's reply with that agent's own bot token, so every member has its own
  name and avatar, and bots never trigger each other.
- One Durable Object per chat runs the discussion one turn per `alarm()`. Any new
  human message interrupts it; `/stop` ends it.
- Agents may answer `[PASS]` and stay silent. In `/council`, round 1 is blind: they
  answer in parallel without seeing each other.
- Agents call their skills (memory, web fetch, vision) on their own through
  function calling, limited to 4 calls per turn.

## Commands

| | |
|---|---|
| plain message | the 1–2 most relevant members reply |
| `@Atlas …`, `Nova, …`, reply to a member, `/atlas …` | only that member replies |
| `/council <topic>` | blind round → debate round → Nexus summary |
| `/debate <topic>` | 3 rounds of argument → summary |
| `/brainstorm <topic>` | cooperative ideas |
| `/critic` | everyone attacks the current idea |
| `/stop`, `/status`, `/help` | |

## Setup

Requires the Workers **Paid** plan (DeepSeek V4 Pro, Kimi and GLM-5.3 need it).

```bash
npm install

# 1. Database
npx wrangler d1 create ai-council        # copy the id into wrangler.jsonc
npm run db:migrate

# 2. Telegram: create 8 bots with @BotFather.
#    Put the agent's name in each username (e.g. DamAtlasBot) so mentions resolve.
#    For the host bot (Nexus): /setprivacy -> Disable.
#    Add all 8 bots to your group.

# 3. Secrets
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
for a in ATLAS NOVA SAGE NEXUS AXIOM CIPHER FORGE IRIS; do npx wrangler secret put BOT_TOKEN_$a; done

# 4. Deploy and connect the webhook
npm run deploy
HOST_BOT_TOKEN=<nexus token> WEBHOOK_SECRET=<same secret> \
  WORKER_URL=https://ai-council.<your-subdomain>.workers.dev npm run telegram:setup
```

Optional: set `ALLOWED_CHAT_IDS` in `wrangler.jsonc` to lock the council to your group.
A bot without a token still works; its replies go through the host bot with a name prefix.

## Development

```bash
npm test          # router, turn planning, reply cleaning, AI response parsing
npm run typecheck
cp .dev.vars.example .dev.vars && npm run dev
```
