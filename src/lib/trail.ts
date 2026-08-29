// What has already been done to this person, in one line.
//
// The question this answers is asked in two directions and the old app could
// answer neither. Walking up to a door: has anyone called this house, and did
// we mail it? On the phone: have we already knocked this door, so do I lead
// with "I stopped by last week" instead of introducing myself cold?
//
// The facts existed — dials_count, knock_count, last_contact_date,
// last_knock_date, the mailer tags — but they were scattered across the edit
// drawer and the stats page, which is nowhere near the moment you need them.
//
// Deliberately only the three touches that are OURS: mail, phone, door. Status
// and stage are a judgement about the lead; this is a record of what we did.

import { isMailerTag, mailerLabel, mailerDate } from "./categories";
import type { Lead } from "./types";

export type TouchKind = "mailer" | "dial" | "knock";

export type Touch = {
  kind: TouchKind;
  /** Short enough to sit on a dense row: "Mailed Aug 21", "3 dials". */
  label: string;
  /** The long version, for a title attribute. */
  detail: string;
};

/**
 * "2026-08-21" → "Aug 21", and "2026-07" → "in Jul" for a drop whose day
 * nobody recorded. Parsed off the string rather than through Date, which
 * would shift the day back for anyone east of UTC and label the 21st the 20th.
 */
function shortDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(iso || ""));
  if (!m) return "";
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = names[Number(m[2]) - 1];
  if (!mon) return "";
  const year = m[1] === String(new Date().getFullYear()) ? "" : ` ${m[1]}`;
  return m[3] ? `${mon} ${Number(m[3])}${year}` : `in ${mon}${year}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Every touch on this lead, mail first because it happened first and it is the
 * one the door opener leans on.
 *
 * Returns an empty array for an untouched lead, which is itself the answer:
 * nothing rendered means nobody has done anything here yet.
 */
export function contactTrail(lead: Lead): Touch[] {
  const out: Touch[] = [];

  // A door can be on two drops. Show the most recent, and say so.
  const drops = (lead.tags || []).filter(isMailerTag);
  if (drops.length) {
    const dated = drops
      .map((t) => ({ tag: t, iso: mailerDate(t) }))
      .sort((a, b) => (b.iso || "").localeCompare(a.iso || ""));
    const newest = dated[0];
    const when = newest.iso ? shortDate(newest.iso) : "";
    const extra = drops.length > 1 ? ` +${drops.length - 1}` : "";
    out.push({
      kind: "mailer",
      label: when ? `Mailed ${when}${extra}` : `Mailed${extra}`,
      detail:
        drops.length > 1
          ? `On ${drops.length} mailer drops: ${drops.map(mailerLabel).join(", ")}`
          : `Mailer drop: ${mailerLabel(newest.tag)}`,
    });
  }

  const dials = Number(lead.dials_count || 0);
  const worked = shortDate(lead.last_contact_date);
  if (dials > 0) {
    out.push({
      kind: "dial",
      label: worked ? `${plural(dials, "dial")} · ${worked}` : plural(dials, "dial"),
      detail: worked
        ? `${plural(dials, "dial")}, last worked ${worked}`
        : `${plural(dials, "dial")}, no contact date recorded`,
    });
  } else if (worked) {
    // Contacted, but the dial counter never got incremented — logged before
    // the counter existed, or worked by hand. Keying off dials alone reported
    // these as never touched.
    out.push({
      kind: "dial",
      label: `Worked ${worked}`,
      detail: `Contacted ${worked}, no dial count recorded`,
    });
  }

  const knocks = Number(lead.knock_count || 0);
  if (knocks > 0) {
    const when = shortDate(lead.last_knock_date);
    out.push({
      kind: "knock",
      label: when ? `${plural(knocks, "knock")} · ${when}` : plural(knocks, "knock"),
      detail: when
        ? `${plural(knocks, "knock")}, last one ${when}`
        : `${plural(knocks, "knock")}, no date recorded`,
    });
  }

  return out;
}

/**
 * The same trail for a whole door rather than one person.
 *
 * A knock is a property of the DOOR — knocking once reaches everyone inside —
 * so knocks take the max across occupants rather than the sum, which would
 * report a couple as knocked twice. Dials are per-person and do add up. Mailer
 * drops union, because one card to the household covers all of them.
 */
export function householdTrail(occupants: Lead[]): Touch[] {
  if (!occupants.length) return [];
  const latest = (vals: (string | null | undefined)[]) =>
    vals.filter(Boolean).sort().pop() || null;
  const merged = {
    tags: Array.from(new Set(occupants.flatMap((o) => o.tags || []))),
    dials_count: occupants.reduce((n, o) => n + Number(o.dials_count || 0), 0),
    knock_count: Math.max(0, ...occupants.map((o) => Number(o.knock_count || 0))),
    last_contact_date: latest(occupants.map((o) => o.last_contact_date)),
    last_knock_date: latest(occupants.map((o) => o.last_knock_date)),
  } as Lead;
  return contactTrail(merged);
}

/** One-line version for places too tight for chips. "" when never touched. */
export function trailSummary(lead: Lead): string {
  return contactTrail(lead)
    .map((t) => t.label)
    .join(" · ");
}

/** Has anyone done anything to this lead at all? */
export const isUntouched = (lead: Lead): boolean => contactTrail(lead).length === 0;
