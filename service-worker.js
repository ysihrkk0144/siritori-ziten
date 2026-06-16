/* ============================================================
   service-worker.js   –   小学生しりとり辞典
   ============================================================
   【バージョン管理ルール】
   ASSETS を追加・変更・削除するたびに CACHE の番号を必ず上げる。
   例: "shiritori-v2" → "shiritori-v3"
   これをしないと古いキャッシュが使われ続ける。
   ============================================================ */
const CACHE  = "shiritori-v2";          // ← ファイル変更時にここを上げる

const ASSETS = [
  /* service-worker.js 自身はリストに含めない              */
  /* （SW はブラウザが別途管理するため、含めると誤動作の元）*/
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
  /* 他のファイルを追加したらここに書き、CACHE 番号も上げる */
];

/* ── インストール：個別キャッシュ（1ファイル失敗でも続行） ── */
self.addEventListener("install", e => {
  e.waitUntil(
    (async () => {
      const cache   = await caches.open(CACHE);

      /* Promise.allSettled で1件ずつ処理                       */
      /* → 1ファイル失敗しても残りはキャッシュされ、全滅しない  */
      const results = await Promise.allSettled(
        ASSETS.map(url =>
          fetch(url, { cache: "reload" })        // HTTPキャッシュをバイパス
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
              return cache.put(url, res);
            })
        )
      );

      const failed = results
        .filter(r => r.status === "rejected")
        .map(r => r.reason?.message ?? String(r.reason));

      if (failed.length) {
        console.warn("[SW] 一部キャッシュ失敗（他は保存済み）:", failed);
      } else {
        console.log("[SW] 全ファイルのキャッシュ完了:", CACHE);
      }

      /* キャッシュ完了後にスキップ（完了前に activate へ進まない）*/
      await self.skipWaiting();
    })()
  );
});

/* ── アクティベート：旧キャッシュ削除 → クライアントを制御 ── */
self.addEventListener("activate", e => {
  e.waitUntil(
    (async () => {
      /* 旧バージョンのキャッシュを全て削除 */
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      );

      /* 今開いているページをこの SW の制御下に即置く */
      await self.clients.claim();

      /* キャッシュ完了をページへ通知（バナー表示のトリガー） */
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach(c =>
        c.postMessage({ type: "CACHE_READY", version: CACHE })
      );

      console.log("[SW] アクティベート完了:", CACHE);
    })()
  );
});

/* ── フェッチ：GET のみ処理、キャッシュ優先 ── */
self.addEventListener("fetch", e => {
  /* GET 以外（POST等）はそのままネットへ通す */
  if (e.request.method !== "GET") return;

  e.respondWith(
    (async () => {
      /* 1. キャッシュに一致するものがあれば即返す */
      const cached = await caches.match(e.request);
      if (cached) return cached;

      /* 2. キャッシュにない場合、URL がルート（/）なら
            index.html を代わりに返してオフライン起動を補助 */
      const url = new URL(e.request.url);
      if (url.pathname.endsWith("/") || url.pathname === "") {
        const fallback = await caches.match("./index.html");
        if (fallback) return fallback;
      }

      /* 3. ネットワークから取得 */
      return fetch(e.request);
    })()
  );
});
