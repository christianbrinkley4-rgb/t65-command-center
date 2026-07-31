// Field service worker. Goal: once the app has been opened on wifi, it opens
// again in a driveway with no signal.
//
// Two strategies, because pages and assets fail differently.
//
// Static assets (JS, CSS, fonts) are cache-first: their filenames contain a
// build hash, so a cached copy is never the wrong copy, and serving it from
// disk is what makes the app open instantly.
//
// Pages are network-first. This is not a preference, it's a correctness fix.
// Serving a cached page instantly means serving HTML that names the PREVIOUS
// build's chunk hashes — so the phone runs yesterday's code even though the
// service worker updated fine, and only catches up on the reload after. Two
// agents working the same book cannot be a build apart without knowing it.
// Offline, it falls straight back to the cached page, so the driveway case is
// unchanged.
//
// Supabase and Google Maps are cross-origin and must never be cached — stale
// lead data pretending to be live is worse than an honest failure, and the app
// has its own lead cache for that.

// Bump this on every deploy. The activate handler deletes every cache whose
// name doesn't match, which is what forces a phone that already has the app
// installed to pick up the new build instead of serving the old shell.
const CACHE = "t65-app-v21";

self.addEventListener("install", (event) => {
  // Take over as soon as possible; a half-updated shell is a field bug.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

function isAppAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.endsWith("/sw.js")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!isAppAsset(url)) return; // Supabase, Census, Maps: always live

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: false });

      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === "basic") {
            cache.put(req, resp.clone()).catch(() => {});
          }
          return resp;
        })
        .catch(() => null);

      // A page: ask the network first so a fresh deploy lands on the first
      // open, not the second. Cache is the fallback, not the default.
      if (req.mode === "navigate") {
        const fresh = await network;
        if (fresh) return fresh;
        if (cached) return cached;
      } else if (cached) {
        // A hashed asset: the cached copy is the right copy.
        event.waitUntil(network);
        return cached;
      }

      const fresh = await network;
      if (fresh) return fresh;

      // Offline and never cached: for a page request fall back to any cached
      // page so the app shell still boots instead of showing the browser error.
      if (req.mode === "navigate") {
        const anyPage =
          (await cache.match(new URL("./", url).toString())) ||
          (await cache.match(new URL("../list/", url).toString()));
        if (anyPage) return anyPage;
      }
      return new Response("Offline and this page has not been cached yet.", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    })()
  );
});
