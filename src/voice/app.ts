/**
 * The live voice room, served at /app. Works as a Telegram Mini App (auth via initData)
 * or in any browser (auth via the signed link from /call).
 *
 * Client pipeline: mic → energy-based voice activity detection → 16 kHz WAV per utterance
 * → WebSocket → Whisper → council → Aura-2 audio chunks back → ordered playback.
 * A manual interrupt button avoids speaker echo being mistaken for the founder's voice.
 */
export function renderApp(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>AI Council Live</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root { --bg:#0f1115; --card:#181b22; --text:#e8eaf0; --muted:#8b91a1; --accent:#6ea8ff; --speak:#4ade80; --think:#fbbf24; --danger:#ef4444; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --card:#ffffff; --text:#14161b; --muted:#667085; --accent:#2563eb; --speak:#16a34a; --think:#d97706; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height:100vh; }
main { max-width:640px; margin:0 auto; padding:16px; display:flex; flex-direction:column; gap:14px; min-height:100vh; }
h1 { font-size:18px; margin:4px 0 0; text-align:center; letter-spacing:.3px; }
.sub { text-align:center; color:var(--muted); font-size:13px; margin-top:-8px; }
.tabs { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; padding:4px; border-radius:14px; background:var(--card); }
.tabs button { padding:9px 8px; border-radius:11px; font-size:12px; color:var(--muted); }
.tabs button.active { background:var(--accent); color:#fff; }
.os-panel { display:grid; gap:12px; }
.os-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.world-name { font-size:19px; font-weight:800; }
.eyebrow { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
.os-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
.os-card { background:var(--card); border-radius:14px; padding:12px; min-width:0; }
.os-card.wide { grid-column:1/-1; }
.os-card h2 { margin:0 0 9px; font-size:13px; }
.metric { display:flex; justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid color-mix(in srgb,var(--muted) 15%,transparent); font-size:12px; }
.metric:last-child { border:0; }
.score { color:var(--accent); font-variant-numeric:tabular-nums; }
.timeline { display:grid; gap:8px; max-height:58vh; overflow:auto; }
.event { background:var(--card); border-radius:12px; padding:10px 12px; border-left:3px solid var(--accent); }
.event small { color:var(--muted); display:block; margin-bottom:3px; }
.event p { margin:0; font-size:13px; }
.video-stage { position:relative; aspect-ratio:16/9; overflow:hidden; border-radius:16px; background:#050608; border:1px solid color-mix(in srgb, var(--muted) 35%, transparent); }
.video-stage video { width:100%; height:100%; display:block; object-fit:cover; transform:scaleX(-1); }
.video-badge { position:absolute; left:10px; bottom:10px; padding:6px 9px; border-radius:999px; background:#000b; color:#fff; font-size:11px; }
.roundtable { position:relative; height:min(132vw,620px); min-height:470px; overflow:hidden; border-radius:28px; border:1px solid #90a4c52b; background:radial-gradient(ellipse at 50% 48%,#1c2638 0 18%,#0b101b 48%,#05070d 78%),linear-gradient(145deg,#111827,#03050a); box-shadow:inset 0 0 80px #000,0 18px 50px #0008; }
.roundtable::before { content:""; position:absolute; inset:7%; border:1px solid #b9d6ff17; border-radius:50%; box-shadow:0 0 45px #3b82f615,inset 0 0 45px #3b82f60d; }
.roundtable::after { content:""; position:absolute; inset:0; pointer-events:none; background:repeating-conic-gradient(from 12deg at 50% 48%,#ffffff07 0 1deg,transparent 1deg 45deg); opacity:.42; }
.grid { position:absolute; inset:0; z-index:3; }
.council-table { position:absolute; z-index:2; left:50%; top:49%; width:54%; height:28%; transform:translate(-50%,-50%) perspective(420px) rotateX(57deg); border-radius:50%; background:radial-gradient(ellipse,#27364e 0 10%,#131d2d 42%,#080d16 73%); border:3px solid #84aef05c; box-shadow:0 0 0 9px #101827,0 18px 24px #000c,inset 0 0 24px #79a8ff35; }
.table-core { position:absolute; z-index:4; left:50%; top:49%; transform:translate(-50%,-50%); width:34%; text-align:center; pointer-events:none; }
.table-seal { width:48px; height:48px; margin:0 auto 5px; display:grid; place-items:center; border-radius:50%; color:#c9ddff; font-size:22px; background:#0a1220; border:1px solid #7daaff78; box-shadow:0 0 24px #3b82f66b; }
.table-title { color:#dce9ff; font-weight:800; font-size:11px; letter-spacing:.16em; text-transform:uppercase; text-shadow:0 2px 8px #000; }
.table-sub { color:#86a2c9; font-size:9px; margin-top:3px; }
.agent { --voice:0; --jaw:1; --lip-wide:1; position:absolute; left:var(--seat-x); top:var(--seat-y); width:clamp(76px,23vw,122px); transform:translate(-50%,-50%); background:#0b1019; border-radius:48% 48% 18px 18px; overflow:hidden; border:2px solid #8ba4c52c; transition:border-color .2s, opacity .2s, transform .2s, filter .2s; box-shadow:0 10px 24px #000b; }
.agent:hover { transform:translate(-50%,-50%) scale(1.04); }
.avatar { position:relative; width:100%; aspect-ratio:.86; overflow:hidden; background:#080a10; }
.portrait { width:100%; height:100%; display:block; object-fit:cover; transform:scale(calc(1.01 + var(--voice) * .035)); transition:filter .25s; will-change:transform,filter; }
.mouth-layer { position:absolute; z-index:1; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; pointer-events:none; clip-path:polygon(var(--mouth-left) var(--mouth-top),var(--mouth-right) var(--mouth-top),var(--mouth-right) var(--mouth-bottom),var(--mouth-left) var(--mouth-bottom)); transform-origin:var(--mouth-x) var(--mouth-y); transform:scaleX(var(--lip-wide)) scaleY(var(--jaw)); will-change:transform; }
.agent.speaking .mouth-layer { opacity:1; }
.agent-info { position:absolute; inset:auto 0 0; padding:23px 7px 6px; color:#fff; background:linear-gradient(transparent, rgba(0,0,0,.94)); }
.agent .name { font-size:12px; font-weight:800; text-shadow:0 1px 3px #000; white-space:nowrap; }
.agent .state { font-size:9px; color:#c7ccda; }
.voice-bars { position:absolute; right:9px; bottom:11px; height:18px; display:flex; align-items:end; gap:2px; opacity:0; }
.voice-bars i { width:3px; min-height:3px; border-radius:3px; background:#fff; transform-origin:bottom; transform:scaleY(calc(.2 + var(--voice) * 1.8)); }
.voice-bars i:nth-child(2) { transform:scaleY(calc(.35 + var(--voice) * 2.5)); }
.voice-bars i:nth-child(3) { transform:scaleY(calc(.2 + var(--voice) * 1.5)); }
.mouth { position:absolute; z-index:2; left:var(--mouth-x,50%); top:var(--mouth-y,50%); width:var(--mouth-w,14%); height:1px; transform:translate(-50%,-50%) scaleX(var(--mouth-shape,.55)); border-radius:50%; background:#240910; opacity:0; box-shadow:inset 0 1px 2px #000, 0 0 2px #0008; transition:height 45ms linear,opacity 35ms linear,transform 45ms linear; }
.mouth::after { content:""; position:absolute; left:15%; right:15%; top:8%; height:22%; border-radius:50%; background:#f4e9df; opacity:0; }
.agent.speaking[data-viseme="M"] .mouth { opacity:.78; --mouth-shape:.55; height:1.2%; }
.agent.speaking[data-viseme="A"] .mouth { opacity:.94; --mouth-shape:.72; height:6%; }
.agent.speaking[data-viseme="E"] .mouth { opacity:.9; --mouth-shape:.9; height:3.2%; }
.agent.speaking[data-viseme="E"] .mouth::after { opacity:.9; }
.agent.speaking[data-viseme="O"] .mouth { opacity:.94; --mouth-shape:.42; height:6%; }
.agent.speaking[data-viseme="F"] .mouth { opacity:.88; --mouth-shape:.72; height:2.5%; }
.agent.speaking[data-viseme="F"] .mouth::after { opacity:.85; }
.agent.speaking[data-viseme="T"] .mouth { opacity:.86; --mouth-shape:.76; height:3.6%; }
.agent.speaking[data-viseme="T"] .mouth::after { opacity:.65; }
.agent.speaking { z-index:6; border-color:var(--speak); transform:translate(-50%,-50%) scale(1.1); box-shadow:0 0 0 4px color-mix(in srgb, var(--speak) 20%, transparent),0 0 34px color-mix(in srgb,var(--speak) 42%,transparent); }
.agent.speaking .state { color:var(--speak); }
.agent.speaking .portrait { filter:brightness(calc(1.02 + var(--voice) * .18)); }
.agent.speaking .voice-bars { opacity:1; }
.agent.thinking { border-color:var(--think); }
.agent.thinking .state { color:var(--think); }
.agent.dormant { opacity:.52; filter:saturate(.45); }
@media (min-width:560px) { .roundtable { height:610px; } .agent { width:118px; } .table-title { font-size:13px; } }
.log { flex:1; background:var(--card); border-radius:14px; padding:12px; overflow-y:auto; max-height:34vh; min-height:120px; font-size:14px; }
.log p { margin:0 0 8px; }
.log b { font-weight:600; }
.me { display:flex; align-items:center; justify-content:center; gap:10px; color:var(--muted); font-size:13px; }
.dot { width:12px; height:12px; border-radius:50%; background:var(--muted); transition:transform .08s, background .2s; }
.dot.live { background:var(--speak); }
.controls { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; padding-bottom:env(safe-area-inset-bottom); }
button { border:0; border-radius:999px; padding:12px 18px; font-size:15px; font-weight:600; cursor:pointer; background:var(--card); color:var(--text); }
button.primary { background:var(--accent); color:#fff; }
button.danger { background:var(--danger); color:#fff; }
form { display:flex; gap:8px; }
input { flex:1; border-radius:999px; border:1px solid color-mix(in srgb, var(--muted) 40%, transparent); background:var(--card); color:var(--text); padding:10px 14px; font-size:15px; }
.hidden { display:none !important; }
.toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#000c; color:#fff; padding:8px 14px; border-radius:10px; font-size:13px; }
</style>
</head>
<body>
<main>
  <h1>AI COUNCIL LIVE</h1>
  <div class="sub" id="sub">Tap Join to start. Talk naturally; use Interrupt when you need the floor.</div>
  <nav class="tabs"><button type="button" class="active" data-view="chamber">Chamber</button><button type="button" data-view="intelligence">Council OS</button><button type="button" data-view="replay">Replay</button></nav>
  <div class="video-stage hidden" id="videoStage">
    <video id="cameraView" autoplay muted playsinline></video>
    <div class="video-badge">Camera on · no recording</div>
  </div>
  <section class="roundtable" id="roundtable" aria-label="Council chamber">
    <div class="grid" id="grid"></div>
    <div class="council-table"></div>
    <div class="table-core"><div class="table-seal">◈</div><div class="table-title">Aegis Council</div><div class="table-sub">Live chamber</div></div>
  </section>
  <section class="os-panel hidden" id="osPanel">
    <div class="os-head"><div><div class="eyebrow">Active project world</div><div class="world-name" id="worldName">General</div></div><button type="button" id="refreshOs">↻ Refresh</button></div>
    <div class="os-grid">
      <div class="os-card"><h2>🏆 Reputation</h2><div id="reputation"></div></div>
      <div class="os-card"><h2>🤝 Relationships</h2><div id="relationships"></div></div>
      <div class="os-card"><h2>🎯 Missions</h2><div id="missions"></div></div>
      <div class="os-card"><h2>⚔️ War rooms</h2><div id="simulations"></div></div>
      <div class="os-card wide"><h2>🧭 Decisions</h2><div id="decisions"></div></div>
    </div>
  </section>
  <section class="hidden" id="replayPanel"><div class="os-head"><div><div class="eyebrow">Meeting memory</div><div class="world-name">Replay</div></div></div><div class="timeline" id="timeline"></div></section>
  <div class="me" id="me"><div class="dot" id="dot"></div><span id="mestate">Not connected</span></div>
  <div class="log" id="log"></div>
  <form id="say" class="hidden"><input id="sayText" placeholder="Or type…" autocomplete="off"><button type="submit">Send</button></form>
  <div class="controls" id="controls">
    <button class="primary" id="join">🎙️ Join call</button>
    <button id="mute" class="hidden">🔇 Mute</button>
    <button id="camera" class="hidden">📹 Start video</button>
    <button id="screen" class="hidden">🖥️ Share screen</button>
    <button id="interrupt" class="hidden">✋ Interrupt</button>
    <button class="danger hidden" id="end">End call</button>
  </div>
</main>
<script>
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }
  var params = new URLSearchParams(location.search);
  var token = params.get("t");
  var initData = tg && tg.initData ? tg.initData : "";

  var $ = function (id) { return document.getElementById(id); };
  var agents = {};
  var ws = null, audioCtx = null, masterGain = null, micStream = null, processor = null, muted = false, joined = false;
  var cameraStream = null, cameraTimer = null, captureCanvas = null, cameraOn = false, screenOn = false;
  var queue = [], current = null, playing = false, streaming = false, voiceFrame = null, osState = null;

  var STATE_LABEL = { listening: "Listening", thinking: "Thinking…", speaking: "Speaking", dormant: "Sleeping" };
  // Portrait-specific facial landmarks measured from the shipped 512×512 avatars.
  var MOUTH = {
    atlas:{x:50.4,y:49.6,w:16.0}, nova:{x:50.3,y:54.5,w:13.5}, sage:{x:50.3,y:46.8,w:12.0}, nexus:{x:50.4,y:48.5,w:13.3},
    axiom:{x:50.0,y:49.5,w:14.1}, cipher:{x:50.3,y:50.8,w:15.4}, forge:{x:49.9,y:51.6,w:15.8}, iris:{x:50.5,y:51.6,w:12.8}
  };

  function toast(text) {
    var t = document.createElement("div"); t.className = "toast"; t.textContent = text;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3000);
  }
  function log(who, text) {
    var p = document.createElement("p"); var b = document.createElement("b");
    b.textContent = who + ": "; p.appendChild(b); p.appendChild(document.createTextNode(text));
    $("log").appendChild(p); $("log").scrollTop = $("log").scrollHeight;
  }
  function renderAgents(list) {
    $("grid").innerHTML = "";
    list.forEach(function (a, index) {
      var el = document.createElement("div"); el.className = "agent " + a.state; el.id = "agent-" + a.id;
      el.innerHTML = '<div class="avatar"><img class="portrait" alt=""><img class="mouth-layer" alt="" aria-hidden="true"><div class="mouth"></div><div class="agent-info"><div class="name"></div><div class="state"></div></div><div class="voice-bars"><i></i><i></i><i></i></div></div>';
      var mouth=MOUTH[a.id]||{x:50,y:50,w:14};
      el.style.setProperty("--mouth-x",mouth.x+"%"); el.style.setProperty("--mouth-y",mouth.y+"%"); el.style.setProperty("--mouth-w",mouth.w+"%");
      el.style.setProperty("--mouth-left",(mouth.x-mouth.w*.68)+"%"); el.style.setProperty("--mouth-right",(mouth.x+mouth.w*.68)+"%");
      el.style.setProperty("--mouth-top",(mouth.y-3.2)+"%"); el.style.setProperty("--mouth-bottom",(mouth.y+5.2)+"%");
      var angle = -Math.PI / 2 + (Math.PI * 2 * index / Math.max(1, list.length));
      el.style.setProperty("--seat-x", (50 + Math.cos(angle) * 39) + "%");
      el.style.setProperty("--seat-y", (48 + Math.sin(angle) * 39) + "%");
      var portrait = el.querySelector(".portrait"); portrait.src = "/avatars/" + a.id + ".webp"; portrait.alt = a.name;
      el.querySelector(".mouth-layer").src = portrait.src;
      el.querySelector(".name").textContent = a.name;
      el.querySelector(".state").textContent = STATE_LABEL[a.state] || a.state;
      el.title = a.role;
      agents[a.id] = a; $("grid").appendChild(el);
      el.onclick = function () { if (!joined) { toast("Join the call first"); return; } send({ type:"floor", agent:a.id }); toast(a.name + " has the floor"); };
    });
  }
  function setState(id, state) {
    var el = $("agent-" + id); if (!el) return;
    el.className = "agent " + state;
    el.querySelector(".state").textContent = STATE_LABEL[state] || state;
  }
  function escText(value) { return String(value == null ? "" : value); }
  function metric(parent, label, value) {
    var row = document.createElement("div"); row.className = "metric";
    var left = document.createElement("span"), right = document.createElement("span"); right.className = "score";
    left.textContent = label; right.textContent = value; row.appendChild(left); row.appendChild(right); parent.appendChild(row);
  }
  function renderOs(os) {
    if (!os) return; osState = os; $("worldName").textContent = os.world ? os.world.name : "General";
    var rep = $("reputation"); rep.innerHTML = "";
    (os.reputation || []).sort(function(a,b){ return (b.founder_score-a.founder_score)||(b.reliability-a.reliability); }).slice(0,8).forEach(function(r){
      metric(rep, (agents[r.agent] ? agents[r.agent].name : r.agent), "★" + (r.founder_score || 0) + " · " + Math.round(r.reliability || 50));
    });
    var rel = $("relationships"); rel.innerHTML = "";
    (os.relationships || []).slice(0,8).forEach(function(r){ metric(rel, r.source_agent + " → " + r.target_agent, "T" + Math.round(r.trust) + " R" + Math.round(r.respect) + " ⚡" + Math.round(r.tension)); });
    if (!(os.relationships || []).length) metric(rel, "No social history yet", "—");
    var missions = $("missions"); missions.innerHTML = "";
    (os.missions || []).slice(0,6).forEach(function(m){ metric(missions, "#" + m.id + " " + m.goal.slice(0,42), m.status); });
    if (!(os.missions || []).length) metric(missions, "No missions", "idle");
    var sims = $("simulations"); sims.innerHTML = "";
    (os.simulations || []).slice(0,6).forEach(function(s){ metric(sims, "#" + s.id + " " + s.title.slice(0,38), s.status); });
    if (!(os.simulations || []).length) metric(sims, "No simulations", "—");
    var decisions = $("decisions"); decisions.innerHTML = "";
    (os.decisions || []).slice(0,8).forEach(function(d){ metric(decisions, "#" + d.id + " " + d.title.slice(0,58), d.status); });
    if (!(os.decisions || []).length) metric(decisions, "No recorded decisions", "—");
    var timeline = $("timeline"); timeline.innerHTML = "";
    (os.events || []).slice().reverse().forEach(function(e){
      var card=document.createElement("div"); card.className="event"; var small=document.createElement("small"), p=document.createElement("p");
      small.textContent=new Date(e.created_at).toLocaleString()+" · "+escText(e.actor)+(e.target?" → "+e.target:""); p.textContent=escText(e.text); card.appendChild(small); card.appendChild(p); timeline.appendChild(card);
    });
  }
  function setView(view) {
    document.querySelectorAll(".tabs button").forEach(function(b){ b.classList.toggle("active", b.getAttribute("data-view")===view); });
    var chamber=view==="chamber"; ["roundtable","videoStage","me","log","say","controls"].forEach(function(id){ var el=$(id); if(el) el.classList.toggle("hidden", !chamber || (id==="videoStage"&&!cameraOn) || (id==="say"&&!joined)); });
    $("osPanel").classList.toggle("hidden", view!=="intelligence"); $("replayPanel").classList.toggle("hidden", view!=="replay");
  }
  function stopVoiceAnimation() {
    if (voiceFrame) cancelAnimationFrame(voiceFrame); voiceFrame = null;
    Object.keys(agents).forEach(function (id) { var el = $("agent-" + id); if (el) { el.style.setProperty("--voice", "0"); el.style.setProperty("--jaw", "1"); el.style.setProperty("--lip-wide", "1"); el.removeAttribute("data-viseme"); } });
  }
  function visemeTrack(text) {
    var sounds = (String(text || "").toLowerCase().match(/ch|sh|th|ph|oo|ee|[a-z]/g) || []);
    var total = 0;
    var track = sounds.map(function (sound) {
      var v = "T", weight = .65;
      if (/^[mbp]$/.test(sound)) v = "M";
      else if (/^(f|v|ph)$/.test(sound)) v = "F";
      else if (/^(o|u|w|q|oo)$/.test(sound)) { v = "O"; weight = 1.25; }
      else if (/^(e|i|y|ee)$/.test(sound)) { v = "E"; weight = 1.15; }
      else if (sound === "a") { v = "A"; weight = 1.3; }
      var start = total; total += weight; return { v:v, start:start, end:total };
    });
    return { items:track, total:Math.max(1,total) };
  }
  function visemeAt(track, progress) {
    var point = Math.max(0, Math.min(.999, progress)) * track.total;
    for (var i = 0; i < track.items.length; i++) if (point < track.items[i].end) return track.items[i].v;
    return "rest";
  }
  function buildSpeechMap(buffer) {
    var data=buffer.getChannelData(0), frameSize=Math.max(1,Math.round(buffer.sampleRate*.02)), frames=Math.ceil(data.length/frameSize), levels=new Float32Array(frames), peak=0;
    for(var f=0;f<frames;f++){ var start=f*frameSize,end=Math.min(data.length,start+frameSize),sum=0; for(var i=start;i<end;i++)sum+=data[i]*data[i]; var rms=Math.sqrt(sum/Math.max(1,end-start)); levels[f]=rms; if(rms>peak)peak=rms; }
    var threshold=Math.max(.004,peak*.11), spoken=new Uint32Array(frames), count=0;
    for(var j=0;j<frames;j++){ if(levels[j]>threshold)count++; spoken[j]=count; }
    return { levels:levels, spoken:spoken, total:Math.max(1,count), frameSeconds:.02, threshold:threshold };
  }
  function animateVoice(agent, analyser, text, buffer, startedAt) {
    stopVoiceAnimation();
    var values = new Uint8Array(analyser.frequencyBinCount);
    var track = visemeTrack(text);
    var speech = buildSpeechMap(buffer);
    var shapes = { rest:[1,1], M:[1,.99], A:[1.02,1.105], E:[1.055,1.025], O:[.965,1.09], F:[1.025,1.018], T:[1.02,1.035] };
    function tick() {
      analyser.getByteFrequencyData(values);
      var end = Math.min(values.length, 48), sum = 0;
      for (var i = 2; i < end; i++) sum += values[i];
      var level = Math.min(1, sum / (Math.max(1, end - 2) * 115));
      var elapsed = Math.max(0, audioCtx.currentTime - startedAt);
      var frame=Math.min(speech.levels.length-1,Math.max(0,Math.floor(elapsed/speech.frameSeconds)));
      var voiced=frame>=0 && speech.levels[frame]>speech.threshold;
      var viseme = !voiced || level < .025 ? "rest" : visemeAt(track, speech.spoken[frame]/speech.total);
      var shape=shapes[viseme]||shapes.rest;
      var el = $("agent-" + agent); if (el) { el.style.setProperty("--voice", level.toFixed(3)); el.style.setProperty("--lip-wide",String(shape[0])); el.style.setProperty("--jaw",String(shape[1])); el.setAttribute("data-viseme", viseme); }
      voiceFrame = requestAnimationFrame(tick);
    }
    tick();
  }

  // ---------------------------------------------------------------- playback
  function b64ToBuf(b64) {
    var bin = atob(b64); var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function enqueueAudio(agent, b64, text) {
    queue.push({ agent: agent, text: text || "", audio: audioCtx.decodeAudioData(b64ToBuf(b64)) });
    playNext();
  }
  function enqueueEnd(agent, text) { queue.push({ agent: agent, end: true, text: text }); playNext(); }
  function playNext() {
    if (playing) return;
    var item = queue.shift(); if (!item) return;
    playing = true;
    if (item.end) {
      playing = false;
      setState(item.agent, "listening");
      log(agents[item.agent] ? agents[item.agent].name : item.agent, item.text);
      send({ type: "played", agent: item.agent });
      playNext(); return;
    }
    setState(item.agent, "speaking");
    item.audio.then(async function (buffer) {
      if (!playing) return;
      if (audioCtx.state === "suspended") await audioCtx.resume();
      if (!playing) return;
      var src = audioCtx.createBufferSource(); src.buffer = buffer;
      var analyser = audioCtx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .7;
      src.connect(analyser); analyser.connect(masterGain || audioCtx.destination);
      current = src;
      src.onended = function () { if (current === src) { stopVoiceAnimation(); current = null; playing = false; playNext(); } };
      var startedAt = audioCtx.currentTime; animateVoice(item.agent, analyser, item.text, buffer, startedAt); src.start();
    }).catch(function () { playing = false; toast("Agent audio could not play. Check media volume."); playNext(); });
  }
  function stopPlayback() {
    queue = []; playing = false; stopVoiceAnimation();
    if (current) { try { current.stop(); } catch (e) {} current = null; }
    Object.keys(agents).forEach(function (id) {
      var el = $("agent-" + id); if (el && (el.classList.contains("speaking") || el.classList.contains("thinking"))) setState(id, "listening");
    });
  }
  function isPlaying() { return playing || queue.length > 0; }

  // ------------------------------------------------------------ mic and VAD
  var TARGET_RATE = 16000;
  var noiseFloor = 0.008, inSpeech = false, loudFrames = 0, silenceMs = 0, speechMs = 0;
  var utterance = [], preroll = [];

  function downsample(input, rate) {
    if (rate === TARGET_RATE) return new Float32Array(input);
    var ratio = rate / TARGET_RATE; var out = new Float32Array(Math.floor(input.length / ratio));
    for (var i = 0; i < out.length; i++) {
      var start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio)), sum = 0;
      for (var j = start; j < end; j++) sum += input[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }
  function encodeWav(chunks) {
    var length = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var buffer = new ArrayBuffer(44 + length * 2); var v = new DataView(buffer);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, TARGET_RATE, true); v.setUint32(28, TARGET_RATE * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, length * 2, true);
    var o = 44;
    chunks.forEach(function (c) { for (var i = 0; i < c.length; i++, o += 2) { var s = Math.max(-1, Math.min(1, c[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); } });
    return buffer;
  }
  function toInt16(frame) {
    var out = new Int16Array(frame.length);
    for (var i = 0; i < frame.length; i++) { var s = Math.max(-1, Math.min(1, frame[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out;
  }
  function onFrame(samples) {
    if (muted || !ws || ws.readyState !== 1) return;
    var frame = downsample(samples, audioCtx.sampleRate);
    var frameMs = (frame.length / TARGET_RATE) * 1000;
    var sum = 0; for (var i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    var rms = Math.sqrt(sum / frame.length);
    var threshold = Math.max(0.012, noiseFloor * 3);
    $("dot").style.transform = "scale(" + (1 + Math.min(1.5, rms * 20)) + ")";

    // Never let the phone speaker interrupt its own reply. The explicit Interrupt
    // control stops playback when the founder actually wants to take the floor.
    if (isPlaying()) {
      if (streaming) ws.send(new Int16Array(frame.length).buffer);
      return;
    }

    // Streaming mode: the server (Deepgram Flux) detects turns. While an agent talks we
    // send silence unless the founder is clearly speaking, so the agent's own voice
    // coming out of the speakers doesn't interrupt it.
    if (streaming) {
      var loud = rms > threshold;
      if (!loud) noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      loudFrames = loud ? loudFrames + 1 : 0;
      ws.send(toInt16(frame).buffer);
      return;
    }

    if (!inSpeech) {
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      preroll.push(frame); if (preroll.length > 4) preroll.shift();
      loudFrames = rms > threshold ? loudFrames + 1 : 0;
      if (loudFrames >= 2) {
        inSpeech = true; silenceMs = 0; speechMs = 0; utterance = preroll.slice(); preroll = [];
        $("mestate").textContent = "Listening to you…";
      }
      return;
    }
    utterance.push(frame); speechMs += frameMs;
    silenceMs = rms > threshold ? 0 : silenceMs + frameMs;
    if (silenceMs > 500 || speechMs > 25000) {
      inSpeech = false; loudFrames = 0;
      $("mestate").textContent = "Connected";
      if (speechMs - silenceMs > 400) { ws.send(encodeWav(utterance)); }
      utterance = [];
    }
  }

  // ------------------------------------------------------------- connection
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function sendFrame() {
    if (!cameraOn || !ws || ws.readyState !== 1) return;
    var video = $("cameraView");
    if (!video.videoWidth || !video.videoHeight) return;
    if (!captureCanvas) captureCanvas = document.createElement("canvas");
    var scale = Math.min(1, 640 / video.videoWidth);
    captureCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    captureCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    var ctx = captureCanvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    send({ type: "frame", image: captureCanvas.toDataURL("image/jpeg", 0.55) });
  }
  function stopCamera() {
    if (cameraTimer) clearInterval(cameraTimer);
    cameraTimer = null; cameraOn = false; screenOn = false;
    if (cameraStream) cameraStream.getTracks().forEach(function (t) { t.stop(); });
    cameraStream = null; $("cameraView").srcObject = null;
    $("videoStage").classList.add("hidden");
    $("camera").textContent = "📹 Start video";
    $("screen").textContent = "🖥️ Share screen";
    send({ type: "frame_clear" });
  }
  async function toggleCamera() {
    if (cameraOn) { stopCamera(); return; }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 360 } }, audio: false });
      var video = $("cameraView"); video.srcObject = cameraStream; await video.play();
      cameraOn = true; $("videoStage").classList.remove("hidden");
      $("camera").textContent = "⏹ Stop video";
      sendFrame(); cameraTimer = setInterval(sendFrame, 3000);
    } catch (e) { stopCamera(); toast("Camera permission is needed for video."); }
  }
  async function toggleScreen() {
    if (screenOn) { stopCamera(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast("Screen sharing is not supported on this device."); return; }
    stopCamera();
    try {
      cameraStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
      var video=$("cameraView"); video.srcObject=cameraStream; await video.play(); cameraOn=true; screenOn=true;
      $("videoStage").classList.remove("hidden"); $("screen").textContent="⏹ Stop sharing";
      var track=cameraStream.getVideoTracks()[0]; if(track) track.onended=function(){ stopCamera(); };
      sendFrame(); cameraTimer=setInterval(sendFrame,2000);
    } catch(e) { stopCamera(); }
  }
  function connect() {
    var q = token ? "t=" + encodeURIComponent(token) : "initData=" + encodeURIComponent(initData);
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/voice/ws?" + q);
    ws.binaryType = "arraybuffer";
    ws.onopen = function () { $("mestate").textContent = "Connected"; $("dot").classList.add("live"); };
    ws.onclose = function () {
      $("dot").classList.remove("live"); $("mestate").textContent = "Disconnected";
      if (joined) setTimeout(connect, 2000);
    };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === "hello") { renderAgents(m.agents); renderOs(m.os); streaming = m.streaming === true; }
      else if (m.type === "os") renderOs(m.os);
      else if (m.type === "stream_unavailable") { streaming = false; toast("Using on-device voice detection"); }
      else if (m.type === "state") setState(m.agent, m.state);
      else if (m.type === "heard") log("You", m.text);
      else if (m.type === "speak") enqueueAudio(m.agent, m.audio, m.text);
      else if (m.type === "speak_end") enqueueEnd(m.agent, m.text);
      else if (m.type === "interrupted") stopPlayback();
      else if (m.type === "error") toast(m.message);
    };
  }

  async function join() {
    if (!token && !initData) { toast("Open this from the /call link in Telegram."); return; }
    try {
      if (tg && tg.requestFullscreen) { try { tg.requestFullscreen(); } catch (e) {} }
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain(); masterGain.gain.value = 1.35; masterGain.connect(audioCtx.destination);
      // iOS/WebView requires playback to be unlocked directly inside the Join gesture.
      var unlock = audioCtx.createBufferSource(); unlock.buffer = audioCtx.createBuffer(1, 1, 22050); unlock.connect(masterGain); unlock.start(0);
      await audioCtx.resume();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { toast("Microphone permission is needed."); return; }
    var source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = function (e) { onFrame(e.inputBuffer.getChannelData(0)); };
    var silent = audioCtx.createGain(); silent.gain.value = 0;
    source.connect(processor); processor.connect(silent); silent.connect(audioCtx.destination);
    joined = true; connect();
    setInterval(function () { send({ type: "ping" }); }, 25000);
    $("join").classList.add("hidden"); $("mute").classList.remove("hidden"); $("camera").classList.remove("hidden"); $("screen").classList.remove("hidden"); $("interrupt").classList.remove("hidden"); $("end").classList.remove("hidden"); $("say").classList.remove("hidden");
    $("sub").textContent = "You're live. Replies finish automatically; tap Interrupt when you need the floor.";
  }
  function end() {
    joined = false; stopPlayback(); stopCamera();
    if (ws) ws.close();
    if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
    if (audioCtx) audioCtx.close();
    $("join").classList.remove("hidden"); $("mute").classList.add("hidden"); $("camera").classList.add("hidden"); $("screen").classList.add("hidden"); $("interrupt").classList.add("hidden"); $("end").classList.add("hidden"); $("say").classList.add("hidden");
    $("mestate").textContent = "Call ended";
    if (tg) { try { tg.close(); } catch (e) {} }
  }

  $("join").onclick = join;
  $("end").onclick = end;
  $("camera").onclick = toggleCamera;
  $("screen").onclick = toggleScreen;
  $("interrupt").onclick = function () { if (isPlaying()) { stopPlayback(); send({ type: "interrupt" }); toast("Council interrupted"); } };
  $("mute").onclick = function () { muted = !muted; $("mute").textContent = muted ? "🎙️ Unmute" : "🔇 Mute"; $("mestate").textContent = muted ? "Muted" : "Connected"; };
  $("say").onsubmit = function (e) {
    e.preventDefault(); var t = $("sayText").value.trim(); if (!t) return;
    if (isPlaying()) { stopPlayback(); send({ type: "interrupt" }); }
    send({ type: "say", text: t }); log("You", t); $("sayText").value = "";
  };
  document.querySelectorAll(".tabs button").forEach(function(b){ b.onclick=function(){ setView(b.getAttribute("data-view")); }; });
  $("refreshOs").onclick=function(){ send({type:"os_snapshot"}); };
})();
</script>
</body>
</html>`;
}
