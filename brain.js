/* ═══════════════════════════════════════════════════════════════
   brain.js — «مدينة هوب الحيّة»
   عقل هوب مرسوم كمدينة على خريطة جوجل: أحياء (مناطق)، أماكن (دبابيس)،
   شوارع تربط الأماكن، ونرڤات (بلاقيطات نور) بتنطّ على الشوارع ومعاها
   أوامر ومسافة ووقت وصول — و«هوب» نفسه نقطة ملاحّة بتتنقّل على الطريق
   لمكان هدفه، والخريطة نفسها بيتغيّر وهو بيتكلم (يضيف أماكن، يبني شوارع،
   يمسح القديم) — عشان تشوف وعيه وهو شغّال.
   ═══════════════════════════════════════════════════════════════ */
(() => {
  "use strict";
  const cv = document.getElementById("brainCv");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  let W = 0, H = 0, DPR = 1;
  let REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* ── فضاء الخريطة (نفس إحداثيات الأدوات: x -0.6..0.6 / y -0.55..0.55) ── */
  const UNIT_KM = 5.5;                 // كل وحدة خريطة = 5.5 كم (للعرض والمسافات)
  const cam = { zoom: 1, panX: 0, panY: 0, base: 500 };
  const fit = () => { cam.base = Math.min(W / 1.35, H / 1.22); };

  /* ── الأحياء (مناطق الخريطة — نفس ألوان الشريحة في index.html) ── */
  const REG = {
    front:    { cx:  0.00, cy: -0.30, color: "#4285f4", label: "مركز التحكم" },
    parietal: { cx:  0.33, cy: -0.10, color: "#7cb8ff", label: "أفعال ونتيجة" },
    occipital:{ cx: -0.33, cy: -0.14, color: "#3ddc84", label: "ذاكرة وملفات" },
    temporal: { cx:  0.31, cy:  0.22, color: "#c77dff", label: "صوت وكلام" },
    limbic:   { cx: -0.31, cy:  0.23, color: "#ff9d8a", label: "أسئلة وتعلّم" },
    stem:     { cx:  0.00, cy:  0.37, color: "#57d9e8", label: "اتصال وجوجل" },
  };
  const KIND2REG = { tool: "front", speak: "temporal", question: "limbic", error: "front",
                     agent: "front", memory: "occipital", file: "occipital", system: "stem",
                     web: "stem", task: "parietal", verify: "front" };
  const KIND2PLACE = { memory: "memory", file: "sheets", task: "tasks", web: "web",
                       question: "tasks", system: "home", agent: "agents", error: "config",
                       verify: "home", speak: "home", tool: "home" };
  const ORDER_BY_KIND = { tool: "تنفيذ أداة", speak: "تكلم مع المدير", question: "يسأل المدير",
                          error: "إصلاح خطأ", agent: "مساعد شغل", memory: "ذاكرته",
                          file: "ملفاته", system: "تشغيل النظام", web: "تصفح الويب",
                          task: "مهمة", verify: "تحقّق" };

  /* ── حالة المدينة ── */
  const marks = new Map();             // id → {x,y,label,icon,color,visible,core,hits,anim,dead}
  const roads = new Set();             // "a|b" (مرتّبة)
  const packets = [];                  // نرڤات على الشوارع
  const bursts = [];                   // دوائر وصول
  let thought = null, thoughtT = 0;
  let markSeq = 0;
  let mode = "idle", ampIn = 0, ampOut = 0;
  let hovered = null;

  const roadKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  function addRoad(a, b) { if (a && b && a !== b && marks.has(a) && marks.has(b)) roads.add(roadKey(a, b)); }
  function delRoad(a, b) { roads.delete(roadKey(a, b)); }

  /* ── هوب نفسه: نقطة ملاحّة على الطريق ── */
  const puck = { x: 0, y: -0.30, pts: [], seg: 0, prog: 0, order: "", dest: "", speed: 1.05, hits: 0 };

  /* ── إسقاط فضاء ↔ شاشة ── */
  function m2s(x, y) {
    const s = cam.base * cam.zoom;
    return { x: W / 2 + cam.panX + x * s, y: H / 2 + cam.panY + y * s };
  }
  function s2m(px, py) {
    const s = cam.base * cam.zoom || 1;
    return { x: (px - W / 2 - cam.panX) / s, y: (py - H / 2 - cam.panY) / s };
  }
  function regCenter(reg) {
    const R = REG[(reg || "").toLowerCase()];
    return R ? { x: R.cx, y: R.cy } : { x: 0, y: 0 };
  }

  /* ── المسار على الشوارع: أقصر طريق (Dijkstra صغير — الشبكة أقل من 40 عقدة) ── */
  const adj = new Map();               // id → [{to, w}]
  function buildAdj() {
    adj.clear();
    for (const id of marks.keys()) adj.set(id, []);
    for (const k of roads) {
      const [a, b] = k.split("|");
      const A = marks.get(a), B = marks.get(b);
      if (!A || !B || A.visible === false || B.visible === false) continue;
      const w = Math.hypot(A.x - B.x, A.y - B.y);
      adj.get(a).push({ to: b, w }); adj.get(b).push({ to: a, w });
    }
  }
  function nearestNode(x, y) {
    let best = null, bd = 1e9;
    for (const p of marks.values()) {
      if (p.visible === false) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  }
  function route(fromId, toId) {
    if (!fromId || !toId) return [];
    if (fromId === toId) return [toId];
    const dist = new Map(), prev = new Map(), seen = new Set();
    for (const id of adj.keys()) dist.set(id, Infinity);
    dist.set(fromId, 0);
    while (true) {
      let u = null, bd = Infinity;
      for (const [id, d] of dist) if (!seen.has(id) && d < bd) { bd = d; u = id; }
      if (u === null) break;
      if (u === toId) break;
      seen.add(u);
      for (const e of (adj.get(u) || [])) {
        const nd = dist.get(u) + e.w;
        if (nd < dist.get(e.to)) { dist.set(e.to, nd); prev.set(e.to, u); }
      }
    }
    if (!prev.has(toId) && fromId !== toId) return [];   // مافيش طريق
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) { cur = prev.get(cur); if (!cur) return []; path.unshift(cur); }
    return path;
  }
  const pathLen = (path) => {
    let L = 0;
    for (let i = 1; i < path.length; i++) {
      const a = marks.get(path[i - 1]), b = marks.get(path[i]);
      if (a && b) L += Math.hypot(a.x - b.x, a.y - b.y);
    }
    return L;
  };
  function pathAt(path, prog) {   // prog 0..1 على طول المسار → نقطة مап + المسافة الباقية
    let total = 0;
    const segs = [];
    for (let i = 1; i < path.length; i++) {
      const a = marks.get(path[i - 1]), b = marks.get(path[i]);
      if (!a || !b) continue;
      const w = Math.hypot(a.x - b.x, a.y - b.y);
      segs.push({ a, b, w }); total += w;
    }
    if (!segs.length) { const p = marks.get(path[0]) || { x: puck.x, y: puck.y }; return { x: p.x, y: p.y, left: 0 }; }
    let want = Math.max(0, Math.min(1, prog)) * total;
    for (const s of segs) {
      if (want <= s.w || s === segs[segs.length - 1]) {
        const t = s.w ? want / s.w : 1;
        return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t, left: total - want };
      }
      want -= s.w;
    }
    const last = marks.get(path[path.length - 1]);
    return { x: last.x, y: last.y, left: 0 };
  }

  /* ── مسافات بالعربي: 850 م / 2.3 كم + تقدير وقت ── */
  function fmtDist(km) {
    if (km < 0.001) return "وصل";
    if (km < 1) return Math.round(km * 1000) + " م";
    return (Math.round(km * 10) / 10) + " كم";
  }
  function fmtEta(km) {
    const min = (km / 35) * 60;                       // متوسط 35 كم/س داخل المكتب
    if (min < 1) return "أقل من دقيقة";
    if (min < 60) return "≈" + Math.round(min) + " دقيقة";
    return "≈" + Math.round(min / 60) + " ساعة";
  }

  /* ── لوحة الملاحة (شريط زي خرائط جوجل) ── */
  const nvEl = document.getElementById("navBar");
  const nvTarget = document.getElementById("nvTarget");
  const nvMeta = document.getElementById("nvMeta");
  const nvProg = document.getElementById("nvProg");
  const nvClose = document.getElementById("nvClose");
  const orderList = document.getElementById("orderList");
  let nvHideT = 0;
  function navShow(order, destLabel, km) {
    if (!nvEl) return;
    nvEl.classList.remove("hidden");
    nvEl.classList.remove("arrive");
    nvTarget.textContent = (order || "تنقّل") + " ← " + (destLabel || "");
    nvMeta.textContent = fmtDist(km) + " · " + fmtEta(km);
    if (nvProg) nvProg.style.width = "0%";
    nvHideT = 0;
    clearTimeout(nvEl._ht);
  }
  function navTick(prog, leftKm) {
    if (!nvEl || nvEl.classList.contains("hidden")) return;
    if (nvProg) nvProg.style.width = Math.round(prog * 100) + "%";
    if (nvMeta) nvMeta.textContent = fmtDist(leftKm) + " · " + fmtEta(leftKm);
  }
  function navArrive(destLabel) {
    if (!nvEl) return;
    nvEl.classList.add("arrive");
    nvTarget.textContent = "✔ وصل — " + (destLabel || "");
    nvMeta.textContent = "الهدف اتنفّذ";
    if (nvProg) nvProg.style.width = "100%";
    nvEl._ht = setTimeout(() => nvEl.classList.add("hidden"), 4200);
  }
  if (nvClose) nvClose.addEventListener("click", () => nvEl && nvEl.classList.add("hidden"));
  function pushOrder(label, km, done) {
    if (!orderList) return;
    const li = document.createElement("li");
    li.className = "ord" + (done ? " done" : "");
    li.innerHTML = `<b>${esc(label)}</b><span>${done ? "✔ " + fmtDist(km) : "→ " + fmtDist(km)}</span>`;
    orderList.prepend(li);
    while (orderList.children.length > 4) orderList.lastChild.remove();
    setTimeout(() => { li.classList.add("fade"); setTimeout(() => li.remove(), 900); }, 9000);
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ── نرڤ (بلاقيطة نور) بتنطّ على الشوارع ومعاها الطلب والمسافة ── */
  function spawnPacket(path, label, col, speed) {
    if (!path || path.length < 2) return null;
    const pk = { path, prog: 0, speed: speed || 1.5, label: String(label || "").slice(0, 42),
                 col: col || "#8ab4ff", born: performance.now() / 1000 };
    if (REDUCED) pk.prog = 0.999;                 // تقليل الحركة: تظهر عند الوجهة
    packets.push(pk);
    if (packets.length > 14) packets.shift();
    return pk;
  }
  function sendPacket(destId, order, kind) {
    const dest = marks.get(destId);
    if (!dest || dest.visible === false) return;
    buildAdjIfDirty();
    const fromId = nearestNode(puck.x, puck.y) || "home";
    const path = route(fromId, destId);
    if (path.length >= 2) spawnPacket(path, order, REG[KIND2REG[kind] || "front"].color);
    else { const p = spawnPacket([fromId, destId], order, "#8ab4ff"); if (!p) dropBurst(destId); }
  }

  /* ── الملاحّة: هوب بيتحرك شخصيًا للهدف (والأمر فوقه) ── */
  function puckNav(destId, order) {
    const dest = marks.get(destId);
    if (!dest || dest.visible === false) return false;
    buildAdjIfDirty();
    const fromId = nearestNode(puck.x, puck.y) || "home";
    const path = route(fromId, destId);
    if (!path.length && fromId !== destId) return false;   // مافيش طريق يصلح
    if (path.length < 2) {                                 // موجود عند الهدف أصلًا
      puck.path = []; puck.order = ""; puck.dest = "";
      dropBurst(destId); navArrive(dest.label);
      return true;
    }
    puck.path = path;
    puck.seg = 0; puck.prog = 0;
    puck.order = String(order || "تنقّل").slice(0, 42);
    puck.dest = destId;
    navShow(puck.order, dest.label, pathLen(puck.path) * UNIT_KM);
    return true;
  }
  function dropBurst(id) {
    const p = marks.get(id);
    if (!p) return;
    bursts.push({ x: p.x, y: p.y, t: 0, col: p.color || "#ffd166" });
    p.hits = (p.hits || 0) + 1;
    p.anim = Math.max(p.anim || 0, 0.7);
  }

  /* ── حدود الشبكة (بتتبخّر لو حد اتغيّر) ── */
  let adjDirty = true;
  const buildAdjIfDirty = () => { if (adjDirty) { buildAdj(); adjDirty = false; } };
  const touchAdj = () => { adjDirty = true; };

  /* ── تنبيه حيّة: كل نشاط = نبضة في الحي + نرڤ/أمير للهدف ── */
  function destFor(kind, label) {
    let best = null, bestLen = 0;
    const txt = String(label || "");
    for (const p of marks.values()) {
      if (p.visible === false || !p.label) continue;
      if (txt.includes(p.label) && p.label.length > bestLen) { best = p.id; bestLen = p.label.length; }
    }
    return best || KIND2PLACE[kind] || "home";
  }
  function pulseReg(reg, strong) {
    const R = REG[reg];
    if (!R) return;
    R.pulse = Math.max(R.pulse || 0, strong ? 1 : 0.55);
    const chip = document.querySelector(`#regionLegend .lchip[data-reg="${reg}"]`);
    if (chip) {
      chip.classList.remove("fire"); void chip.offsetWidth; chip.classList.add("fire");
      clearTimeout(chip._ft);
      chip._ft = setTimeout(() => chip.classList.remove("fire"), 800);
    }
  }
  function fire(kind, n, label) {
    const reg = KIND2REG[kind] || "front";
    pulseReg(reg, kind === "error");
    const destId = destFor(kind, label);
    const order = (label && String(label).trim()) || ORDER_BY_KIND[kind] || "شغله";
    if (marks.has(destId)) {
      sendPacket(destId, order, kind);            // نرڤ سريع يوصل الأمر
      puckNav(destId, order);                     // وهوب نفسه يتنقّل له (الطلب الحالي)
    }
  }
  function fireRegionBtn(reg) {
    const R = REG[reg];
    if (!R) return;
    pulseReg(reg, true);
    const here = [];
    for (const p of marks.values()) {
      if (p.visible === false) continue;
      if (Math.hypot(p.x - R.cx, p.y - R.cy) < 0.22) here.push(p);
    }
    if (here.length) {
      const target = here[(Math.random() * here.length) | 0];
      sendPacket(target.id, "استكشاف " + R.label, null);
    }
  }

  /* ═══════ وعيه بعقله: أوامر جاية من السيرفر (WS type:"brain") ═══════ */
  function view(m) {
    if (!m) return;
    const a = (m.a || "").toLowerCase();
    if (a === "clear") {                       // يمسح كل اللي اترسم — والأماكن الأساسية تفضل
      for (const p of marks.values()) if (!p.core) p.dead = 1;
      for (const k of [...roads]) { const [x, y] = k.split("|"); if (!(marks.get(x) || {}).core || !(marks.get(y) || {}).core) roads.delete(k); }
      thought = null; touchAdj(); return;
    }
    if (a === "think") {
      if (m.text) { thought = { text: String(m.text) }; thoughtT = performance.now() / 1000; }
      return;
    }
    if (a === "road") { addRoad(m.id, m.to); touchAdj(); return; }
    if (a === "unroad") { delRoad(m.id, m.to); touchAdj(); return; }
    if (a === "navigate") { puckNav(m.id, m.order || m.text || "تنقّل"); return; }

    let id = m.id || "";
    if (a === "place") {
      if (!id) id = "mk" + (++markSeq);
      let x = (typeof m.x === "number") ? m.x : null;
      let y = (typeof m.y === "number") ? m.y : null;
      if (x === null || y === null) { const c = regCenter(m.region); x = c.x + (Math.random() - 0.5) * 0.06; y = c.y + (Math.random() - 0.5) * 0.05; }
      const old = marks.get(id);
      marks.set(id, Object.assign(old || {}, {
        id, x, y, label: m.label || (old && old.label) || id, icon: m.icon || (old && old.icon) || "📍",
        color: m.color || (old && old.color) || "#ffd166", visible: m.visible !== false,
        core: (old && old.core) || !!m.core, anim: old ? 0.35 : 1,
      }));
      touchAdj(); return;
    }
    const mk = marks.get(id);
    if (!mk) return;
    if (a === "move") {
      if (typeof m.x === "number") mk.x = m.x;
      if (typeof m.y === "number") mk.y = m.y;
      if (m.region && typeof m.x !== "number") { const c = regCenter(m.region); mk.x = c.x; mk.y = c.y; }
      touchAdj();
    } else if (a === "label") { if (m.label) mk.label = m.label; }
    else if (a === "icon") { if (m.icon) mk.icon = m.icon; }
    else if (a === "hide") { mk.visible = false; touchAdj(); }
    else if (a === "show") { mk.visible = true; touchAdj(); }
    else if (a === "erase") { mk.dead = 1; for (const k of [...roads]) if (k.split("|").includes(id)) roads.delete(k); touchAdj(); return; }
    if (m.color) mk.color = m.color;
  }

  /* ── تحميل خريطة كاملة (من /api/brainview عند فتح أي شاشة) ── */
  function loadMap(bv) {
    if (!bv) return;
    marks.clear(); roads.clear(); packets.length = 0;
    for (const [id, v] of Object.entries(bv.marks || {})) {
      marks.set(id, Object.assign({ id, hits: 0, anim: 0.5 }, v));
    }
    for (const r of (bv.roads || [])) { if (Array.isArray(r) && r.length >= 2) roads.add(roadKey(r[0], r[1])); }
    if (bv.pos && typeof bv.pos.x === "number") { puck.x = bv.pos.x; puck.y = bv.pos.y; }
    thought = bv.thought ? { text: String(bv.thought) } : null;
    touchAdj();
    if (bv.nav && bv.nav.to) puckNav(bv.nav.to, bv.nav.order || "متابعة");
  }

  /* ── تفاعل: سحب/تقريب/لمس ── */
  const ptrs = new Map();
  let dragging = false, lastPX = 0, lastPY = 0, pinchD = 0, tap0 = null;
  cv.style.touchAction = "none";
  function markAt(mx, my) {
    let best = null, hd = 30;
    for (const p of marks.values()) {
      if (p.visible === false) continue;
      const s = m2s(p.x, p.y);
      const d = Math.hypot(s.x - mx, s.y - my - 8);
      if (d < hd) { hd = d; best = p; }
    }
    return best;
  }
  /* لمس علامة (مكتب/ذاكرة/ملفات…) = يفتح الشاشة المرتبطة بيها */
  function openMark(p) {
    if (!p) return;
    puckNav(p.id, "فتح " + (p.label || ""));
    dropBurst(p.id);
    if (typeof window.hopeOpenMark === "function") {
      try { window.hopeOpenMark(p.id, p.label || ""); } catch (err) { /* شاشة مش جاهزة */ }
    }
  }
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = true; lastPX = e.clientX; lastPY = e.clientY;
    if (ptrs.size === 1) tap0 = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
  });
  cv.addEventListener("pointermove", (e) => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [p1, p2] = [...ptrs.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchD) zoomAt((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, d / pinchD);
      pinchD = d; return;
    }
    if (dragging) {
      cam.panX += e.clientX - lastPX; cam.panY += e.clientY - lastPY;
      lastPX = e.clientX; lastPY = e.clientY;
    }
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    hovered = markAt(mx, my);
    cv.style.cursor = hovered ? "pointer" : "grab";
  });
  const endPtr = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinchD = 0;
    if (!ptrs.size) dragging = false;
    /* لمسة قصيرة (مش سحب) على علامة → يفتح وجهتها */
    if (tap0 && tap0.id === e.pointerId) {
      const moved = Math.hypot(e.clientX - tap0.x, e.clientY - tap0.y);
      if (moved < 12 && Date.now() - tap0.t < 700) {
        const r = cv.getBoundingClientRect();
        const p = markAt(e.clientX - r.left, e.clientY - r.top);
        if (p) openMark(p);
      }
      tap0 = null;
    }
  };
  cv.addEventListener("pointerup", endPtr);
  cv.addEventListener("pointercancel", endPtr);
  cv.addEventListener("pointerleave", () => { hovered = null; }, { passive: true });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0012));
  }, { passive: false });
  function zoomAt(px, py, k) {
    const before = s2m(px, py);
    cam.zoom = Math.max(0.55, Math.min(3.4, cam.zoom * k));
    const after = m2s(before.x, before.y);
    cam.panX += px - after.x; cam.panY += py - after.y;
  }

  /* ── الرسم ── */
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.75);
    W = cv.clientWidth || window.innerWidth;
    H = cv.clientHeight || window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    fit();
  }

  /* ── الخريطة القديمة: نجوم + شبكة عصبية عضوية ── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let STARS = null;
  function buildStars() {
    const rnd = mulberry32(777);
    const cols = ["#cfe0ff", "#ffe9c9", "#d6fff0", "#ffd6e7"];
    STARS = [];
    for (let i = 0; i < 190; i++) {
      STARS.push({
        x: (rnd() * 2 - 1) * 0.85, y: (rnd() * 2 - 1) * 0.72,
        r: 0.6 + rnd() * 1.25, ph: rnd() * 6.28, sp: 0.4 + rnd() * 1.4,
        c: cols[(rnd() * cols.length) | 0],
      });
    }
  }

  let MESH = null, MESH_E = null;
  function buildMesh() {
    if (MESH) return;
    const rnd = mulberry32(20261021);
    const hubs = Object.values(REG).map((R) =>
      ({ x: R.cx, y: R.cy, color: R.color }));
    const nodes = [];
    for (const h of hubs) {
      for (let i = 0; i < 11; i++) {           // عقد حوالين كل حي
        const ang = rnd() * Math.PI * 2;
        const rr = Math.abs(rnd() + rnd() - 1) * 0.21;
        nodes.push({ x: h.x + Math.cos(ang) * rr * 1.2, y: h.y + Math.sin(ang) * rr,
                     color: h.color, flash: 0, ph: rnd() * 6.28, sp: 0.5 + rnd() });
      }
    }
    for (let i = 0; i < 34; i++) {             // عقد متناثرة في القلب
      const ang = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
      nodes.push({ x: Math.cos(ang) * rr * 0.58, y: Math.sin(ang) * rr * 0.5,
                   color: "#8fb6ff", flash: 0, ph: rnd() * 6.28, sp: 0.5 + rnd() });
    }
    MESH = nodes;
    const edges = new Set();                   // أقرب جارين لكل عقدة (شبكة عضوية)
    nodes.forEach((n, i) => {
      const near = nodes.map((m, j) =>
        ({ j, d: (m.x - n.x) * (m.x - n.x) + (m.y - n.y) * (m.y - n.y) }))
        .filter((o) => o.j !== i)
        .sort((a, b) => a.d - b.d).slice(0, 2);
      near.forEach((o) => edges.add(Math.min(i, o.j) + "|" + Math.max(i, o.j)));
    });
    MESH_E = [...edges].map((k) => k.split("|").map(Number));
  }

  function drawBg(t) {
    if (!STARS) buildStars();
    const g = ctx.createRadialGradient(W * 0.5, H * 0.4, 30, W * 0.5, H * 0.5,
                                        Math.max(W, H) * 0.8);
    g.addColorStop(0, "#11143a"); g.addColorStop(0.55, "#0a0d24");
    g.addColorStop(1, "#04050d");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // سديم ملوّن خفيف (بنفسجي/أزرق/وردي) — نفس روح الخريطة القديمة
    const neb = [
      { x: 0.30, y: 0.34, c: "rgba(96,84,200,0.17)", r: 0.50 },
      { x: 0.74, y: 0.63, c: "rgba(40,120,190,0.14)", r: 0.55 },
      { x: 0.56, y: 0.24, c: "rgba(150,70,160,0.11)", r: 0.45 },
    ];
    for (const n of neb) {
      const rg = ctx.createRadialGradient(n.x * W, n.y * H, 10, n.x * W, n.y * H,
                                          n.r * Math.max(W, H));
      rg.addColorStop(0, n.c); rg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    }
    // نجوم بتلألأ — في فضاء الماب (بتمشي مع السحب والتقريب)
    for (const st of STARS) {
      const p = m2s(st.x, st.y);
      if (p.x < -8 || p.x > W + 8 || p.y < -8 || p.y > H + 8) continue;
      const tw = REDUCED ? 0.7 : 0.45 + 0.55 * Math.sin(t * st.sp + st.ph);
      ctx.fillStyle = st.c;
      ctx.globalAlpha = 0.25 + tw * 0.65;
      ctx.beginPath(); ctx.arc(p.x, p.y, st.r * (0.75 + tw * 0.5), 0, Math.PI * 2);
      ctx.fill();
      if (st.r > 1.5 && tw > 0.8) {            // نجمة لامعة: صليب خفيف
        ctx.globalAlpha = Math.min(1, (tw - 0.8) * 2.4);
        ctx.strokeStyle = st.c; ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(p.x - 4.5, p.y); ctx.lineTo(p.x + 4.5, p.y);
        ctx.moveTo(p.x, p.y - 4.5); ctx.lineTo(p.x, p.y + 4.5);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* الشبكة العصبية: عقد مضيئة بخيوط رفيعة — وتحرق لما تمرّ عليها حركة هوب */
  function drawMesh(t, dt) {
    buildMesh();
    const movers = [];
    for (const pk of packets) {
      if (pk.path && pk.path.length > 1) movers.push(pathAt(pk.path, pk.prog));
    }
    if (puck.path && puck.path.length >= 1) movers.push({ x: puck.x, y: puck.y });
    const lit = 0.052;
    for (const n of MESH) {
      for (const m of movers) {
        const dx = n.x - m.x, dy = n.y - m.y;
        if (dx * dx + dy * dy < lit * lit) { n.flash = 1; break; }
      }
      if (n.flash > 0) n.flash = Math.max(0, n.flash - dt * 2.3);
    }
    ctx.lineWidth = 1;
    for (const e of MESH_E) {
      const a = MESH[e[0]], b = MESH[e[1]];
      if (!a || !b) continue;
      const p = m2s(a.x, a.y), q = m2s(b.x, b.y);
      if ((p.x < -40 && q.x < -40) || (p.x > W + 40 && q.x > W + 40) ||
          (p.y < -40 && q.y < -40) || (p.y > H + 40 && q.y > H + 40)) continue;
      const fl = Math.max(a.flash, b.flash);
      ctx.strokeStyle = hexA(a.color === b.color ? a.color : "#9db8ff",
                             0.085 + fl * 0.42);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    for (const n of MESH) {
      const p = m2s(n.x, n.y);
      if (p.x < -12 || p.x > W + 12 || p.y < -12 || p.y > H + 12) continue;
      const tw = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(t * n.sp + n.ph);
      const a = 0.26 + tw * 0.3 + n.flash * 0.5;
      if (n.flash > 0.05) { ctx.shadowColor = n.color; ctx.shadowBlur = 7 * n.flash; }
      ctx.fillStyle = hexA(n.color, Math.min(1, a));
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2 + tw * 0.7 + n.flash * 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawDistricts(t) {
    const s = cam.base * cam.zoom;
    ctx.save();
    ctx.textAlign = "center"; ctx.direction = "rtl";
    for (const [k, R] of Object.entries(REG)) {
      const c = m2s(R.cx, R.cy);
      const rad = 0.34 * s;
      const g = ctx.createRadialGradient(c.x, c.y, rad * 0.06, c.x, c.y, rad);
      const a = 0.085 + (R.pulse || 0) * 0.18;
      g.addColorStop(0, hexA(R.color, a)); g.addColorStop(1, hexA(R.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, rad, 0, Math.PI * 2); ctx.fill();
      if (R.pulse) R.pulse = Math.max(0, R.pulse - t * 0.9);
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillStyle = hexA(R.color, 0.36);
      ctx.fillText(R.label, c.x, c.y - rad * 0.72);
    }
    ctx.restore();
  }
  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function drawRoads(t) {
    for (const k of roads) {
      const [a, b] = k.split("|");
      const A = marks.get(a), B = marks.get(b);
      if (!A || !B || A.visible === false || B.visible === false || A.dead || B.dead) continue;
      const p1 = m2s(A.x, A.y), p2 = m2s(B.x, B.y);
      ctx.lineCap = "round";
      // خيط عصبي مضيء (بدل الشارع الغامق) — الوظيفة نفسها: مسار مفتوح للتنقّل
      const col = A.color || "#8fb6ff";
      ctx.strokeStyle = hexA(col, 0.42);
      ctx.lineWidth = Math.max(1.8, 2.4 * Math.min(cam.zoom, 1.6));
      ctx.shadowColor = col; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      ctx.shadowBlur = 0;
      if (!REDUCED) {                         // تدفّق ضوء خفيف على الخيط
        ctx.strokeStyle = hexA(col, 0.55); ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 14]); ctx.lineDashOffset = -((t * 30) % 17);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function drawPins(t) {
    ctx.textAlign = "center"; ctx.direction = "rtl";
    for (const p of marks.values()) {
      if (p.visible === false) continue;
      if (p.dead) { p.anim = (p.anim || 0) - 0.04; if (p.anim <= 0) { marks.delete(p.id); touchAdj(); continue; } }
      const s = m2s(p.x, p.y);
      const drop = p.anim ? (p.anim = Math.max(0, p.anim - 0.02), 1 + p.anim * 0.6) : 1;
      const hov = hovered === p ? 1.14 : 1;
      const sc = drop * hov;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.scale(sc, sc);
      const col = p.color || "#ffd166";
      // هالات الزيارة
      if (p.hits && !REDUCED) {
        const ph = (t * 0.9 + p.hits * 0.37) % 1;
        ctx.strokeStyle = hexA(col, (1 - ph) * 0.35); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(0, 0, 12 + ph * 14, 0, Math.PI * 2); ctx.stroke();
      }
      // العقدة المضيئة (روح الخريطة القديمة — بدل دبوس جوجل)
      const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, 16);
      halo.addColorStop(0, hexA(col, 0.5)); halo.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = col; ctx.shadowBlur = 11;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, 5.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(0, 0, 2.1, 0, Math.PI * 2); ctx.fill();
      // لافتة الاسم (حبّة زي الخريطة القديمة: إيموجي + الاسم)
      ctx.font = (hovered === p ? "700" : "600") + " 12px system-ui, sans-serif";
      const lab = (p.icon || "📍") + " " + (p.label || p.id);
      const tw = ctx.measureText(lab).width + 16;
      roundRect(-tw / 2, 10, tw, 20, 10);
      ctx.fillStyle = "rgba(16,20,44,0.86)"; ctx.fill();
      ctx.strokeStyle = hexA(col, 0.6); ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#eef2ff"; ctx.fillText(lab, 0, 24);
      if (hovered === p && (p.hits || 0) > 0) {
        ctx.font = "10px system-ui, sans-serif"; ctx.fillStyle = hexA(col, 0.9);
        ctx.fillText(p.hits + " زيارة", 0, 46);
      }
      ctx.restore();
    }
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawPacket(pk, t) {
    if (!pk.path || pk.path.length < 2) return;
    const pos = pathAt(pk.path, pk.prog);
    const a = m2s(pk.path && pos.x, pos.y);
    // شهاب: ذيل أطول بتدرّج + نواة بيضا + رأس مضيء
    const tail = pathAt(pk.path, Math.max(0, pk.prog - 0.17));
    const b = m2s(tail.x, tail.y);
    const g = ctx.createLinearGradient(b.x, b.y, a.x, a.y);
    g.addColorStop(0, hexA(pk.col, 0)); g.addColorStop(1, hexA(pk.col, 0.92));
    ctx.strokeStyle = g; ctx.lineWidth = 3.2; ctx.lineCap = "round";
    ctx.shadowColor = pk.col; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke();
    const head = ctx.createRadialGradient(a.x, a.y, 0.5, a.x, a.y, 7);
    head.addColorStop(0, "rgba(255,255,255,0.95)");
    head.addColorStop(0.4, hexA(pk.col, 0.75)); head.addColorStop(1, hexA(pk.col, 0));
    ctx.fillStyle = head;
    ctx.beginPath(); ctx.arc(a.x, a.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(a.x, a.y, 2.4, 0, Math.PI * 2); ctx.fill();
    // لافتة الأمر + المسافة الباقية
    if (pk.label) {
      const km = pos.left * UNIT_KM;
      const txt = pk.label + " · " + fmtDist(km);
      ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.direction = "rtl";
      const tw = ctx.measureText(txt).width + 14;
      roundRect(a.x - tw / 2, a.y - 26, tw, 17, 8);
      ctx.fillStyle = "rgba(10,14,26,0.9)"; ctx.fill();
      ctx.strokeStyle = hexA(pk.col, 0.7); ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#eaf0ff"; ctx.fillText(txt, a.x, a.y - 14);
    }
  }

  function drawPuck(t) {
    // خط الطريق المتبقي (شريط ملاحة أزرق زي خرائط جوجل)
    if (puck.path && puck.path.length >= 2) {
      ctx.save();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      let started = false;
      let prev = m2s(puck.x, puck.y);
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y);
      for (let i = puck.seg + 1; i < puck.path.length; i++) {
        const n = marks.get(puck.path[i]); if (!n) continue;
        const q = m2s(n.x, n.y); ctx.lineTo(q.x, q.y); started = true;
      }
      if (started) {
        ctx.strokeStyle = "rgba(66,133,244,0.20)"; ctx.lineWidth = 8;
        ctx.stroke();
        ctx.strokeStyle = "rgba(96,165,250,0.85)"; ctx.lineWidth = 3.4;
        ctx.setLineDash(REDUCED ? [] : [10, 8]);
        ctx.lineDashOffset = REDUCED ? 0 : -((t * 30) % 18);
        ctx.shadowColor = "#4285f4"; ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.setLineDash([]); ctx.shadowBlur = 0;
      }
      ctx.restore();
    }
    // نقطة هوب
    const s = m2s(puck.x, puck.y);
    const pulse = REDUCED ? 0 : Math.sin(t * 3.2) * 0.5 + 0.5;
    const g = ctx.createRadialGradient(s.x, s.y, 1, s.x, s.y, 16 + pulse * 5);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.35, "rgba(122,180,255,0.85)");
    g.addColorStop(1, "rgba(66,133,244,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, 17 + pulse * 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(s.x, s.y, 4.2, 0, Math.PI * 2); ctx.fill();
    if (!REDUCED) {
      ctx.strokeStyle = `rgba(140,190,255,${0.5 - pulse * 0.3})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(s.x, s.y, 10 + pulse * 12, 0, Math.PI * 2); ctx.stroke();
    }
    // لافتة هوب
    ctx.font = "700 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.direction = "rtl";
    const lbl = puck.order ? "هوب · " + puck.order : "هوب";
    const tw = ctx.measureText(lbl).width + 14;
    roundRect(s.x - tw / 2, s.y - 40, tw, 18, 9);
    const lg = ctx.createLinearGradient(s.x - tw / 2, 0, s.x + tw / 2, 0);
    lg.addColorStop(0, "#1a73e8"); lg.addColorStop(1, "#34a853");
    ctx.fillStyle = lg; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(lbl, s.x, s.y - 27);
  }

  function drawBursts(dt) {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.t += dt * 1.6;
      if (b.t >= 1) { bursts.splice(i, 1); continue; }
      const s = m2s(b.x, b.y);
      ctx.strokeStyle = hexA(b.col, (1 - b.t) * 0.8);
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(s.x, s.y, 6 + b.t * 26, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawThought(t) {
    if (!thought) return;
    const age = t - thoughtT;
    if (age > 14) { thought = null; return; }
    const a = age < 0.4 ? age / 0.4 : age > 12 ? Math.max(0, (14 - age) / 2) : 1;
    ctx.save();
    ctx.font = "600 13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.direction = "rtl";
    const maxW = Math.min(W * 0.7, 460);
    let txt = thought.text;
    if (ctx.measureText(txt).width > maxW - 30) {
      while (txt.length > 6 && ctx.measureText(txt + "…").width > maxW - 30) txt = txt.slice(0, -1);
      txt += "…";
    }
    const tw = Math.min(maxW, ctx.measureText(txt).width + 34);
    const x = W / 2 - tw / 2, y = H - 74;
    ctx.globalAlpha = a;
    roundRect(x, y, tw, 34, 17);
    ctx.fillStyle = "rgba(12,17,32,0.88)"; ctx.fill();
    ctx.strokeStyle = "rgba(122,180,255,0.4)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#dce8ff";
    ctx.fillText("💭 " + txt, W / 2, y + 22);
    ctx.restore();
  }

  /* ── المرور الهامشي (المدينة حيّة حتى وهو ساكت) ── */
  let ambT = 0;
  const AMBIENT = ["مزامنة ذاكرة", "مراجعة ملاحظات", "فحص المهام", "تحديث الحالة", "ترتيب ملفات"];
  function ambient(dt) {
    if (REDUCED || document.hidden) return;
    ambT += dt * (mode === "thinking" ? 2.2 : mode === "idle" ? 0.55 : 1);
    if (ambT < 6.5) return;
    ambT = 0;
    const vis = [...marks.values()].filter((p) => p.visible !== false && !p.dead);
    if (vis.length < 2) return;
    const a = vis[(Math.random() * vis.length) | 0];
    let b = vis[(Math.random() * vis.length) | 0];
    if (a === b) b = vis[(vis.indexOf(a) + 1) % vis.length];
    buildAdjIfDirty();
    const path = route(a.id, b.id);
    if (path.length >= 2) spawnPacket(path, AMBIENT[(Math.random() * AMBIENT.length) | 0], "rgba(140,170,230,0.9)", 0.85);
  }

  /* ── الحلقة ── */
  let raf = 0, lastT = 0;
  function boost() {
    if (mode === "listening") return 0.25 + ampIn * 1.5;
    if (mode === "speaking") return 0.3 + ampOut * 1.6;
    if (mode === "thinking") return 0.55;
    return 0.2;
  }
  function step(now) {
    raf = requestAnimationFrame(step);
    if (document.hidden || !W) { lastT = now; return; }
    const dt = Math.min(0.05, (now - (lastT || now)) / 1000);
    lastT = now;
    const t = now / 1000;
    ampIn *= Math.pow(0.25, dt); ampOut *= Math.pow(0.25, dt);
    const B = boost();

    // حركة النرڤات
    for (let i = packets.length - 1; i >= 0; i--) {
      const pk = packets[i];
      const total = pathLen(pk.path) || 0.01;
      pk.prog += (pk.speed * B * dt) / (total * 6);
      if (pk.prog >= 1) {
        const destId = pk.path[pk.path.length - 1];
        dropBurst(destId);
        packets.splice(i, 1);
      }
    }
    // حركة هوب
    if (puck.path && puck.path.length >= 2) {
      const segA = marks.get(puck.path[puck.seg]), segB = marks.get(puck.path[puck.seg + 1]);
      if (segA && segB) {
        const w = Math.hypot(segB.x - segA.x, segB.y - segA.y) || 0.01;
        puck.prog += (puck.speed * dt) / (w * 3.2);
        puck.x = segA.x + (segB.x - segA.x) * Math.min(1, puck.prog);
        puck.y = segA.y + (segB.y - segA.y) * Math.min(1, puck.prog);
        // الملاحّة على الشاشة
        const total = pathLen(puck.path);
        let doneW = 0;
        for (let i = 0; i < puck.seg; i++) {
          const a = marks.get(puck.path[i]), b = marks.get(puck.path[i + 1]);
          if (a && b) doneW += Math.hypot(b.x - a.x, b.y - a.y);
        }
        doneW += w * Math.min(1, puck.prog);
        navTick(total ? doneW / total : 1, Math.max(0, total - doneW) * UNIT_KM);
        if (puck.prog >= 1) {
          puck.seg++; puck.prog = 0;
          if (puck.seg >= puck.path.length - 1) {
            const destId = puck.path[puck.path.length - 1];
            const dest = marks.get(destId);
            dropBurst(destId);
            navArrive(dest ? dest.label : "");
            pushOrder(puck.order || "تنقّل", (pathLen(puck.path) || 0) * UNIT_KM, true);
            puck.path = []; puck.order = "";
          }
        }
      } else { puck.path = []; }
    }
    ambient(dt);

    /* رسم */
    ctx.clearRect(0, 0, W, H);
    drawBg(t);
    drawDistricts(dt);
    drawMesh(t, dt);
    drawRoads(t);
    drawPins(t);
    for (const pk of packets) drawPacket(pk, t);
    drawBursts(dt);
    drawPuck(t);
    drawThought(t);
  }

  /* ── الواجهة العامة لـ app.js ── */
  const api = {
    setMode(m) { mode = m; },
    setAmp(which, v) { if (which === "in") ampIn = Math.max(v, ampIn * 0.9); else ampOut = Math.max(v, ampOut * 0.9); },
    fire, fireRegion: fireRegionBtn,
    travel(fromReg, pinId, label) {          // لمتطلبات خاصة: نرڤ من حيّ لعلامة
      const c = regCenter(fromReg);
      buildAdjIfDirty();
      const fromId = nearestNode(c.x, c.y);
      const path = fromId && pinId ? route(fromId, pinId) : [];
      if (path.length >= 2) spawnPacket(path, label, "#8ab4ff");
      else if (marks.has(pinId)) dropBurst(pinId);
    },
    view,                                   // هوب يغيّر خريطة عقله بنفسه
    think(txt) { if (txt) { thought = { text: String(txt) }; thoughtT = performance.now() / 1000; } },
    loadMap,                                // تحميل الخريطة كاملة من السيرفر
    nav(destId, order) { puckNav(destId, order); },
    _setReduced(v) { REDUCED = !!v; },
    ready() {                               // ترحيب: نبضات أحياء + نرڤات ترحيب
      ["front", "limbic", "temporal", "parietal", "occipital", "stem"].forEach((r, i) =>
        setTimeout(() => fireRegionBtn(r), i * 150));
      setTimeout(() => { puckNav("memory", "أهلًا يا بيه 👋"); }, 420);
      setTimeout(() => { puckNav("sheets", "جاهز للشغل"); }, 1400);
      if (nvEl) {
        nvEl.classList.remove("hidden");
        nvTarget.textContent = "🏁 جاهز يا بيه";
        nvMeta.textContent = "المدينة شغّالة — كل حاجة تحت أمرك";
        nvEl._ht = setTimeout(() => nvEl.classList.add("hidden"), 3800);
      }
    },
    _dbg() {
      return { travels: packets.length, pins: marks.size, roads: roads.size,
               marks: marks.size, thought: thought ? thought.text : null,
               yaw: 0, last: puck.order || (packets.length ? packets[packets.length - 1].label : null) };
    },
    _map() {
      return { marks: [...marks.values()].map((p) => ({ id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), label: p.label })),
               roads: [...roads], puck: { x: +puck.x.toFixed(3), y: +puck.y.toFixed(3), order: puck.order } };
    },
  };
  window.Brain = api;

  /* ── تشغيل ── */
  resize();
  window.addEventListener("resize", () => { resize(); }, { passive: true });
  document.addEventListener("visibilitychange", () => { lastT = 0; });
  const lb = document.querySelectorAll("#regionLegend .lchip");
  lb.forEach((b) => b.addEventListener("click", () => fireRegionBtn(b.dataset.reg)));
  // مدينة أساسية فورية (قبل ما تجي الخريطة من السيرفر — عشان الشاشة ما تبقاش فاضية)
  if (!marks.size) {
    const seed = [
      ["home", "المكتب", "🏢", "front", 0.02, -0.31],
      ["tasks", "المهام", "📌", "front", 0.15, -0.23],
      ["agents", "المساعدين", "🤖", "front", -0.12, -0.24],
      ["config", "الإعدادات", "⚙︎", "front", 0.16, -0.38],
      ["suppliers", "الموردين", "🚚", "parietal", 0.30, -0.19],
      ["workers", "العمال", "👷", "parietal", 0.40, -0.04],
      ["sheets", "ملفات 2026", "🗂", "occipital", -0.30, -0.21],
      ["notes", "ملاحظات", "📝", "occipital", -0.42, -0.08],
      ["memory", "الذاكرة", "🧠", "occipital", -0.22, -0.07],
      ["wa", "واتساب", "💬", "stem", -0.13, 0.35],
      ["im", "الماسنجر", "🗨", "stem", 0.10, 0.35],
      ["web", "المتصفح", "🌐", "stem", -0.01, 0.45],
      ["drive", "جوجل درايف", "☁︎", "stem", 0.22, 0.30],
    ];
    for (const [id, label, icon, reg, x, y] of seed) {
      marks.set(id, { id, label, icon, reg, x, y, color: REG[reg].color, visible: true, core: true, hits: 0, anim: 0 });
    }
    [["home", "tasks"], ["home", "agents"], ["home", "config"], ["home", "memory"],
     ["home", "sheets"], ["home", "notes"], ["home", "wa"], ["home", "im"],
     ["home", "web"], ["home", "drive"], ["home", "suppliers"], ["suppliers", "workers"],
     ["sheets", "memory"], ["notes", "sheets"], ["wa", "im"], ["tasks", "suppliers"],
     ["web", "drive"]].forEach(([a, b]) => roads.add(roadKey(a, b)));
    touchAdj();
  }
  raf = requestAnimationFrame(step);
})();
