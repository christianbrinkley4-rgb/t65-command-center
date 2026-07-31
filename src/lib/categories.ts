// Categories are additive, never exclusive.
//
// A lead that came in on the Pleasant Garden mailing list is ALSO a May
// birthday, and might also be an OSCR turning-65 lead. The old model forced one
// answer — `source` is a single column, and an import that matched an existing
// lead kept whichever list got there first — so picking "May" threw away the
// neighborhood list and picking the list threw away the month.
//
// Three kinds of category, all stackable:
//   list    — where the lead came from (source, plus a `list:` tag per import,
//             so a lead on two lists carries both)
//   month   — the month they turn 65, derived from the birthday, never stored
//   tag     — anything typed by hand (mailer drops, campaigns, "spanish")

import type { Lead } from "./types";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Month filter value for "we don't know when they turn 65". */
export const MONTH_UNKNOWN = -1;

/** 1-12 for the month they turn 65 (same as the birth month), null if unknown. */
export function birthMonth(birthday: string | null | undefined): number | null {
  if (!birthday) return null;
  const m = String(birthday).match(/^\d{4}-(\d{2})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}

export function birthMonthLabel(birthday: string | null | undefined): string | null {
  const m = birthMonth(birthday);
  return m ? MONTH_NAMES[m - 1] : null;
}

/**
 * "OSCR:Turning 65" is not a category. Every lead in this book is turning 65,
 * so it made a filter entry that couldn't narrow anything, and it hid the
 * distinction that matters: WHICH MONTH they turn 65, which is derived from
 * the birthday and already stacks with every other filter.
 *
 * Collapsed to plain "OSCR" (the channel, which Source ROI still needs). Other
 * OSCR pulls keep their own label, because "OSCR:GLIA EBD Annuity" is a
 * genuinely different kind of lead.
 */
export function normalizeSource(source: string | null | undefined): string {
  const s = String(source || "").trim();
  if (/^oscr\s*:?\s*turning\s*65$/i.test(s)) return "OSCR";
  return s || "Unknown";
}

/**
 * What LIST a lead came off, in the only vocabulary that means anything here.
 *
 * `source` had grown sixteen values — OSCR, TrackerLeads_T65Apr, T65 27406,
 * T65 Kernersville, ProspectSheet, BusinessTracker — which made the list menu
 * a tour of import history rather than a way to choose work. There are really
 * only two kinds of lead: one that came off a monthly T65 list, and one that
 * didn't. So the menu says "T65 April" or "General leads", and the month
 * filter (which is derived from the birthday) does the rest — pick May and you
 * get the T65 May list AND every other lead with a May birthday, which is what
 * you actually wanted.
 */
export const GENERAL_LIST = "General leads";

const MONTH_FROM_SOURCE = /t65\s*[_-]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

export function listLabel(source: string | null | undefined): string {
  const m = MONTH_FROM_SOURCE.exec(String(source || ""));
  if (!m) return GENERAL_LIST;
  const i = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(m[1].toLowerCase());
  return i >= 0 ? `T65 ${MONTH_NAMES[i]}` : GENERAL_LIST;
}

/** Slug for a list name, so the same list always produces the same tag. */
export function listTag(name: string): string {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `list:${slug}` : "";
}

/**
 * Union, case-insensitive, order preserved. An import ADDS its list tag; it
 * never replaces what's already on the lead — that's the whole point.
 */
export function mergeTags(existing: string[] | null | undefined, add: string[]): string[] {
  const out = [...(existing || [])];
  const seen = new Set(out.map((t) => t.toLowerCase()));
  for (const t of add) {
    const v = String(t || "").trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** Every bucket this lead belongs to, for display and for filter menus. */
export function leadCategories(lead: Lead): string[] {
  const cats: string[] = [];
  if (lead.source) cats.push(lead.source);
  for (const t of lead.tags || []) cats.push(t);
  const month = birthMonthLabel(lead.birthday);
  if (month) cats.push(`${month} birthdays`);
  return cats;
}
