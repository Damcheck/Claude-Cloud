import type { Env } from "../types";

/** Admin links are signed with a key derived from the webhook secret, separate from call links. */
export function adminSecret(env: Env): string {
  return `${env.TELEGRAM_WEBHOOK_SECRET}:admin`;
}

async function all(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
  } catch (err) {
    return [{ error: String(err) }];
  }
}

export async function adminData(env: Env): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
  const [frozen, usage, traces, calls, missions, jobs, watchers, approvals, autonomy, tools, errors] = await Promise.all([
    env.DB.prepare("SELECT value FROM settings WHERE key = 'frozen'").first<{ value: string }>().catch(() => null),
    all(env, "SELECT day, agent, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, COUNT(*) AS calls FROM usage WHERE day >= ? GROUP BY day, agent ORDER BY day DESC, agent", since),
    all(env, "SELECT id, conv_id, discussion_id, agent, models, latency_ms, prompt_tokens, completion_tokens, tool_calls, tainted, outcome, error, created_at FROM traces ORDER BY id DESC LIMIT 60"),
    all(env, "SELECT conv_id, agent, skill, args_summary, decision, tainted, ok, duration_ms, created_at FROM skill_calls ORDER BY id DESC LIMIT 60"),
    all(env, "SELECT id, conv_id, goal, status, token_budget, deadline_at, created_at, updated_at FROM missions ORDER BY id DESC LIMIT 20"),
    all(env, "SELECT id, conv_id, kind, status, created_at, updated_at FROM jobs ORDER BY id DESC LIMIT 20"),
    all(env, "SELECT id, conv_id, agent, kind, target, every_minutes, last_checked_at FROM watchers WHERE active = 1 ORDER BY id"),
    all(env, "SELECT id, conv_id, agent, skill, summary, status, created_at FROM approvals ORDER BY id DESC LIMIT 20"),
    all(env, "SELECT agent, skill, level FROM autonomy ORDER BY agent, skill"),
    all(env, "SELECT id, name, version, status, created_by, allowed_domains FROM custom_tools ORDER BY id DESC LIMIT 20"),
    all(env, "SELECT agent, error, created_at FROM traces WHERE outcome = 'error' ORDER BY id DESC LIMIT 15"),
  ]);
  return { frozen: frozen?.value === "1", usage, traces, calls, missions, jobs, watchers, approvals, autonomy, tools, errors };
}

export function renderAdmin(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Council Admin</title>
<style>
:root { --bg:#0f1115; --card:#181b22; --text:#e8eaf0; --muted:#8b91a1; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --card:#fff; --text:#14161b; --muted:#667085; --ok:#16a34a; --bad:#dc2626; --warn:#d97706; } }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:1200px; margin:0 auto; padding:16px; }
h1 { font-size:18px; } h2 { font-size:15px; margin:22px 0 8px; }
.card { background:var(--card); border-radius:12px; padding:12px; overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid color-mix(in srgb, var(--muted) 25%, transparent); white-space:nowrap; max-width:420px; overflow:hidden; text-overflow:ellipsis; }
th { color:var(--muted); font-weight:600; }
.ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
.pill { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:600; }
</style></head>
<body><main>
<h1>AI Council · Admin <span id="frozen"></span></h1>
<div id="root">Loading…</div>
</main>
<script>
(function () {
  var t = new URLSearchParams(location.search).get("t") || "";
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function when(ms) { return ms ? new Date(Number(ms)).toISOString().slice(5, 16).replace("T", " ") : ""; }
  function table(rows, cols) {
    if (!rows || !rows.length) return '<div class="card">Nothing yet.</div>';
    var h = "<tr>" + cols.map(function (c) { return "<th>" + esc(c[0]) + "</th>"; }).join("") + "</tr>";
    var b = rows.map(function (r) { return "<tr>" + cols.map(function (c) { var v = c[2] ? c[2](r[c[1]], r) : esc(r[c[1]]); return "<td>" + v + "</td>"; }).join("") + "</tr>"; }).join("");
    return '<div class="card"><table>' + h + b + "</table></div>";
  }
  var outcome = function (v) { return '<span class="' + (v === "error" ? "bad" : v === "passed" ? "warn" : "ok") + '">' + esc(v) + "</span>"; };
  var yes = function (v) { return v ? '<span class="warn">yes</span>' : ""; };
  fetch("/admin/api?t=" + encodeURIComponent(t)).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (d) {
    document.getElementById("frozen").innerHTML = d.frozen ? '<span class="pill bad">FROZEN</span>' : '<span class="pill ok">live</span>';
    document.getElementById("root").innerHTML =
      "<h2>Recent turns</h2>" + table(d.traces, [["when", "created_at", when], ["agent", "agent"], ["models", "models"], ["ms", "latency_ms"], ["in", "prompt_tokens"], ["out", "completion_tokens"], ["skills", "tool_calls"], ["tainted", "tainted", yes], ["outcome", "outcome", outcome], ["error", "error"]]) +
      "<h2>Skill calls (audit)</h2>" + table(d.calls, [["when", "created_at", when], ["agent", "agent"], ["skill", "skill"], ["decision", "decision"], ["tainted", "tainted", yes], ["ok", "ok"], ["ms", "duration_ms"], ["args", "args_summary"]]) +
      "<h2>Token usage (7 days)</h2>" + table(d.usage, [["day", "day"], ["agent", "agent"], ["prompt", "prompt"], ["completion", "completion"], ["calls", "calls"]]) +
      "<h2>Missions</h2>" + table(d.missions, [["#", "id"], ["goal", "goal"], ["status", "status"], ["budget", "token_budget"], ["deadline", "deadline_at", when], ["updated", "updated_at", when]]) +
      "<h2>Jobs</h2>" + table(d.jobs, [["#", "id"], ["kind", "kind"], ["status", "status"], ["started", "created_at", when], ["updated", "updated_at", when]]) +
      "<h2>Approvals</h2>" + table(d.approvals, [["#", "id"], ["agent", "agent"], ["skill", "skill"], ["summary", "summary"], ["status", "status"], ["when", "created_at", when]]) +
      "<h2>Watchers</h2>" + table(d.watchers, [["#", "id"], ["agent", "agent"], ["kind", "kind"], ["target", "target"], ["every (min)", "every_minutes"], ["last check", "last_checked_at", when]]) +
      "<h2>Autonomy rules</h2>" + table(d.autonomy, [["agent", "agent"], ["skill", "skill"], ["level", "level"]]) +
      "<h2>Council-built tools</h2>" + table(d.tools, [["#", "id"], ["name", "name"], ["v", "version"], ["status", "status"], ["by", "created_by"], ["domains", "allowed_domains"]]) +
      "<h2>Recent errors</h2>" + table(d.errors, [["when", "created_at", when], ["agent", "agent"], ["error", "error"]]);
  }).catch(function (e) { document.getElementById("root").textContent = "Couldn't load: " + e.message + ". Get a fresh link with /admin in Telegram."; });
})();
</script></body></html>`;
}
