// A planned route has to outlive the screen it was built on.
//
// The route used to live in React state and nowhere else, which meant it was
// gone the moment anything touched the page: a filter tap, the tab closing, the
// phone reclaiming memory while you were at a door, a reload. Twelve doors put
// in walking order, and you're back to guessing which house you were on.
//
// So every built route is written down. One slot holds the route you're on and
// is overwritten by the next build; a named save is pinned and survives it, for
// the neighborhood you work every Thursday.
//
// What gets stored is HOUSEHOLD KEYS, not leads. A stored lead is a photograph
// of Tuesday: it would show a door as unknocked after you knocked it, and hide
// the note you left on it. Keys are re-resolved against the live book every
// time the route is opened, so a restored route is today's data in Tuesday's
// order — which is the only part worth keeping.
//
// localStorage, matching offline.ts: this is field state on one phone, it has
// to survive a reboot in a driveway with no signal, and it must never wait on a
// network round trip to tell you where you were.
//
// NAMED routes are also shared. Christian and Will each carry their own phone,
// so a saved route is mirrored to the saved_views table (page = "knock-route")
// and pulled back down on every device. localStorage stays the source the
// screen reads from, so a dead zone still shows the list; the network only
// ever adds to it. The route you're currently on is never shared.

import { supabase } from "./supabaseClient";
import type { Household } from "./knock";
import type { LatLng, RoutePlan, Stop } from "./route";

export type SavedRoute = {
  id: string;
  /** null = the route you're currently on. Named = pinned by the agent. */
  name: string | null;
  /** Last touched, not first built — knocking a door refreshes it. */
  savedAt: string;
  start: LatLng;
  end: LatLng | null;
  plan: RoutePlan;
  /** Who saved it, so the other phone can see whose route this is. */
  by?: string;
  /** Household keys in walking order. */
  stops: string[];
  /** Which of those doors are already worked, so resuming shows the gap. */
  done: string[];
};

const CURRENT_KEY = "t65-route-current";
const SAVED_KEY = "t65-routes";
const MAX_SAVED = 12;

export function newRouteId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Rebuild a stored blob into a route, or reject it.
 *
 * Anything on disk is untrusted: a write interrupted by the tab closing, or a
 * record from a build before these fields existed. A field page that throws on
 * load is worse than one that quietly forgets a route, so a bad record is
 * dropped rather than trusted.
 */
function coerce(x: unknown): SavedRoute | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (!Array.isArray(r.stops) || !r.stops.every((s) => typeof s === "string")) return null;
  const start = r.start as LatLng | undefined;
  if (!start || typeof start.lat !== "number" || typeof start.lng !== "number") return null;
  if (!r.plan || typeof r.plan !== "object") return null;
  const end = r.end as LatLng | null | undefined;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : null,
    savedAt: typeof r.savedAt === "string" ? r.savedAt : new Date(0).toISOString(),
    start: { lat: start.lat, lng: start.lng },
    end: end && typeof end.lat === "number" && typeof end.lng === "number"
      ? { lat: end.lat, lng: end.lng }
      : null,
    plan: r.plan as RoutePlan,
    by: typeof r.by === "string" && r.by.trim() ? r.by.trim() : undefined,
    stops: r.stops as string[],
    done: Array.isArray(r.done)
      ? (r.done.filter((d) => typeof d === "string") as string[])
      : [],
  };
}

function read(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode. The route still works on screen; it just won't
    // come back. Not worth an error in front of someone at a door.
  }
}

// ── the route you're on ──────────────────────────────────────────────────────

export function loadCurrentRoute(): SavedRoute | null {
  return coerce(read(CURRENT_KEY));
}

export function putCurrentRoute(r: SavedRoute) {
  write(CURRENT_KEY, r);
}

export function clearCurrentRoute() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CURRENT_KEY);
  } catch {
    // Same as write: nothing the agent can act on.
  }
}

// ── named saves ──────────────────────────────────────────────────────────────

export function loadSavedRoutes(): SavedRoute[] {
  const raw = read(SAVED_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(coerce)
    .filter((r): r is SavedRoute => r !== null && r.name !== null)
    .slice(0, MAX_SAVED);
}

/** Upsert by id, most recently touched first. Returns the new list. */
export function putSavedRoute(r: SavedRoute): SavedRoute[] {
  const next = [r, ...loadSavedRoutes().filter((x) => x.id !== r.id)].slice(0, MAX_SAVED);
  write(SAVED_KEY, next);
  void pushSharedRoute(r);
  return next;
}

export function deleteSavedRoute(id: string): SavedRoute[] {
  const next = loadSavedRoutes().filter((x) => x.id !== id);
  write(SAVED_KEY, next);
  void removeSharedRoute(id);
  return next;
}

// ── sharing between phones ───────────────────────────────────────────────────

const SHARED_PAGE = "knock-route";

// Progress is written on every knock, which is far more often than anyone needs
// a second phone to hear about it. One push per route per few seconds.
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mirror a named route to the team. Never throws: offline just means later. */
export function pushSharedRoute(r: SavedRoute): Promise<void> {
  if (!r.name || typeof window === "undefined") return Promise.resolve();
  const prior = pushTimers.get(r.id);
  if (prior) clearTimeout(prior);
  return new Promise((resolve) => {
    pushTimers.set(
      r.id,
      setTimeout(async () => {
        pushTimers.delete(r.id);
        try {
          const filters = { rid: r.id, route: JSON.stringify(r) };
          const found = await supabase
            .from("saved_views")
            .select("id")
            .eq("page", SHARED_PAGE)
            .eq("filters->>rid", r.id)
            .limit(1);
          const existing = found.data?.[0]?.id as string | undefined;
          if (existing) {
            await supabase.from("saved_views").update({ name: r.name, filters }).eq("id", existing);
          } else {
            await supabase
              .from("saved_views")
              .insert({ name: r.name, page: SHARED_PAGE, filters, created_by: r.by ?? null });
          }
        } catch {
          // Offline or signed out. The route is still saved on this phone and
          // is pushed again the next time it's touched or synced.
        }
        resolve();
      }, 1500)
    );
  });
}

export async function removeSharedRoute(id: string): Promise<void> {
  try {
    await supabase.from("saved_views").delete().eq("page", SHARED_PAGE).eq("filters->>rid", id);
  } catch {
    // Offline: it comes back on the next sync, and can be deleted again.
  }
}

/**
 * Pull the team's saved routes and merge them with this phone's. The newer copy
 * of a route wins (progress on a door is a write, so "newer" is the phone that
 * knocked most recently). Anything only this phone has is pushed up. Returns
 * the merged list, or null if the network wasn't there, so the caller keeps
 * what it already shows.
 */
export async function syncSharedRoutes(): Promise<SavedRoute[] | null> {
  if (typeof window === "undefined") return null;
  try {
    const { data, error } = await supabase
      .from("saved_views")
      .select("filters")
      .eq("page", SHARED_PAGE);
    if (error || !data) return null;
    const remote = new Map<string, SavedRoute>();
    for (const row of data) {
      const f = row.filters as { route?: string } | null;
      if (!f?.route) continue;
      try {
        const r = coerce(JSON.parse(f.route));
        if (r && r.name) remote.set(r.id, r);
      } catch {
        // A row that isn't a route we wrote. Ignore it.
      }
    }
    const local = loadSavedRoutes();
    const localById = new Map(local.map((r) => [r.id, r]));
    const merged = new Map<string, SavedRoute>();
    for (const r of remote.values()) {
      const mine = localById.get(r.id);
      merged.set(r.id, mine && Date.parse(mine.savedAt) > Date.parse(r.savedAt) ? mine : r);
    }
    for (const r of local) {
      if (!merged.has(r.id)) merged.set(r.id, r);
    }
    // Local-only or locally-newer copies go up so the other phone gets them.
    for (const r of merged.values()) {
      const theirs = remote.get(r.id);
      if (!theirs || Date.parse(r.savedAt) > Date.parse(theirs.savedAt)) void pushSharedRoute(r);
    }
    const next = [...merged.values()]
      .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))
      .slice(0, MAX_SAVED);
    write(SAVED_KEY, next);
    return next;
  } catch {
    return null;
  }
}

// ── putting one back on screen ───────────────────────────────────────────────

/**
 * Resolve stored keys against the live book.
 *
 * `missing` is doors that dropped out since the route was built — closed,
 * marked do-not-knock, flagged as wrong info, or their coordinates went. That
 * count is shown rather than swallowed, so a route that comes back eight stops
 * long instead of twelve explains itself.
 */
export function rehydrateRoute(
  saved: SavedRoute,
  doors: Map<string, Household>
): { stops: Stop[]; missing: number } {
  const stops: Stop[] = [];
  let missing = 0;
  for (const key of saved.stops) {
    const h = doors.get(key);
    if (!h || h.lat == null || h.lng == null) {
      missing++;
      continue;
    }
    stops.push({ lead: h.primary, lat: h.lat, lng: h.lng, hh: h });
  }
  return { stops, missing };
}

/** Doors on the route still to knock. */
export function remainingCount(r: SavedRoute): number {
  const done = new Set(r.done);
  return r.stops.filter((k) => !done.has(k)).length;
}

/**
 * A name you'd recognise on a list a week later: where it goes and when you
 * built it. The town beats the street — "Pleasant Garden · Aug 6" places the
 * route instantly, "Neelley Rd · Aug 6" makes you think.
 */
export function suggestRouteName(stops: Stop[], when: Date = new Date()): string {
  const day = when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const first = stops[0]?.lead;
  const town = String(first?.city || "").trim();
  const street = String(first?.address || "")
    .split(",")[0]
    .replace(/^\s*\d+\s*/, "")
    .trim();
  const where = town || street;
  return where ? `${where} · ${day}` : `Route · ${day}`;
}

/** How long ago, in the words you'd use out loud. */
export function savedAgo(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((now.getTime() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
