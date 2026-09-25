// Registers the Telegram webhook for the host bot.
// Usage: HOST_BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://ai-council.<you>.workers.dev npm run telegram:setup
const { HOST_BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!HOST_BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) {
  console.error("Set HOST_BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL.");
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${HOST_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${WORKER_URL.replace(/\/$/, "")}/telegram/webhook`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
});
console.log(await res.json());
