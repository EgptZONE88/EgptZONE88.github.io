/* ═══════════════════════════════════════════════════════
   offline.js — عقل Hope الأوفلاين (على التليفون نفسه)
   زي "الذكاء المجاني الأوفلاين" اللي جوجل نزلته (Gemini Nano):
   ─ لو المتصفح داعم (أندرويد كروم) → بنستخدم النموذج المدمج
     المجاني اللي جوه التليفون (Prompt API / Gemini Nano).
   ─ وإلا → عقل محلي بيشتغل من مخ التليفون (IndexedDB): ذكريات +
     ملاحظات + منطق بسيط — يردّ عليك دايمًا حتى من غير نت.
   الشخصية واحدة مع الأونلاين: Hope، محاسب المحجر، مصرية بسيطة.
   ═══════════════════════════════════════════════════════ */
"use strict";

const Offline = (() => {
  const PERSONA = `انت "Hope" — محاسب مصري بسيط وودود في محجر حجر الفلتو (العريش).
صاحب الشغل: محمد سليمان علي — ناديه «يا بشمهندس محمد» (متقولش «يا بيه» أبدًا).
العملة: جنيه مصري.
ردودك: من جملة لـ3 جمل، لهجة مصرية بسيطة ومفهومة، بدون markdown ولا نجوم.
انت شغال أوفلاين دلوقتي على مخ التليفون — لو محتاج معلومة مش محفوظة قول بوضوح
إنها هتتحقن أول ما الاتصال يرجع، ومتخترعش أرقام أبدًا.`;

  let session = null;        // جلسة النموذج المدمج (Gemini Nano)
  let mode = "none";         // nano | local
  let ready = false;

  /* ── كشف النموذج المدمج المجاني (Prompt API / Gemini Nano) ── */
  function nanoAvailable() {
    return !!(navigator.languageModel ||
              (window.ai && window.ai.languageModel));
  }

  async function ensure() {
    if (ready) return mode;
    // 1) النموذج المدمج المجاني (أندرويد كروم — أوفلاين)
    try {
      const api = navigator.languageModel ||
                  (window.ai && window.ai.languageModel);
      if (api) {
        session = await api.create({
          systemPrompt: PERSONA,
          initialPrompts: [{ role: "user", parts: [{ text: "مستعد؟" }],
                             responsePrompt: { role: "assistant", parts: [{ text: "تمام يا بشمهندس محمد." }] } }],
          temperature: 0.6, topK: 3,
        });
        mode = "nano"; ready = true;
        return mode;
      }
    } catch (e) { session = null; }

    // 2) عقل محلي من مخ التليفون (دائمًا متاح)
    mode = "local"; ready = true;
    return mode;
  }

  /* ── البحث في مخ التليفون عن سياق يساعد الرد ── */
  async function localContext(q) {
    const bits = [];
    try {
      const mem = await Store.searchMemories(q, 6);
      if (mem.length) {
        bits.push("ذكريات محفوظة:");
        mem.forEach((m) => bits.push(`- ${m.name} (${m.category}): ${m.note}`));
      }
      const notes = await Store.searchNotes(q, 4);
      if (notes.length) {
        bits.push("ملاحظات مشروع:");
        notes.forEach((n) => bits.push(`- ${n.title}: ${n.content.slice(0, 200)}`));
      }
    } catch (e) {}
    return bits.join("\n");
  }

  /* ── عقل محلي احتياطي: يردّ من الذاكرة + منطق بسيط ── */
  async function localReply(q) {
    const text = (q || "").trim();
    const low = text.toLowerCase();

    // سلام/ترحيب
    if (/^(سلام|هلا|أهلا|اهلا|صباح|مساء|هاي|hi|hello)/.test(low))
      return "أهلًا يا بشمهندس محمد 👋 — أنا Hope، شغال أوفلاين على التليفون دلوقتي. اسألني عن أي حاجة محفوظة عندي.";

    // الذاكرة/الملاحظات
    if (/ذاكر|احفظ|عندك|معرف| شخص|مورد|عامل|عميل|ملاحظ/.test(low)) {
      const ctx = await localContext(text);
      if (ctx) return "شوفت في مخ التليفون:\n" + ctx;
      return "مافيش معلومة محفوظة عن الموضوع ده على التليفون — لما النت يرجع هتحفظها أول ما تقولي.";
    }

    // بحث عام في المخ
    const ctx = await localContext(text);
    if (ctx) return "من مخ التليفون (أوفلاين):\n" + ctx;

    // رقم/عملية حساب بسيطة (شغال أوفلاين)
    const m = text.replace(/[،,]/g, "").match(/(-?\d+)\s*([+\-x*/×÷])\s*(-?\d+)/);
    if (m) {
      const a = +m[1], b = +m[3]; let r;
      if (m[2] === "+") r = a + b;
      else if (m[2] === "-") r = a - b;
      else if (m[2] === "x" || m[2] === "×" || m[2] === "*") r = a * b;
      else r = b !== 0 ? a / b : NaN;
      if (!isNaN(r)) return `النتيجة: ${Math.round(r * 100) / 100} جنيه.`;
    }

    return "أنا Hope شغال أوفلاين دلوقتي من مخ التليفون — أقدر أردّ على اللي محفوظ عندي (ذكريات وملاحظات) وأعمل حسابات بسيطة. الشغل اللي محتاج الملفات أو جوجل هيتنفّذ أول ما الاتصال يرجع.";
  }

  /* ── الردّ: نموذج مدمج لو موجود، وإلا محلي ── */
  async function reply(q) {
    await ensure();
    if (mode === "nano" && session) {
      try {
        const out = await session.prompt(q);
        if (out && out.trim()) return out.trim();
      } catch (e) {
        // النموذج وقع — ارجع للعقل المحلي
        try { await session.close(); } catch (_) {}
        session = null; mode = "local";
      }
    }
    return localReply(q);
  }

  return {
    ensure, reply, nanoAvailable,
    get mode() { return mode; },
    async info() {
      await ensure();
      const st = await Store.stats().catch(() => ({}));
      return { mode, nano: nanoAvailable(), ...st };
    },
  };
})();
window.Offline = Offline;
