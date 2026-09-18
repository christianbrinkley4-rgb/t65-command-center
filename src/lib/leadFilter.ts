// One filter definition, used by every page that picks who to work.
//
// The Power List, the Dial Session and Door Knock were each growing their own
// row of dropdowns. Same questions every time — which towns, which ZIPs, which
// list, what are their houses worth, when do they turn 65 — answered by three
// separate piles of code that drifted apart. This is the single answer.
//
// Rules that hold everywhere:
//   An empty array means NO RESTRICTION. An untouched filter must never hide
//   a lead, and it keeps "clear" and "select none" from meaning the same thing.
//   Within one filter the picks are OR; across filters they are AND.

import { birthMonth, listLabel, MONTH_UNKNOWN } from "./categories";
import { matchesOccupancy, matchesValueBand, type Occupancy } from "./valueBands";
import { trustedHomeValue } from "./homeValue";
import { withinMiles, type DistanceOrigin } from "./distance";
import type { LatLng } from "./route";
import type { Lead } from "./types";

export type LeadFilterState = {
  cities: string[];
  zips: string[];
  lists: string[];      // source or tag — a lead can be on several
  months: string[];     // month they turn 65; MONTH_UNKNOWN for "no date"
  counties: string[];
  band: string;
  includeUnpriced: boolean;
  occupancy: Occupancy;
  /** Miles from `origin`; 0 means no restriction. */
  maxMiles: number;
  origin: DistanceOrigin;
  includeUnmapped: boolean;
  lastDialed: "any" | "never" | "today" | "7" | "30" | "older";
  results: string[];
  dialCount: "any" | "0" | "1-2" | "3+" | "5+";
};

export const emptyFilter: LeadFilterState = {
  cities: [], zips: [], lists: [], months: [], counties: [],
  band: "any", includeUnpriced: true, occupancy: "any",
  maxMiles: 0, origin: "office", includeUnmapped: true,
  lastDialed: "any", results: [], dialCount: "any",
};

export const cityOf = (l: Lead) => (l.city || "Unknown city").trim();
export const zipOf = (l: Lead) => (l.zip || "").trim();
export const countyOf = (l: Lead) => (l.county || "Unknown").trim();

/** How many questions the user has actually answered. Shown on the button. */
export function activeCount(f: LeadFilterState): number {
  return (
    (f.cities.length ? 1 : 0) +
    (f.zips.length ? 1 : 0) +
    (f.lists.length ? 1 : 0) +
    (f.months.length ? 1 : 0) +
    (f.counties.length ? 1 : 0) +
    (f.band !== "any" ? 1 : 0) +
    (f.occupancy !== "any" ? 1 : 0) +
    (f.maxMiles > 0 ? 1 : 0)
    + (f.lastDialed !== "any" ? 1 : 0)
    + (f.results.length ? 1 : 0)
    + (f.dialCount !== "any" ? 1 : 0)
  );
}

/**
 * `sharedAddress` says whether several leads live at this street address, which
 * is how an apartment gets a seven-figure "home value". Callers that have the
 * whole book pass it; the rest get the other three checks, which is most of it.
 */
export function matchesFilter(
  lead: Lead,
  f: LeadFilterState,
  sharedAddress = false,
  /** Where "within N miles" is measured from. Null disables the distance test. */
  origin: LatLng | null = null
): boolean {
  if (f.cities.length && !f.cities.includes(cityOf(lead))) return false;
  if (f.zips.length && !f.zips.includes(zipOf(lead))) return false;
  if (f.counties.length && !f.counties.includes(countyOf(lead))) return false;
  if (f.lists.length) {
    // The list is "T65 April" or "General leads". Tags (smartasset, prospect,
    // pipeline) sit in the same menu because they're the useful cross-cuts.
    const onList =
      f.lists.includes(listLabel(lead.source)) ||
      (lead.tags || []).some((t) => f.lists.includes(t));
    if (!onList) return false;
  }
  if (f.months.length) {
    const m = birthMonth(lead.birthday);
    if (!f.months.includes(m === null ? String(MONTH_UNKNOWN) : String(m))) return false;
  }
  if (!matchesValueBand(trustedHomeValue(lead, sharedAddress), f.band, f.includeUnpriced)) return false;
  if (!matchesOccupancy(lead.home_owner_occupied, f.occupancy)) return false;
  if (!withinMiles(lead, origin, f.maxMiles, f.includeUnmapped)) return false;
  const last = lead.last_contact_date || lead.oscr_last_disp_date || null;
  if (f.lastDialed !== "any") {
    if (f.lastDialed === "never" && last) return false;
    if (f.lastDialed !== "never") {
      if (!last) return false;
      const day = new Date(`${last.slice(0, 10)}T00:00:00`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const age = Math.floor((today.getTime() - day.getTime()) / 86400000);
      if (isNaN(day.getTime())) return false;
      if (f.lastDialed === "today" && age !== 0) return false;
      if (f.lastDialed === "7" && (age < 0 || age > 7)) return false;
      if (f.lastDialed === "30" && (age < 0 || age > 30)) return false;
      if (f.lastDialed === "older" && age <= 30) return false;
    }
  }
  if (f.results.length) {
    const result = String(lead.status || lead.oscr_latest_disp || "").trim().toLowerCase();
    if (!f.results.some((r) => {
      if (r === "no-answer") return /no answer|no_answer/.test(result);
      if (r === "voicemail") return /voicemail|vm/.test(result);
      if (r === "talked") return /talked|interested|not ready|contacted/.test(result);
      if (r === "closed") return result.startsWith("closed") || /not interested|wrong number|deceased/.test(result);
      return false;
    })) return false;
  }
  const dials = Number(lead.dials_count || 0);
  if (f.dialCount === "0" && dials !== 0) return false;
  if (f.dialCount === "1-2" && (dials < 1 || dials > 2)) return false;
  if (f.dialCount === "3+" && dials < 3) return false;
  if (f.dialCount === "5+" && dials < 5) return false;
  return true;
}

export type Option = { value: string; label: string; count?: number };

function tally(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of items) if (k) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

const asOptions = (counts: Map<string, number>): Option[] =>
  Array.from(counts.keys())
    .sort()
    .map((v) => ({ value: v, label: v, count: counts.get(v) }));

/**
 * The menus, built from whatever pool the page is working with, so the counts
 * are true for that page. ZIPs narrow to the chosen towns — a menu of 60 ZIPs
 * you can't reach is worse than no menu.
 */
export function buildOptions(pool: Lead[], f: LeadFilterState) {
  const zipPool = f.cities.length ? pool.filter((l) => f.cities.includes(cityOf(l))) : pool;
  return {
    cities: asOptions(tally(pool.map(cityOf))),
    zips: asOptions(tally(zipPool.map(zipOf))),
    counties: asOptions(tally(pool.map(countyOf))),
    lists: asOptions(
      tally([...pool.map((l) => listLabel(l.source)), ...pool.flatMap((l) => l.tags || [])])
    ),
  };
}

/** Drop ZIPs that don't exist in the towns just chosen. */
export function pruneZips(pool: Lead[], nextCities: string[], zips: string[]): string[] {
  if (!nextCities.length) return zips;
  return zips.filter((z) =>
    pool.some((l) => nextCities.includes(cityOf(l)) && zipOf(l) === z)
  );
}
