/* ═══════════════════════════════════════════════════
   هوب — محجر حجر الفلتو · محرك الواجهة
   متصفح ← (PCM16 16k) ← سيرفر ← Gemini Live
   ═══════════════════════════════════════════════════ */
"use strict";

const $ = (id) => document.getElementById(id);
const chatEl = $("chat"), statusEl = $("status"), textEl = $("text"),
      micBtn = $("mic"), gateEl = $("gate"), toastEl = $("toast");
const OUT_RATE = 24000;   // معدل صوت جوجل الصادر
const IN_RATE = 16000;    // معدل المايك المطلوب

let token = localStorage.getItem("atefToken") || "";
let ws = null, wsReady = false, reconnectTries = 0, intentionalClose = false,
    reconnectPending = false;
let micOn = false, micStream = null, micCtx = null, micNode = null, micWorklet = null;
let playCtx = null, playNext = 0;
const playSources = new Set();
let curBubble = null;          // فقاعة الرد الحالية
let curText = "";              // نص الرد الحالي
let deferredPrompt = null;

/* ═══════ حالة الواجهة ═══════ */
function setState(s) {
  document.body.dataset.state = s;
  if (window.Brain) window.Brain.setMode(s);   // الدماغ الحي بيغيّر جِلسته
  const words = {
    boot: "بيتهيأ…", connecting: "بيتشغل…", ready: "جاهز — اتكلم أو اكتب",
    listening: "بيسمعك…", thinking: "بيفكر…", speaking: "بيتكلم…",
    working: "بينفّذ الأدوات…", verifying: "بيتأكد من نفسه…",
    answering: "بيردّ…",
  };
  statusEl.textContent = words[s] || s;
}
/* سعات صوت → العصبونات */
function rms(f32) {
  let s = 0;
  for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
  return Math.sqrt(s / (f32.length || 1));
}

/* ═══════ رسائل وتنبيهات ═══════ */
let toastTimer = null;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), ms);
}
function addMsg(cls, html) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  if (html !== undefined) d.innerHTML = html;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}
function addUser(text) { addMsg("user", "").textContent = text; }

/* ═══════ مفتاح الشبكة — ONLINE / OFFLINE (إنترنت السيرفر + المخ المحلي) ═══════ */
const netSw = $("netSwitch"), netTxt = $("netSwTxt");
const netState = { link: false, internet: null, brain: "none" };
function paintNet() {
  const link = netState.link, inet = netState.internet, brain = netState.brain || "none";
  let mode, label;
  if (!link) { mode = "off"; label = "OFFLINE"; }
  else if (inet === false) { mode = "local"; label = "OFFLINE"; }
  else if (inet === null) { mode = "wait"; label = "CHECKING"; }
  else { mode = "on"; label = "ONLINE"; }
  netSw.dataset.mode = mode;
  netTxt.textContent = label;
  const b = brain === "none" ? "no local brain yet"
    : brain === "llamafile" ? "llamafile (offline brain on)" : brain + " (local)";
  netSw.title = !link
    ? "OFFLINE — no link to the Hope server (running from local mode)"
    : inet === false
      ? "OFFLINE — server has no internet · " + b
      : inet === null ? "Checking network…"
      : "ONLINE — internet OK · " + b;
  document.body.classList.toggle("offline", !link);
}
netSw.addEventListener("click", async () => {
  try {
    const s = await api("/api/net");
    netState.internet = !!s.online;
    netState.brain = s.brain || "none";
    paintNet();
  } catch (e) {}
  toast("🌐 " + netSw.title, 3400);
});
paintNet();
function notifyPhone(title, body) {
  // 🔔 تنبيه هوب — حتى لو التطبيق في الخلفية
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title || "Hope", { body: body || "", tag: "hope-notify" }); } catch (e) {}
  }
  toast("🔔 " + (title || "Hope") + (body ? " — " + body : ""), 4000);
}
function addBot() {
  curBubble = addMsg("bot", `<span class="dot"></span><div class="body"><span class="dots"><i></i><i></i><i></i></span></div>`);
  curText = "";
  return curBubble;
}
function botAppend(delta) {
  if (!curBubble) addBot();
  curText += delta;
  const body = curBubble.querySelector(".body");
  body.textContent = curText;
  chatEl.scrollTop = chatEl.scrollHeight;
}
function botDone() {
  if (curBubble && !curText.trim()) curBubble.remove();  // رد صوتي خالص
  else if (curBubble) attachCopy(curBubble);
  curBubble = null; curText = "";
}
function clearThinking() {
  chatEl.querySelectorAll(".msg.tool").forEach((n) => n.remove());
  chatEl.querySelectorAll(".msg.sys.thinking").forEach((n) => n.remove());
}

/* ═══════ الصوت: مساعدات ═══════ */
function resample(f32, from, to) {
  if (from === to || !f32.length) return f32;
  const ratio = from / to, newLen = Math.max(1, Math.round(f32.length / ratio));
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const pos = i * ratio, idx = Math.floor(pos), frac = pos - idx;
    const a = f32[idx], b = f32[Math.min(idx + 1, f32.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}
function f32ToB64(f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/* ═══════ تشغيل صوت جوجل ═══════ */
function ensurePlayCtx() {
  if (!playCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { playCtx = new AC({ sampleRate: OUT_RATE }); }
    catch (e) { playCtx = new AC(); }
  }
  if (playCtx.state === "suspended") { playCtx.resume().catch(() => {}); renderSound(); }
  return playCtx;
}
function playChunk(b64) {
  const ctx = ensurePlayCtx();
  // لو السياق لسه متجمّد (autoplay) — بنحاول نفكّه ونجدول الصوت بعد شوية
  if (ctx.state !== "running") {
    ctx.resume().then(() => playChunk(b64)).catch(() => {});
    return;
  }
  let f32 = b64ToF32(b64);
  if (!f32.length) return;
  if (window.Brain) window.Brain.setAmp("out", Math.min(1, rms(f32) * 5));
  f32 = resample(f32, OUT_RATE, ctx.sampleRate);
  const buf = ctx.createBuffer(1, f32.length, ctx.sampleRate);
  buf.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination);
  const now = ctx.currentTime;
  const at = Math.max(playNext || now, now + 0.03);
  src.start(at);
  playNext = at + buf.duration;
  playSources.add(src);
  renderSound();
  setState("speaking");
  src.onended = () => {
    playSources.delete(src);
    if (!playSources.size) {
      playNext = 0;
      if (document.body.dataset.state === "speaking")
        setState(micOn ? "listening" : "ready");
    }
  };
}
function stopPlayback() {
  for (const s of playSources) { try { s.stop(); } catch (e) {} }
  playSources.clear();
  playNext = 0;
}

/* ═══════ فتح قفل الصوت (دائمًا) ═══════
   المتصفح على التليفون والكمبيوتر بيمنع أي صوت لحد ما المستخدم يلمس الشاشة
   فعلًا (سياسة الـautoplay)، وبيقفله تاني لو السياق رجع suspended. بنفتح الصوت
   مع كل تفاعل، وبنعيد الفتح تلقائيًا قبل كل حتة صوت، وبنعرض مؤشر حالة الصوت. */
function unlockAudio() {
  const ctx = ensurePlayCtx();          // يخلق السياق لو مش موجود
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  // نبضة صامتة صغيرة تفكّل قفل الصوت على iOS
  try {
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination); s.start(0);
  } catch (e) {}
  renderSound();
}
// نسمع لكل تفاعل (مش مرة واحدة) عشان لو السياق اتقفل تاني يتفتح تاني
["pointerdown", "touchstart", "click", "keydown"].forEach((ev) =>
  document.addEventListener(ev, unlockAudio, { passive: true })
);

/* مؤشر حالة الصوت في أعلى الشاشة — يوريك إذا الصوت مفتوح ولا لأ */
function renderSound() {
  let el = $("soundDot");
  if (!el) return;
  const on = playCtx && playCtx.state === "running";
  el.innerHTML = on
    ? '🔊 <span class="sd-txt">الصوت شغال</span>'
    : '🔇 <span class="sd-txt">الصوت مقفول — اضغط في أي مكان</span>';
  el.className = "sound-dot " + (on ? "on" : "off");
}

/* ═══════ المايك ═══════ */
const WORKLET_SRC = `
class AtefCap extends AudioWorkletProcessor {
  constructor(){ super(); this.bufs=[]; this.len=0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length){
      const c = new Float32Array(ch.length); c.set(ch);
      this.bufs.push(c); this.len += c.length;
      if (this.len >= 4096){
        const out = new Float32Array(this.len); let o=0;
        for (const b of this.bufs){ out.set(b,o); o+=b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.bufs=[]; this.len=0;
      }
    }
    return true;
  }
}
registerProcessor("atef-cap", AtefCap);
`;

async function micStart() {
  if (micOn) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("المتصفح مانع المايك — استخدم https أو اكتب بدل ما تتكلم");
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    micDenied(e);
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  micCtx = micCtx || new AC();
  if (micCtx.state === "suspended") await micCtx.resume();
  const src = micCtx.createMediaStreamSource(micStream);

  const sendF32 = (f32) => {
    if (window.Brain) window.Brain.setAmp("in", Math.min(1, rms(f32) * 6));
    if (!micOn || !ws || ws.readyState !== 1 || !wsReady) return;
    const ds = resample(f32, micCtx.sampleRate, IN_RATE);
    ws.send(JSON.stringify({ type: "audio", pcm: f32ToB64(ds) }));
  };

  try {
    if (!micWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      await micCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      micWorklet = true;
    }
    micNode = new AudioWorkletNode(micCtx, "atef-cap");
    micNode.port.onmessage = (e) => sendF32(e.data);
    src.connect(micNode);
    micNode._src = src;
  } catch (e) {
    // احتياطي: ScriptProcessor (صامت — output ميت)
    micNode = micCtx.createScriptProcessor(4096, 1, 1);
    micNode.onaudioprocess = (e) => sendF32(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(micNode);
    micNode.connect(micCtx.destination);
    micNode._src = src;
  }
  micOn = true;
  setState("listening");
}
function micStop() {
  if (!micOn) return;
  micOn = false;
  if (micNode) {
    try { micNode._src && micNode._src.disconnect(); } catch (e) {}
    try { micNode.disconnect(); } catch (e) {}
    if (micNode.onaudioprocess) micNode.onaudioprocess = null;
    if (micNode.port) micNode.port.onmessage = null;
    micNode = null;
  }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (ws && ws.readyState === 1 && wsReady)
    ws.send(JSON.stringify({ type: "stream_end" }));
  setState("ready");
}
micBtn.addEventListener("click", () => (micOn ? micStop() : micStart()));

/* ═══════ الوضع الصوتي الدائم (Wake word — «هوب» يصحى لوحده) ═══════
   التليفون بيفضل يسمع باسمي «هوب» من غير ما تضغط حاجة، وأول ما تقوله
   بيفتح المايك الكامل ويردّ عليك — زي مكالمة صوتية مفتوحة معاك. */
const WAKE_WORDS = ["هوب", "هووب", "hope", "هوبب", "هب", "أهوب", "يا هوب"];
const ALWAYS_KEY = "alwaysOn";
let alwaysOn = localStorage.getItem(ALWAYS_KEY) === "1";
let wakeCtx = null, wakeStream = null, wakeNode = null, wakeRecog = null;
let wakeArmed = false, wakeCooldown = 0;

function alwaysBtnRender() {
  const b = $("alwaysBtn");
  if (!b) return;
  b.classList.toggle("ok", alwaysOn);
  b.textContent = alwaysOn ? "🔊 صوتي مفتوح: اقول «هوب» يردّ" : "🔇 فعّل مكالمة صوتية";
}
function setAlways(v) {
  alwaysOn = !!v;
  localStorage.setItem(ALWAYS_KEY, alwaysOn ? "1" : "0");
  if (alwaysOn) startWake(); else stopWake();
  alwaysBtnRender();
}
async function startWake() {
  if (wakeRecog || !("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      toast("المتصفح ده مش داعم للاستماع الدائم — استخدم Chrome");
      return;
    }
  }
  try {
    wakeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    micDenied(e);
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  wakeRecog = new SR();
  wakeRecog.lang = "ar-EG";
  wakeRecog.continuous = true;
  wakeRecog.interimResults = true;
  wakeRecog.onresult = (e) => {
    let txt = "";
    for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
    const t = (txt || "").trim();
    if (!t) return;
    const hit = WAKE_WORDS.find((w) => t.includes(w));
    if (hit && Date.now() > wakeCooldown) {
      wakeCooldown = Date.now() + 6000;
      onWake(t, hit);
    }
  };
  wakeRecog.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("المايك مرفوض — فعّله من إعدادات المتصفح");
      stopWake();
    }
  };
  wakeRecog.onend = () => {
    if (alwaysOn) { try { wakeRecog.start(); } catch (e) {} }
  };
  try { wakeRecog.start(); } catch (e) {}
  wakeArmed = true;
  setState("ready");
}
function stopWake() {
  wakeArmed = false;
  if (wakeRecog) { try { wakeRecog.stop(); } catch (e) {} wakeRecog = null; }
  if (wakeStream) { wakeStream.getTracks().forEach((t) => t.stop()); wakeStream = null; }
}
function onWake(heard, word) {
  // بصّ على مكان الكلمة في النص وشيلها
  const rest = heard.replace(new RegExp(word, "g"), "").trim();
  // أوامر الإغلاق: لو قال «كفاية»/«خلاص» من غير طلب → اقفل المايك بس
  const stopWords = ["كفاية", "كفايه", "خلاص", "claus", "قفل", "استنى بعدين"];
  if (!rest || stopWords.some((s) => rest.includes(s))) { micStop(); return; }
  // شغّل المايك الكامل وابعت الكلمة الباقية كطلب
  micStart();
  sendText(rest);
  if (window.Brain) window.Brain.fire("system", null, "🔊 استجاب لـ«" + word + "»");
}
/* ═══════ إذن الميكروفون: ما نطلبوش وهو مرفوض (طلب رفض بيقفله للأبد) ═══════ */
let micPermBlocked = false;
function micDenied(e) {
  const name = (e && e.name) || "";
  if (name !== "NotAllowedError" && name !== "PermissionDeniedError" && name !== "SecurityError") {
    toast("مشكلة مايك: " + name);
    return;
  }
  micPermBlocked = true;
  toast("مافيش إذن ميكروفون — اضغط أيقونة القفل/الكاميرا جنب الرابط واختار «السماح بالميكروفون»، وبعدين اضغط زر الميك تاني");
}
try {
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "microphone" }).then((p) => {
      const sync = () => {
        micPermBlocked = p.state === "denied";
        if (p.state === "granted" && alwaysOn && !wakeRecog) startWake();
      };
      p.onchange = () => { sync(); if (p.state === "granted") toast("الميكروفون اتسماح ✔"); };
      if (p.state === "denied") {
        micPermBlocked = true;
        if (!sessionStorage.getItem("micHintShown")) {
          sessionStorage.setItem("micHintShown", "1");
          toast("الميكروفون مرفوض من المتصفح — افتح أيقونة القفل/الكاميرا جنب الرابط واختار «السماح بالميكروفون»");
        }
      } else if (alwaysOn && p.state === "granted") startWake();
      else if (alwaysOn && p.state === "prompt") toast("اضغط زر 🔊 عشان تسمح بالمايك ويفتح الاستماع الدائم");
    }).catch(() => { if (alwaysOn) startWake(); });
  } else if (alwaysOn) startWake();
} catch (e) { if (alwaysOn) startWake(); }

/* ═══════ تتبّع ضغطات المدير — الوكيل يشوف بيعمل إيه بالمايك والكيبورد ═══════ */
const uiLog = [];
function uiNote(kind, el, x, y) {
  try {
    const t = (el && (el.id || el.className || el.tagName)) || "";
    const txt = ((el && el.textContent) || "").trim().slice(0, 60);
    const ev = { k: kind, el: String(t).slice(0, 60), txt: txt, x: Math.round(x || 0), y: Math.round(y || 0) };
    uiLog.push(ev);
    if (uiLog.length > 50) uiLog.shift();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "pointer", ev: ev }));
  } catch (e) {}
}
document.addEventListener("click", (e) => uiNote("click", e.target, e.clientX, e.clientY), true);
document.addEventListener("contextmenu", (e) => uiNote("rightclick", e.target, e.clientX, e.clientY), true);

/* ═══════ الاتصال بالسيرفر ═══════ */
function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?t=${encodeURIComponent(token)}`;
}
function connect() {
  setState("connecting");
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    reconnectTries = 0; reconnectPending = false; flushPending();
    // 🌐 الشارة: الاتصال فتح — نجيب حالة الشبكة كمان (fallback لو البث وصل أسرع)
    netState.link = true; paintNet();
    api("/api/net").then((s) => {
      netState.internet = !!s.online;
      netState.brain = s.brain || "none";
      paintNet();
    }).catch(() => {});
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    wsReady = false;
    netState.link = false; paintNet();
    if (intentionalClose) return;
    setState("connecting");
    const wait = Math.min(2000 * Math.max(1, reconnectTries), 15000);
    reconnectTries++;
    if (reconnectTries <= 8) {
      reconnectPending = true;
      setTimeout(() => { reconnectPending = false; connect(); }, wait);
    } else {
      reconnectPending = false;
      setState("ready");
      statusEl.textContent = "الاتصال قطع — أعد المحاولة بالضغط على الميك";
      drainPendingOffline();   // اللي في الطابور ما يروحش — يتدفع للعقل المحلّي
    }
  };
  ws.onerror = () => {};
}
function handle(m) {
  switch (m.type) {
    case "connected":
      break;
    case "ready":
      wsReady = true;
      reconnectTries = 0;
      flushPending();   // رسائل الطابور تتبعت دلوقتي (كانت بتضيع قبل كده)
      setState(micOn ? "listening" : "ready");
      statusEl.textContent = (micOn ? "بيسمعك… · " : "جاهز · ") + (m.model || "");
      if (window.Brain) window.Brain.ready();
      break;
    case "audio":
      playChunk(m.pcm);
      break;
    case "text":
      if (!curBubble) { clearThinking(); addBot(); if (window.Brain) window.Brain.fire("speak"); }
      botAppend(m.delta || "");
      break;
    case "thought":
      // تفكير هوب الداخلي (أسراره) — سطر خافت حي
      thoughtLine(m.delta || "");
      if (window.Brain) window.Brain.fire("think", 3);
      break;
    case "user_interim":
      // نص مؤقت وهو لسه بتكلم (يتبدّل وراه)
      liveCaption(m.delta || "", true);
      break;
    case "user_text":
      // نص حي لكلام المدير وهو بتكلم (زي شات جات جيت الجديد)
      liveCaption(m.delta || "", false);
      break;
    case "tool":
      if (window.Brain) window.Brain.fire("tool", null, (m.names || []).join("، "));
      (m.names || []).forEach((n) => addMsg("tool", "⚙ " + n));
      chatEl.scrollTop = chatEl.scrollHeight;
      break;
    case "turn_end":
      clearThinking();
      botDone();
      endCaption();
      setState(micOn ? "listening" : "ready");
      break;
    case "state":
      // 🧠 آلة حالات المحادثة من السيرفر (فكر/شغّل/تأكد/رد) — بتوضّح شعوره
      if (m.state) {
        if (m.state === "answering") setState("speaking");
        else if (m.state === "listening")
          setState(micOn ? "listening" : "ready");   // رجوع من verifying/working
        else setState(m.state);
      }
      if (window.Brain && m.state === "working")
        window.Brain.fire("tool", 4, m.detail || "");
      break;
    case "review":
      // 🔎 مراجعة ذاتية بعد الرد — ثقة حقيقية بتظهر للمدير
      reviewChip(m);
      break;
    case "interrupt":
      stopPlayback();
      endCaption();
      setState(micOn ? "listening" : "ready");
      break;
    case "error":
      clearThinking();
      if (window.Brain) window.Brain.fire("error");
      addMsg("err", "");
      chatEl.lastChild.textContent = "⚠ " + (m.message || "خطأ");
      endCaption();
      setState(micOn ? "listening" : "ready");
      toast(m.message || "حصل خطأ");
      break;
    case "pagecard":
      // 🌐 صفحة Hope فتحها دلوقتي — بتظهر كارت في الشات + شاشة «متصفحه»
      addPageCard(m);
      break;
    case "screencap":
      // 🖥 لقطة شاشة المدير (screenCapture) — بتظهر حيًّا وهو شايفها
      addScreenCap(m);
      break;
    case "browse":
      // خطوة حية في شاشة المتصفح (فتح/قراءة/فشل)
      addBrowseStep(m.step, true);
      if (window.Brain) window.Brain.fire("web", null, (m.step && (m.step.title || m.step.url)) || "");
      break;
    case "activity":
      onActivity(m.item, true);      // بث حي لشاشة العقل + نبض في الدماغ
      break;
    case "notify":
      // 🔔 هوب نبّهك (notifyUser) — شاشة التليفون حتى لو في الخلفية
      notifyPhone(m.title, m.message);
      if (window.Brain) window.Brain.fire("system", null, m.title || "");
      break;
    case "wa":
      // 💬 أحداث واتساب الحيّة (رسائل واردة/ردود/مواقع/حالة)
      waEvent(m);
      break;
    case "im":
      // 💬 رسائل التطبيق الحيّة (Business Messages)
      if (window.IM && IM.onEvent) IM.onEvent(m);
      break;
    case "brain":
      // 🧠 هوب بيرسم/يغيّر عقله بنفسه — ده وعيه بدماغه (لوحته هو)
      if (window.Brain) window.Brain.view(m);
      break;
    case "uicmd":
      // 🖥 Hope بيحرّك شاشة المدير بنفسه (أداة uiNav) — يفتح شاشة/تبويب/الإعدادات
      uiCmd(m.cmd);
      break;
    case "net":
      // 🌐 حالة الشبكة من السيرفر — مفتاح ONLINE/OFFLINE في الهيدر
      netState.internet = !!m.online;
      netState.brain = m.brain || "none";
      paintNet();
      break;
  }
}

/* ═══════ نص حي لكلام المدير (وهو بتكلم في المايك) ═══════
   حسب توثيق جوجل: interim = نص مؤقت كامل يتبدّل وهو بتكلم،
   و final = النص الرسمي للفقرة (يتحطّ ثابت تحت المؤقت). */
let capEl = null, capDone = "", capLive = "";
function liveCaption(d, interim) {
  if (!d) return;
  if (!capEl) { capEl = addMsg("user caption", ""); capDone = ""; capLive = ""; }
  if (interim) {
    if (!capLive) capLive = d;
    else if (d.startsWith(capLive)) capLive = d;        // متراكم
    else if (capLive.includes(d)) { /* مكرر */ }
    else capLive = d;                                   // استبدال (نص مؤقت جديد)
  } else {
    if (capLive && d.startsWith(capLive)) capDone += d;   // تأكيد المؤقت
    else if (capLive && d.includes(capLive)) capDone += d; // النهائي شمله
    else if (capDone.endsWith(d)) { /* نسخة مكررة */ }
    else capDone += d;                                     // فقرة جديدة
    capLive = "";
  }
  capEl.textContent = capDone + capLive;
  chatEl.scrollTop = chatEl.scrollHeight;
}
function endCaption() { capEl = null; capDone = ""; capLive = ""; thinkEl = null; }

/* ═══════ تفكير هوب الداخلي — سطر خافت حي (أسراره) ═══════ */
let thinkEl = null;
function thoughtLine(d) {
  if (!d) return;
  if (!thinkEl) thinkEl = addMsg("sys thought", "");
  const cur = thinkEl.textContent;
  let t = !cur ? d : (d.startsWith(cur) ? d : (cur.includes(d) ? cur : cur + d));
  if (t.length > 460) t = "…" + t.slice(-460);        // سايب آخر جزء بس
  thinkEl.textContent = "🧠 " + t;
  // نفس الفكره دي بالظبط تظهر فوق الدماغ (ما يبانش حاجة مختلف عن تفكيره)
  if (window.Brain) window.Brain.think(t.replace(/^🧠\s*/, ""));
  chatEl.scrollTop = chatEl.scrollHeight;
}

/* ═══════ 🔎 مراجعة ذاتية — ثقة الرد بتظهر تحته ═══════ */
function reviewChip(m) {
  const conf = Math.round(Number(m.confidence) || 0);
  const low = !!m.low;
  const chip = addMsg("review" + (low ? " low" : ""),
    `<span class="rv-ic">${low ? "⚠" : "✔"}</span>` +
    `<b>${conf}%</b><span>${m.note ? "" : (low ? " محتاج تأكيد" : " ثقة عالية")}</span>` +
    (m.note ? `<span class="rv-note">${m.note}</span>` : ""));
  if (window.Brain) window.Brain.fire(low ? "error" : "verify", 3,
                                       "ثقة " + conf + "%");
  chatEl.scrollTop = chatEl.scrollHeight;
  return chip;
}

/* ═══════ إرسال ═══════ */
let pendingTexts = [];   // رسائل لسه مستنية الاتصال (ما تروحش للعقل المحلّي وأنت متوصل)

function flushPending() {
  if (!pendingTexts.length || !ws || ws.readyState !== 1) return;
  while (pendingTexts.length) ws.send(pendingTexts.shift());
}

function drainPendingOffline() {
  // السيرفر وقع خالص والطابور لسه مليان → ندّيه للعقل المحلّي بدل ما يضيع
  if (!pendingTexts.length) return;
  const pend = pendingTexts.splice(0);
  pend.forEach((p) => {
    try {
      sendOffline(JSON.parse(p).text + "\n⚠ (اتبعت من مخ التليفون — السيرفر كان مقفول)");
    } catch (e) {}
  });
}

function sendText(t, opts = {}) {
  t = (t || "").trim();
  if (!t) return;
  const st = ws ? ws.readyState : -1;
  if (st !== 1 && st !== 0) {
    // الموقع مقفول خالص (أوفلاين فعلاً) → عقل التليفون المحلّي على طول
    if (navigator.onLine === false) { sendOffline(t); return; }
    if (st === -1) connect();                       // لسه ما اتصلّاش أصلًا
    else if (st === 3 && !reconnectPending && !intentionalClose) {
      // socket مقفول ومافيش محاولة شغالة → نرجع الاتصال (الطابور يتبعت أول ما يفتح)
      reconnectPending = true; reconnectTries = 0;
      setTimeout(() => { reconnectPending = false; connect(); }, 250);
    }
  }
  if (!opts.silent) addUser(t);
  clearThinking();
  addMsg("sys thinking",
         (st === 1) ? "بيفكر…" : "في الطابور — أول ما يتصل يتبعت لـهوب…");
  setState("thinking");
  if (window.Brain) window.Brain.fire("think", 6);
  const payload = JSON.stringify({ type: "text", text: t });
  if (ws && ws.readyState === 1) ws.send(payload);   // السيرفر نفسه بيطابور لو جيميني لسه بيتصل
  else pendingTexts.push(payload);                   // لحد ما الـsocket يفتح
  // اتسجل محليًا كمان (عشان المخ يفضل مطابق للسيرفر)
  if (window.Store) Store.addMessage("user", t).catch(() => {});
}

/* أوفلاين: هوب يردّ من مخ التليفون ويحفظ للتزامن لاحقًا */
async function sendOffline(t) {
  addUser(t);
  if (window.Store) Store.addMessage("user", t).catch(() => {});
  clearThinking();
  const bub = addBot();
  setState("thinking");
  if (window.Brain) window.Brain.fire("think", 4);
  let reply;
  try {
    reply = await Offline.reply(t);
  } catch (e) {
    reply = "أنا Hope شغال أوفلاين — مافيش اتصال بالسيرفر دلوقتي. أول ما الشبكة ترجع هنفّذ اللي طلبته.";
  }
  // شريط حي للرد
  botAppend(reply);
  botDone();
  setState("ready");
  if (window.Store) Store.addMessage("bot", reply).catch(() => {});
  // لو المدير طلب حاجة محتاجة السيرفر → سجّلها تنفّذ أول ما يرجع
  if (/قارئ|اقرا|احسب|سجّل|دف|فاتورة|تقرير|ارسل|ابعت|بريد|ايميل|بحث|موقع/i.test(t))
    Sync.enqueue("pending_task", { text: t }).catch(() => {});
}
/* ═══════ الشات: إدخال كامل (إرفاق + إيموجي + لصق صورة + زرار إرسال) ═══════ */
$("composer").addEventListener("submit", (e) => { e.preventDefault(); });

function autoGrow() {
  textEl.style.height = "auto";
  textEl.style.height = Math.min(120, textEl.scrollHeight) + "px";
}
function syncSend() { $("sendBtn").classList.toggle("hidden", !textEl.value.trim()); }

textEl.addEventListener("keydown", (e) => {
  // Enter يبعت + يفضّي — بس بعد ما تكتب فعلًا (ما يمسحش الكتابة على كل ضغطة!)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const v = textEl.value;
    if (!v.trim()) return;
    sendText(v);
    textEl.value = "";
    autoGrow(); syncSend();
  }
});
textEl.addEventListener("input", () => { autoGrow(); syncSend(); });
$("sendBtn").addEventListener("click", () => {
  const v = textEl.value;
  if (!v.trim()) return;
  sendText(v);
  textEl.value = "";
  autoGrow(); syncSend();
  textEl.focus();
});

/* 📎 قائمة الإرفاق */
const attachMenu = $("attachMenu"), emojiMenu = $("emojiMenu");
function closeMenus() {
  attachMenu.classList.add("hidden");
  emojiMenu.classList.add("hidden");
}
$("attachBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  emojiMenu.classList.add("hidden");
  attachMenu.classList.toggle("hidden");
});
$("emojiBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  attachMenu.classList.add("hidden");
  emojiMenu.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!attachMenu.contains(e.target) && !emojiMenu.contains(e.target)) closeMenus();
});
attachMenu.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    const a = b.dataset.a;
    closeMenus();
    if (a === "image") $("upImage").click();
    else if (a === "camera") $("upImageCam").click();
    else if (a === "file") $("upFile").click();
    else if (a === "loc") sendLocation();
    else if (a === "screen") toggleScreenShare();
    else if (a === "devices") askDevices();
  }));

/* 😊 إيموجي صغير يتكتب في مكان الكتابة */
const EMOJIS = ["😀", "😂", "😍", "👍", "🙏", "🔥", "✅", "❌", "⚠", "💰",
                 "📊", "📄", "🖼️", "📍", "🎙️", "🧠", "🌙", "☀️", "⏱️", "📦",
                 "🚚", "⛏️", "🪨", "🧾", "❤️", "🎉", "😅", "🤔", "👌", "📩",
                 "📲", "🔒"];
EMOJIS.forEach((em) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = em;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const s = textEl.selectionStart || textEl.value.length;
    textEl.value = textEl.value.slice(0, s) + em + textEl.value.slice(textEl.selectionEnd || s);
    textEl.selectionStart = textEl.selectionEnd = s + em.length;
    closeMenus(); autoGrow(); syncSend(); textEl.focus();
  });
  emojiMenu.appendChild(b);
});

/* 🖼 لصق صورة من الكليبورد (Ctrl+V) مباشرة في الشات */
textEl.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); uploadFile(f); return; }
    }
  }
});

/* 📎 رفع صورة/ملف → السيرفر يشوفه/يقرأه ويبعته لـهوب */
function addUserImg(url, name) {
  const el = addMsg("user", "");
  const img = document.createElement("img");
  img.className = "chat-img";
  img.alt = name || "صورة";
  img.src = url + (url.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(token);
  const cap = document.createElement("div");
  cap.className = "chat-img-cap";
  cap.textContent = name || "";
  el.appendChild(img); el.appendChild(cap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return el;
}
async function uploadFile(file) {
  if (!file) return;
  const isImg = (file.type || "").startsWith("image/");
  if (file.size > (isImg ? 8 : 5) * 1024 * 1024) {
    toast("الملف أكبر من " + (isImg ? "8" : "5") + "MB"); return;
  }
  const bub = addMsg("user", isImg ? "🖼 بيبعت الصورة…" : "📄 بيرفع " + file.name + "…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await api("/api/chat/upload", { method: "POST", body: fd });
    if (!r || !r.ok) throw new Error((r && r.error) || "فشل الرفع");
    bub.remove();
    if (isImg) {
      addUserImg(r.url, r.name);
      sendText("📤 بعتلك صورة اسمها «" + r.name + "» — وصفها: " +
               (r.desc || "(ماقدرتش أوصفها)") +
               " — شوفها وقولّي نتعامل معاها إزاي.", { silent: true });
    } else {
      addUser("📄 " + r.name + " (" + (r.chars || 0) + " حرف)");
      sendText("📤 رفعت ملف اسمه «" + r.name + "» — محتواه بالنص تحت:\n" +
               (r.text || "(مافيش نص قابل للقراءة)"), { silent: true });
    }
  } catch (e) {
    bub.textContent = "⚠ فشل الرفع — جرّب تاني";
    toast("الرفع فشل", 3200);
  }
}
["upImage", "upImageCam", "upFile"].forEach((id) => {
  $(id).addEventListener("change", () => {
    const f = $(id).files && $(id).files[0];
    $(id).value = "";
    if (f) uploadFile(f);
  });
});

/* 📍 إرسال موقعي */
function sendLocation() {
  if (!navigator.geolocation) { toast("التليفون مابيدعمش تحديد الموقع"); return; }
  toast("بياخد موقعك…", 2200);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = +pos.coords.latitude.toFixed(6);
    const lng = +pos.coords.longitude.toFixed(6);
    try {
      await api("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng, note: "موقعي من الشات" })
      });
    } catch (e) {}
    sendText("📍 موقعي الحالي: خط العرض " + lat + " وخط الطول " + lng +
             " (الدقة تقريبًا ±" + Math.round(pos.coords.accuracy || 0) +
             "م) — استخدمه لو محتاج.");
  }, () => toast("مقدرتش آخد الموقع — اتأكد إن السماح مفتوح", 3600),
     { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

/* 🖥 مشاركة شاشة حيّة — بتشتغل على سطح المكتب (السيرفر) */
let _shareOn = false;
async function toggleScreenShare() {
  const on = !_shareOn;
  try {
    const r = await fetch("/api/screen-share", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify({ on })
    }).then((x) => x.json());
    _shareOn = !!(r && r.live);
    toast(_shareOn ? "🖥 بشارك معاك شاشتي — هيتشاف في الشات"
                   : "قفلت مشاركة الشاشة", 3000);
    if (_shareOn) addUser("🖥 بدأ مشاركة الشاشة — أول ما هوب يلقط هتشوفها تحت.");
  } catch (e) { toast("مقدرتش أبدأ مشاركة الشاشة", 3000); }
}

/* 📡 أجهزة الشبكة القريبة */
function askDevices() {
  sendText("📡 دور على أجهزة الشبكة القريبة وقولّي مين شغّال (search the close devices).",
           { silent: false });
}

document.querySelectorAll(".sug").forEach((b) =>
  b.addEventListener("click", () => sendText(b.dataset.q)));

/* ═══════ جوجل درايف ═══════ */
async function api(path, opts = {}) {
  opts.headers = Object.assign({ "X-Token": token }, opts.headers || {});
  const r = await fetch(path, opts);
  if (r.status === 401) { showGate("كلمة السر غلط"); throw new Error("401"); }
  return r.json();
}
function paintGoogle(g) {
  const b = $("googleBtn");
  if (g && g.connected) {
    b.className = "chip ibtn ok"; b.textContent = "☁︎";
    b.title = "جوجل درايف متصل ✔";
  } else {
    b.className = "chip ibtn warn"; b.textContent = "☁︎";
    b.title = "اتصل بجوجل درايف";
  }
}
$("googleBtn").addEventListener("click", async () => {
  try {
    const st = await api("/api/google/status");
    if (st.connected) { toast("متصل بجوجل درايف — " + (st.email || "")); return; }
    const r = await api("/api/google/auth");
    if (r.blocked) { toast(r.msg || "الدرايف مش متاح دلوقتي — والتطبيق شغّال كامل من غيره", 7000); return; }
    toast(r.browser_opened ? "وافق على الكمبيوتر — وصّل الجوجل هناك" : "افتح الرابط على الكمبيوتر", 5000);
  } catch (e) {}
});

/* ═══════ بوابة الرمز ═══════ */
function showGate(msg) {
  gateEl.classList.remove("hidden");
  $("gateErr").textContent = msg || "";
}
$("gateBtn").addEventListener("click", tryGate);
$("gateInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryGate(); });
async function tryGate() {
  const v = $("gateInput").value.trim();
  if (!v) return;
  token = v;
  try {
    const cfg = await api("/api/config");
    localStorage.setItem("atefToken", v);
    gateEl.classList.add("hidden");
    boot(cfg);
  } catch (e) {
    const card = gateEl.querySelector(".gate-card");
    card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
    $("gateErr").textContent = "كلمة السر غلط";
  }
}

/* ═══════ تثبيت PWA ═══════ */
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e;
  $("install").classList.remove("hidden");
});
$("installYes").addEventListener("click", async () => {
  $("install").classList.add("hidden");
  if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
});
$("installNo").addEventListener("click", () => $("install").classList.add("hidden"));

/* ═══════ الإقلاع ═══════ */
async function boot(cfg) {
  paintGoogle(cfg.google);
  try {
    $("voiceSel").value = cfg.voice || "Puck";
    if ("Notification" in window && Notification.permission === "granted")
      $("notifBtn").textContent = "مفعّلة ✔";
  } catch (e) {}
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  // 🔕 تنبيهات هوب (notifyUser) — نطلب الإذن لو لسه
  if ("Notification" in window && Notification.permission === "default")
    Notification.requestPermission().then((p) => {
      $("notifBtn").textContent = p === "granted" ? "مفعّلة ✔" : "تفعيل";
    }).catch(() => {});
  const hadHist = await loadHistory();          // آخر محادثة محفوظة
  if (!hadHist)
    addMsg("sys", "أهلًا — أنا Hope، محاسب المحجر 🪨 (صوتي أو اكتب)");
  // 📡 مزامنة تلقائية (أوفلاين ↔ أونلاين — نفس الدماغ على الجانبين)
  if (window.Sync) Sync.start(paintNet);
  if (window.Offline) Offline.ensure().catch(() => {});
  // 🗺️ خريطة عقل هوب الحيّة — تتحمّل من السيرفر قبل الاتصال، عشان أي فكرة/طلب تجي بعدها تكسب
  try {
    const bv = await api("/api/brainview");
    if (window.Brain && bv) {
      if (bv.marks && Object.keys(bv.marks).length) Brain.loadMap(bv);
      else if (bv.thought) Brain.think(bv.thought);
    }
  } catch (e) {}
  connect();
  // تحديث حالة جوجل كل شوية
  setInterval(async () => {
    try { paintGoogle((await api("/api/google/status"))); } catch (e) {}
  }, 30000);
  // شاشات المحادثات (im.js) تبدأ بعد ما البوابة تخلص
  window.dispatchEvent(new Event("bm:ready"));
}
(async () => {
  // فتح مباشر من الـ QR: ?t=رمز الدخول — نحفظه ونشطف الرابط
  try {
    const t = (new URLSearchParams(location.search).get("t") || "").trim();
    if (t) {
      token = t;
      localStorage.setItem("atefToken", t);
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {}
  if (!token) { showGate(); return; }
  try { boot(await api("/api/config")); }
  catch (e) { showGate(); }
})();

/* ═══════════════════════════════════════════════════════
   🧠 شاشة العقل — وضع الواقع: نشاط حي + ملفاته + مساعديه + أسئلته
   ═══════════════════════════════════════════════════════ */
const brainEl = $("brain");
const feedList = $("feedList"), agentLog = $("agentLog");
let brainOpen = false, brainPollT = null, lastActId = 0, feedCount = 0;
let curFile = null;
const KIND_ICON = {
  system: "🔔", tool: "🔧", speak: "💬", memory: "🧠",
  file: "📁", agent: "🤖", question: "❓", error: "⚠️", web: "🌐", task: "📌",
};

function feedItemEl(it) {
  const d = document.createElement("div");
  d.className = "fitem k-" + (it.kind || "system");
  const h = document.createElement("div");
  h.className = "fh";
  const t = document.createElement("span");
  t.className = "ft";
  t.textContent = (KIND_ICON[it.kind] || "🔔") + " " + (it.title || "");
  const time = document.createElement("span");
  time.className = "ftime";
  time.textContent = it.ts || "";
  h.appendChild(t); h.appendChild(time);
  d.appendChild(h);
  if (it.detail) {
    const fd = document.createElement("div");
    fd.className = "fd";
    fd.textContent = it.detail;
    d.appendChild(fd);
  }
  return d;
}

function onActivity(it, live) {
  if (!it) return;
  if (it.id && it.id <= lastActId) return;      // مكرر
  if (it.id) lastActId = it.id;
  feedList.appendChild(feedItemEl(it));
  feedCount++;
  if (live && window.Brain) window.Brain.fire(it.kind || "system", null, it.title || "");
  if (feedCount > 220) feedList.removeChild(feedList.firstChild);
  if (it.kind === "agent" || it.kind === "error") {
    agentLog.appendChild(feedItemEl(it));
    if (agentLog.childElementCount > 60) agentLog.removeChild(agentLog.firstChild);
  }
  if (brainOpen) feedList.parentElement.scrollTop = 999999;
  if (it.kind === "question") loadQuestions();
  if (live && it.kind === "agent" && brainOpen) toast("🤖 " + (it.title || "مساعد"), 2200);
}

async function brainPoll() {
  try {
    const r = await api(`/api/panel/activity?since=${lastActId}&limit=120`);
    (r.items || []).forEach((it) => onActivity(it, true));
    loadQuestions();
  } catch (e) { /* هيعاود في المرة الجاية */ }
}
async function brainOpenLoad() {
  brainOpen = true;
  document.body.classList.add("brain-open");   // الدماغ يرجع للخلفية والشغله يظهر
  brainEl.classList.remove("hidden");
  if (!feedCount) {
    try {
      const r = await api("/api/panel/activity?limit=90");
      (r.items || []).reverse().forEach((it) => onActivity(it, false));   // الأقدم الأول — بلا نبضات
    } catch (e) {}
  }
  loadQuestions();
  brainPoll();
  clearInterval(brainPollT);
  brainPollT = setInterval(brainPoll, 3000);
}
function brainClose() {
  brainOpen = false;
  document.body.classList.remove("brain-open");
  brainEl.classList.add("hidden");
  clearInterval(brainPollT);
}
$("brainBtn").addEventListener("click", brainOpenLoad);
$("brainClose").addEventListener("click", brainClose);

/* 🖥 أوامر تحكّم الشاشة من الأداة uiNav — هوب يفتح/يتنقّل في واجهة المدير بنفسه */
function uiCmd(c) {
  c = c || {};
  try {
    if (c.brain && !brainOpen) brainOpenLoad();
    if (c.view) {
      const vb = document.querySelector('#nav button[data-v="' + c.view + '"]');
      if (vb) vb.click();
    }
    if (c.tab) {
      if (!brainOpen) brainOpenLoad();
      const tb = document.querySelector('.brain-tabs button[data-bt="' + c.tab + '"]');
      if (tb) tb.click();
    }
    if (c.settings) $("setSheet").classList.remove("hidden");
    if (c.toast) toast(c.toast, 3200);
  } catch (e) { /* شاشة لسه مش جاهزة — متجاهلين */ }
}

/* تبويبات العقل */
document.querySelectorAll(".brain-tabs button").forEach((b) => {
  if (!b.dataset.bt) return;
  b.addEventListener("click", () => {
    document.querySelectorAll(".brain-tabs button").forEach((x) => x.classList.remove("on"));
    document.querySelectorAll(".btab").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    $("bt-" + b.dataset.bt).classList.add("on");
    if (b.dataset.bt === "notes") loadWorkspace();
    if (b.dataset.bt === "apps") loadApplets();
    if (b.dataset.bt === "browse") loadBrowseSteps();
    if (b.dataset.bt === "tasks") loadTasks();
    if (b.dataset.bt === "wa") waLoad();
    if (b.dataset.bt === "map") { mapInit(); loadLocations(); }
    if (b.dataset.bt === "draw") drawInit();
    if (b.dataset.bt === "files") loadFileList(".");
  });
});

/* ✏️ لوحة الرسم (HTML5 Canvas) — لمس على التليفون + ماوس على الكمبيوتر */
let dw = null;
function drawInit() {
  const cv = $("dwCv");
  if (!cv) return;
  if (dw) { drawFit(); return; }
  const ctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  dw = { cv, ctx, dpr, undo: [], draw: false, erase: false, lx: 0, ly: 0 };
  drawFit(true);
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width),
             y: (e.clientY - r.top) * (cv.height / r.height) };
  };
  const curW = () => (+$("dwSize").value || 4) * (dw.erase ? 3 : 1) * dw.dpr;
  function whiteFill() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
  dw.whiteFill = whiteFill;
  const snap = () => {
    try {
      dw.undo.push(cv.toDataURL());
      if (dw.undo.length > 20) dw.undo.shift();
    } catch (e) {}
  };
  cv.addEventListener("pointerdown", (e) => {
    e.preventDefault(); snap(); dw.draw = true;
    const p = pos(e); dw.lx = p.x; dw.ly = p.y;
    ctx.beginPath();
    ctx.fillStyle = dw.erase ? "#ffffff" : $("dwColor").value;
    ctx.arc(p.x, p.y, curW() / 2, 0, 6.3);
    ctx.fill();
    try { cv.setPointerCapture(e.pointerId); } catch (x) {}
  });
  cv.addEventListener("pointermove", (e) => {
    if (!dw.draw) return;
    e.preventDefault();
    const p = pos(e);
    ctx.beginPath();
    ctx.strokeStyle = dw.erase ? "#ffffff" : $("dwColor").value;
    ctx.lineWidth = curW();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.moveTo(dw.lx, dw.ly);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    dw.lx = p.x; dw.ly = p.y;
  });
  const end = () => { dw.draw = false; };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  window.addEventListener("resize", drawFit);

  $("dwPen").addEventListener("click", () => {
    dw.erase = false;
    $("dwPen").classList.add("on"); $("dwEraser").classList.remove("on");
  });
  $("dwEraser").addEventListener("click", () => {
    dw.erase = true;
    $("dwEraser").classList.add("on"); $("dwPen").classList.remove("on");
  });
  $("dwUndo").addEventListener("click", () => {
    const d = dw.undo.pop();
    if (!d) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
    };
    img.src = d;
  });
  $("dwClear").addEventListener("click", () => { snap(); whiteFill(); });
  $("dwSave").addEventListener("click", () => {
    try {
      cv.toBlob((b) => {
        if (!b) { toast("مقدرتش أعمل صورة", 2500); return; }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = "hope-drawing-" + new Date().toISOString().slice(0, 10) + ".png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 8000);
        toast("💾 نزّلت الرسمة PNG ✔", 2600);
      }, "image/png");
    } catch (e) { toast("الحفظ فشل", 2500); }
  });
  whiteFill();
}
function drawFit(initial) {
  if (!dw) return;
  const { cv } = dw;
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  let data = null;
  if (!initial) {
    try { data = cv.toDataURL(); } catch (e) {}
  }
  const w = Math.round(r.width * dw.dpr), h = Math.round(r.height * dw.dpr);
  if (cv.width === w && cv.height === h) return;
  cv.width = w; cv.height = h;
  if (dw.whiteFill && !data) dw.whiteFill();
  if (data) {
    const img = new Image();
    img.onload = () => { dw.ctx.drawImage(img, 0, 0, w, h); };
    img.src = data;
  } else if (dw.whiteFill) dw.whiteFill();
}

/* ═══════ متصفح الملفات الداخلي — عرض ملفات الذاكرة والملفات المخزنة ═══════ */
let fileCwd = ".";
async function loadFileList(p = ".") {
  fileCwd = p || ".";
  const box = $("fileList");
  const pathEl = $("filePath");
  if (!box || !pathEl) return;
  pathEl.textContent = p;
  try {
    const r = await api("/api/files/list?p=" + encodeURIComponent(p));
    const items = r.items || [];
    box.innerHTML = "";
    if (p && p !== ".") {
      const up = document.createElement("div");
      up.className = "file-item";
      up.innerHTML = '<span class="file-icon">📁</span><div class="file-info"><div class="file-name">.. (الأعلى)</div><div class="file-size">مجلد أب</div></div>';
      up.onclick = () => { const parts = p.split("/"); parts.pop(); loadFileList(parts.join("/") || "."); };
      box.appendChild(up);
    }
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "fitem";
      d.textContent = "مافيش ملفات هنا.";
      box.appendChild(d);
      return;
    }
    items.forEach((it) => {
      const d = document.createElement("div");
      d.className = "file-item" + (it.is_dir ? "" : " clickable");
      d.innerHTML = '<span class="file-icon">' + (it.is_dir ? "📁" : "📄") + '</span>' +
        '<div class="file-info"><div class="file-name" title="' + it.name + '">' + it.name + '</div>' +
        '<div class="file-size">' + (it.is_dir ? "مجلد" : (it.size / 1024).toFixed(1) + " KB") + "</div></div>";
      if (!it.is_dir) {
        d.onclick = () => { loadFileRead(p + "/" + it.name); };
      } else {
        d.onclick = () => { loadFileList(p + "/" + it.name); };
      }
      box.appendChild(d);
    });
  } catch (e) {
    box.innerHTML = '<div class="fitem">خطأ في تحميل الملفات: ' + String(e).slice(0, 100) + "</div>";
  }
}

async function loadFileRead(relPath) {
  const viewer = $("fileViewer");
  const contentEl = $("fileViewContent");
  const nameEl = $("fileViewName");
  if (!viewer || !contentEl || !nameEl) return;
  try {
    const r = await api("/api/files/read?p=" + encodeURIComponent(relPath));
    nameEl.textContent = r.name || relPath;
    contentEl.textContent = r.content || "(فارغ)";
    viewer.classList.remove("hidden");
  } catch (e) {
    toast("تعذّر قراءة الملف: " + String(e).slice(0, 80), 3500);
  }
}

$("fileViewer").addEventListener("click", (e) => {
  if (e.target.id === "fileViewer" || e.target.id === "fileViewClose") {
    $("fileViewer").classList.add("hidden");
  }
});
$("fileRefresh").addEventListener("click", () => { loadFileList(fileCwd); });
$("fileUp").addEventListener("click", () => {
  const parts = fileCwd.split("/");
  parts.pop();
  loadFileList(parts.join("/") || ".");
});

/* ── مهامه وتذكيراته 📌 (منطق Odysseus: مهام + تنبيه في ميعادها) ── */
async function loadTasks() {
  const box = $("taskList");
  if (!box) return;
  try {
    const r = await api("/api/tasks");
    const items = r.items || [];
    box.innerHTML = "";
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "fitem";
      d.textContent = "مافيش مهام — قلّي «ضيف مهمة…» أو «ذكّرني…» وأنا أضيفها.";
      box.appendChild(d);
      return;
    }
    items.forEach((t) => {
      const d = document.createElement("div");
      d.className = "fitem k-task";
      const h = document.createElement("div");
      h.className = "fh";
      const tt = document.createElement("span");
      tt.className = "ft";
      tt.textContent = (t.due_at ? "⏰ " : "📌 ") + (t.title || "");
      const due = document.createElement("span");
      due.className = "ftime";
      due.textContent = t.due_at || "";
      h.appendChild(tt); h.appendChild(due);
      d.appendChild(h);
      if (t.detail) {
        const det = document.createElement("div");
        det.className = "fd";
        det.textContent = t.detail;
        d.appendChild(det);
      }
      const done = document.createElement("button");
      done.type = "button";
      done.className = "tskd";
      done.textContent = "✅ تمّت";
      done.addEventListener("click", async () => {
        try { await api(`/api/tasks/${t.id}/done`, { method: "POST" }); } catch (e) {}
        loadTasks();
      });
      d.appendChild(done);
      box.appendChild(d);
    });
  } catch (e) { /* هيعاود في المرة الجاية */ }
}

/* ═══════════════════════════════════════════════════════
   💬 واتساب — حالة + محادثات (ردّ تلقائي) + صلاحيات الأشخاص
   ═══════════════════════════════════════════════════════ */
async function waLoad() {
  const stEl = $("waSt");
  if (!stEl) return;
  try {
    const st = await api("/api/wa/status");
    const txt = { off: "● مقفول", starting: "● بيتهيأ…",
                  scanning: "● مستني مسح QR — افتح «وصلاته 🔗»",
                  ready: "● متصل ✔", disconnected: "● اتقطع", error: "● ⚠ خطأ" }[st.status] || st.status;
    stEl.textContent = txt + " — داخل " + (st.msgs_in || 0) + " / صادر " + (st.msgs_out || 0);
    stEl.className = "wa-st " + (st.status === "ready" ? "ok" : "bad");
    if (st.error) stEl.textContent += " — " + String(st.error).slice(0, 80);

    const r = await api("/api/wa/chats");
    const auto = st.auto_map || {};
    const box = $("waChats");
    box.innerHTML = "";
    const items = (r.items || []).slice(0, 25);
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "fitem";
      d.textContent = st.status === "ready"
        ? "بنجلب المحادثات… لو فاضلة اضغط تحديث 🔄"
        : "افتح الواتساب الأول من «وصلاته 🔗» — وتمسح QR من تليفونك";
      box.appendChild(d);
    }
    items.forEach((c) => {
      const d = document.createElement("div");
      d.className = "fitem";
      const h = document.createElement("div");
      h.className = "fh";
      const tt = document.createElement("span");
      tt.className = "ft";
      tt.textContent = (c.isGroup ? "👥 " : "👤 ") + (c.name || c.id || "");
      h.appendChild(tt);
      d.appendChild(h);
      const on = !!(auto && auto[c.id]);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mini" + (on ? " gold" : "");
      btn.textContent = on ? "الردّ التلقائي ✔" : "فعّل الردّ";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const rr = await api("/api/wa/chats/auto", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat: c.id, on: !on }),
          });
          toast(rr.ok ? (!on ? "اتفعّل الردّ في المحادثة ✔" : "اتوقف الردّ") : (rr.message || "حصل خطأ"));
          waLoad();
        } catch (e) { btn.disabled = false; }
      });
      d.appendChild(btn);
      box.appendChild(d);
    });

    const acc = await api("/api/access");
    const ab = $("waAccess");
    ab.innerHTML = "";
    (acc.items || []).forEach((p) => {
      const d = document.createElement("div");
      d.className = "fitem";
      const h = document.createElement("div");
      h.className = "fh";
      const tt = document.createElement("span");
      tt.className = "ft";
      tt.textContent = "👤 " + (p.name || "") + (p.phone ? " · " + p.phone : "");
      h.appendChild(tt);
      const sel = document.createElement("select");
      sel.className = "mini";
      Object.keys(acc.levels || { full: 1, self: 1, basic: 1, none: 1 }).forEach((lv) => {
        const o = document.createElement("option");
        o.value = lv; o.textContent = lv;
        if ((p.access || "basic") === lv) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", async () => {
        try {
          const rr = await api("/api/access", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ person: p.phone || p.name, level: sel.value }),
          });
          toast(rr.message || "");
        } catch (e) {}
      });
      h.appendChild(sel);
      d.appendChild(h);
      ab.appendChild(d);
    });
    if (!(acc.items || []).length) {
      const d = document.createElement("div");
      d.className = "fitem";
      d.textContent = "مافيش أرقام متسجّلة لسه — أول رسالة توصل من حد بتتسجّل هنا تلقائيًا (basic).";
      ab.appendChild(d);
    }
  } catch (e) {
    stEl.textContent = "مش قادر أوصل سيرفر الواتساب";
  }
}
$("waRefresh").addEventListener("click", waLoad);

function waEvent(m) {
  const tabOn = (sel) => !!document.querySelector(sel + ".on");
  if (m.kind === "location") {
    if (tabOn('.brain-tabs button[data-bt="map"]')) loadLocations();
    return;
  }
  if (m.kind === "msg" && m.dir === "in") {
    notifyPhone("💬 واتساب من " + (m.sender || m.chatName || ""), (m.body || "").slice(0, 120));
    if (tabOn('.brain-tabs button[data-bt="wa"]')) waLoad();
    return;
  }
  if (m.kind === "reply") {
    if (tabOn('.brain-tabs button[data-bt="wa"]')) waLoad();
    return;
  }
  if (m.kind === "status" && tabOn('.brain-tabs button[data-bt="wa"]')) waLoad();
}

/* ═══════════════════════════════════════════════════════
   🗺 خريطة المكان 3D — Cesium + خرائط OpenStreetMap (بلا مفاتيح)
   ═══════════════════════════════════════════════════════ */
let mapViewer = null, mapTried = false;
const MAP_HOME = { lat: 31.132, lng: 33.803 };   // العريش

function mapInit() {
  if (mapTried) return;
  mapTried = true;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Widgets/widgets.css";
  document.head.appendChild(css);
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Cesium.js";
  s.onload = () => { try { mapBoot(); } catch (e) { mapFail(); } };
  s.onerror = mapFail;
  document.head.appendChild(s);
}
function mapFail() {
  const el = $("mapMsg");
  if (el) el.textContent = "الخريطة 3D محتاجة إنترنت أول مرة — بس قائمة المواقع تحت شغّالة دايمًا.";
}
function mapBoot() {
  try {
    Cesium.Ion.defaultAccessToken = "";
    mapViewer = new Cesium.Viewer("map3d", {
      baseLayer: Cesium.ImageryLayer.fromProviderAsync(new Cesium.UrlTemplateImageryProvider({
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        maximumLevel: 19, credit: "© OpenStreetMap",
      })),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false, timeline: false, geocoder: false, homeButton: false,
      sceneModePicker: false, baseLayerPicker: false, navigationHelpButton: false,
      fullscreenButton: false, selectionIndicator: false, infoBox: false,
    });
    mapViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(MAP_HOME.lng, MAP_HOME.lat, 9000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
    });
    const el = $("mapMsg");
    if (el && el.parentNode) el.parentNode.removeChild(el);
    loadLocations();
  } catch (e) { mapFail(); }
}
async function loadLocations() {
  try {
    const r = await api("/api/locations?limit=200");
    const items = r.items || [];
    const ts = $("mapTs");
    if (ts) ts.textContent = items.length ? (items[0].ts || "") : "—";
    const list = $("mapList");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "fitem";
      d.textContent = "مافيش مواقع لسه — دوس «شارك موقعي» أو ابعت موقعك من واتساب وهيظهر هنا.";
      list.appendChild(d);
    }
    items.forEach((loc) => {
      const d = document.createElement("div");
      d.className = "fitem k-task";
      const h = document.createElement("div");
      h.className = "fh";
      const tt = document.createElement("span");
      tt.className = "ft";
      tt.textContent = (loc.source === "whatsapp" ? "💬 " : "📍 ") + (loc.person || "مجهول") +
        (loc.note ? " — " + loc.note : "");
      const ts2 = document.createElement("span");
      ts2.className = "ftime";
      ts2.textContent = loc.ts || "";
      h.appendChild(tt); h.appendChild(ts2);
      d.appendChild(h);
      const fly = document.createElement("button");
      fly.type = "button"; fly.className = "tskd"; fly.textContent = "✈ طير للمكان";
      fly.addEventListener("click", () => mapFly(loc.lat, loc.lng));
      d.appendChild(fly);
      list.appendChild(d);
    });
    mapRender(items);
  } catch (e) { /* هيعاود في المرة الجاية */ }
}
function mapFly(lat, lng) {
  if (!mapViewer) { toast("الخريطة لسه ما حمّلتش — محتاجة إنترنت أول مرة"); return; }
  try {
    mapViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(+lng, +lat, 2500),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-65), roll: 0 },
      duration: 1.6,
    });
  } catch (e) {}
}
function mapRender(items) {
  if (!mapViewer) return;
  try {
    mapViewer.entities.removeAll();
    (items || []).forEach((loc) => {
      const wa = loc.source === "whatsapp";
      mapViewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(+loc.lng, +loc.lat),
        point: {
          pixelSize: 13,
          color: wa ? Cesium.Color.fromCssColorString("#25D366")
                    : Cesium.Color.fromCssColorString("#f5c518"),
          outlineColor: Cesium.Color.WHITE, outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: (loc.person || "مجهول") + (loc.note ? " — " + loc.note : ""),
          font: "600 14px sans-serif",
          pixelOffset: new Cesium.Cartesian2(0, -26),
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
  } catch (e) {}
}
$("mapRefresh").addEventListener("click", loadLocations);
$("mapMe").addEventListener("click", () => {
  if (!navigator.geolocation) { toast("الجهاز ما بيدعمش تحديد الموقع"); return; }
  toast("بنجيب موقعك…");
  navigator.geolocation.getCurrentPosition(async (p) => {
    try {
      const r = await api("/api/locations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: p.coords.latitude, lng: p.coords.longitude,
                               note: "موقع المدير" }),
      });
      toast(r.message || "");
      loadLocations();
    } catch (e) { toast("حصل خطأ في الحفظ"); }
  }, () => toast("مافيش إذن موقع — فعّله من الإعدادات 🔐"),
     { enableHighAccuracy: true, timeout: 15000 });
});

/* ═══════════════════════════════════════════════════════
   🌤 أول مرة: ترحيب + دخول جوجل + قفل الخصوصية
   ═══════════════════════════════════════════════════════ */
(function welcomeInit() {
  const w = $("welcome");
  if (!w) return;
  if (localStorage.getItem("bm_seen") === "1") return;
  w.classList.remove("hidden");
  const finish = () => {
    localStorage.setItem("bm_seen", "1");
    w.classList.add("hidden");
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  };
  $("welLocal").addEventListener("click", finish);
  $("welGoogle").addEventListener("click", async () => {
    const msg = $("welMsg");
    try {
      const r = await api("/api/google/auth");
      if (r.already) { msg.textContent = "حسابك متصل بالفعل ✔"; finish(); return; }
      if (r.blocked) { msg.textContent = (r.msg || "الدرايف مش متاح") + " — ارجع للمستخدم المحلي وكمّل"; return; }
      msg.textContent = r.browser_opened
        ? "وافق على الكمبيوتر — هيتم الربط تلقائيًا ✔"
        : "افتح الرابط اللي ظهر على الكمبيوتر";
      if (r.url) window.open(r.url, "_blank");
      const t = setInterval(async () => {
        try {
          const g = await api("/api/google/status");
          if (g.connected) { clearInterval(t); msg.textContent = "اتربط بجوجل ✔"; finish(); }
        } catch (e) {}
      }, 3000);
      setTimeout(() => clearInterval(t), 120000);
    } catch (e) { msg.textContent = "حصل خطأ — جرّب «دخول محلي»"; }
  });
})();

/* ═══════════════════════════════════════════════════════
   🔐 الأذونات — أيقونة لكل صلاحية + منح بضغطة (وضع إذن بسيط)
   ═══════════════════════════════════════════════════════ */
const PERMS = [
  { icon: "🎤", name: "الميكروفون", why: "المحادثة الصوتية مع Hope", kind: "microphone" },
  { icon: "📍", name: "الموقع", why: "خريطة المكان + زر «موقعي»", kind: "geolocation" },
  { icon: "🔔", name: "الإشعارات", why: "تنبيهات المهام وأسئلة Hope وواتساب", kind: "notifications" },
  { icon: "💾", name: "التخزين الدائم", why: "ثبات التطبيق ووضع أوفلاين", kind: "storage" },
];
async function permStatus(p) {
  try {
    if (p.kind === "storage") {
      if (navigator.storage && navigator.storage.persisted)
        return (await navigator.storage.persisted()) ? "granted" : "prompt";
      return "unsupported";
    }
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: p.kind });
      return st.state;
    }
  } catch (e) {}
  return "unknown";
}
async function permGrant(p) {
  try {
    if (p.kind === "storage") {
      if (navigator.storage && navigator.storage.persisted)
        return await navigator.storage.persist();
      return false;
    }
    if (p.kind === "notifications") {
      const s = await Notification.requestPermission();
      return s === "granted";
    }
    if (p.kind === "microphone") {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return true;
    }
    if (p.kind === "geolocation") {
      return await new Promise((res) => {
        navigator.geolocation.getCurrentPosition(() => res(true),
          () => res(false), { timeout: 10000 });
      });
    }
  } catch (e) { return false; }
  return false;
}
async function renderPerms() {
  const box = $("permList");
  if (!box) return;
  box.innerHTML = "";
  for (const p of PERMS) {
    const st = await permStatus(p);
    const row = document.createElement("div");
    row.className = "perm-row";
    const ic = document.createElement("span");
    ic.className = "perm-ic"; ic.textContent = p.icon;
    const txt = document.createElement("div");
    txt.className = "perm-txt";
    const b1 = document.createElement("b"); b1.textContent = p.name;
    const b2 = document.createElement("span"); b2.textContent = p.why;
    txt.appendChild(b1); txt.appendChild(b2);
    const dot = document.createElement("span");
    dot.className = "perm-dot " + (st === "granted" ? "ok" : (st === "denied" ? "bad" : "wait"));
    dot.textContent = st === "granted" ? "ممنوح ✔" : (st === "denied" ? "مرفوض ✖" : "اضغط للمنح");
    dot.addEventListener("click", async () => {
      dot.textContent = "بيمنح…";
      const ok = await permGrant(p);
      renderPerms();
      toast(ok ? p.name + ": ممنوح ✔" : p.name + ": ما اتمنحش — جرّب من إعدادات المتصفح");
    });
    row.appendChild(ic); row.appendChild(txt); row.appendChild(dot);
    box.appendChild(row);
  }
}
$("permToggle").addEventListener("click", () => {
  const box = $("permBox");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden")) renderPerms();
});
$("permAll").addEventListener("click", async () => {
  for (const p of PERMS) await permGrant(p);
  renderPerms();
  toast("خلصنا منح الأذونات ⚡");
});

/* ── أسئلة هوب للمدير (تعلّم ذاتي) ── */
let curQuestion = null;
async function loadQuestions() {
  try {
    const qq = await api("/api/panel/questions?pending=1");
    const items = qq.items || [];
    if (!items.length) { $("qBox").classList.add("hidden"); curQuestion = null; return; }
    const q = items[0];
    if (curQuestion && curQuestion.id === q.id) return;
    curQuestion = q;
    $("qText").textContent = q.question;
    const opts = $("qOpts");
    opts.innerHTML = "";
    let list = [];
    try { list = q.options ? JSON.parse(q.options) : []; } catch (e) {}
    list.forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o;
      b.addEventListener("click", () => answerQuestion(o));
      opts.appendChild(b);
    });
    $("qInput").value = "";
    $("qBox").classList.remove("hidden");
    toast("❓ Hope بيسألك — افتح شاشة العقل", 4500);
    // 🔔 تنبيه حتى لو التطبيق في الخلفية
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification("❓ Hope بيسألك", { body: q.question, tag: "atef-q" }); } catch (e) {}
    }
  } catch (e) {}
}
async function answerQuestion(text) {
  if (!curQuestion) return;
  const t = (text !== undefined ? text : $("qInput").value).trim();
  if (!t) { toast("اكتب إجابة"); return; }
  try {
    const r = await api(`/api/panel/questions/${curQuestion.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: t }),
    });
    if (r.ok) {
      toast("وصلت لـHope ✔" + (r.delivered_to_session ? " — بيجاوب دلوقتي" : ""), 3200);
      curQuestion = null;
      $("qBox").classList.add("hidden");
    } else toast(r.error || "فشلت");
  } catch (e) { toast("حصل خطأ"); }
}
$("qSend").addEventListener("click", () => answerQuestion());

/* ── مساحة العمل: ملفاته وملاحظاته ── */
async function loadWorkspace() {
  const list = $("wsList");
  list.innerHTML = "";
  try {
    const r = await api("/api/panel/workspace");
    (r.items || []).forEach((f) => {
      const row = document.createElement("div");
      row.className = "wsrow";
      row.innerHTML = "";
      const ic = document.createElement("span");
      ic.textContent = f.folder === "مذكرات المشروع" ? "📝" :
                       f.folder.startsWith("ذكريات") ? "🧠" :
                       f.folder === "قوائم" ? "📊" : "📄";
      const nm = document.createElement("span");
      nm.className = "wname";
      nm.textContent = f.name.replace(/\.(md|csv|txt|xlsx)$/i, "");
      const fl = document.createElement("span");
      fl.className = "wfolder";
      fl.textContent = f.folder;
      const sz = document.createElement("span");
      sz.className = "wsize";
      sz.textContent = f.size + "KB";
      row.appendChild(ic); row.appendChild(nm); row.appendChild(fl); row.appendChild(sz);
      row.addEventListener("click", () => openFile(f));
      list.appendChild(row);
    });
    if (!list.childElementCount) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "لسه مافيش ملفات — كل ما Hope يتعلم حاجة بتتسجل هنا.";
      list.appendChild(p);
    }
  } catch (e) { toast("مش قادر أوصل مساحة العمل"); }
}
async function openFile(f) {
  curFile = f;
  try {
    const r = await api("/api/panel/workspace/read?path=" + encodeURIComponent(f.path));
    $("wsTitle").textContent = f.name.replace(/\.(md|csv|txt)$/i, "");
    $("wsBody").textContent = r.ok ? r.text : (r.error || "مش قادر أقرا الملف");
    $("wsRead").classList.remove("hidden");
  } catch (e) { toast("حصل خطأ"); }
}
$("wsClose").addEventListener("click", () => $("wsRead").classList.add("hidden"));
$("wsAsk").addEventListener("click", () => {
  if (!curFile) return;
  $("wsRead").classList.add("hidden");
  brainClose();
  const nm = curFile.name.replace(/\.(md|csv|txt|xlsx)$/i, "");
  sendText(`من مساحة عملك: اقرا ملاحظة/ذاكرة "${nm}" واشرح لي أهم اللي جواها باختصار`);
  toast("اسأل Hope ✔");
});

/* ── المساعدين ── */
document.querySelectorAll(".arole").forEach((b) =>
  b.addEventListener("click", () => {
    $("agRole").value = b.dataset.role;
    $("agTask").value = b.dataset.task;
  }));
$("agentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = $("agRole").value.trim(), task = $("agTask").value.trim();
  if (!role || !task) { toast("اكتب اسم المساعد + المهمة"); return; }
  try {
    const r = await api("/api/panel/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, task }),
    });
    if (r.ok) {
      toast("🤖 " + role + " شغال في الخلفية…", 3000);
      $("agTask").value = "";
      brainPoll();
    } else toast(r.error || "فشل");
  } catch (e) { toast("حصل خطأ"); }
});

/* ═══════════════════════════════════════════════════
   🗨 سجل المحادثة + نسخ الردود + محادثة جديدة
   ═══════════════════════════════════════════════════ */
function attachCopy(el) {
  if (!el || el.querySelector(".copyb")) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "copyb"; b.title = "نسخ الرد"; b.textContent = "⧉";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const body = el.querySelector(".body");
    const t = (body ? body.textContent : el.textContent || "").trim();
    if (!t) return;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
      .then(() => toast("اتنسخ ✔"))
      .catch(() => toast("مش قادر أنسخ من هنا"));
  });
  el.appendChild(b);
}
function addBotText(text) {
  const d = addMsg("bot", `<span class="dot"></span><div class="body"></div>`);
  d.querySelector(".body").textContent = text;
  attachCopy(d);
  return d;
}
async function loadHistory() {
  // أولًا من السيرفر (أونلاين)
  try {
    const r = await api("/api/history?limit=80");
    const items = r.items || [];
    if (items.length) {
      items.forEach((m) => {
        if (m.role === "user") addUser(m.text);
        else addBotText(m.text);
      });
      // نسخة للمخ المحلي (عشان لو بعدين قطع النت)
      if (window.Store) {
        items.forEach((m) => Store.addMessage(m.role, m.text, m.ts).catch(() => {}));
      }
      return true;
    }
  } catch (e) { /* أوفلاين — نجرب المخ المحلي */ }
  // أوفلاين → من مخ التليفون
  if (window.Store) {
    try {
      const items = await Store.listMessages(80);
      if (items.length) {
        items.forEach((m) => {
          if (m.role === "user") addUser(m.text);
          else addBotText(m.text);
        });
        return true;
      }
    } catch (e) {}
  }
  return false;
}
async function newChat() {
  if (!confirm("نبدأ محادثة جديدة؟ السجل القديم هيتمسح من غير رجوع.")) return;
  try { await api("/api/history", { method: "DELETE" }); } catch (e) {}
  chatEl.innerHTML = "";
  addMsg("sys", "محادثة جديدة 🗨 — اسألني أي حاجة يا بيه");
  toast("محادثة جديدة ✔");
}
$("newChat").addEventListener("click", newChat);

/* ═══════════════════════════════════════════════════
   🔗 الوصلات (Applets) — توصيل تطبيقات وخدمات خارجية
   ═══════════════════════════════════════════════════ */
let apItems = [];
async function loadApplets() {
  const wrap = $("apList");
  wrap.innerHTML = `<p class="hint">بيحمّل…</p>`;
  try {
    const r = await api("/api/applets");
    apItems = r.items || [];
    renderApplets();
  } catch (e) { wrap.innerHTML = `<p class="hint">مش قادر أوصل الوصلات</p>`; }
}
function apRefresh(r) {
  if (r && r.items) { apItems = r.items; renderApplets(); }
}
function apMini(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "mini " + (cls || ""); b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
function apNote(text) {
  const s = document.createElement("span");
  s.className = "aphint"; s.textContent = text;
  return s;
}
function renderApplets() {
  const wrap = $("apList");
  wrap.innerHTML = "";
  apItems.forEach((a) => wrap.appendChild(apCard(a)));
}
function apCard(a) {
  const card = document.createElement("div");
  card.className = "apcard" + (a.connected ? " on" : "");

  const head = document.createElement("div");
  head.className = "aphead";
  const ic = document.createElement("span");
  ic.className = "apic"; ic.textContent = a.icon;
  const nm = document.createElement("div");
  nm.className = "apnm";
  nm.innerHTML = "";
  const t1 = document.createElement("b"); t1.textContent = a.name;
  const t2 = document.createElement("span"); t2.textContent = a.desc;
  nm.appendChild(t1); nm.appendChild(t2);
  const badge = document.createElement("span");
  badge.className = "apbadge " + (a.connected ? "ok" : "off");
  badge.textContent = a.connected ? "✔ متصل" : "✖ مش متصل";
  head.appendChild(ic); head.appendChild(nm); head.appendChild(badge);
  card.appendChild(head);

  const row = document.createElement("div");
  row.className = "apact";

  if (a.kind === "builtin") {
    badge.textContent = "✔ مدمج";
    row.appendChild(apNote(a.help));

  } else if (a.id === "google") {
    row.appendChild(apMini(a.connected ? "📂 فتح درايف ↗" : "اتصل بجوجل ☁︎", "", async () => {
      if (a.connected) { window.open("https://drive.google.com/drive/my-drive", "_blank"); return; }
      try {
        const r = await api("/api/google/auth");
        if (r.blocked) { toast(r.msg || "الدرايف مش متاح دلوقتي", 7000); return; }
        toast(r.browser_opened ? "وافق على الكمبيوتر — هيتربط أوتوماتيك" : "افتح الرابط على الكمبيوتر", 5500);
      } catch (e) { toast("حصل خطأ"); }
    }));
    if (a.connected && a.extra && a.extra.email) row.appendChild(apNote("الحساب: " + a.extra.email));
    else row.appendChild(apNote(a.help));

  } else if (a.id === "whatsapp") {
    const st = (a.extra && a.extra.status) || "off";
    const stTxt = { off: "مقفول", starting: "بيتهيأ…", scanning: "مستني مسح QR ⏳",
                    ready: "متصل ✔", disconnected: "اتقطع", error: "⚠ خطأ" }[st] || st;
    if (st === "ready") {
      row.appendChild(apMini("افصل", "ghost", async () => {
        try {
          apRefresh(await api("/api/applets/whatsapp/disconnect", { method: "POST" }));
          toast("قفل جسر الواتساب ✔");
        } catch (e) {}
      }));
      row.appendChild(apNote("ردّ تلقائي في " + ((a.extra && a.extra.auto) || 0) +
        " محادثة — فعّله من تبويب «واتساب 💬»"));
    } else {
      const cbtn = apMini((st === "scanning" || st === "starting") ? "بيتهيأ…" : "اتصل 🔗",
        "", async (ev) => {
          ev.target.disabled = true; ev.target.textContent = "بيتهيأ…";
          try {
            const r = await api("/api/applets/whatsapp/connect", { method: "POST" });
            toast(r.message || "");
            apRefresh(await api("/api/applets"));
          } catch (e) { toast("حصل خطأ"); }
          ev.target.disabled = false; ev.target.textContent = "اتصل 🔗";
        });
      if (st === "scanning" || st === "starting") cbtn.disabled = true;
      row.appendChild(cbtn);
      if (a.extra && a.extra.error) row.appendChild(apNote("⚠ " + a.extra.error));
      else row.appendChild(apNote(a.help));
    }
    if (st === "scanning") {
      const img = document.createElement("img");
      img.className = "waqr";
      img.alt = "QR واتساب";
      img.src = "/api/wa/qr.png?t=" + Date.now();
      const t = setInterval(() => {
        if (!document.body.contains(img)) { clearInterval(t); return; }
        img.src = "/api/wa/qr.png?t=" + Date.now();
      }, 4000);
      card.appendChild(img);
      card.appendChild(apNote("افتح واتساب تليفونك ← الأجهزة المرتبطة ← ربط جهاز، وامسح الكود ده"));
    }

  } else if (a.id === "github") {
    if (a.connected) {
      row.appendChild(apMini("افصل", "ghost", async () => {
        try { apRefresh(await api("/api/applets/github/disconnect", { method: "POST" })); toast("اتفصل ✔"); } catch (e) {}
      }));
      row.appendChild(apNote("مفتاحك محفوظ ✔ — عدّله من GitHub"));
    } else {
      const inp = document.createElement("input");
      inp.type = "password"; inp.placeholder = "Personal Access Token";
      inp.autocomplete = "off"; inp.className = "apin";
      const btn = apMini("اتصل 🔗", "", async () => {
        const pat = inp.value.trim();
        if (!pat) { toast("حط المفتاح الأول"); return; }
        btn.disabled = true; btn.textContent = "بيفحص…";
        try {
          const r = await api("/api/applets/github/connect", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: { pat } }),
          });
          toast(r.message || "");
          if (r.ok) apRefresh(r);
          else { btn.disabled = false; btn.textContent = "اتصل 🔗"; }
        } catch (e) { toast("حصل خطأ"); btn.disabled = false; btn.textContent = "اتصل 🔗"; }
      });
      row.appendChild(inp); row.appendChild(btn);
      const link = document.createElement("a");
      link.className = "aphint"; link.target = "_blank"; link.rel = "noopener";
      link.href = "https://github.com/settings/personal-access-tokens/new";
      link.textContent = "جيب مفتاح من جيت هاب ↗";
      row.appendChild(link);
    }

  } else if (a.id === "email") {
    if (a.connected) {
      row.appendChild(apMini("افصل", "ghost", async () => {
        try { apRefresh(await api("/api/applets/email/disconnect", { method: "POST" })); toast("اتفصل ✔"); } catch (e) {}
      }));
      row.appendChild(apNote(a.extra && a.extra.host ? "SMTP: " + a.extra.host : "متصل ✔"));
    } else {
      const form = document.createElement("div");
      form.className = "apform";
      const mk = (ph, key, type) => {
        const i = document.createElement("input");
        i.placeholder = ph; i.type = type || "text"; i.dataset.k = key;
        i.autocomplete = "off"; i.className = "apin";
        return i;
      };
      const iHost = mk("SMTP host", "host");
      const iPort = mk("port", "port"); iPort.value = "587";
      const iUser = mk("user / email", "user");
      const iPass = mk("password / API key", "password"); iPass.type = "password";
      [iHost, iPort, iUser, iPass].forEach((i) => form.appendChild(i));
      const btn = apMini("اتصل ✉︎", "", async () => {
        const config = {};
        form.querySelectorAll(".apin").forEach((i) => config[i.dataset.k] = i.value.trim());
        if (!config.host || !config.user || !config.password) { toast("كمل البيانات"); return; }
        btn.disabled = true; btn.textContent = "بيجرّب…";
        try {
          const r = await api("/api/applets/email/connect", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config }),
          });
          toast(r.message || "");
          if (r.ok) apRefresh(r);
          else { btn.disabled = false; btn.textContent = "اتصل ✉︎"; }
        } catch (e) { toast("حصل خطأ"); btn.disabled = false; btn.textContent = "اتصل ✉︎"; }
      });
      row.appendChild(form);
      row.appendChild(btn);
      row.appendChild(apNote("زي بيانات Brevo/SMTP — المفتاح ما بيتسجّلش في مكان تاني"));
    }
  }

  card.appendChild(row);
  return card;
}

/* ═══════════════════════════════════════════════════
   🖥 متصفحه — يشوف الصفحات وهو بيفتحها حيًا (Browser-use)
   ═══════════════════════════════════════════════════ */
const brSeen = new Set();
async function loadBrowseSteps() {
  try {
    const r = await api("/api/browse/steps?limit=30");
    brSeen.clear();
    $("brSteps").innerHTML = "";
    (r.items || []).forEach((s) => addBrowseStep(s, false));
  } catch (e) {}
}
function addBrowseStep(s, live) {
  if (!s) return;
  const key = (s.ts || "") + "|" + (s.url || "") + "|" + (s.action || "") + "|" + (s.title || "");
  if (brSeen.has(key)) return;
  brSeen.add(key);
  const box = $("brSteps");
  const row = document.createElement("div");
  row.className = "bstep" + (s.ok ? "" : " bad");
  const ts = document.createElement("span");
  ts.className = "btime"; ts.textContent = (s.ts || "").split(" ").pop();
  const ac = document.createElement("span");
  ac.className = "bact"; ac.textContent = (s.ok ? "▶ " : "✖ ") + (s.action || "");
  const ti = document.createElement("span");
  ti.className = "btitle"; ti.textContent = s.title || s.url || "";
  row.appendChild(ts); row.appendChild(ac); row.appendChild(ti);
  box.appendChild(row);
  while (box.childElementCount > 40) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
  if (live) updateBrBar(s.url);
}
function updateBrBar(url) {
  if (!url) return;
  $("brUrl").textContent = url;
  const open = $("brOpen");
  open.classList.remove("hidden"); open.href = url;
}
function addPageCard(m) {
  if (window.Brain) window.Brain.fire("web", null, m.title || m.url || "");
  const card = addMsg("web", `<div class="wc-in">
      <div class="wc-h">🌐 <b></b> <span class="wc-ts"></span></div>
      <div class="wc-d"></div>
      <a class="wc-a" target="_blank" rel="noopener">↗ افتح الصفحة</a>
    </div>`);
  card.querySelector("b").textContent = m.title || "صفحة";
  card.querySelector(".wc-ts").textContent = m.ts || "";
  const snippet = (m.desc || "") || (m.text || "").replace(/\s+/g, " ").slice(0, 200);
  card.querySelector(".wc-d").textContent = snippet;
  card.querySelector(".wc-a").href = m.url || "#";

  updateBrBar(m.url);
  const frame = $("brFrame"), txt = $("brText");
  if (m.embed && m.url) {
    txt.classList.add("hidden");
    frame.classList.remove("hidden");
    if (frame.dataset.src !== m.url) { frame.dataset.src = m.url; frame.src = m.url; }
  } else {
    frame.classList.add("hidden");
    try { frame.src = "about:blank"; } catch (e) {}
    txt.classList.remove("hidden");
    txt.textContent = (m.title ? m.title + "\n\n" : "") + (m.text || snippet);
  }
}

/* ═══════════════════════════════════════════════════
   🖥 لقطة شاشة المدير (screenCapture) — بتشوف اللي شايفه
   ═══════════════════════════════════════════════════ */
function addScreenCap(m) {
  if (window.Brain) window.Brain.fire("web", null, "🖥 شاشة الكمبيوتر");
  const card = addMsg("web", `<div class="wc-in shot-card">
      <div class="wc-h">🖥 <b>شاشة الكمبيوتر</b> <span class="wc-ts"></span></div>
      <a class="shot-open" target="_blank" rel="noopener">
        <img class="shot-img" alt="لقطة شاشة" />
      </a>
      <div class="wc-d">📷 اتقطت — اضغط عشان تشوفها بالحجم</div>
    </div>`);
  const url = (m.url || "") + (m.url && m.url.indexOf("?") < 0 ? "?t=" + Date.now() : "");
  card.querySelector(".wc-ts").textContent = m.ts || "";
  const img = card.querySelector(".shot-img");
  img.src = m.url || "";
  card.querySelector(".shot-open").href = m.url || "#";
  img.onload = () => { chatEl.scrollTop = chatEl.scrollHeight; };
  img.onerror = () => { card.querySelector(".wc-d").textContent = "⚠ اللقطة ما روحتش"; };
}

/* ═══════════════════════════════════════════════════
   ⚙︎ الإعدادات: صوت Hope · تنبيهات · محادثة جديدة
   ═══════════════════════════════════════════════════ */
$("setBtn").addEventListener("click", () => $("setSheet").classList.remove("hidden"));
$("setClose").addEventListener("click", () => $("setSheet").classList.add("hidden"));

/* ── QR سريع: افتحه بالتليفون يفتح التطبيق على طول ── */
async function openQr() {
  const ov = $("qrOverlay"), img = $("qrImg"), urlEl = $("qrUrl");
  ov.classList.remove("hidden");
  let phone = "";
  try { phone = (await api("/api/config")).phone || ""; } catch (e) {}
  if (!phone) phone = location.origin;
  urlEl.textContent = phone;
  img.src = "/api/qr?u=" + encodeURIComponent(phone) + "&t=" + Date.now();
  $("qrOpen").onclick = () => window.open(phone, "_blank");
  // زر التطبيق على النت — يفتح على الرابط المنشور (يحدثه المدير من الإعدادات)
  const netlifyUrl = localStorage.getItem("netlifyUrl") || "https://egptzone88.github.io/";
  $("qrNetlify").onclick = () => window.open(netlifyUrl, "_blank");
  $("qrNetlify").innerHTML = '<span class="net-icon">🚀</span> افتح على النت (' +
    netlifyUrl.split("//")[1].split("/")[0] + ")";
  // أيقونة QR القابلة للنقر — نفس الرابط
  const nlLink = $("netlifyQrLink");
  if (nlLink) nlLink.href = netlifyUrl;
  const nlImg = $("qrNetlifyImg");
  if (nlImg) nlImg.src = "/icons/qr-netlify.png?v=" + Date.now();
}
$("qrBtn").addEventListener("click", openQr);
$("qrClose").addEventListener("click", () => $("qrOverlay").classList.add("hidden"));
$("qrOverlay").addEventListener("click", (e) => {
  if (e.target === $("qrOverlay")) $("qrOverlay").classList.add("hidden");
});
$("setSheet").addEventListener("click", (e) => {
  if (e.target === $("setSheet")) $("setSheet").classList.add("hidden");
});
$("voiceSel").addEventListener("change", async () => {
  const v = $("voiceSel").value;
  try {
    const r = await api("/api/voice", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: v }),
    });
    if (r.ok) {
      toast("الصوت بقى " + v + " — بيعاد الاتصال…", 3200);
      reconnectTries = 0;
      try { ws.close(); } catch (e) {}      // onclose هيعيد الاتصال تلقائيًا
    } else toast(r.error || "مش قادر أغيّر الصوت");
  } catch (e) { toast("حصل خطأ"); }
});
$("notifBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) { toast("المتصفح ما بيدعمش التنبيهات"); return; }
  try {
    const p = await Notification.requestPermission();
    $("notifBtn").textContent = p === "granted" ? "مفعّلة ✔" : "تفعيل";
    toast(p === "granted" ? "التنبيهات اتفعّلت ✔" : "التنبيهات مرفوضة من المتصفح");
  } catch (e) {}
});
$("setNewChat").addEventListener("click", () => {
  $("setSheet").classList.add("hidden");
  newChat();
});
$("netlifyUrl").addEventListener("change", () => {
  const v = $("netlifyUrl").value.trim();
  if (v) {
    localStorage.setItem("netlifyUrl", v);
    toast("تم حفظ رابط Netlify", 2000);
  }
});
$("setBtn").addEventListener("click", () => {
  const saved = localStorage.getItem("netlifyUrl");
  if (saved) $("netlifyUrl").value = saved;
  $("setSheet").classList.remove("hidden");
});

/* ═══════ 📞 المكالمة الصوتية الدائم (Wake word — «هوب» يصحى لوحده) ═══════ */
toggleBox($("callToggle"), $("callBox"));
alwaysBtnRender();
$("alwaysBtn").addEventListener("click", () => setAlways(!alwaysOn));

/* زر مؤشر الصوت — يفتح قفل الصوت فورًا لو المتصفح مسكّره */
$("soundDot").addEventListener("click", () => { unlockAudio(); renderSound(); });
renderSound();

/* إبقاء الشاشة مفتوحة عشان الاستماع ما يفصلش (Screen Wake Lock) */
let _wl = null;
$("wakeWl").addEventListener("click", async () => {
  if (_wl) {
    try { await _wl.release(); } catch (e) {}
    _wl = null;
    $("wakeWl").textContent = "إبقاء الشاشة مفتوحة 🌙";
    toast("الشاشة هتقفل عادي تاني");
    return;
  }
  try {
    _wl = await navigator.wakeLock.request("screen");
    $("wakeWl").textContent = "الشاشة مفتوحة ✔ اضغط للإيقاف";
    toast("الشاشة هتفضل مفتوحة طول ما التطبيق شغّال");
  } catch (e) {
    toast("المتصفح مانع إبقاء الشاشة — جرّب من الإعدادات");
  }
});
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && alwaysOn && !wakeRecog && !micPermBlocked) startWake();
});

/* ═══════════════════════════════════════════════════════════
   🧩 المزوّدات + 🤖 المساعدات المخصّصة (من الإعدادات)
   ═══════════════════════════════════════════════════════════ */
function toggleBox(btn, box) {
  btn.addEventListener("click", () => {
    const hid = box.classList.toggle("hidden");
    btn.textContent = hid ? "عرض ▾" : "إخفاء ▴";
    if (!hid) box.dispatchEvent(new Event("open"));
  });
}
toggleBox($("provToggle"), $("provBox"));
toggleBox($("agentToggle"), $("agentBox"));
toggleBox($("odToggle"), $("odBox"));
toggleBox($("ollToggle"), $("ollBox"));

/* ── 💾 موديلات أوفلاين على السيرفر (Gemma على Ollama) ── */
async function ollLoad() {
  const st = await api("/api/ollama");
  $("ollStatus").textContent = st.running_server
    ? "✔ Ollama شغّال — " + (st.installed.length || "مافيش") + " موديل مثبت"
    : "✘ Ollama مش شغّال على السيرفر — افتحه الأول (" + (st.err || "") + ")";
  const ins = $("ollInstalled"); ins.innerHTML = "";
  (st.installed || []).forEach((m) => {
    const c = document.createElement("span");
    c.className = "chip"; c.textContent = `${m.name} · ${m.size_gb}GB`;
    ins.appendChild(c);
  });
  if (!(st.installed || []).length) ins.textContent = "مافيش موديل مثبت لسه.";
  const cat = $("ollCatalog"); cat.innerHTML = "";
  (st.catalog || []).forEach((m) => {
    const b = document.createElement("button");
    b.className = "mini" + (m.installed ? " ok" : ""); b.type = "button";
    b.textContent = `${m.installed ? "✔ " : "⬇ "}${m.label} (${m.gb}GB)`;
    b.addEventListener("click", async () => {
      b.disabled = true;
      await api("/api/ollama/pull", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m.model }) });
      ollPoll();
    });
    cat.appendChild(b);
  });
  if (st.pulling) ollPoll();
}
async function ollPoll() {
  const wrap = $("ollProgWrap"), bar = $("ollProg"), msg = $("ollMsg");
  wrap.classList.remove("hidden");
  const tick = async () => {
    const p = await api("/api/ollama/pull");
    bar.style.width = (p.percent || 0) + "%";
    msg.textContent = p.msg || "";
    if (p.running) { setTimeout(tick, 1200); return; }
    wrap.classList.add("hidden");
    if (p.err) { msg.textContent = "✘ " + p.err; }
    else { msg.textContent = "✔ " + (p.msg || "اتثبت"); ollLoad(); }
  };
  tick();
}
$("ollBox").addEventListener("open", ollLoad);

/* 🖥 استرجاع حالة مشاركة الشاشة عند فتح التطبيق */
(async () => {
  try {
    const r = await api("/api/screen-share/state");
    _shareOn = !!(r && r.live);
  } catch (e) {}
})();

/* ── المزوّدات ── */
let _provEditId = null;

function provFillForm(p) {
  _provEditId = (p && p.id) || null;
  $("provKind").value = (p && p.kind) || "gemini";
  $("provName").value = (p && p.name) || "";
  $("provBase").value = (p && p.base_url) || "";
  $("provKey").value = "";
  $("provKey").placeholder = (p && p.has_key)
    ? "مفتاح محفوظ — اتركه فاضي للإبقاء" : "المفتاح API (اختياري للـOllama)";
  $("provModel").value = (p && p.model) || "";
}

async function loadProviders() {
  try {
    const d = await api("/api/providers");
    const listEl = $("provList");
    listEl.innerHTML = "";
    (d.list || []).forEach((p) => {
      const c = document.createElement("span");
      c.className = "chip" + (p.id === d.active_id ? " active" : "");
      c.innerHTML = `<span>${p.name} · ${p.model}</span>`;
      const on = document.createElement("span");
      on.className = "chip-on"; on.title = "تفعيل";
      on.textContent = p.id === d.active_id ? "✔" : "⚡";
      on.onclick = async () => {
        const r = await api(`/api/providers/${p.id}/activate`, { method: "POST" });
        if (r.ok) { toast("اتفعّل: " + p.name); loadProviders(); }
        else toast(r.error || "مش قادر أفعّله");
      };
      const ed = document.createElement("span");
      ed.className = "chip-on"; ed.title = "تعديل";
      ed.textContent = "✏"; ed.onclick = () => provFillForm(p);
      const x = document.createElement("span");
      x.className = "chip-x"; x.title = "حذف"; x.textContent = "✕";
      x.onclick = async () => {
        await api(`/api/providers/${p.id}`, { method: "DELETE" });
        toast("اتمسح"); if (_provEditId === p.id) provFillForm(null);
        loadProviders();
      };
      c.append(on, ed, x);
      listEl.appendChild(c);
    });
    const st = d.active_status || {};
    $("provActive").textContent =
      (d.active_id ? "المفعّل: " + (st.source || "") + " · " + (st.model || "")
                   : "المفعّل: افتراضي (جوجل جيميني الأساسي)");
  } catch (e) {}
}

$("provBox").addEventListener("open", loadProviders);
$("provNew").addEventListener("click", () => provFillForm(null));

$("provTest").addEventListener("click", async () => {
  const msg = $("provMsg");
  msg.textContent = "⏳ بجرّب الاتصال…";
  try {
    const body = _provEditId
      ? { id: _provEditId }
      : { kind: $("provKind").value, base_url: $("provBase").value,
          api_key: $("provKey").value, model: $("provModel").value };
    const r = await api("/api/providers/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    msg.textContent = r.ok ? `✔ شغال (${r.ms}ms): ${r.detail}`
                           : `✘ فشل: ${r.detail}`;
    msg.style.color = r.ok ? "var(--green)" : "var(--pink)";
  } catch (e) { msg.textContent = "✘ حصل خطأ"; }
});

$("provSave").addEventListener("click", async () => {
  const msg = $("provMsg");
  try {
    const body = {
      id: _provEditId || "", kind: $("provKind").value, name: $("provName").value,
      base_url: $("provBase").value, api_key: $("provKey").value,
      model: $("provModel").value,
    };
    const r = await api("/api/providers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      toast("اتحفّظ المزوّد ✔"); msg.textContent = "";
      provFillForm(null); loadProviders();
    } else msg.textContent = r.error || "مش قادر أحفظه";
  } catch (e) { msg.textContent = "✘ حصل خطأ"; }
});

/* ── مفاتيح جيميني (تبديل تلقائي عند 429) ── */
/* apiS = api + جلسة الدخول (X-User) — الحاجات الحساسة للمدير بس */
function apiS(path, opts = {}) {
  opts.headers = Object.assign(
    { "X-User": localStorage.getItem("imToken") || "" }, opts.headers || {});
  return api(path, opts);
}
async function loadKeys() {
  try {
    const d = await apiS("/api/llm/keys");
    const el = $("keyList");
    el.innerHTML = "";
    if (!d.keys) {        // مش حساب المدير (403) أو حالة غلط
      $("keyReady").textContent = d.error === "owner"
        ? "🔑 قسم المفاتيح للمدير بس — ادخل بحسابه 👑"
        : (d.error ? "✘ " + d.error : "—");
      return;
    }
    (d.keys || []).forEach((k) => {
      const c = document.createElement("span");
      c.className = "chip" + (k.cooled ? "" : " active");
      const s = document.createElement("span");
      s.setAttribute("dir", "ltr");
      s.textContent = k.masked;
      c.appendChild(s);
      const m = document.createElement("small");
      m.textContent = (k.src === "env" ? " ⚙" : " 🔑") +
        (k.cooled ? " · مبرّد ⏳" : " · جاهز");
      c.appendChild(m);
      if (k.kv) {
        const x = document.createElement("span");
        x.className = "chip-x"; x.title = "حذف"; x.textContent = "✕";
        x.onclick = async () => {
          try {
            const r = await apiS("/api/llm/keys", {
              method: "DELETE", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kvi: k.kvi }),
            });
            if (r.ok) { toast("اتمسح المفتاح"); loadKeys(); }
            else toast(r.error || "مش قادر أمسحو");
          } catch (e) { toast("حصل خطأ"); }
        };
        c.appendChild(x);
      }
      el.appendChild(c);
    });
    $("keyReady").textContent =
      `جاهز دلوقتي: ${d.ready} مفتاح — أي واحد يتعذّر (429) ` +
      "بيتنقّل للي بعده تلقائيًا، وبعدهم أوفلاين جوجل (Gemma).";
  } catch (e) {}
}
$("provBox").addEventListener("open", loadKeys);
$("keyAdd").addEventListener("click", async () => {
  const msg = $("keyMsg");
  const v = $("keyNew").value.trim();
  if (!v) { msg.textContent = "اكتب المفتاح الأول"; return; }
  try {
    const r = await apiS("/api/llm/keys", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: v }),
    });
    if (r.ok) {
      $("keyNew").value = ""; msg.textContent = "اتضاف ✔";
      toast("اتضاف مفتاح جيميني ✔"); loadKeys();
    } else msg.textContent = r.error || "مش قادر أضيفه";
  } catch (e) { msg.textContent = "✘ حصل خطأ"; }
});

/* ── المساعدات المخصّصة ── */
async function loadAgents() {
  try {
    const d = await api("/api/agents");
    const el = $("agentList");
    el.innerHTML = "";
    (d.items || []).forEach((a) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.innerHTML = `<span>${a.builtin ? "🔒" : "🤖"} ${a.name}` +
                    (a.specialty ? ` · ${a.specialty}` : "") + "</span>";
      if (!a.builtin) {
        const x = document.createElement("span");
        x.className = "chip-x"; x.title = "حذف"; x.textContent = "✕";
        x.onclick = async () => {
          await api(`/api/agents/${a.id}`, { method: "DELETE" });
          toast("اتمسح"); loadAgents();
        };
        c.appendChild(x);
      }
      el.appendChild(c);
    });
  } catch (e) {}
}

$("agentBox").addEventListener("open", loadAgents);
$("agRefresh").addEventListener("click", loadAgents);

$("agSave").addEventListener("click", async () => {
  const msg = $("agMsg");
  const name = $("agName").value.trim();
  if (!name) { msg.textContent = "لازم اسم المساعد"; return; }
  try {
    const r = await api("/api/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name, specialty: $("agSpec").value.trim(),
        system_prompt: $("agPrompt").value.trim(), tools: [], provider_id: "",
      }),
    });
    if (r.ok) {
      toast("اتضاف المساعد «" + name + "» ✔");
      $("agName").value = ""; $("agSpec").value = ""; $("agPrompt").value = "";
      msg.textContent = ""; loadAgents();
    } else msg.textContent = r.error || "مش قادر أضيفه";
  } catch (e) { msg.textContent = "✘ حصل خطأ"; }
});

/* ═══════════════════════════════════════════════════════════
   🧠 مقدمة «العقل» + زر التخطّي + وضع عرض العقل
   ═══════════════════════════════════════════════════════════ */
(function () {
  const splash = $("splash");
  const skip = $("splashSkip");
  const thoughtEl = $("splashThought");
  const mindBtn = $("mindBtn");

  function enterChat() {
    splash.classList.add("gone");
    document.body.classList.remove("mindview");
    try { $("text").focus(); } catch (e) {}
  }
  // زر التخطّي → يدخل على المحادثة/الشات مباشرة
  if (skip) skip.addEventListener("click", enterChat);
  // لو دوسة على خلفية المقدمة (مش الزر) → برضو يدخل
  if (splash) splash.addEventListener("click", (e) => {
    if (e.target === splash) enterChat();
  });

  // زر «🧠 عقله» في الهيدر → يعرض العقل الساحر كامل ويخفي المحادثة، ويرجّعها لو مضغوط تاني
  let mindOn = false;
  if (mindBtn) mindBtn.addEventListener("click", () => {
    mindOn = !mindOn;
    document.body.classList.toggle("mindview", mindOn);
    // لو المقدمة لسه ظاهرة → دخل على الشات الأول
    if (!splash.classList.contains("gone")) splash.classList.add("gone");
  });

  // عرض فكرة هوب الحالية في المقدمة (نفس اللي فوق الدماغ — من غير أي اختلاف)
  const _think = window.Brain ? window.Brain.think : null;
  if (window.Brain) {
    window.Brain.think = function (txt) {
      if (_think) _think.call(window.Brain, txt);
      if (thoughtEl && txt) thoughtEl.textContent = "💭 " + txt;
    };
  }

  // تلقائيًا: بعد ما يجهز (اتصال كامل) المقدمة تخش على الشات لو المستخدم ما ضغطش
  // (بس بنسيبها شوية عشان يشوفوا العقل الساحر — 2.2 ثانية)
  let autoDone = false;
  function maybeAutoEnter() {
    if (autoDone) return;
    autoDone = true;
    setTimeout(() => {
      if (!splash.classList.contains("gone") && !mindOn) enterChat();
    }, 2200);
  }
  // نراقب حالة الاتصال من #status
  const statusEl = $("status");
  if (statusEl) {
    const obs = new MutationObserver(() => {
      const t = statusEl.textContent || "";
      if (/جاهز|بيسمع|بيتكلم|بيفكر/.test(t)) maybeAutoEnter();
    });
    obs.observe(statusEl, { childList: true, characterData: true, subtree: true });
  }
})();
