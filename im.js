/* ═══════════════════════════════════════════════════════════
   im.js — Business Messages: دخول برقم تليفون + محادثات العمل
   + مصنع مساعدات الشغل. نفس دماغ هوب — بس جوّه تطبيق رسائل
   ═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const IM = (window.IM = {});
  let me = null;
  let imTok = localStorage.getItem("imToken") || "";
  let curChat = 0;
  let chats = [];
  let pollT = null;

  /* ── fetch خاص بمحادثات التطبيق (بوابة الرمز + جلسة المستخدم) ── */
  async function apiU(path, opts = {}) {
    opts.headers = Object.assign(
      { "X-Token": localStorage.getItem("atefToken") || "",
        "X-User": imTok },
      opts.headers || {});
    const r = await fetch(path, opts);
    let j = {};
    try { j = await r.json(); } catch (e) {}
    return Object.assign({ st: r.status }, j);
  }

  /* ═══ شاشات ═══ */
  function view(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("on"));
    const el = $("view-" + name);
    if (el) el.classList.add("on");
    document.querySelectorAll("#nav button").forEach((b) =>
      b.classList.toggle("on", b.dataset.v === name));
    if (name === "chats") loadChats();
    if (name === "agents") loadFactory();
    // إيقاف استطلاع المحادثة لما نخرج منها
    if (name !== "chat" && pollT) { clearInterval(pollT); pollT = null; }
  }
  document.querySelectorAll("#nav button").forEach((b) =>
    b.addEventListener("click", () => view(b.dataset.v)));

  /* ═══ دخول بكلمة السر الوحيدة ═══ */
  function showLogin() {
    $("login").classList.remove("hidden");
    $("lgTitle").textContent = "تسجيل الدخول";
    $("lgSub").textContent = "كلمة السر بس — الدخول محلي على جهازك بس 🔒";
    setTimeout(() => { try { $("lgPass").focus(); } catch (e) {} }, 60);
  }
  function loginErr(msg) { $("lgErr").textContent = msg || ""; }
  function enterWith(r) {
    imTok = r.token; me = r.user;
    localStorage.setItem("imToken", imTok);
    enterApp();
  }
  async function loginWith(pass) {
    const r = await apiU("/api/auth/login",
      { method: "POST", body: JSON.stringify({ password: pass }) });
    if (r.st === 200 && r.token) { enterWith(r); return true; }
    return false;
  }
  $("lgMain").addEventListener("click", async () => {
    loginErr("");
    const pass = $("lgPass").value.trim();
    if (!pass) { loginErr("اكتب كلمة السر"); return; }
    try {
      if (await loginWith(pass)) return;
      loginErr("كلمة السر غلط");
    } catch (e) { loginErr("السيرفر مش متاح"); }
  });
  $("lgPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("lgMain").click();
  });

  function enterApp() {
    $("login").classList.add("hidden");
    $("imMe").textContent = (me.name || "") + (me.role === "owner" ? " 👑" : "");
    $("imNewGroup").classList.toggle("hidden", me.role !== "owner");
    const uh = $("usrHead");
    if (uh) uh.classList.toggle("hidden", me.role !== "owner");
    view("chats");
  }

  /* ═══ المستخدمون (لوحة المدير: عمال + صندوق OTP محلي) ═══ */
  let usrLoaded = false;
  async function loadUsers(force) {
    if (!me || me.role !== "owner") return;
    if (!force && usrLoaded) return;
    const r = await apiU("/api/users");
    if (r.st !== 200) return;
    usrLoaded = true;
    const box = $("usrList");
    box.innerHTML = "";
    (r.items || []).forEach((u) => {
      const row = document.createElement("div");
      row.className = "usr-row";
      const info = document.createElement("div");
      info.className = "usr-info";
      const b = document.createElement("b");
      b.textContent = (u.name || "") + (u.role === "owner" ? " 👑" : "");
      const s = document.createElement("span");
      s.textContent = u.phone + (u.has_pin ? " · PIN ✔" : " · بدون PIN");
      info.appendChild(b); info.appendChild(s);
      row.appendChild(info);
      const sel = document.createElement("select");
      ["full", "self", "basic", "none"].forEach((lv) => {
        const o = document.createElement("option");
        o.value = lv; o.textContent = lv;
        sel.appendChild(o);
      });
      sel.value = u.access || "self";
      sel.addEventListener("change", async () => {
        const rr = await apiU(`/api/users/${u.id}/access`,
          { method: "POST", body: JSON.stringify({ level: sel.value }) });
        $("usrMsg").textContent = rr.ok
          ? `صلاحية «${u.name || u.phone}» → ${sel.value} ✔`
          : (rr.message || "حصل خطأ");
      });
      row.appendChild(sel);
      const del = document.createElement("button");
      del.className = "mini"; del.type = "button"; del.textContent = "🗑";
      del.addEventListener("click", async () => {
        if (u.role === "owner") {
          $("usrMsg").textContent = "صاحب الجهاز ما يتمسحش 👑";
          return;
        }
        if (!window.confirm(`تمسح «${u.name || u.phone}»؟ هيفقد دخوله.`)) return;
        const rr = await apiU(`/api/users/${u.id}`, { method: "DELETE" });
        if (rr.ok) { $("usrMsg").textContent = "اتمسح ✔"; loadUsers(true); }
        else $("usrMsg").textContent = rr.message || "حصل خطأ";
      });
      row.appendChild(del);
      box.appendChild(row);
    });
    // صندوق OTP المحلي (الكود بيوصل للمدير هنا بدل الـSMS)
    const ob = $("usrOtps");
    const otps = (r.otps || []).filter((o) => o && o.code);
    ob.innerHTML = "";
    if (otps.length) {
      const h = document.createElement("div");
      h.textContent = "📩 أحدث أكواد الدخول (بتيجي للمدير بس):";
      ob.appendChild(h);
      otps.slice(0, 5).forEach((o) => {
        const d = document.createElement("div");
        d.className = "usr-otp";
        const mins = Math.max(1, Math.round(((o.exp || 0) - Date.now() / 1000) / 60));
        d.textContent = `${o.phone} ← ${o.code}   (صالح ${mins} دقيقة)`;
        ob.appendChild(d);
      });
    }
  }
  IM.loadUsers = loadUsers;
  $("usrToggle").addEventListener("click", () => {
    const box = $("usrBox");
    box.classList.toggle("hidden");
    if (!box.classList.contains("hidden")) loadUsers(true);
  });
  $("usrRefresh").addEventListener("click", () => loadUsers(true));
  $("usrAdd").addEventListener("click", async () => {
    const phone = $("usrPhone").value.trim();
    const name = $("usrName").value.trim();
    const pin = $("usrPin").value.trim();
    const access = $("usrAccess").value;
    if (!phone) { $("usrMsg").textContent = "اكتب رقم التليفون"; return; }
    const r = await apiU("/api/users", { method: "POST",
      body: JSON.stringify({ phone, name, pin, access }) });
    if (r.ok) {
      $("usrMsg").textContent =
        `اتضاف «${r.user.name || phone}» ✔ — يدخل من تليفونه بالرقم والـPIN`;
      $("usrPhone").value = ""; $("usrName").value = ""; $("usrPin").value = "";
      loadUsers(true);
    } else $("usrMsg").textContent = r.message || "حصل خطأ";
  });

  /* ═══ قائمة المحادثات (ستايل واتساب) ═══ */
  async function loadChats() {
    if (!me) return;
    const r = await apiU("/api/im/chats");
    if (r.st !== 200) {
      if (r.st === 401) { me = null; imTok = ""; localStorage.removeItem("imToken"); showLogin(); }
      return;
    }
    chats = r.items || [];
    const box = $("imList");
    box.innerHTML = "";
    if (!chats.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.style.padding = "18px";
      p.textContent = "مافيش محادثات لسه — اتكلم مع هوب من تبويب «تكلّم» 🎙";
      box.appendChild(p);
    }
    chats.forEach((c) => {
      const d = document.createElement("div");
      d.className = "chat-item";
      const av = document.createElement("div");
      av.className = "ci-av"; av.textContent = c.icon || "🌤";
      const main = document.createElement("div");
      main.className = "ci-main";
      const top = document.createElement("div");
      top.className = "ci-top";
      const b = document.createElement("b"); b.textContent = c.title || "محادثة";
      const tm = document.createElement("span");
      tm.className = "ci-time"; tm.textContent = (c.last_ts || "").slice(5, 16);
      top.appendChild(b); top.appendChild(tm);
      if (c.unread) {
        const em = document.createElement("em");
        em.className = "badge"; em.textContent = c.unread;
        top.appendChild(em);
      }
      const last = document.createElement("div");
      last.className = "ci-last";
      last.textContent = (c.last_kind === "voice" ? "🎤 " :
                          c.last_kind === "location" ? "📍 " : "") +
                         (c.last_body || "…");
      main.appendChild(top); main.appendChild(last);
      d.appendChild(av); d.appendChild(main);
      d.addEventListener("click", () => openChat(c.id, c));
      box.appendChild(d);
    });
    const total = chats.reduce((s, c) => s + (c.unread || 0), 0);
    const nb = $("navUnread");
    if (nb) { nb.textContent = total; nb.classList.toggle("hidden", !total); }
  }

  /* ═══ شاشة المحادثة ═══ */
  async function openChat(cid, info) {
    curChat = cid;
    const c = info || chats.find((x) => x.id === cid) || {};
    $("imChatName").textContent = c.title || "محادثة";
    $("imChatAv").textContent = c.icon || "🌤";
    $("imChatSub").textContent =
      c.kind === "agent" ? (c.specialty || "مساعد شغل") :
      c.kind === "group" ? "جروب شغل — هوب عضو فيه" : "Hope · مساعدك الصوتي";
    view("chat");
    await loadMsgs();
    if (pollT) clearInterval(pollT);
    pollT = setInterval(() => {
      if (document.hasFocus() && curChat) loadMsgs();
    }, 9000);
  }
  IM.openChat = openChat;

  async function loadMsgs() {
    if (!curChat) return;
    const r = await apiU(`/api/im/chats/${curChat}/messages`);
    if (r.st !== 200) return;
    const box = $("imMsgs");
    box.innerHTML = "";
    (r.items || []).forEach((m) => box.appendChild(bubble(m)));
    box.scrollTop = box.scrollHeight;
  }
  function bubble(m) {
    const mine = !!(m.sender_id && me && m.sender_id === me.id);
    const d = document.createElement("div");
    d.className = "bub " + (mine ? "mine" : "theirs") + " k-" + (m.kind || "text");
    let pre = "";
    if (m.kind === "voice") pre = '<div class="bub-voice">🎤 رسالة صوتية</div>';
    else if (m.kind === "location") pre = '<div class="bub-loc">📍 مشارك على الخريطة 🗺</div>';
    d.innerHTML = pre + '<div class="bub-body"></div><span class="bub-ts"></span>';
    d.querySelector(".bub-body").textContent = m.body || "";
    d.querySelector(".bub-ts").textContent = (m.ts || "").slice(11);
    return d;
  }
  $("imBack").addEventListener("click", () => view("chats"));

  async function sendIm() {
    const t = $("imText").value.trim();
    if (!t || !curChat) return;
    $("imText").value = "";
    const box = $("imMsgs");
    const pend = document.createElement("div");
    pend.className = "bub mine";
    pend.innerHTML = '<div class="bub-body"></div><span class="bub-ts">…</span>';
    pend.querySelector(".bub-body").textContent = t;
    box.appendChild(pend); box.scrollTop = box.scrollHeight;
    let r = null, netFail = false;
    try {
      r = await apiU(`/api/im/chats/${curChat}/send`,
        { method: "POST", body: JSON.stringify({ body: t }) });
    } catch (e) { netFail = true; }     // السيرفر مش وصل خالص (قطع النت/الجهاز)
    // وسيط الشبكة (بروكسي/بوابة) ممكن يرد 502/503/504 بدل ما يرمي خطأ —
    // دي كمان معناها السيرفر مش متاح → ندخل الوضع الأوفلاين
    if (!netFail && r && [502, 503, 504].includes(r.st)) netFail = true;
    if (!netFail && r && r.st === 200) { loadMsgs(); return; }
    if (netFail) {
      // ── الوضع الأوفلاين: موديل جوجل على الجهاز نفسه ──
      if (window.OD && OD.state === "ready") {
        pend.querySelector(".bub-ts").textContent = "🔧";
        try {
          const out = await OD.chat(
            'انت "Hope" (هوب) — محاسب مكتب محجر حجر الفلتو بالعريش. ' +
            "ردودك قصيرة جدًا بالمصري البسيط، من غير رموز أو تنسيق، " +
            "وكلها عن شغل المكتب والمحاسبة.", t, 260);
          if (out) {
            pend.classList.add("od");
            pend.querySelector(".bub-body").textContent = out;
            pend.querySelector(".bub-ts").textContent = "🔧 من على الجهاز";
            toast("السيرفر مقطوع — الردّ جه من موديل جوجل المحلي");
            box.scrollTop = box.scrollHeight;
            return;
          }
          throw new Error("فارغ");
        } catch (e) {
          pend.querySelector(".bub-ts").textContent = "✕";
          toast("السيرفر مقطوع والموديل المحلي فشل — جرّب تاني");
          box.scrollTop = box.scrollHeight;
          return;
        }
      }
      pend.querySelector(".bub-ts").textContent = "✕";
      toast(window.OD && OD.state === "loading"
        ? "السيرفر مقطوع والموديل المحلي لسه بينزّل…"
        : "السيرفر مش متاح — تقدر تفعّل موديل على الجهاز من الإعدادات 📱");
      $("imText").value = t;          // نرجّع النص عشان ما يضيعش
      box.scrollTop = box.scrollHeight;
      return;
    }
    toast(r.message || "مقدرتش ابعت");
    $("imText").value = t;
    loadMsgs();
  }
  $("imSend").addEventListener("click", sendIm);
  $("imText").addEventListener("keydown", (e) => { if (e.key === "Enter") sendIm(); });

  /* ── مشاركة الموقع ── */
  $("imLoc").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("الجهاز ما بيدعمش الموقع"); return; }
    toast("بنجيب موقعك…");
    navigator.geolocation.getCurrentPosition(async (p) => {
      const r = await apiU(`/api/im/chats/${curChat}/location`,
        { method: "POST",
          body: JSON.stringify({ lat: p.coords.latitude, lng: p.coords.longitude }) });
      toast(r.ok ? "اتشارك الموقع ✔" : (r.message || "حصل خطأ"));
      loadMsgs();
    }, () => toast("مافيش إذن موقع — فعّله من الإعدادات 🔐"),
       { enableHighAccuracy: true, timeout: 15000 });
  });

  /* ── رسالة صوتية (تسجيل → ترانسكريبشن → ردّ) ── */
  let rec = null, recStream = null, recChunks = [];
  $("imRec").addEventListener("click", async () => {
    if (rec) { rec.stop(); return; }
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      const mime = (window.MediaRecorder &&
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
        ? "audio/webm;codecs=opus" : "";
      rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : {});
      rec.ondataavailable = (e) => recChunks.push(e.data);
      rec.onstop = async () => {
        try { recStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        const blob = new Blob(recChunks, { type: rec.mimeType || "audio/webm" });
        rec = null;
        $("imRec").classList.remove("rec");
        toast("بيبعت الصوت — ممكن ياخد شوية…");
        try {
          const r = await fetch(`/api/im/chats/${curChat}/voice`, {
            method: "POST",
            headers: { "X-Token": localStorage.getItem("atefToken") || "",
                       "X-User": imTok,
                       "Content-Type": blob.type || "audio/webm" },
            body: blob });
          let j = {};
          try { j = await r.json(); } catch (e) {}
          toast(j.message || (r.ok ? "اتبعت ✔" : "حصل خطأ"));
          loadMsgs();
        } catch (e) { toast("مقدرتش ابعت الصوت"); }
      };
      rec.start();
      $("imRec").classList.add("rec");
      toast("🎤 بيسجّل — اضغط تاني عشان تبعت");
    } catch (e) { toast("مافيش إذن ميكروفون 🔐"); }
  });

  /* ═══ المصنع: قوالب جاهزة + بناء مساعدك ═══ */
  async function loadFactory() {
    if (!me) return;
    const r = await apiU("/api/agents/factory");
    const g = $("agTemplates");
    if (r.st !== 200) {
      g.innerHTML = '<p class="hint">' + (r.message || "ادخل برقمك الأول") + "</p>";
      return;
    }
    g.innerHTML = "";
    (r.templates || []).forEach((t) => {
      const d = document.createElement("div");
      d.className = "ag-card";
      d.innerHTML = '<div class="ag-ic"></div><b></b><span class="ag-spec"></span>' +
                    '<button class="mini" type="button"></button>';
      d.querySelector(".ag-ic").textContent = t.icon;
      d.querySelector("b").textContent = t.name;
      d.querySelector(".ag-spec").textContent = t.specialty;
      const btn = d.querySelector("button");
      btn.textContent = t.built ? "افتح محادثته 💬" : "اتبع وابدأ ▸";
      if (t.built) btn.classList.add("gold");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          if (!t.built) {
            const br = await apiU("/api/agents/build",
              { method: "POST", body: JSON.stringify({ template_id: t.id }) });
            if (br.st !== 200) { toast(br.message || "حصل خطأ"); btn.disabled = false; return; }
            toast(br.message);
            if (br.chat) IM.openChat(br.chat.id, br.chat);
            return;
          }
          const or = await apiU(`/api/im/agents/${t.agent_id}/open`, { method: "POST" });
          if (or.chat) IM.openChat(or.chat.id, or.chat);
        } catch (e) { btn.disabled = false; }
      });
      g.appendChild(d);
    });
    // مهارات البناء
    const sk = $("agSkills");
    sk.innerHTML = "";
    (r.skills || []).forEach((s) => {
      const l = document.createElement("label");
      l.className = "ag-skill";
      l.innerHTML = '<input type="checkbox" /> <i></i> <b></b>';
      l.querySelector("input").value = s.id;
      l.querySelector("i").textContent = s.icon;
      l.querySelector("b").textContent = s.name;
      sk.appendChild(l);
    });
    $("agBuildBox").classList.toggle("hidden", me.role !== "owner");
  }
  $("agCreate").addEventListener("click", async () => {
    const name = $("agvName").value.trim();
    if (!name) { toast("اكتب اسم المساعد أولًا"); return; }
    const skills = [...document.querySelectorAll("#agSkills input:checked")]
      .map((i) => i.value);
    const r = await apiU("/api/agents/build", { method: "POST",
      body: JSON.stringify({ name, job_desc: $("agJob").value.trim(), skills }) });
    toast(r.message || (r.ok ? "اتعمل ✔" : "حصل خطأ"));
    if (r.ok) {
      $("agvName").value = ""; $("agJob").value = "";
      document.querySelectorAll("#agSkills input").forEach((i) => i.checked = false);
      if (r.chat) IM.openChat(r.chat.id, r.chat);
    }
  });

  /* ═══ جروب شغل جديد (للمدير) ═══ */
  $("imNewGroup").addEventListener("click", async () => {
    const r = await apiU("/api/users");
    if (r.st !== 200) { toast("للمدير بس"); return; }
    const others = (r.items || []).filter((u) => u.id !== (me && me.id));
    if (!others.length) { toast("ضيف عمال الأول من الإعدادات 👥"); return; }
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = '<div class="gate-card"><h3>جروب جديد 👥</h3>' +
      '<input id="gmTitle" type="text" placeholder="اسم الجروب (مثال: عمالة المحجر)" />' +
      '<div id="gmUsers" class="ag-skills"></div>' +
      '<div class="btn-row"><button id="gmOk" class="btn-gold" type="button">إنشاء ✔</button>' +
      '<button id="gmNo" class="mini" type="button">إلغاء</button></div></div>';
    document.body.appendChild(ov);
    const ul = ov.querySelector("#gmUsers");
    others.forEach((u) => {
      const l = document.createElement("label");
      l.className = "ag-skill";
      l.innerHTML = '<input type="checkbox" /> <b></b>';
      l.querySelector("input").value = u.id;
      l.querySelector("b").textContent = (u.name || "عامل") + " · " + u.phone;
      ul.appendChild(l);
    });
    ov.querySelector("#gmNo").addEventListener("click", () => ov.remove());
    ov.querySelector("#gmOk").addEventListener("click", async () => {
      const title = ov.querySelector("#gmTitle").value.trim();
      const members = [...ov.querySelectorAll("input:checked")]
        .map((i) => +i.value);
      const rr = await apiU("/api/im/group",
        { method: "POST", body: JSON.stringify({ title, members }) });
      ov.remove();
      if (rr.ok) { toast("الجروب اتعمل ✔ — هوب عضو فيه"); loadChats(); }
      else toast(rr.message || "حصل خطأ");
    });
  });

  /* ═══ أحداث WS الحيّة (رسائل جديدة من السيرفر/المساعد) ═══ */
  IM.onEvent = (m) => {
    if (!m || !me) return;
    if (m.event !== "msg") return;
    const open = $("view-chat").classList.contains("on") && m.chat_id === curChat;
    if (open) loadMsgs();
    else loadChats();
    const msg = m.msg || {};
    if (msg.sender_id && msg.sender_id === me.id) return;   // رسالتي
    if (document.hidden && window.notifyPhone) {
      const c = chats.find((x) => x.id === m.chat_id) || {};
      notifyPhone("💬 " + (c.title || "رسالة جديدة"), (msg.body || "").slice(0, 90));
    }
  };

  /* ═══ الإقلاع: نستنى البوابة تخلص → جلسة محفوظة أو دخول ═══ */
  async function boot() {
    // الترحيب الأول ممكن يكون فاتح — مستنيه يتقفل
    const wel = $("welcome");
    if (wel && !wel.classList.contains("hidden")) {
      setTimeout(boot, 800); return;
    }
    if (imTok) {
      const r = await apiU("/api/auth/me");
      if (r.st === 200 && r.user) { me = r.user; enterApp(); return; }
      imTok = ""; localStorage.removeItem("imToken");
    }
    // دخول صامت بنفس كلمة السر بتاعة البوابة — من غير أي شاشة تانية
    const gp = localStorage.getItem("atefToken") || "";
    if (gp) {
      try {
        const r = await apiU("/api/auth/login", { method: "POST",
          body: JSON.stringify({ password: gp }) });
        if (r.st === 200 && r.token) return enterWith(r);
      } catch (e) {}
    }
    showLogin();
  }
  window.addEventListener("bm:ready", () => boot());
  // احتياط: لو الحدث فات (الصفحة كانت جاهزة قبلك)
  setTimeout(() => { if (!me && $("login").classList.contains("hidden") &&
                    $("gate").classList.contains("hidden")) boot(); }, 3500);
})();
