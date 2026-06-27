/* ============================================================
   service-worker.js   –   こどもしりとり辞典
   ============================================================
   【設計方針】
   ・このSWは「完全オフライン優先」で動く。
   ・新バージョンへの切り替えは、ユーザーが画面の
     「更新する」ボタンを押した時だけ行う。
   ・install時に skipWaiting() は呼ばない。
     自動更新と機内モード起動のタイミングが衝突して
     ERR_FAILED の原因になることが分かっているため。
   ・バージョンを上げる時は CACHE_NAME の数字を必ず増やすこと。
   ============================================================ */
const CACHE_NAME = "kodomo-shiritori-v3";   // ← ファイル変更時に必ず上げる

/* キャッシュ対象（service-worker.js 自身は含めない） */
const ASSET_PATHS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

/* 相対パスを self.location 基準の完全URLに変換しておく。
   これにより、キャッシュキーの不一致（相対/絶対のブレ）を防ぐ。 */
const ASSETS    = ASSET_PATHS.map(p => new URL(p, self.location).href);
const INDEX_URL = new URL("./index.html", self.location).href;

/* ── リトライ付きフェッチ ──
   モバイル回線の不安定さに対応するため、最大3回まで試す。
   {cache:"reload"} 単体は一部Android環境で不安定になることが
   分かっているため使わない。代わりに、試行ごとに
   "no-store"（ブラウザキャッシュを完全無視）と
   デフォルト（ブラウザ標準の判断に任せる）を交互に試し、
   どちらか一方だけがうまくいくケースに両対応する。        */
async function fetchWithRetry(url, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    const useNoStore = (i % 2 === 0);   // 1,3回目はno-store／2回目はデフォルト
    try {
      const opts = useNoStore ? { cache: "no-store" } : {};
      const res  = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/* install時・CACHE_NOW時の両方から呼ばれる共通ロジック。
   「キャッシュし直す」処理を一箇所にまとめておくことで、
   2つの経路の動作が食い違わないようにする。               */
async function cacheAllAssets() {
  const cache = await caches.open(CACHE_NAME);

  const results = await Promise.allSettled(
    ASSETS.map(async absUrl => {
      const res = await fetchWithRetry(absUrl, 3);
      await cache.put(absUrl, res);
    })
  );

  const succeeded = [];
  const failed     = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      succeeded.push(ASSETS[i]);
    } else {
      failed.push({ url: ASSETS[i], message: r.reason?.message ?? String(r.reason) });
    }
  });

  return { succeeded, failed };
}

/* ── install：個別キャッシュ（1件失敗しても他は継続） ── */
self.addEventListener("install", e => {
  e.waitUntil(
    (async () => {
      const { succeeded, failed } = await cacheAllAssets();

      /* 結果を画面（診断パネル・バナー）へ通知する。
         DevToolsが使えない環境のため、console.logだけでは不十分。 */
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach(c => c.postMessage({
        type: "INSTALL_RESULT",
        cacheName: CACHE_NAME,
        succeededCount: succeeded.length,
        totalCount: ASSETS.length,
        succeeded,
        failed
      }));

      /* ★ ここで skipWaiting() は呼ばない。
         ユーザーが「更新する」を押した時だけ、
         message イベント経由で呼び出す（下記参照）。      */
    })()
  );
});

/* ── activate：旧キャッシュ削除 → クライアントを制御 ── */
self.addEventListener("activate", e => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );

      await self.clients.claim();

      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach(c => c.postMessage({
        type: "ACTIVATED",
        cacheName: CACHE_NAME
      }));
    })()
  );
});

/* 「redirectされた」フラグ付きResponseは、Chromeの仕様で
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

/* ── fetch：オフライン優先（Cache First） ── */
self.addEventListener("fetch", e => {
  const req = e.request;

  /* GET以外（POST等）はスルー */
  if (req.method !== "GET") return;
  /* http(s)以外（chrome-extension: 等）はスルー */
  if (!req.url.startsWith("http")) return;

  /* ページそのものの読み込み（ナビゲーション）は
     必ず index.html のキャッシュを最優先で返す。
     manifestのstart_url/scopeが "./" のため、
     "./" へのナビゲーションも同じ index.html を返す。   */
  if (req.mode === "navigate") {
    e.respondWith(
      (async () => {
        const cached = await caches.match(INDEX_URL);
        if (cached) return await stripRedirectFlag(cached);

        /* キャッシュに無い場合のみネットワークへフォールバック */
        try {
          return await fetch(req);
        } catch (err) {
          console.warn("[SW] ナビゲーション失敗・フォールバック表示:", err);
          return new Response(
            `<!DOCTYPE html><html lang="ja"><meta charset="UTF-8">
             <body style="font-family:sans-serif;text-align:center;padding:40px 20px;">
               <h2>オフラインで開けませんでした</h2>
               <p>一度オンラインの状態でこのアプリを開き、
               画面右下の「🔧」診断パネルで「キャッシュ済み件数」が
               期待件数と一致することを確認してください。</p>
             </body></html>`,
            { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } }
          );
        }
      })()
    );
    return;
  }

  /* その他のリソース（CSS・JS・画像・JSON等）：
     キャッシュにあれば即返す。無ければネットワークを試すが、
     失敗しても自動で何度も取りに行ったりはしない。
     respondWithのPromiseは必ず解決させ、ERR_FAILEDを起こさない。 */
  e.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return await stripRedirectFlag(cached);

      try {
        return await fetch(req);
      } catch (err) {
        console.warn("[SW] キャッシュ無し・ネットワークも失敗:", req.url, err);
        return new Response("", { status: 504, statusText: "Offline (no cache)" });
      }
    })()
  );
});

/* ── message：診断要求・手動更新の指示 ── */
self.addEventListener("message", e => {
  const data = e.data || {};

  if (data.type === "GET_DIAGNOSTIC" || data.type === "RETRY_CACHE") {
    e.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_NAME);

        let reqs       = await cache.keys();
        let cachedUrls = reqs.map(r => r.url);
        let missing    = ASSETS.filter(a => !cachedUrls.includes(a));

        let retryDetails = null;

        /* RETRY_CACHE の時だけ、不足しているファイルを今その場で
           取り直し、成功/失敗の具体的な理由まで返す。
           これまで「失敗した」事実しか分からなかった問題に対し、
           "なぜ失敗したか" を画面上で直接確認できるようにする。 */
        if (data.type === "RETRY_CACHE" && missing.length > 0) {
          const results = await Promise.allSettled(
            missing.map(async absUrl => {
              const res = await fetchWithRetry(absUrl, 3);
              await cache.put(absUrl, res);
            })
          );
          retryDetails = results.map((r, i) => ({
            url: missing[i],
            ok: r.status === "fulfilled",
            message: r.status === "rejected"
              ? (r.reason?.message ?? String(r.reason))
              : null
          }));

          /* 取り直した結果で再集計する */
          reqs       = await cache.keys();
          cachedUrls = reqs.map(r => r.url);
          missing    = ASSETS.filter(a => !cachedUrls.includes(a));
        }

        const info = {
          type: "DIAGNOSTIC_RESULT",
          cacheName: CACHE_NAME,
          cachedCount: cachedUrls.length,
          expectedCount: ASSETS.length,
          cachedUrls,
          missing,
          retryDetails
        };
        if (e.source) e.source.postMessage(info);
      })()
    );
    return;
  }

  if (data.type === "CACHE_NOW") {
    /* 「📥 キャッシュを今すぐ手動で再取得する」ボタンから送られる。
       install時とまったく同じロジック（cacheAllAssets）で
       ASSETS全件を取得し直す。不足分だけでなく全件を対象にするのは、
       「壊れている可能性のあるファイルを含めて、まっさらに作り直す」
       ための機能だから。                                       */
    e.waitUntil(
      (async () => {
        const { succeeded, failed } = await cacheAllAssets();
        const info = {
          type: "CACHE_NOW_RESULT",
          cacheName: CACHE_NAME,
          succeededCount: succeeded.length,
          totalCount: ASSETS.length,
          succeeded,
          failed
        };
        if (e.source) e.source.postMessage(info);
      })()
    );
    return;
  }

  if (data.type === "SKIP_WAITING") {
    /* これは「更新する」ボタンを押した時だけページ側から送られる。
       SW側が自発的に呼ぶことは絶対にしない。 */
    self.skipWaiting();
  }
});
