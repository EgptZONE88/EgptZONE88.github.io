/* ═══════════════════════════════════════════════════════
   sync.js — مزامنة تلقائية بين مخ التليفون والسيرفر
   القاعدة: نفس البيانات على الجانبين دايمًا.
   ─ أول ما الاتصال يرجع → يرفّع الشغل المؤجّل (أوتفوكس)
     ويجيب أحدث الذكريات/الملاحظات.
   ─ وهو أوفلاين → كل حاجة بتتخزن محليًا وبرجوع النت بتتزامن.
   ═══════════════════════════════════════════════════════ */
"use strict";

const Sync = (() => {
  let online = navigator.onLine;
  let syncing = false;
  let onStatus = null;        // callback(online, pending)

  function api(path, opts) {
    const token = window.token || localStorage.getItem("atefToken") || "";
    opts = opts || {};
    opts.headers = Object.assign({ "X-Token": token }, opts.headers || {});
    return fetch(path, opts).then((r) => {
      if (r.status === 401) throw new Error("401");
      return r.json();
    });
  }

  async function pushOutbox() {
    const items = await Store.outbox();
    if (!items.length) return 0;
    let sent = 0;
    for (const it of items) {
      try {
        const r = await api("/api/sync/push", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: it.kind, payload: it.payload }),
        });
        // نحذف من الأوفلاين بس لو السيرفر فعلاً قبلها (ok:true)
        // — لو رجّع ok:false لازم الشغل يفضل مسجّل هنا عشان ما يضيعش
        if (r && r.ok === true) {
          await Store.removeOutbox([it.oid]);
          sent++;
        } else {
          break;   // السيرفر رفضها — نرجّعها بعدين (مثلاً نوع لسه مدعوم)
        }
      } catch (e) { break; }   // لسه أوفلاين — نجرب تاني بعدين
    }
    return sent;
  }

  async function pushMessages() {
    const msgs = await Store.unsyncedMessages();
    if (!msgs.length) return 0;
    for (const m of msgs) {
      try {
        await api("/api/sync/push", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "message", payload: { role: m.role, text: m.text, ts: m.ts } }),
        });
      } catch (e) { return 0; }
    }
    await Store.markMessagesSynced(msgs.map((m) => m.lid));
    return msgs.length;
  }

  /* ذكريات وملاحظات اتعملت أوفلاين → نرفعها للسيرفر قبل ما نسحب (ما نضيعهاش) */
  async function pushLocalStore() {
    const mems = await Store.unsyncedMemories();
    const mkeys = new Set();
    for (const m of mems) {
      try {
        await api("/api/sync/push", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "memory", payload: {
            category: m.category, name: m.name, note: m.note, ts: m.ts } }),
        });
        mkeys.add((m.name_norm || "") + "|" + (m.note || ""));
      } catch (e) { return; }
    }
    if (mkeys.size) await Store.markMemoriesSynced(mkeys);

    const notes = await Store.unsyncedNotes();
    const nkeys = new Set();
    for (const n of notes) {
      try {
        await api("/api/sync/push", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "note", payload: {
            title: n.title, content: n.content, ts: n.ts } }),
        });
        nkeys.add((n.title_norm || "") + "|" + (n.content || ""));
      } catch (e) { return; }
    }
    if (nkeys.size) await Store.markNotesSynced(nkeys);
  }

  async function pull() {
    // نجيب أحدث الذكريات والملاحظات ونحطها في المخ المحلي
    try {
      const r = await api("/api/sync/pull");
      if (r.memories) await Store.replaceMemories(r.memories);
      if (r.notes) await Store.replaceNotes(r.notes);
      await Store.setMeta("lastSync", new Date().toISOString());
      return true;
    } catch (e) { return false; }
  }

  async function run() {
    if (syncing || !online) return false;
    syncing = true;
    try {
      await pushOutbox();
      await pushLocalStore();   // ذكريات/ملاحظات أوفلاين → السيرفر قبل السحب
      await pushMessages();
      await pull();
      await emit();
      return true;
    } finally { syncing = false; }
  }

  /* تسجيل شغل مؤجّل وهو أوفلاين — يتنفّذ أول ما النت يرجع */
  async function enqueue(kind, payload) {
    await Store.queue(kind, payload);
    await emit();
  }

  async function emit() {
    if (!onStatus) return;
    const st = await Store.stats().catch(() => ({ outbox: 0 }));
    onStatus(online, st.outbox || 0);
  }

  function setOnline(v) {
    const was = online;
    online = v;
    if (v && !was) run();          // رجع النت → زامن فورًا
    emit();
  }

  function start(statusCb) {
    onStatus = statusCb;
    window.addEventListener("online", () => setOnline(true));
    window.addEventListener("offline", () => setOnline(false));
    online = navigator.onLine;
    // أول مزامنة لما يفتح
    setTimeout(run, 1200);
    // مزامنة دورية خفيفة كل 60 ثانية لو في حاجة مؤجّلة
    setInterval(() => { if (online) run(); }, 60000);
    emit();
  }

  return { start, run, enqueue, api, get online() { return online; } };
})();
window.Sync = Sync;
