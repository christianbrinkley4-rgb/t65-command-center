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

import { birthMonth, leadLists, mailerDate, mailerLabel, MONTH_UNKNOWN } from "./categories";
import { classifyLeadResult } from "./callOutcomes";
import { householdKey } from "./knock";
import { matchesOccupancy, matchesValueBand, type Occupancy } from "./valueBands";
import { trustedHomeValue } from "./homeValue";
import { withinMiles, type DistanceOrigin } from "./distance";
import type { LatLng } from "./route";
import type { Lead } from "./types";

export type LeadFilterState = {
  cities: string[];
  zips: string[];
  lists: string[];      // mailer drop tags — a door mailed twice is on several
  months: string[];     // month they turn 65; MONTH_UNKNOWN for "no date"
  counties: string[];
  band: string;
  includeUnpriced: boolean;
  occupancy: Occupancy;
  /** Miles from `origin`; 0 means no restriction. */
  maxMiles: number;
  origin: DistanceOrigin;
  includeUnmapped: boolean;
  /** How long since anyone worked them. See WORKED_WINDOWS. */
  worked: string;
  /** What happened last time. Keys from LEAD_RESULT_OPTIONS; empty = any. */
  results: string[];
  /** Which kinds of line to dial. See LINE_TYPE_FILTERS. */
  lineType: string;
  /** How many times anyone has dialed them. */
  dialCount: "any" | "0" | "1-2" | "3+" | "5+";
};

export const emptyFilter: LeadFilterState = {
  cities: [], zips: [], lists: [], months: [], counties: [],
  band: "any", includeUnpriced: true, occupancy: "any",
  maxMiles: 0, origin: "office", includeUnmapped: true,
  worked: "any", results: [], lineType: "any", dialCount: "any",
};

/**
 * Which lines to dial.
 *
 * The whole book is typed against public NPA-NXX block assignments, and the
 * split is not close. Of the landlines in this book that anyone actually
 * dialed, 68.8% turned out to be dead numbers; for mobiles it was 11.8%. Good
 * outcomes ran 73 on mobiles against 13 on landlines. So "mobile only" is the
 * setting most calling sessions want, and it is one pick rather than a
 * standing argument.
 *
 * "Mobile only" is strict: it excludes the competitive-carrier blocks that
 * hold a mix of ported cells and ported landlines and genuinely cannot be told
 * apart, because a session you asked to be mobile should be mobile. "Skip
 * landlines" is the looser version that keeps those unknowns in. Default is
 * everything, so an untouched filter still never hides anyone.
 */
export const LINE_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "any", label: "Mobile and landline" },
  { value: "mobile", label: "Mobile only" },
  { value: "notlandline", label: "Skip known landlines" },
  { value: "fixed_line", label: "Landlines only" },
];

/**
 * Does either of this lead's numbers satisfy the line-type pick?
 *
 * Either, not just the primary: 272 leads carry a landline as their primary
 * and a mobile as their second, and the Dial Session rings the mobile for
 * those (see bestPhone). Judging them on the primary alone would filter out
 * the exact people the swap was built for.
 */
export function matchesLineType(lead: Lead, pick: string): boolean {
  if (!pick || pick === "any") return true;
  const types = [lead.phone_type, lead.phone2_type].filter(Boolean) as string[];
  if (pick === "mobile") return types.includes("mobile");
  if (pick === "fixed_line") return types.includes("fixed_line") && !types.includes("mobile");
  if (pick === "notlandline") {
    // Keep anything that isn't known-landline-only: mobiles, unknowns, and
    // untyped rows. Untyped is not evidence of anything and must not be
    // treated as a landline.
    if (!types.length) return true;
    return types.some((t) => t !== "fixed_line");
  }
  return true;
}

/**
 * How long since anyone worked this person.
 *
 * Reads last_contact_date, which a call, a door and a captured note all stamp.
 * That is deliberate and it is not a compromise: when you are deciding who to
 * dial in the next hour, someone whose door you knocked yesterday should be
 * just as suppressed as someone you called yesterday. Hence "worked", not
 * "called" — the label has to say what the field actually means, or a door
 * knocked on Tuesday reads as a call made on Tuesday.
 */
export const WORKED_WINDOWS: { value: string; label: string }[] = [
  { value: "any", label: "Worked any time" },
  { value: "today", label: "Worked today" },
  { value: "7d", label: "Worked in the last 7 days" },
  { value: "30d", label: "Worked in the last 30 days" },
  { value: "over7", label: "Not worked in over a week" },
  { value: "over30", label: "Not worked in over a month" },
  { value: "over90", label: "Not worked in over 3 months" },
  { value: "never", label: "Never worked at all" },
];

/** Whole days since a YYYY-MM-DD (or ISO) date. Null when there isn't one. */
export function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - d.getTime()) / 86400000);
}

export function matchesWorked(lead: Lead, window: string): boolean {
  if (!window || window === "any") return true;
  const n = daysSince(lead.last_contact_date);
  if (window === "never") return n === null;
  // A lead nobody has ever worked is not "not worked in over a week" — it has
  // its own option, and folding the two together makes the cold-list filters
  // return the entire untouched book.
  if (n === null) return false;
  if (window === "today") return n === 0;
  if (window === "7d") return n <= 7;
  if (window === "30d") return n <= 30;
  if (window === "over7") return n > 7;
  if (window === "over30") return n > 30;
  if (window === "over90") return n > 90;
  return true;
}

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
    (f.maxMiles > 0 ? 1 : 0) +
    (f.worked !== "any" ? 1 : 0) +
    (f.results.length ? 1 : 0) +
    (f.lineType !== "any" ? 1 : 0) +
    (f.dialCount !== "any" ? 1 : 0)
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
    // Mailer drops and nothing else. Everything that used to live here — T65
    // April, General leads, OSCR, smartasset, a town — was a second name for a
    // filter sitting right next to it.
    if (!leadLists(lead).some((l) => f.lists.includes(l))) return false;
  }
  if (f.months.length) {
    const m = birthMonth(lead.birthday);
    if (!f.months.includes(m === null ? String(MONTH_UNKNOWN) : String(m))) return false;
  }
  if (!matchesValueBand(trustedHomeValue(lead, sharedAddress), f.band, f.includeUnpriced)) return false;
  if (!matchesOccupancy(lead.home_owner_occupied, f.occupancy)) return false;
  if (!withinMiles(lead, origin, f.maxMiles, f.includeUnmapped)) return false;
  if (!matchesWorked(lead, f.worked)) return false;
  if (f.results.length && !f.results.includes(classifyLeadResult(lead))) return false;
  if (!matchesLineType(lead, f.lineType)) return false;
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
    lists: listOptions(pool),
  };
}

/**
 * The mailer menu: every drop present in this pool, newest first.
 *
 * Options carry the tag as their value and the readable date as their label,
 * which is what lets this sort chronologically. Sorting the labels instead
 * would put "Sent Aug 21" before "Sent Jul 28" because A precedes J, and a
 * menu of drops that isn't in drop order is worse than an unsorted one.
 */
function listOptions(pool: Lead[]): Option[] {
  // Per DOOR, not per lead. One card reaches the whole house, so a couple at
  // one address is one mailer — counting leads reported 16 for a 15-door drop.
  const seen = new Set<string>();
  const perDoor: string[] = [];
  for (const l of pool) {
    for (const tag of leadLists(l)) {
      const k = `${tag}|${householdKey(l)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      perDoor.push(tag);
    }
  }
  const counts = tally(perDoor);
  return Array.from(counts.keys())
    .sort((a, b) => {
      const da = mailerDate(a);
      const db = mailerDate(b);
      if (da && db) return db.localeCompare(da);   // newest drop first
      if (da) return -1;                           // dated drops above unnamed
      if (db) return 1;
      return a.localeCompare(b);
    })
    .map((v) => ({ value: v, label: mailerLabel(v), count: counts.get(v) }));
}

/** Drop ZIPs that don't exist in the towns just chosen. */
export function pruneZips(pool: Lead[], nextCities: string[], zips: string[]): string[] {
  if (!nextCities.length) return zips;
  return zips.filter((z) =>
    pool.some((l) => nextCities.includes(cityOf(l)) && zipOf(l) === z)
  );
}
