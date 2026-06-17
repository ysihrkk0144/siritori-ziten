/* ============================================================
   service-worker.js   –   小学生しりとり辞典
   ============================================================
   【バージョン管理ルール】
   ASSETS を追加・変更・削除するたびに CACHE の番号を必ず上げる。
   例: "shiritori-v2" → "shiritori-v3"
   これをしないと古いキャッシュが使われ続ける。
   ============================================================ */
const CACHE  = "shiritori-v3";          // ← ファイル変更時にここを上げる

const ASSETS = [
  /* service-worker.js 自身はリストに含めない */
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
  /* 他のファイルを追加したらここに書き、CACHE 番号も上げる */
];

/* キャッシュ照合時に共通で使うオプション。
   ignoreVary: true … GitHub Pages（Fastly配信）が付与する
                       Vary ヘッダーの違いで不一致になるのを防ぐ。
                       これが無いと「キャッシュしたのに見つからない」
                       という不一致が起こりうる。
   ignoreSearch: true … URLの ?query 差異を無視する。               */
const MATCH_OPTS = { ignoreVary: true, ignoreSearch: true };

/* ── インストール：個別キャッシュ（1ファイル失敗でも続行） ── */
self.addEventListener("install", e => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      const results = await Promise.allSettled(
        ASSETS.map(url =>
          fetch(url, { cache: "reload" })
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
              /* キーは ASSETS に書いた相対パスの文字列そのものに固定する。
                 後で caches.match("./index.html") のように
                 「固定キーでの問い合わせ」と必ず一致させるため。 */
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

      await self.skipWaiting();
    })()
  );
});

/* ── アクティベート：旧キャッシュ削除 → クライアントを制御 ── */
self.addEventListener("activate", e => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      );

      await self.clients.claim();

      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach(c =>
        c.postMessage({ type: "CACHE_READY", version: CACHE })
      );

      console.log("[SW] アクティベート完了:", CACHE);
    })()
  );
});

/* 「redirectされた」フラグの付いたResponseは、Chromeの仕様で
   ナビゲーションリクエストへそのまま返すとエラーになることがある。
   bodyだけ取り出して新しいResponseに包み直して回避する。      */
async function stripRedirectFlag(response) {
  if (!response || !response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/* ── フェッチ ── */
self.addEventListener("fetch", e => {
  /* GET 以外（POST等）はそのままネットへ通す */
  if (e.request.method !== "GET") return;

  /* ページそのものの読み込み（ナビゲーション）は特別扱いする。
     event.request をそのままキャッシュキーにせず、
     必ず "./index.html" という固定キーで問い合わせることで、
     URLの微妙な差異やVaryヘッダーの不一致による
     「キャッシュ済みなのに見つからない」事故を避ける。   */
  if (e.request.mode === "navigate") {
    e.respondWith(
      (async () => {
        try {
          const cached = await caches.match("./index.html", MATCH_OPTS);
          if (cached) return await stripRedirectFlag(cached);

          /* キャッシュに無ければネットを試す */
          return await fetch(e.request);
        } catch (err) {
          /* ネットも無い・キャッシュにも無い → ここで初めて
             「絶対に reject させない」最終防衛ラインを敷く。
             これにより ERR_FAILED を出さず、最低限の案内文を表示する。 */
          console.warn("[SW] ナビゲーション失敗・フォールバック表示:", err);
          return new Response(
            `<!DOCTYPE html><html lang="ja"><meta charset="UTF-8">
             <body style="font-family:sans-serif;text-align:center;padding:40px 20px;">
               <h2>オフラインで開けませんでした</h2>
               <p>一度オンラインの状態でこのアプリを開き、
               画面上部に緑色の「オフライン対応完了」バナーが
               出ることを確認してから、もう一度お試しください。</p>
             </body></html>`,
            { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } }
          );
        }
      })()
    );
    return;
  }

  /* ナビゲーション以外（CSS・JS・画像・JSON等の付随リソース） */
  e.respondWith(
    (async () => {
      try {
        const cached = await caches.match(e.request, MATCH_OPTS);
        if (cached) return await stripRedirectFlag(cached);
        return await fetch(e.request);
      } catch (err) {
        /* ここでも reject させない。何も返せない場合は
           「失敗した」とわかる軽量なResponseを返す。       */
        console.warn("[SW] リソース取得失敗:", e.request.url, err);
        return new Response("", { status: 504, statusText: "Offline" });
      }
    })()
  );
});

/* ── 診断用メッセージ ──
   PCが無い開発環境でも、ページ側から問い合わせて
   「何がキャッシュされているか」を画面上で確認できるようにする。 */
self.addEventListener("message", e => {
  if (e.data?.type !== "DIAG_REQUEST") return;
  e.waitUntil(
    (async () => {
      const cache      = await caches.open(CACHE);
      const reqs       = await cache.keys();
      const cachedUrls = reqs.map(r => r.url);
      const missing    = ASSETS.filter(a => {
        const abs = new URL(a, self.location.href).href;
        return !cachedUrls.includes(abs);
      });
      const info = {
        type: "DIAG_RESPONSE",
        cacheName: CACHE,
        cachedCount: cachedUrls.length,
        expectedCount: ASSETS.length,
        cachedUrls,
        missing
      };
      if (e.source) e.source.postMessage(info);
    })()
  );
});
