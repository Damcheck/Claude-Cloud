// Registers the Telegram webhook for every agent bot that has a token.
// Each bot gets its own path so DMs and approval buttons reach the right agent;
// group messages are only processed from the host bot.
//
// Usage:
//   WEBHOOK_SECRET=... WORKER_URL=https://ai-council.<you>.workers.dev \
//   BOT_TOKEN_NEXUS=... BOT_TOKEN_ATLAS=... (etc.) npm run telegram:setup
const { WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!WEBHOOK_SECRET || !WORKER_URL) {
  console.error("Set WEBHOOK_SECRET and WORKER_URL, plus BOT_TOKEN_<AGENT> for each bot.");
  process.exit(1);
}
const agents = ["atlas", "nova", "sage", "nexus", "axiom", "cipher", "forge", "iris"];
const commands = [
  ["council", "All core members: blind round, debate, summary"],
  ["debate", "Rounds of argument on a topic"],
  ["brainstorm", "Cooperative ideas"],
  ["critic", "Everyone attacks the current idea"],
  ["premortem", "Atlas imagines the failure"],
  ["decide", "Atlas builds a decision matrix"],
  ["personas", "Axiom role-plays customers"],
  ["minutes", "Nexus writes minutes and action items"],
  ["brief", "Daily brief (on/off)"],
  ["call", "Open the live voice room"],
  ["voice", "Voice replies on/off"],
  ["actions", "Open action items"],
  ["claims", "Claim ledger"],
  ["ideas", "Idea bank"],
  ["record", "Prediction track records"],
  ["followups", "Scheduled follow-ups"],
  ["cost", "Token usage"],
  ["stop", "End the current discussion"],
  ["status", "Who's here"],
  ["help", "All commands"],
].map(([command, description]) => ({ command, description }));

for (const agent of agents) {
  const token = process.env[`BOT_TOKEN_${agent.toUpperCase()}`];
  if (!token) {
    console.log(`${agent}: no token, skipped`);
    continue;
  }
  const api = (method, body) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const hook = await api("setWebhook", {
    url: `${WORKER_URL.replace(/\/$/, "")}/telegram/webhook/${agent}`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  const cmds = await api("setMyCommands", { commands });
  console.log(`${agent}: webhook ${hook.ok ? "ok" : hook.description}, commands ${cmds.ok ? "ok" : cmds.description}`);
}
