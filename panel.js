/* ═══════════════════════════════════════════════════
   لوحة تحكم هوب — منطق الواجهة
   القاعدة المحلية ← API السيرفر ← جوجل درايف/شيتات
   ═══════════════════════════════════════════════════ */
"use strict";

const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("atefToken") || "";

/* ═══════ أدوات صغيرة ═══════ */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
let toastTimer = null;
function toast(msg, ms = 2800) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}
async function api(path, opts = {}) {
  opts.headers = Object.assign({ "X-Token": token }, opts.headers || {});
  const r = await fetch(path, opts);
  if (r.status === 401) { showGate("كلمة السر غلط"); throw new Error("401"); }
  return r.json();
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" },
               body: JSON.stringify(body || {}) });
const put = (path, body) =>
  api(path, { method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body || {}) });
const del = (path) => api(path, { method: "DELETE" });

/* ═══════ بوابة الرمز ═══════ */
function showGate(msg) {
  $("gate").classList.remove("hidden");
  $("gateErr").textContent = msg || "";
}
$("gateBtn").addEventListener("click", tryGate);
$("gateInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryGate(); });
async function tryGate() {
  const v = $("gateInput").value.trim();
  if (!v) return;
  token = v;
  try {
    await api("/api/panel/stats");
    localStorage.setItem("atefToken", v);
    $("gate").classList.add("hidden");
    start();
  } catch (e) {
    const card = document.querySelector(".gate-card");
    card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
    $("gateErr").textContent = "كلمة السر غلط";
  }
}

/* ═══════ التبويبات ═══════ */
let brainTimer = null;
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("on"));
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    $("tab-" + b.dataset.tab).classList.add("on");
    clearInterval(brainTimer);          // البث الحي يشتغل بس مع فتح التبويب
    const loaders = { home: loadStats, mem: loadMemories, notes: loadNotes,
                      people: loadPeople, logs: loadLogs, google: loadGoogleTab,
                      apps: loadAppletsP, brain: loadBrain, ws: loadWsFiles };
    (loaders[b.dataset.tab] || (() => {}))();
  }));

/* ═══════ نظرة عامة ═══════ */
async function loadStats() {
  try {
    const s = await api("/api/panel/stats");
    $("cMem").textContent = s.memories;
    $("cPeople").textContent = s.people;
    $("cNotes").textContent = s.notes;
    $("cSheets").textContent = s.sheets;
    $("cDb").textContent = s.db_size_kb;
    $("cSync").textContent = s.last_sync || "لسه";
    $("iModel").textContent = s.model;
    $("iGoogle").textContent = s.google.connected ? ("متصل — " + (s.google.email || "")) : "مش متصل";
    $("iWork").textContent = s.workspace;
    $("iOffice").textContent = s.office_root;
    $("iBuilt").textContent = s.people_built_at || "لسه";
    paintGoogle(s.google);
    $("hstat").textContent = "قاعدة البيانات شغالة · " + s.memories + " ذكرة";
  } catch (e) { /* gate هيظهر لو فشل */ }
}
$("btnRefresh").addEventListener("click", () => { loadStats(); toast("تم التحديث"); });
$("btnRebuild").addEventListener("click", rebuildPeople);
$("btnSync2") && $("btnSync2").addEventListener("click", doSync);
$("btnSync").addEventListener("click", doSync);

async function rebuildPeople() {
  toast("بيبني فهرس الأسماء من الإكسل… (ممكن ياخد دقيقة)");
  try {
    const r = await post("/api/panel/people/rebuild");
    toast("الفهرس جاهز: " + r.count + " اسم");
    loadStats(); loadPeople();
  } catch (e) { toast("فشل: " + e); }
}
async function doSync() {
  toast("بيزامن مع جوجل درايف…");
  try {
    const r = await post("/api/panel/sync");
    if (r.ok) toast("تمت مزامنة " + r.files + " ملف ☁︎");
    else toast(r.error || "فشلت المزامنة", 4000);
    loadStats(); loadLogs();
  } catch (e) { toast("فشل: " + e); }
}

/* ═══════ الذكريات ═══════ */
async function loadMemories() {
  const list = $("memList");
  list.innerHTML = "";
  list.appendChild(el("div", "hint", "بيتحمّل…"));
  const q = $("memQ").value.trim(), cat = $("memCatF").value;
  const r = await api(`/api/panel/memories?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`);
  list.innerHTML = "";
  $("memCount").textContent = r.total ? r.total + " ذكرة" : "";
  if (!r.items.length) { list.appendChild(el("div", "hint", "مافيش ذكريات — احفظ واحدة فوق")); return; }
  r.items.forEach((m) => list.appendChild(memItem(m)));
}
function memItem(m) {
  const it = el("div", "item");
  const head = el("div", "head");
  head.appendChild(el("span", "badge cat-" + m.category, m.category));
  head.appendChild(el("span", "name", m.name));
  head.appendChild(el("span", "date", m.created_at || ""));
  it.appendChild(head);
  it.appendChild(el("div", "txt", m.note));
  const acts = el("div", "acts");
  const bEdit = el("button", "", "✏️ تعديل");
  const bDel = el("button", "danger", "🗑 حذف");
  bEdit.addEventListener("click", () => {
    const ta = el("textarea", "", m.note);
    ta.rows = 3;
    const bSave = el("button", "", "💾 حفظ");
    it.appendChild(ta);
    acts.replaceChild(bSave, bEdit);
    bSave.addEventListener("click", async () => {
      await put("/api/panel/memories/" + m.id, { note: ta.value });
      toast("اتعدل ✔"); loadMemories(); loadStats();
    });
  });
  bDel.addEventListener("click", async () => {
    if (!confirm("تحذف الذكرة دي عن " + m.name + "؟")) return;
    await del("/api/panel/memories/" + m.id);
    toast("اتحذفت"); loadMemories(); loadStats();
  });
  acts.appendChild(bEdit); acts.appendChild(bDel);
  it.appendChild(acts);
  return it;
}
$("memForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = $("mNote").value.trim();
  if (!note) { toast("اكتب الذكرة الأول"); return; }
  const r = await post("/api/panel/memories",
                       { name: $("mName").value.trim(), category: $("mCat").value, note });
  if (!r.ok) { toast(r.error || "فشل"); return; }
  toast("اتحفظت ✔"); $("mNote").value = ""; $("mName").value = "";
  loadMemories(); loadStats();
});
$("memQ").addEventListener("input", debounce(loadMemories, 350));
$("memCatF").addEventListener("change", loadMemories);

/* ═══════ الملاحظات ═══════ */
async function loadNotes() {
  const list = $("noteList");
  list.innerHTML = "";
  const q = $("noteQ").value.trim();
  const r = await api(`/api/panel/notes?q=${encodeURIComponent(q)}`);
  $("noteCount").textContent = r.total ? r.total + " ملاحظة" : "";
  if (!r.items.length) { list.appendChild(el("div", "hint", "مافيش ملاحظات لسه")); return; }
  r.items.forEach((n) => {
    const it = el("div", "item");
    const head = el("div", "head");
    head.appendChild(el("span", "badge", "ملاحظة"));
    head.appendChild(el("span", "name", n.title));
    head.appendChild(el("span", "date", n.created_at || ""));
    it.appendChild(head);
    it.appendChild(el("div", "txt", n.content));
    const acts = el("div", "acts");
    const bEdit = el("button", "", "✏️ تعديل");
    const bDel = el("button", "danger", "🗑 حذف");
    bEdit.addEventListener("click", () => {
      const ta = el("textarea", "", n.content); ta.rows = 3;
      const bSave = el("button", "", "💾 حفظ");
      it.appendChild(ta); acts.replaceChild(bSave, bEdit);
      bSave.addEventListener("click", async () => {
        await put("/api/panel/notes/" + n.id, { content: ta.value });
        toast("اتعدلت ✔"); loadNotes(); loadStats();
      });
    });
    bDel.addEventListener("click", async () => {
      if (!confirm("تحذف ملاحظة '" + n.title + "'؟")) return;
      await del("/api/panel/notes/" + n.id);
      toast("اتحذفت"); loadNotes(); loadStats();
    });
    acts.appendChild(bEdit); acts.appendChild(bDel);
    it.appendChild(acts);
    list.appendChild(it);
  });
}
$("noteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await post("/api/panel/notes",
                       { title: $("nTitle").value.trim(), content: $("nContent").value.trim() });
  if (!r.ok) { toast(r.error || "فشل"); return; }
  toast("اتحفظت ✔"); $("nTitle").value = ""; $("nContent").value = "";
  loadNotes(); loadStats();
});
$("noteQ").addEventListener("input", debounce(loadNotes, 350));

/* ═══════ الأشخاص ═══════ */
async function loadPeople() {
  const list = $("peopleList");
  list.innerHTML = "";
  list.appendChild(el("div", "hint", "بيتحمّل…"));
  const q = $("pQ").value.trim(), cat = $("pCatF").value;
  const r = await api(`/api/panel/people?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`);
  list.innerHTML = "";
  r.items.slice(0, 300).forEach((p) => {
    const it = el("div", "item");
    const head = el("div", "head");
    head.appendChild(el("span", "badge cat-" + p.category, p.category));
    head.appendChild(el("span", "name", p.name));
    if (p.mem_count > 0) head.appendChild(el("span", "badge mem", "🧠 " + p.mem_count + " ذكرة"));
    it.appendChild(head);
    if (p.source) it.appendChild(el("div", "src", p.source));
    list.appendChild(it);
  });
  if (!r.items.length) list.appendChild(el("div", "hint", "مافيش نتائج"));
}
$("pQ").addEventListener("input", debounce(loadPeople, 350));
$("pCatF").addEventListener("change", loadPeople);
$("btnRebuild2").addEventListener("click", rebuildPeople);

/* ═══════ المكتب ═══════ */
$("btnFiles").addEventListener("click", async () => {
  $("officeOut").textContent = "بيقرأ…";
  const r = await api("/api/panel/office/files");
  $("officeOut").textContent = r.text;
});
document.querySelectorAll(".of").forEach((b) =>
  b.addEventListener("click", async () => {
    $("officeOut").textContent = "بيقرأ " + b.dataset.f + "…";
    const r = await api("/api/panel/office/read?file=" + encodeURIComponent(b.dataset.f));
    $("officeOut").textContent = r.text;
  }));

/* ═══════ جوجل ═══════ */
function paintGoogle(g) {
  const c = $("gchip");
  if (g && g.connected) { c.className = "chip ok"; c.textContent = "☁︎ متصل"; }
  else { c.className = "chip warn"; c.textContent = "☁︎ غير متصل"; }
}
async function loadGoogleTab() {
  const st = await api("/api/panel/drive/status");
  paintGoogle(st);
  $("gState").textContent = st.connected ? "متصل ✔" : "مش متصل";
  $("gMail").textContent = st.email || "—";
  $("btnGConnect").disabled = !!st.connected;
  loadSheets(); loadDrive();
}
$("btnGConnect").addEventListener("click", async () => {
  const r = await post("/api/panel/drive/connect");
  toast(r.already ? "متصل من قبل" :
        (r.browser_opened ? "وافق على الكمبيوتر… ☝️" : "افتح الرابط على الكمبيوتر"), 5000);
});
async function loadDrive() {
  const out = $("dvOut");
  out.innerHTML = "";
  const p = $("dvPath").value.trim();
  const r = await api("/api/panel/drive/list?path=" + encodeURIComponent(p));
  if (!r.ok) { out.appendChild(el("div", "hint", r.error || "مش متصل")); return; }
  if (!r.items.length) { out.appendChild(el("div", "hint", "المجلد فاضي")); return; }
  r.items.forEach((name) => out.appendChild(el("div", "item", name)));
}
$("btnDvList").addEventListener("click", loadDrive);
async function loadSheets() {
  const out = $("shList");
  const r = await api("/api/panel/sheets");
  out.innerHTML = "";
  if (!r.items.length) { out.appendChild(el("div", "hint", "لسه مافيش شيتات")); return; }
  r.items.forEach((s) => {
    const it = el("div", "item");
    const head = el("div", "head");
    head.appendChild(el("span", "badge", "شيت"));
    head.appendChild(el("span", "name", s.title));
    head.appendChild(el("span", "date", s.created_at || ""));
    it.appendChild(head);
    out.appendChild(it);
  });
}
$("btnShCreate").addEventListener("click", async () => {
  const title = $("shTitle").value.trim();
  if (!title) { toast("اكتب اسم الشيت"); return; }
  const headers = $("shHeaders").value.split(",").map((s) => s.trim()).filter(Boolean);
  const r = await post("/api/panel/sheets", { title, headers: headers.length ? headers : null });
  toast(r.ok ? "الشيت اتعمل ✔" : (r.error || "فشل"), 3500);
  if (r.ok) { $("shTitle").value = ""; $("shHeaders").value = ""; loadSheets(); loadStats(); }
});
$("btnShRead").addEventListener("click", async () => {
  const t = $("shReadT").value.trim();
  if (!t) return;
  $("shOut").textContent = "بيقرأ…";
  const r = await api("/api/panel/sheets/read?title=" + encodeURIComponent(t));
  $("shOut").textContent = r.ok ? r.text : (r.error || "فشل");
});
$("btnShAppend").addEventListener("click", async () => {
  const t = $("shAppendT").value.trim();
  const row = $("shAppendR").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!t || !row.length) { toast("اكتب اسم الشيت + القيم"); return; }
  const r = await post("/api/panel/sheets/append", { title: t, row });
  toast(r.ok ? "السطر اتزود ✔" : (r.error || "فشل"), 3500);
  if (r.ok) $("shAppendR").value = "";
});

/* ═══════ نشاط حي (وضع الواقع) ═══════ */
const KIND_ICON = { system: "🔔", tool: "🔧", speak: "💬", memory: "🧠",
                    file: "📁", agent: "🤖", question: "❓", error: "⚠️" };
let brLastId = 0, brFeedCount = 0;

function brItem(it) {
  const d = el("div", "item");
  const head = el("div", "head");
  head.appendChild(el("span", "badge", (KIND_ICON[it.kind] || "🔔") + " " + (it.kind || "")));
  head.appendChild(el("span", "name", it.title || ""));
  head.appendChild(el("span", "date", it.ts || ""));
  d.appendChild(head);
  if (it.detail) d.appendChild(el("div", "txt", it.detail));
  return d;
}
function onBrActivity(it) {
  if (!it || (it.id && it.id <= brLastId)) return;
  if (it.id) brLastId = it.id;
  const feed = $("brainFeed");
  feed.insertBefore(brItem(it), feed.firstChild);
  brFeedCount++;
  if (brFeedCount > 240) feed.removeChild(feed.lastChild);
}
async function loadBrain() {
  $("brainFeed").innerHTML = "";
  brFeedCount = 0;
  try {
    const r = await api("/api/panel/activity?limit=120");
    (r.items || []).forEach(onBrActivity);   // الأحدث أولًا (مقلوب)
  } catch (e) {}
  await loadPendingQuestions();
  clearInterval(brainTimer);
  brainTimer = setInterval(async () => {
    try {
      const r = await api(`/api/panel/activity?since=${brLastId}&limit=100`);
      (r.items || []).reverse().forEach(onBrActivity);
    } catch (e) {}
  }, 3000);
}
async function loadPendingQuestions() {
  const box = $("qPanel");
  box.innerHTML = "";
  try {
    const r = await api("/api/panel/questions?pending=1");
    const items = r.items || [];
    $("qCount").textContent = items.length ? "❓ " + items.length + " سؤال بانتظارك" : "";
    items.forEach((q) => {
      const it = el("div", "item");
      const head = el("div", "head");
      head.appendChild(el("span", "badge", "❓ سؤال Hope"));
      head.appendChild(el("span", "date", q.ts || ""));
      it.appendChild(head);
      it.appendChild(el("div", "txt", q.question));
      const row = el("div", "toolbar");
      const inp = el("input", "");
      inp.placeholder = "الإجابة…";
      const btn = el("button", "btn small gold", "جاوب");
      let opts = [];
      try { opts = q.options ? JSON.parse(q.options) : []; } catch (e) {}
      opts.forEach((o) => {
        const ob = el("button", "btn small", o);
        ob.addEventListener("click", () => answerQ(q.id, o));
        row.appendChild(ob);
      });
      btn.addEventListener("click", () => answerQ(q.id, inp.value));
      row.appendChild(inp); row.appendChild(btn);
      it.appendChild(row);
      box.appendChild(it);
    });
  } catch (e) {}
}
async function answerQ(qid, text) {
  const t = (text || "").trim();
  if (!t) { toast("اكتب الإجابة"); return; }
  const r = await post(`/api/panel/questions/${qid}/answer`, { answer: t });
  if (r.ok) {
    toast("وصلت لـHope ✔" + (r.delivered_to_session ? " — بيجاوب دلوقتي" : ""));
    loadPendingQuestions();
  } else toast(r.error || "فشلت");
}
$("btnBrRefresh").addEventListener("click", loadBrain);

/* ═══════ مساحة العمل — ملفاته ═══════ */
async function loadWsFiles() {
  const list = $("wsFiles");
  list.innerHTML = "";
  try {
    const r = await api("/api/panel/workspace");
    (r.items || []).forEach((f) => {
      const it = el("div", "item");
      const head = el("div", "head");
      head.appendChild(el("span", "badge", f.folder === "مذكرات المشروع" ? "📝 ملاحظة" :
                                          f.folder.startsWith("ذكريات") ? "🧠 ذاكرة" :
                                          f.folder === "قوائم" ? "📊 قائمة" : "📄"));
      head.appendChild(el("span", "name", f.name.replace(/\.(md|csv|txt|xlsx)$/i, "")));
      head.appendChild(el("span", "date", f.size + "KB"));
      it.appendChild(head);
      it.style.cursor = "pointer";
      it.addEventListener("click", async () => {
        const rr = await api("/api/panel/workspace/read?path=" + encodeURIComponent(f.path));
        const v = $("wsView");
        v.classList.remove("hidden");
        v.textContent = rr.ok ? rr.text : (rr.error || "مش قادر أقرا الملف");
      });
      list.appendChild(it);
    });
    if (!list.childElementCount) list.appendChild(el("div", "hint", "لسه مافيش ملفات"));
  } catch (e) { toast("مش قادر أوصل مساحة العمل"); }
}

/* ═══════ السجل ═══════ */
async function loadLogs() {
  const list = $("logsList");
  const r = await api("/api/panel/logs?limit=40");
  list.innerHTML = "";
  if (!r.items.length) { list.appendChild(el("div", "hint", "السجل فاضي")); return; }
  r.items.forEach((l) => {
    const it = el("div", "item");
    const head = el("div", "head");
    head.appendChild(el("span", "badge", l.status || "—"));
    head.appendChild(el("span", "name", l.target || ""));
    head.appendChild(el("span", "date", l.ts || ""));
    it.appendChild(head);
    it.appendChild(el("div", "txt", l.detail || ""));
    list.appendChild(it);
  });
}

/* ═══════ مساعدات ═══════ */
function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ═══════ الإقلاع ═══════ */
async function start() {
  await loadStats();
  loadMemories(); loadPeople();
}
(async () => {
  if (!token) { showGate(); return; }
  try { await api("/api/panel/stats"); start(); }
  catch (e) { /* gate هيظهر من api */ }
})();

/* ═══════ الوصلات (Applets) ═══════ */
async function loadAppletsP() {
  const wrap = $("apListP");
  wrap.innerHTML = "";
  try {
    const r = await api("/api/applets");
    (r.items || []).forEach((a) => wrap.appendChild(apRowP(a)));
  } catch (e) { wrap.innerHTML = `<p class="hint">مش قادر أوصل الوصلات</p>`; }
}
function apRowP(a) {
  const box = document.createElement("div");
  box.className = "box";
  const row = document.createElement("div");
  row.className = "row";
  const nm = document.createElement("span");
  nm.textContent = a.icon + " " + a.name;
  const st = document.createElement("b");
  st.textContent = a.connected ? (a.kind === "builtin" ? "مدمج ✔" : "متصل ✔") : "مش متصل";
  st.style.color = a.connected ? "#7ee2a8" : "";
  row.appendChild(nm); row.appendChild(st);
  box.appendChild(row);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = a.desc + " — " + a.help;
  box.appendChild(hint);

  const btns = document.createElement("div");
  btns.className = "btn-row";
  const refresh = async (r) => { toast(r.message || ""); if (r.items) { const w = $("apListP"); w.innerHTML = ""; r.items.forEach((x) => w.appendChild(apRowP(x))); } };

  if (a.id === "google") {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = a.connected ? "📂 فتح درايف ↗" : "🔗 اتصل بجوجل";
    b.addEventListener("click", async () => {
      if (a.connected) { window.open("https://drive.google.com/drive/my-drive", "_blank"); return; }
      try { const r = await api("/api/google/auth"); toast(r.browser_opened ? "وافق على الكمبيوتر" : "افتح الرابط على الكمبيوتر", 5000); } catch (e) {}
    });
    btns.appendChild(b);

  } else if (a.id === "github") {
    if (a.connected) {
      const b = document.createElement("button");
      b.className = "btn small danger"; b.textContent = "افصل";
      b.addEventListener("click", async () => refresh(await post("/api/applets/github/disconnect")));
      btns.appendChild(b);
    } else {
      const inp = document.createElement("input");
      inp.type = "password"; inp.placeholder = "Personal Access Token من جيت هاب"; inp.style.flex = "1";
      const b = document.createElement("button");
      b.className = "btn small"; b.textContent = "اتصل";
      b.addEventListener("click", async () => {
        const pat = inp.value.trim();
        if (!pat) { toast("حط المفتاح"); return; }
        b.disabled = true; b.textContent = "بيفحص…";
        const r = await post("/api/applets/github/connect", { config: { pat } });
        b.disabled = false; b.textContent = "اتصل";
        if (!r.ok) inp.value = "";
        refresh(r);
      });
      btns.appendChild(inp); btns.appendChild(b);
    }

  } else if (a.id === "email") {
    if (a.connected) {
      const b = document.createElement("button");
      b.className = "btn small danger"; b.textContent = "افصل";
      b.addEventListener("click", async () => refresh(await post("/api/applets/email/disconnect")));
      btns.appendChild(b);
    } else {
      const cfg = {};
      [["host", "SMTP host"], ["port", "587"], ["user", "user"], ["password", "password"]].forEach(([k, ph]) => {
        const i = document.createElement("input");
        i.placeholder = ph; if (k === "password") i.type = "password"; if (k === "port") i.value = "587";
        i.addEventListener("input", () => cfg[k] = i.value.trim());
        btns.appendChild(i);
      });
      const b = document.createElement("button");
      b.className = "btn small"; b.textContent = "اتصل";
      b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "بيجرّب…";
        const r = await post("/api/applets/email/connect", { config: cfg });
        b.disabled = false; b.textContent = "اتصل";
        refresh(r);
      });
      btns.appendChild(b);
    }
  }

  if (btns.childElementCount) box.appendChild(btns);
  return box;
}
