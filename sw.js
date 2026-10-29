/* sw.js — تخزين الواجهة عشان تفتح بسرعة وتتجنّب "added to home screen" */
const CACHE = "hope-v14";
const ASSETS = [
  "/", "/index.html", "/style.css", "/app.js", "/brain.js", "/manifest.json",
  "/store.js", "/offline.js", "/sync.js", "/im.js", "/ondevice.js",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
];
/* مكتبة الموديل على الجهاز (WebLLM) — عشان تتحمّل من غير نت بعد أول مرة.
   (ملفات الموديل نفسها بتتخزّن جوّه WebLLM نفسه — مش هنا.) */
const LIB_CDN = ["cdn.jsdelivr.net", "esm.run", "unpkg.com"];

self.addEventListener("install", (e) => {
  // cache: "reload" → دايمًا من السيرفر (مش من كاش المتصفح) — عشان التحديثات توصل
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api") || url.pathname === "/ws") return;
  const sameOrigin = url.origin === location.origin;
  // بقية البرّه (ملفات موديل جوجل…) — WebLLM بيخزّن بتوعه بنفسه جوّه المتصفح
  const isLib = !sameOrigin && LIB_CDN.includes(url.hostname);
  if (!sameOrigin && !isLib) return;
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          })
          .catch(() => (sameOrigin ? caches.match("/index.html") : Promise.reject()))
    )
  );
});
