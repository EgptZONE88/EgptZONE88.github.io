/* ═══════════════════════════════════════════════════════
   store.js — مخزن الهاتف المحلي (IndexedDB)
   عشان هوب يفضل يشتغل من مخ التليفون ولو النت قطع تمامًا،
   وبعدين يزامن نفس البيانات مع السيرفر أول ما الاتصال يرجع.
   نفس الذكريات/الرسائل/الملاحظات على الجانبين — دايمًا واحد.
   ═══════════════════════════════════════════════════════ */
"use strict";

const Store = (() => {
  const DB_NAME = "imagen-local", DB_VER = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = (e) => {
        const d = rq.result;
        if (!d.objectStoreNames.contains("messages"))
          d.createObjectStore("messages", { keyPath: "lid", autoIncrement: true });
        if (!d.objectStoreNames.contains("memories")) {
          const s = d.createObjectStore("memories", { keyPath: "lid", autoIncrement: true });
          s.createIndex("name_norm", "name_norm");
        }
        if (!d.objectStoreNames.contains("notes"))
          d.createObjectStore("notes", { keyPath: "lid", autoIncrement: true });
        // طابور الشغل المؤجّل (أوتفوكس) — يتنفّذ أول ما النت يرجع
        if (!d.objectStoreNames.contains("outbox"))
          d.createObjectStore("outbox", { keyPath: "oid", autoIncrement: true });
        // إعدادات محلية صغيرة (آخر مزامنة، وضع أوفلاين…)
        d.createObjectStore("meta", { keyPath: "k" });
      };
      rq.onsuccess = () => { _db = rq.result; res(_db); };
      rq.onerror = () => rej(rq.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then((d) => new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    }));
  }

  // مساعدة: تجميع نتيجة طلب IDB
  const req = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  const norm = (s) => (s || "").toString().toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")   // حركات + تشديد + تطويل
    .replace(/[إأآا]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[ؤئ]/g, "ء").replace(/\s+/g, " ").trim();

  return {
    norm,
    open,

    /* ── رسائل المحادثة ── */
    async addMessage(role, text, ts) {
      const t = (text || "").trim();
      if (!t) return null;
      const rec = { role: role === "bot" ? "bot" : "user", text: t,
                    ts: ts || new Date().toISOString(), synced: 0 };
      return tx("messages", "readwrite", (s) => s.add(rec));
    },
    async listMessages(limit = 120) {
      const all = await tx("messages", "readonly", (s) => s.getAll());
      return (all || []).slice(-limit);
    },
    async clearMessages() { return tx("messages", "readwrite", (s) => s.clear()); },
    async unsyncedMessages() {
      const all = await tx("messages", "readonly", (s) => s.getAll());
      return (all || []).filter((m) => !m.synced);
    },
    async markMessagesSynced(lids) {
      return open().then((d) => new Promise((res) => {
        const t = d.transaction("messages", "readwrite");
        const s = t.objectStore("messages");
        lids.forEach((l) => s.get(l).onsuccess = (e) => {
          const r = e.target.result; if (r) { r.synced = 1; s.put(r); }
        });
        t.oncomplete = () => res(true);
      }));
    },

    /* ── الذكريات (نفس بنية السيرفر تقريبًا) ── */
    async addMemory(cat, name, note, ts) {
      const rec = { category: cat || "عام", name: name || "", name_norm: norm(name),
                    note: note || "", ts: ts || new Date().toISOString(), synced: 0 };
      return tx("memories", "readwrite", (s) => s.add(rec));
    },
    async allMemories() { return tx("memories", "readonly", (s) => s.getAll()); },
    async searchMemories(q, limit = 20) {
      const nq = norm(q);
      if (!nq) return [];
      const all = await this.allMemories();
      const out = [];
      for (const m of all) {
        if (m.name_norm.includes(nq) || norm(m.note).includes(nq) ||
            norm(m.category).includes(nq)) { out.push(m); if (out.length >= limit) break; }
      }
      return out.reverse();
    },
    async replaceMemories(rows) {           // مسح + إعادة بناء من السيرفر
      await tx("memories", "readwrite", (s) => s.clear());
      for (const r of rows || [])
        await tx("memories", "readwrite", (s) => s.add(
          { category: r.category, name: r.name, name_norm: r.name_norm || norm(r.name),
            note: r.note, ts: r.created_at || r.ts, synced: 1 }));
    },
    async unsyncedMemories() {
      const all = await tx("memories", "readonly", (s) => s.getAll());
      return (all || []).filter((m) => !m.synced);
    },
    async markMemoriesSynced(keys) {        // keys = name_norm + "|" + note
      return open().then((d) => new Promise((res) => {
        const t = d.transaction("memories", "readwrite");
        const s = t.objectStore("memories");
        const idx = s.getAll();
        idx.onsuccess = () => {
          (idx.result || []).forEach((m) => {
            if (keys.has((m.name_norm || "") + "|" + (m.note || ""))) { m.synced = 1; s.put(m); }
          });
        };
        t.oncomplete = () => res(true);
      }));
    },

    /* ── ملاحظات المشروع ── */
    async addNote(title, content, ts) {
      const rec = { title: title || "", title_norm: norm(title), content: content || "",
                    ts: ts || new Date().toISOString(), synced: 0 };
      return tx("notes", "readwrite", (s) => s.add(rec));
    },
    async allNotes() { return tx("notes", "readonly", (s) => s.getAll()); },
    async searchNotes(q, limit = 15) {
      const nq = norm(q);
      if (!nq) return [];
      const all = await this.allNotes();
      const out = [];
      for (const n of all) {
        if (n.title_norm.includes(nq) || norm(n.content).includes(nq)) {
          out.push(n); if (out.length >= limit) break;
        }
      }
      return out.reverse();
    },
    async replaceNotes(rows) {
      await tx("notes", "readwrite", (s) => s.clear());
      for (const r of rows || [])
        await tx("notes", "readwrite", (s) => s.add(
          { title: r.title, title_norm: r.title_norm || norm(r.title),
            content: r.content, ts: r.created_at || r.ts, synced: 1 }));
    },
    async unsyncedNotes() {
      const all = await tx("notes", "readonly", (s) => s.getAll());
      return (all || []).filter((n) => !n.synced);
    },
    async markNotesSynced(keys) {           // keys = title_norm + "|" + content
      return open().then((d) => new Promise((res) => {
        const t = d.transaction("notes", "readwrite");
        const s = t.objectStore("notes");
        const idx = s.getAll();
        idx.onsuccess = () => {
          (idx.result || []).forEach((n) => {
            if (keys.has((n.title_norm || "") + "|" + (n.content || ""))) { n.synced = 1; s.put(n); }
          });
        };
        t.oncomplete = () => res(true);
      }));
    },

    /* ── طابور الشغل المؤجّل (أوتفوكس) — تنفيذ أول ما النت يرجع ── */
    async queue(kind, payload) {
      const rec = { kind, payload, ts: new Date().toISOString(), tries: 0 };
      return tx("outbox", "readwrite", (s) => s.add(rec));
    },
    async outbox() { return tx("outbox", "readonly", (s) => s.getAll()); },
    async removeOutbox(oids) {
      return open().then((d) => new Promise((res) => {
        const t = d.transaction("outbox", "readwrite");
        const s = t.objectStore("outbox");
        oids.forEach((o) => s.delete(o));
        t.oncomplete = () => res(true);
      }));
    },

    /* ── إعدادات محلية ── */
    async setMeta(k, v) { return tx("meta", "readwrite", (s) => s.put({ k, v })); },
    async getMeta(k, dflt) {
      const r = await tx("meta", "readonly", (s) => s.get(k));
      return r ? r.v : dflt;
    },

    /* ── إحصائيات للعرض ── */
    async stats() {
      const [m, mem, n, o] = await Promise.all([
        tx("messages", "readonly", (s) => s.count()),
        tx("memories", "readonly", (s) => s.count()),
        tx("notes", "readonly", (s) => s.count()),
        tx("outbox", "readonly", (s) => s.count()),
      ]);
      return { messages: m, memories: mem, notes: n, outbox: o };
    },
  };
})();
window.Store = Store;
