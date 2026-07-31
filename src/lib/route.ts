// Door-knock route optimization. Neighborhood routes are 5–30 stops, so a
// nearest-neighbour pass polished with 2-opt gets within a few percent of
// optimal instantly, in the browser, with no routing API and no key.
// Turn-by-turn is handed off to Google Maps via deep links.
//
// Distances are straight-line (haversine). For a subdivision that tracks real
// driving closely enough to rank stops correctly; it will understate mileage
// where a river or a highway forces a detour, so treat the total as a floor.

import type { Lead } from "./types";
import type { Household } from "./knock";

export type Stop = {
  /** The occupant we lead with; the door is the household. */
  lead: Lead;
  lat: number;
  lng: number;
  /** Every occupant behind this door, so one stop dispositions the whole house. */
  hh?: Household;
};

const EARTH_MI = 3958.8;

export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(s));
}

export type LatLng = { lat: number; lng: number };

const dist = (a: LatLng, b: LatLng) => haversineMiles(a.lat, a.lng, b.lat, b.lng);

/**
 * Order stops for minimal travel from `start`. Nearest-neighbour builds a tour,
 * 2-opt untangles the crossings.
 *
 * `end` fixes where the day finishes (the office, a next appointment). With no
 * end it is an open tour and you simply stop at the last door — that changes
 * the answer, so the final leg has to be inside the cost function rather than
 * bolted on afterwards.
 */
export function optimizeRoute(start: LatLng, stops: Stop[], end?: LatLng | null): Stop[] {
  if (stops.length <= 1) return [...stops];

  // Nearest neighbour from the start point.
  const remaining = [...stops];
  const route: Stop[] = [];
  let cur: LatLng = { lat: start.lat, lng: start.lng };
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(cur, remaining[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const next = remaining.splice(best, 1)[0];
    route.push(next);
    cur = { lat: next.lat, lng: next.lng };
  }

  // 2-opt. `tail` is the fixed finish when there is one, so reversing a segment
  // that touches the last stop is costed honestly.
  const tail: LatLng | null = end ?? null;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const prev = i === 0 ? start : route[i - 1];
        const afterK = k + 1 < route.length ? route[k + 1] : tail;
        const before = dist(prev, route[i]) + (afterK ? dist(route[k], afterK) : 0);
        const after = dist(prev, route[k]) + (afterK ? dist(route[i], afterK) : 0);
        if (after + 1e-9 < before) {
          let lo = i;
          let hi = k;
          while (lo < hi) {
            const t = route[lo];
            route[lo] = route[hi];
            route[hi] = t;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return route;
}

export function routeMiles(start: LatLng, route: Stop[], end?: LatLng | null): number {
  let total = 0;
  let cur: LatLng = start;
  for (const s of route) {
    total += dist(cur, s);
    cur = { lat: s.lat, lng: s.lng };
  }
  if (end && route.length) total += dist(cur, end);
  return total;
}

/**
 * Drop doors until the drive fits the mileage budget, always removing whichever
 * stop is costing the most detour. Keeps the dense cluster and sheds the
 * outliers, which is what you'd do by eye.
 * Returns the trimmed route — the caller still checks the final mileage, since
 * a budget smaller than the first leg can't be met by dropping anything.
 */
export function trimToBudget(
  start: LatLng,
  route: Stop[],
  maxMiles: number,
  end?: LatLng | null
): Stop[] {
  if (!maxMiles || maxMiles <= 0) return route;
  let cur = [...route];
  let guard = 0;
  while (cur.length > 1 && routeMiles(start, cur, end) > maxMiles && guard++ < 500) {
    const baseline = routeMiles(start, cur, end);
    let bestIdx = -1;
    let bestSave = -Infinity;
    for (let i = 0; i < cur.length; i++) {
      const without = cur.slice(0, i).concat(cur.slice(i + 1));
      const save = baseline - routeMiles(start, without, end);
      if (save > bestSave) {
        bestSave = save;
        bestIdx = i;
      }
    }
    // Nothing left worth dropping: the remaining doors sit on the way, and the
    // floor is the start->finish leg itself. Removing more would cost you doors
    // for no mileage back, so keep them and let the caller flag the overage.
    if (bestIdx < 0 || bestSave <= 0.01) break;
    cur.splice(bestIdx, 1);
    // Re-optimise the survivors; removing a stop can unlock a better order.
    cur = optimizeRoute(start, cur, end);
  }
  return cur;
}

// ── choosing WHICH doors ─────────────────────────────────────────────────────

export type RouteRequest = {
  start: LatLng;
  end?: LatLng | null;
  /** 0 = take every door that fits */
  maxStops: number;
  /** 0 = no mileage ceiling */
  maxMiles: number;
};

/** Cost of reaching a door at all: the detour it adds to the start→finish trip. */
function accessCost(start: LatLng, c: LatLng, end?: LatLng | null): number {
  if (!end) return dist(start, c);
  return dist(start, c) + dist(c, end) - dist(start, end);
}

/**
 * How tight a pocket of `n` doors sits around this one: the distance to its
 * (n-1)th nearest neighbour. Small number = a neighbourhood, big number = a
 * door standing alone.
 */
function pocketRadius(c: LatLng, pool: LatLng[], n: number): number {
  if (n <= 1) return 0;
  const ds: number[] = [];
  for (const p of pool) {
    if (p === c) continue;
    ds.push(dist(c, p));
  }
  ds.sort((a, b) => a - b);
  return ds[Math.min(n - 2, ds.length - 1)] ?? 0;
}

/** Miles added by dropping `s` into `route` at index `at` (path start→…→end). */
function insertionCost(
  start: LatLng,
  route: Stop[],
  at: number,
  s: Stop,
  end?: LatLng | null
): number {
  const before: LatLng = at === 0 ? start : route[at - 1];
  const after: LatLng | null = at < route.length ? route[at] : (end ?? null);
  if (!after) return dist(before, s);
  return dist(before, s) + dist(s, after) - dist(before, after);
}

/** Grow a route from one seed door, always adding the cheapest next door. */
function growFromSeed(
  seed: Stop,
  pool: Stop[],
  req: RouteRequest,
  cap: number
): Stop[] {
  const { start, end, maxMiles } = req;
  const route: Stop[] = [seed];
  const left = pool.filter((s) => s !== seed);
  while (route.length < cap && left.length) {
    let bestI = -1;
    let bestAt = 0;
    let bestCost = Infinity;
    for (let i = 0; i < left.length; i++) {
      for (let at = 0; at <= route.length; at++) {
        const c = insertionCost(start, route, at, left[i], end);
        if (c < bestCost) {
          bestCost = c;
          bestI = i;
          bestAt = at;
        }
      }
    }
    if (bestI < 0) break;
    const pick = left[bestI];
    if (maxMiles > 0) {
      const trial = [...route];
      trial.splice(bestAt, 0, pick);
      // Adding this door would blow the budget. Everything else left is at
      // least as expensive (we just took the cheapest), so we're done.
      if (routeMiles(start, trial, end) > maxMiles + 1e-9) break;
    }
    route.splice(bestAt, 0, pick);
    left.splice(bestI, 1);
  }
  return route;
}

/**
 * Choose WHICH doors to knock, then put them in order.
 *
 * Taking the N doors nearest the start point is the obvious rule and it is
 * wrong: nearest-to-start is a RING. Ten doors four miles out in ten different
 * directions beat a dense pocket that happens to start at 4.2 miles, so you
 * drive past twenty houses on the list to reach the next stop. What costs time
 * is the distance BETWEEN doors, not the distance from where you parked.
 *
 * So the set is grown by cheapest insertion: seed a pocket, then repeatedly add
 * whichever remaining door adds the fewest miles to the trip you already have.
 * A door 300 feet from one you've already taken costs nothing and gets picked
 * up; one five miles out has to earn its place. Several seeds are tried — the
 * tightest pockets and the door closest to the route — and the shortest full
 * route wins, so the answer doesn't ride on a lucky first pick.
 */
export function planRoute(stops: Stop[], req: RouteRequest): Stop[] {
  const { start, end, maxStops, maxMiles } = req;
  if (stops.length === 0) return [];

  if (maxStops <= 0 && maxMiles <= 0) return optimizeRoute(start, stops, end);

  // "No door limit" with a mileage ceiling still needs a working ceiling, or
  // the search grows with every door it adds and stalls the phone. Sixty doors
  // is well past a full day on foot.
  const NO_LIMIT_CAP = 60;
  const cap = Math.min(maxStops > 0 ? maxStops : NO_LIMIT_CAP, stops.length);

  // Candidate pool: doors that are cheap to reach at all. Generous on purpose —
  // this only exists to keep the search fast, not to pick the answer.
  const poolSize = Math.min(stops.length, Math.max(50, cap * 6, 0), 220);
  const pool =
    stops.length <= poolSize
      ? [...stops]
      : [...stops]
          .sort((a, b) => accessCost(start, a, end) - accessCost(start, b, end))
          .slice(0, poolSize);

  // Seeds: the tightest pockets (cheap to work) plus the easiest door to reach
  // (cheap to get to). Scoring both in miles keeps them comparable.
  const scored = pool.map((s) => ({
    stop: s,
    score: pocketRadius(s, pool, cap) + accessCost(start, s, end),
  }));
  scored.sort((a, b) => a.score - b.score);
  // Each seed costs a full greedy build, and a build gets more expensive as the
  // route gets longer — so try fewer of them on the big routes.
  const seedCount = cap > 30 ? 3 : 5;
  const seeds: Stop[] = scored.slice(0, seedCount).map((x) => x.stop);
  const nearest = [...pool].sort(
    (a, b) => accessCost(start, a, end) - accessCost(start, b, end)
  )[0];
  if (nearest && !seeds.includes(nearest)) seeds.push(nearest);

  let best: Stop[] = [];
  let bestMiles = Infinity;
  for (const seed of seeds) {
    const grown = optimizeRoute(start, growFromSeed(seed, pool, req, cap), end);
    const miles = routeMiles(start, grown, end);
    // More doors always wins; between equal door counts, take the shorter drive.
    if (grown.length > best.length || (grown.length === best.length && miles < bestMiles)) {
      best = grown;
      bestMiles = miles;
    }
  }
  // Belt and braces: a fixed finish can still push the total over budget.
  return maxMiles > 0 ? trimToBudget(start, best, maxMiles, end) : best;
}

/** Rough door-to-door time: neighborhood driving ~22 mph + ~3 min per stop. */
export function estimateMinutes(miles: number, stops: number): number {
  return Math.round((miles / 22) * 60 + stops * 3);
}

function addr(lead: Lead): string {
  const street = String(lead.address || "").split(",")[0].trim();
  return [street, lead.city || "", "NC", lead.zip || ""].filter(Boolean).join(", ");
}

export type MapLeg = { url: string; label: string; from: number; to: number };

/**
 * Google Maps deep links for turn-by-turn. Maps caps a single directions URL at
 * roughly ten points, so a long route is split into legs that each pick up where
 * the last one ended. Labels name the actual stop numbers ("Stops 1-9") rather
 * than an opaque leg index.
 */
/**
 * `endAddress` must be something Google can actually geocode — a street
 * address. Never pass a display label like "back where you started": it
 * becomes the destination in the URL and sends the driver somewhere random.
 * Omit it and the exact coordinates are used, which always works.
 */
export function googleMapsLegs(
  start: LatLng | null,
  route: Stop[],
  end?: LatLng | null,
  endAddress?: string
): MapLeg[] {
  const legs: MapLeg[] = [];
  if (!route.length) return legs;
  const PER_LEG = 9;
  for (let i = 0; i < route.length; i += PER_LEG) {
    const chunk = route.slice(i, i + PER_LEG);
    const points: string[] = [];
    if (i === 0 && start) points.push(`${start.lat},${start.lng}`);
    if (i > 0) points.push(addr(route[i - 1].lead));
    for (const s of chunk) points.push(addr(s.lead));
    const isLast = i + PER_LEG >= route.length;
    if (isLast && end) points.push(endAddress || `${end.lat},${end.lng}`);
    const from = i + 1;
    const to = i + chunk.length;
    legs.push({
      url: `https://www.google.com/maps/dir/${points.map((p) => encodeURIComponent(p)).join("/")}`,
      label:
        route.length <= PER_LEG
          ? "Open in Google Maps"
          : `Stops ${from}-${to}`,
      from,
      to,
    });
  }
  return legs;
}

/** Directions to one door — for mid-route "just get me to the next one". */
export function mapsLinkTo(stop: Stop, from?: LatLng | null): string {
  const dest = encodeURIComponent(addr(stop.lead));
  const origin = from ? `${from.lat},${from.lng}/` : "";
  return `https://www.google.com/maps/dir/${origin}${dest}`;
}
