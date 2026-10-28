/* ═══════════════════════════════════════════════════════════
   ondevice.js — موديل جوجل (Gemma) جوّه المتصفح نفسه:
   أوفلاين تمامًا لما السيرفر يقطع (الواي فاي فصل / اللاب مقفول).
   أول مرة بس يحتاج إنترنت عشان ينزّل الموديل ويتحطّ في
   التخزين بتاع المتصفح (مرة واحدة ~0.7-2.9GB حسب الموديل).
   من بعدها: صفر إنترنت، صفر اشتراك، بياناتك ما بتخرجش من الجهاز.
   المكتبة بتتحمّل بس لما المستخدم يفعّلها (في أول نداء على
   الويب) — ومافيش أي تأثير على بقية التطبيق لو مفعّلتش.
   ═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const LIBS = [
    "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm",
    "https://esm.run/@mlc-ai/web-llm@0.2.86",
  ];

  const OD = (window.OD = {
    state: "off",            // off | loading | ready | error
    model: localStorage.getItem("odModel") || "gemma-4-E2B-it-q4f16_1-MLC",
    progress: 0,
    err: "",
    engine: null,
    webllm: null,
  });

  function render() {
    const el = $("odStatus");
    if (el) el.textContent = statusText();
    const pw = $("odProgressWrap"), pb = $("odProgress");
    if (pw && pb) {
      pw.classList.toggle("hidden", OD.state !== "loading");
      pb.style.width = Math.round(OD.progress * 100) + "%";
    }
  }

  function statusText() {
    if (OD.state === "ready")
      return "✔ جاهز — " + OD.model + " (بيشتغل من غير إنترنت خالص)";
    if (OD.state === "loading")
      return "⏳ بينزّل/بيتحضّر… " + Math.round(OD.progress * 100) + "% (مرة واحدة بس)";
    if (OD.state === "error")
      return "✘ " + (OD.err || "مش متاح على الجهاز ده");
    return navigator.gpu
      ? "— مش مفعّل — WebGPU موجود وجاهز ✔"
      : "— مش متاح: المتصفح ده مافيش فيه WebGPU (جرّب Chrome/Edge أحدث)";
  }

  async function loadLib() {
    if (OD.webllm) return OD.webllm;
    let last = null;
    for (const url of LIBS) {
      try {
        OD.webllm = await import(/* @vite-ignore */ url);
        if (OD.webllm && OD.webllm.CreateMLCEngine) return OD.webllm;
      } catch (e) { last = e; }
    }
    throw last || new Error("مقدرتش أحمّل مكتبة الموديل (محتاج إنترنت أول مرة)");
  }

  async function enable() {
    if (OD.state === "loading") return;
    const msg = $("odMsg");
    if (msg) msg.textContent = "";
    if (!navigator.gpu) {
      OD.state = "error";
      OD.err = "المتصفح ده مافيش فيه WebGPU — جرّب Chrome أو Edge أحدث.";
      render();
      return;
    }
    OD.state = "loading"; OD.progress = 0; OD.err = ""; render();
    try {
      const webllm = await loadLib();
      const list = (webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list) || [];
      const rec = list.find((m) => m.model_id === OD.model) || list[0];
      if (!rec) throw new Error("قائمة الموديلات فاضية");
      OD.model = rec.model_id;
      localStorage.setItem("odModel", OD.model);
      OD.engine = await webllm.CreateMLCEngine(rec.model_id, {
        initProgressCallback: (r) => { OD.progress = r.progress || 0; render(); },
      });
      OD.state = "ready"; render();
      if (msg)
        msg.textContent = "تمام ✔ من دلوقتي لو السيرفر قطع، الردود بتيجي من على الجهاز.";
      window.dispatchEvent(new CustomEvent("od:ready"));
    } catch (e) {
      OD.state = "error";
      OD.err = String((e && e.message) || e).slice(0, 170);
      OD.engine = null;
      render();
      if (msg)
        msg.textContent = "✘ فشل: " + OD.err +
          " — جرّب موديل أخف من القائمة (أو تأكد إن النت شغال أول مرة).";
    }
  }

  function disable() {
    try { if (OD.engine && OD.engine.unload) OD.engine.unload(); } catch (e) {}
    OD.engine = null; OD.state = "off"; OD.progress = 0; render();
    const msg = $("odMsg");
    if (msg) msg.textContent = "اتقفل ✔ (التنزيل موجود لسه — تقدر تفعّله تاني بضغطة).";
  }

  /* ردّ محلي — نفس شخصية هوب، من غير أي سيرفر */
  async function chat(system, text, maxTokens) {
    if (OD.state !== "ready" || !OD.engine)
      throw new Error("الموديل المحلي مش جاهز");
    const q = await OD.engine.chat.completions.create({
      messages: [{ role: "system", content: system || "" },
                 { role: "user", content: text }],
      stream: false,
      max_tokens: maxTokens || 300,
      temperature: 0.7,
    });
    return ((q.choices && q.choices[0] && q.choices[0].message &&
             q.choices[0].message.content) || "").trim();
  }

  OD.enable = enable;
  OD.disable = disable;
  OD.chat = chat;
  OD.render = render;

  document.addEventListener("DOMContentLoaded", () => {
    if (!$("odBox")) return;
    if ($("odModel")) $("odModel").value = OD.model;
    const th = $("odToggle");
    if (th) th.addEventListener("click", () => {
      const hid = $("odBox").classList.toggle("hidden");
      th.textContent = hid ? "عرض ▾" : "إخفاء ▴";
      if (!hid) render();
    });
    if ($("odOn")) $("odOn").addEventListener("click", enable);
    if ($("odOff")) $("odOff").addEventListener("click", disable);
    if ($("odModel")) $("odModel").addEventListener("change", (e) => {
      OD.model = e.target.value;
      localStorage.setItem("odModel", OD.model);
      if (OD.state === "ready") {
        const msg = $("odMsg");
        if (msg)
          msg.textContent = "غيّرت الموديل — دوس «تنزيل وتفعيل» تاني عشان يحمّل الجديد.";
      } else render();
    });
    render();
  });
})();
