/**
 * The live voice room, served at /app. Works as a Telegram Mini App (auth via initData)
 * or in any browser (auth via the signed link from /call).
 *
 * Client pipeline: mic → energy-based voice activity detection → 16 kHz WAV per utterance
 * → WebSocket → Whisper → council → Aura-2 audio chunks back → ordered playback.
 * Talking while an agent speaks stops playback and interrupts the council (barge-in).
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
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(135px, 1fr)); gap:10px; }
.agent { background:var(--card); border-radius:14px; padding:12px; display:flex; flex-direction:column; align-items:center; gap:4px; border:2px solid transparent; transition:border-color .2s, opacity .2s; }
.agent .emoji { font-size:30px; }
.agent .name { font-weight:600; }
.agent .state { font-size:12px; color:var(--muted); }
.agent.speaking { border-color:var(--speak); box-shadow:0 0 0 4px color-mix(in srgb, var(--speak) 20%, transparent); }
.agent.speaking .state { color:var(--speak); }
.agent.thinking { border-color:var(--think); }
.agent.thinking .state { color:var(--think); }
.agent.dormant { opacity:.45; }
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
  <div class="sub" id="sub">Tap Join to start. Talk naturally; talk over anyone to interrupt.</div>
  <div class="grid" id="grid"></div>
  <div class="me"><div class="dot" id="dot"></div><span id="mestate">Not connected</span></div>
  <div class="log" id="log"></div>
  <form id="say" class="hidden"><input id="sayText" placeholder="Or type…" autocomplete="off"><button type="submit">Send</button></form>
  <div class="controls">
    <button class="primary" id="join">🎙️ Join call</button>
    <button id="mute" class="hidden">🔇 Mute</button>
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
  var ws = null, audioCtx = null, micStream = null, processor = null, muted = false, joined = false;
  var queue = [], current = null, playing = false;

  var STATE_LABEL = { listening: "Listening", thinking: "Thinking…", speaking: "Speaking", dormant: "Sleeping" };

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
    list.forEach(function (a) {
      var el = document.createElement("div"); el.className = "agent " + a.state; el.id = "agent-" + a.id;
      el.innerHTML = '<div class="emoji"></div><div class="name"></div><div class="state"></div>';
      el.querySelector(".emoji").textContent = a.emoji;
      el.querySelector(".name").textContent = a.name;
      el.querySelector(".state").textContent = STATE_LABEL[a.state] || a.state;
      el.title = a.role;
      agents[a.id] = a; $("grid").appendChild(el);
    });
  }
  function setState(id, state) {
    var el = $("agent-" + id); if (!el) return;
    el.className = "agent " + state;
    el.querySelector(".state").textContent = STATE_LABEL[state] || state;
  }

  // ---------------------------------------------------------------- playback
  function b64ToBuf(b64) {
    var bin = atob(b64); var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function enqueueAudio(agent, b64) {
    queue.push({ agent: agent, audio: audioCtx.decodeAudioData(b64ToBuf(b64)) });
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
    item.audio.then(function (buffer) {
      if (!playing) return;
      var src = audioCtx.createBufferSource(); src.buffer = buffer; src.connect(audioCtx.destination);
      current = src;
      src.onended = function () { if (current === src) { current = null; playing = false; playNext(); } };
      src.start();
    }).catch(function () { playing = false; playNext(); });
  }
  function stopPlayback() {
    queue = []; playing = false;
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
  function onFrame(samples) {
    if (muted || !ws || ws.readyState !== 1) return;
    var frame = downsample(samples, audioCtx.sampleRate);
    var frameMs = (frame.length / TARGET_RATE) * 1000;
    var sum = 0; for (var i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    var rms = Math.sqrt(sum / frame.length);
    // Our own speakers leak into the mic; demand more energy while an agent is talking.
    var threshold = Math.max(0.012, noiseFloor * 3) * (isPlaying() ? 2.5 : 1);
    $("dot").style.transform = "scale(" + (1 + Math.min(1.5, rms * 20)) + ")";

    if (!inSpeech) {
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      preroll.push(frame); if (preroll.length > 4) preroll.shift();
      loudFrames = rms > threshold ? loudFrames + 1 : 0;
      if (loudFrames >= 2) {
        inSpeech = true; silenceMs = 0; speechMs = 0; utterance = preroll.slice(); preroll = [];
        $("mestate").textContent = "Listening to you…";
        if (isPlaying()) { stopPlayback(); send({ type: "interrupt" }); }
      }
      return;
    }
    utterance.push(frame); speechMs += frameMs;
    silenceMs = rms > threshold ? 0 : silenceMs + frameMs;
    if (silenceMs > 800 || speechMs > 25000) {
      inSpeech = false; loudFrames = 0;
      $("mestate").textContent = "Connected";
      if (speechMs - silenceMs > 400) { ws.send(encodeWav(utterance)); }
      utterance = [];
    }
  }

  // ------------------------------------------------------------- connection
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
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
      if (m.type === "hello") renderAgents(m.agents);
      else if (m.type === "state") setState(m.agent, m.state);
      else if (m.type === "heard") log("You", m.text);
      else if (m.type === "speak") enqueueAudio(m.agent, m.audio);
      else if (m.type === "speak_end") enqueueEnd(m.agent, m.text);
      else if (m.type === "interrupted") stopPlayback();
      else if (m.type === "error") toast(m.message);
    };
  }

  async function join() {
    if (!token && !initData) { toast("Open this from the /call link in Telegram."); return; }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { toast("Microphone permission is needed."); return; }
    var source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = function (e) { onFrame(e.inputBuffer.getChannelData(0)); };
    var silent = audioCtx.createGain(); silent.gain.value = 0;
    source.connect(processor); processor.connect(silent); silent.connect(audioCtx.destination);
    joined = true; connect();
    setInterval(function () { send({ type: "ping" }); }, 25000);
    $("join").classList.add("hidden"); $("mute").classList.remove("hidden"); $("end").classList.remove("hidden"); $("say").classList.remove("hidden");
    $("sub").textContent = "You're live. Speak whenever you want.";
  }
  function end() {
    joined = false; stopPlayback();
    if (ws) ws.close();
    if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
    if (audioCtx) audioCtx.close();
    $("join").classList.remove("hidden"); $("mute").classList.add("hidden"); $("end").classList.add("hidden"); $("say").classList.add("hidden");
    $("mestate").textContent = "Call ended";
    if (tg) { try { tg.close(); } catch (e) {} }
  }

  $("join").onclick = join;
  $("end").onclick = end;
  $("mute").onclick = function () { muted = !muted; $("mute").textContent = muted ? "🎙️ Unmute" : "🔇 Mute"; $("mestate").textContent = muted ? "Muted" : "Connected"; };
  $("say").onsubmit = function (e) {
    e.preventDefault(); var t = $("sayText").value.trim(); if (!t) return;
    if (isPlaying()) { stopPlayback(); send({ type: "interrupt" }); }
    send({ type: "say", text: t }); log("You", t); $("sayText").value = "";
  };
})();
</script>
</body>
</html>`;
}
