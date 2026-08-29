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

// ---------------------------------------------------------------------------
// The list menu, after the pruning.
//
// The menu used to be a tour of import history: "T65 April", "General leads",
// `list:t65-april`, `smartasset`, `prospect`, `pipeline`, `merged` — sixteen
// entries, several of them two names for the same pile, none of them a decision
// you actually make. Worse, "T65 April" and the April birth-month filter meant
// almost the same thing, so the menu competed with the filter sitting next to
// it.
//
// There are only two questions worth asking of a list: did this door get a
// piece of mail, and has anyone ever actually spoken to this person. Town and
// birth month are their own filters and always were; they do the rest.

export const MAILER_PREFIX = "mailer:";

/**
 * A mailer tag is the DATE the batch dropped: `mailer:2026-08-21`.
 *
 * It used to be the town, which was the wrong key. One drop covers several
 * towns — the 08-21 batch is Gibsonville and McLeansville and Browns Summit —
 * so naming it after a town either splits one drop into three lists or picks
 * one town and hides the others. The date is what the batch actually is, it is
 * the thing the follow-up schedule keys off, and two drops to the same town a
 * month apart stay separate instead of collapsing into each other.
 *
 * Town is still answerable: the town filter sits three menus over.
 */
export function mailerTag(dateOrName: string): string {
  const v = String(dateOrName || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${MAILER_PREFIX}${iso[1]}-${iso[2]}-${iso[3]}`;
  // Month precision, for a drop somebody remembers the month of and not the
  // day. Better than inventing a day: the follow-up cadence keys off the
  // enrollment window anyway, and a made-up date reads as fact forever.
  const month = /^(\d{4})-(\d{2})$/.exec(v);
  if (month) return `${MAILER_PREFIX}${month[1]}-${month[2]}`;
  const slug = v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `${MAILER_PREFIX}${slug}` : "";
}

/**
 * The drop date behind a tag: "2026-08-21", or "2026-07" when only the month
 * is known. Null for an older town-named one. Sorts correctly either way,
 * because a month prefix orders against a full date exactly as you'd want.
 */
export function mailerDate(tag: string): string | null {
  if (!isMailerTag(tag)) return null;
  const m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(tag.slice(MAILER_PREFIX.length));
  return m ? m[0] : null;
}

export const isMailerTag = (tag: string): boolean =>
  String(tag || "").toLowerCase().startsWith(MAILER_PREFIX);

/** `mailer:graham` reads as "Mailer Graham" in the menu and on the chip. */
export function mailerLabel(tag: string): string {
  if (!isMailerTag(tag)) return tag;
  const iso = mailerDate(tag);
  if (iso) {
    // Parsed off the string rather than through Date, which would shift the
    // day backwards for anyone east of UTC and label the 21st as the 20th.
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso) as RegExpExecArray;
    const [, y, mo, d] = m;
    const mon = MONTH_NAMES[Number(mo) - 1].slice(0, 3);
    const now = String(new Date().getFullYear());
    const year = y === now ? "" : ` ${y}`;
    // "Sent in Jul" says month-precision out loud, so it never reads as a
    // day-precision drop somebody can plan an eight-day knock off.
    return d ? `Sent ${mon} ${Number(d)}${year}` : `Sent in ${mon}${year}`;
  }
  const words = tag
    .slice(MAILER_PREFIX.length)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? `Mailer ${words.join(" ")}` : "Mailer";
}

/**
 * Which mailer drops this lead is on. A door mailed twice is on both, and
 * both should find it.
 *
 * This is the whole list menu. Everything else that used to live here was a
 * second name for a filter sitting next to it: "T65 December" for the birth
 * month, an OSCR or import-source pile for provenance nobody chooses work by,
 * a town for the town filter. A mailer drop is the one grouping the rest of
 * the app cannot express, because it records something we DID rather than
 * something the lead is.
 */
export function leadLists(lead: Lead): string[] {
  return (lead.tags || []).filter(isMailerTag);
}
