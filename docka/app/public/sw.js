/* Docka offline shell service worker.
 *
 * The persona is offline-first on a vessel: when the satellite link is down the
 * seaman must still be able to open his OWN already-saved documents. This worker
 * makes that possible with a NETWORK-FIRST strategy — when online, every request
 * goes to the network as normal (so nothing is ever stale), and each successful
 * GET is copied into a runtime cache. When the network is unreachable, we serve
 * the last-known cached copy instead of a browser error page.
 *
 * Scope is deliberately conservative: only same-origin GETs are cached, POST/
 * PATCH and cross-origin (e.g. the live government registry) always go straight
 * to the network, and nothing is ever served stale while online.
 */

const CACHE = "docka-offline-v3";

// Runtime-cache guard rails. The cache is meant for the seafarer's own modest
// pages/assets, not for heavyweight admin documents. Two independent limits keep
// origin storage bounded:
//   - MAX_CACHE_ENTRY_BYTES: never cache a single response larger than this.
//   - MAX_CACHE_ENTRIES: FIFO cap on how many runtime entries we retain; because
//     cache.keys() yields entries in insertion order, deleting from the front is
//     a cheap, robust LRU approximation.
const MAX_CACHE_ENTRY_BYTES = 3 * 1024 * 1024; // 3 MB
const MAX_CACHE_ENTRIES = 60;
// A static, framework-free, self-localising page that renders with no network and
// no server render. It is the guaranteed last-resort fallback for a cold load on a
// dead link or while the backend is returning 500s.
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Precache the offline shell so it is available even on the very first load
      // after the connection has already dropped.
      try {
        const cache = await caches.open(CACHE);
        await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      } catch {
        /* best-effort — the runtime fallback below still degrades gracefully */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function cacheable(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  // HMR / websocket / dev-only endpoints — never cache.
  if (url.pathname.startsWith("/_next/webpack-hmr")) return false;
  if (url.pathname.startsWith("/__nextjs")) return false;
  // Auth + mutations must always be live.
  if (url.pathname.startsWith("/api/auth")) return false;
  if (url.pathname.startsWith("/api/test-login")) return false;
  // Admin pages render huge inlined-HTML documents (25–30 MB per floor variant)
  // that would balloon the runtime cache. They are online-only tooling and must
  // never be written to the cache.
  if (url.pathname.startsWith("/admin")) return false;
  return true;
}

// Should this response be written to the runtime cache, given its declared size?
// We rely on the Content-Length header rather than reading the body, so measuring
// costs nothing. If the header is present and exceeds the per-entry cap, decline.
// If it is absent on a navigation/document response, decline too — those are the
// oversized inlined-HTML docs we specifically want to keep out, and we will not
// buffer the whole body just to measure it.
function withinCacheEntryLimit(request, response) {
  const len = response.headers.get("Content-Length");
  if (len != null) {
    const bytes = Number(len);
    if (Number.isFinite(bytes) && bytes > MAX_CACHE_ENTRY_BYTES) return false;
    return true;
  }
  // No Content-Length: safe for small assets, risky for documents. Decline to
  // cache size-unknown navigation/document responses.
  if (request.mode === "navigate") return false;
  const accept = request.headers.get("Accept") || "";
  if (accept.includes("text/html")) return false;
  return true;
}

// Keep the runtime cache under MAX_CACHE_ENTRIES by deleting the oldest entries.
// cache.keys() returns entries in insertion order, so the front of the list is the
// oldest — a cheap FIFO/LRU approximation. Best-effort: never let a prune failure
// break the fetch handler.
async function pruneCache(cache) {
  try {
    const keys = await cache.keys();
    const overflow = keys.length - MAX_CACHE_ENTRIES;
    for (let i = 0; i < overflow; i++) {
      // Preserve the precached offline shell — it is the last-resort fallback.
      const req = keys[i];
      if (new URL(req.url).pathname === OFFLINE_URL) continue;
      await cache.delete(req).catch(() => {});
    }
  } catch {
    /* best-effort — pruning must never break serving */
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!cacheable(request, url)) return; // let the browser handle it normally

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      // Shared navigation fallback: last-known cached copy of THIS page, else any
      // cached app shell, else the static offline page. Never a bare browser error.
      async function navFallback() {
        const cached = await cache.match(request);
        if (cached) return cached;
        const anyPage =
          (await cache.match("/seafarer")) ||
          (await cache.match("/")) ||
          (await cache.match("/agent"));
        if (anyPage) return anyPage;
        const offline = await cache.match(OFFLINE_URL);
        if (offline) return offline;
        return null;
      }

      try {
        const fresh = await fetch(request);
        // A wedged/disk-full backend answers navigations with 5xx. Serving that raw
        // gives the seafarer the dreaded bare "Internal Server Error"; instead fall
        // back to a cached shell or the friendly offline page.
        if (request.mode === "navigate" && fresh && fresh.status >= 500) {
          const fallback = await navFallback();
          if (fallback) return fallback;
        }
        // Only cache successful, basic (same-origin) responses — and only when
        // within the per-entry size limit. Oversized or size-unknown documents are
        // skipped so a single heavy page can never bloat the cache. After a write,
        // prune back to the entry cap (best-effort, never blocks the response).
        if (
          fresh &&
          fresh.ok &&
          fresh.type !== "opaque" &&
          withinCacheEntryLimit(request, fresh)
        ) {
          cache
            .put(request, fresh.clone())
            .then(() => pruneCache(cache))
            .catch(() => {});
        }
        return fresh;
      } catch (err) {
        // Offline / network unreachable: serve the last-known copy if we have one.
        const cached = await cache.match(request);
        if (cached) return cached;
        // For a navigation, degrade to a cached app shell or the offline page so the
        // user always sees something styled and localised, never the browser error.
        if (request.mode === "navigate") {
          const fallback = await navFallback();
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
