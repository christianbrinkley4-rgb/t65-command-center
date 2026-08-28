// Two rows, one person.
//
// 104 leads share 52 phone numbers, because the same household arrived on the
// April T65 list, the SmartAsset pull and a Nextdoor thread. Until now the app
// could only WARN about that — a "dupe" chip on the row and a count on Stats —
// and the fix was to open Supabase. So the warning fired forever and the two
// rows stayed, which means half of somebody's history is on a record you aren't
// looking at while you're on the phone with them.
//
// types.ts has described the intended shape of a merge since the beginning and
// nothing ever wrote it: the loser keeps its row (leads are never deleted and
// history is append-only) but stops being a lead — it becomes a tombstone
// pointing at the survivor, and useLeads filters it out of every screen.
//
// Three rules this follows, in order of importance:
//
//   1. Never lose a fact. Blank fields on the survivor get filled from the
//      loser; fields that disagree keep the survivor's value and the loser's
//      goes into the notes, verbatim, rather than being thrown away.
//   2. Never lose a suppression. Do-not-call, do-not-knock and consent flags
//      are OR-ed. A merge can only ever make the surviving record MORE
//      restricted, never less.
//   3. Never orphan history. Calls, knocks, notes and pending tasks are
//      repointed at the survivor. That isn't rewriting what happened — it's
//      re-attaching it to the record that still exists.

import { supabase } from "./supabaseClient";
import { logActivity, todayStr } from "./sequences";
import { mergeTags } from "./categories";
import { canonicalPhone, samePhone } from "./phone";
import { MERGED_STATUS } from "./types";
import type { Lead, LeadWithBucket } from "./types";

/**
 * A shared phone number is NOT a duplicate.
 *
 * This is the single most dangerous assumption in the whole feature, and the
 * live book proves it: Randall Cox and Kimberly Cox share 336-342-2410 and
 * 205 Glencoe Church Loop. So do Karen and Peter Resh, Kelly and Michaela
 * Smith, Amy and Theodore Mead. They are married couples on one landline — two
 * people, two birthdays, two separate enrollment windows (Randall turns 65 in
 * March 2027, Kimberly in May). Merging them would delete a real lead and take
 * their T65 date with it.
 *
 * The old `_dupe` chip had the same false positives, but it only ever WARNED.
 * A merge button acts, so it has to be much more certain than a chip.
 *
 * The test is deliberately strict, because the two mistakes are not
 * symmetrical: a missed duplicate stays visible in the households list below
 * and can be merged next week, while a wrongly merged couple is gone. So
 * nicknames are not accepted ("Kim" and "Kimberly" stay separate, and so do
 * "Jo" and "Joseph", who are a couple), and neither are bare initials.
 *
 * The surname rule earned its exception from the data. Requiring last names to
 * match found nothing at all in a book of 43 shared numbers — because all three
 * real duplicates in it are name changes: Deborah Chamberlain and Deborah
 * Eddins at 6835 Harry Ct, Lou Franklin and Lou Hood at 301 Windsor Manor Way,
 * Mary Degraffenridt and Mary Ward. Each pair shares a phone AND an exact date
 * of birth, which is what makes a differing surname read as a maiden name
 * rather than a second person: one household does not contain two people with
 * the same first name born on the same day.
 */
function looksLikeSamePerson(a: LeadWithBucket, b: LeadWithBucket): boolean {
  const dobA = a.birthday ? String(a.birthday).slice(0, 10) : "";
  const dobB = b.birthday ? String(b.birthday).slice(0, 10) : "";
  // Two different dates of birth is two different people, whatever the names
  // say. This is the rule that keeps every couple apart on its own.
  if (dobA && dobB && dobA !== dobB) return false;
  const sameDob = Boolean(dobA) && dobA === dobB;

  const parts = (l: LeadWithBucket) =>
    String(l.name || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const na = parts(a);
  const nb = parts(b);

  // A row with no name at all, on a number that already belongs to someone, is
  // an import fragment rather than a second person.
  if (na.length === 0 || nb.length === 0) return true;

  const firstA = na[0];
  const firstB = nb[0];
  const lastA = na.length > 1 ? na[na.length - 1] : "";
  const lastB = nb.length > 1 ? nb[nb.length - 1] : "";

  // The load-bearing guard. Randall and Kimberly Cox never get past this.
  if (firstA !== firstB) return false;
  // Different surnames need the date of birth to vouch for them.
  if (lastA && lastB && lastA !== lastB) return sameDob;
  return true;
}

/** Every set of leads answering to one 10-digit number, largest first. */
function groupByPhone(leads: LeadWithBucket[]): LeadWithBucket[][] {
  const byPhone = new Map<string, LeadWithBucket[]>();
  for (const l of leads) {
    const p = canonicalPhone(l.phone);
    if (p.length !== 10) continue;
    byPhone.set(p, [...(byPhone.get(p) || []), l]);
  }
  return Array.from(byPhone.values()).filter((group) => group.length > 1);
}

export type PhoneGroups = {
  /** Same number AND the same person. Safe to merge. */
  duplicates: LeadWithBucket[][];
  /** Same number, different people — a household. Never merge these. */
  households: LeadWithBucket[][];
};

export function duplicateGroups(leads: LeadWithBucket[]): PhoneGroups {
  const duplicates: LeadWithBucket[][] = [];
  const households: LeadWithBucket[][] = [];

  for (const group of groupByPhone(leads)) {
    const sorted = [...group].sort(rankSurvivorFirst);
    // Every member has to look like the same person as the best record. One
    // stranger in the group makes the whole group a household, because merging
    // "all of these" is the button on offer.
    const same = sorted.every((l) => l.id === sorted[0].id || looksLikeSamePerson(sorted[0], l));
    (same ? duplicates : households).push(sorted);
  }

  const bySize = (a: LeadWithBucket[], b: LeadWithBucket[]) => b.length - a.length;
  return { duplicates: duplicates.sort(bySize), households: households.sort(bySize) };
}

/**
 * The row that should survive, first.
 *
 * Most worked wins: the record carrying the dials and the last conversation is
 * the one whose id is already on the activity rows, the OSCR link and anyone's
 * muscle memory. Ties go to the more complete record, then the older one.
 */
function rankSurvivorFirst(a: LeadWithBucket, b: LeadWithBucket): number {
  const work = (l: LeadWithBucket) =>
    (l.dials_count || 0) + (l.knock_count || 0) + (l.last_contact_date ? 5 : 0) + (l.oscr_lead_id ? 3 : 0);
  if (work(a) !== work(b)) return work(b) - work(a);
  const filled = (l: LeadWithBucket) =>
    [l.name, l.birthday, l.address, l.email, l.phone2, l.lead_profile].filter(Boolean).length;
  if (filled(a) !== filled(b)) return filled(b) - filled(a);
  return String(a.created_at || "").localeCompare(String(b.created_at || ""));
}

/**
 * Columns the app derives for itself. A disagreement in one of these is not a
 * decision anybody makes — the survivor's address already tells you why its
 * coordinates and parcel value differ, and printing six more lines about
 * latitude and geocoded_at buries the one line that matters. Blanks still fill
 * from the other row; only the reporting is suppressed.
 *
 * oscr_lead_id is deliberately NOT in here: two OSCR links means the merge
 * drops one, and that is worth saying out loud.
 */
const QUIET_CONFLICTS = new Set<keyof Lead>([
  "latitude", "longitude", "geocoded_at", "state",
  "home_value", "home_value_source", "home_value_checked_at",
  "home_owner_occupied", "home_property_type",
  "oscr_lead_source", "oscr_status", "oscr_latest_disp", "oscr_last_disp_date",
  "oscr_score", "oscr_owner",
]);

/** Column names read like a schema. This is a safety dialog, so use English. */
const FIELD_LABEL: Partial<Record<keyof Lead, string>> = {
  name: "name",
  birthday: "date of birth",
  lead_profile: "what they told SmartAsset",
  oscr_lead_id: "OSCR record",
  zip: "ZIP",
  county: "county",
  tier: "tier",
};

const label = (key: keyof Lead): string =>
  FIELD_LABEL[key] || String(key).replace(/_/g, " ");

const firstOf = <T,>(...vals: (T | null | undefined)[]): T | null =>
  vals.find((v) => v !== null && v !== undefined && v !== "") ?? null;

const earliest = (a: string | null, b: string | null): string | null =>
  a && b ? (a <= b ? a : b) : a || b;
const latest = (a: string | null, b: string | null): string | null =>
  a && b ? (a >= b ? a : b) : a || b;

/**
 * What the survivor will look like afterwards, without writing anything. The
 * UI shows this before you commit, because a merge is the one operation here
 * that isn't a single-click undo.
 */
export function previewMerge(survivor: Lead, loser: Lead): { patch: Partial<Lead>; kept: string[]; conflicts: string[] } {
  const kept: string[] = [];
  const conflicts: string[] = [];

  const patch: Partial<Lead> = {};

  // A genuinely different second line is worth keeping — the same number in
  // two formats is not (see altPhone).
  const loserPhone = loser.phone || loser.phone2;
  if (!survivor.phone2 && loserPhone && !samePhone(survivor.phone, loserPhone)) {
    patch.phone2 = loserPhone;
    kept.push(`second number ${loserPhone}`);
  }

  const fillable: (keyof Lead)[] = [
    "name", "email", "birthday", "address", "city", "county", "zip", "state",
    "lead_profile", "tier", "latitude", "longitude", "geocoded_at",
    "home_value", "home_value_source", "home_value_checked_at",
    "home_owner_occupied", "home_property_type",
    "oscr_lead_id", "oscr_lead_source", "oscr_status", "oscr_latest_disp",
    "oscr_last_disp_date", "oscr_score", "oscr_owner",
  ];
  for (const key of fillable) {
    const mine = survivor[key];
    const theirs = loser[key];
    const missing = mine === null || mine === undefined || mine === "";
    const haveTheirs = theirs !== null && theirs !== undefined && theirs !== "";
    if (missing && haveTheirs) {
      (patch as Record<string, unknown>)[key] = theirs;
      // Timestamps are bookkeeping. "takes its geocoded_at from the other row"
      // is not a thing anyone needs to be told.
      if (!String(key).endsWith("_at")) kept.push(`${label(key)} from the other row`);
    } else if (
      !missing &&
      haveTheirs &&
      String(mine) !== String(theirs) &&
      !QUIET_CONFLICTS.has(key)
    ) {
      conflicts.push(`${label(key)}: keeping "${mine}", the other row said "${theirs}"`);
    }
  }

  // Counters add up. Two records with four dials each is a person who has been
  // called eight times, and pretending otherwise is how they get called a ninth.
  patch.dials_count = (survivor.dials_count || 0) + (loser.dials_count || 0);
  patch.knock_count = (survivor.knock_count || 0) + (loser.knock_count || 0);
  patch.last_contact_date = latest(survivor.last_contact_date, loser.last_contact_date);
  patch.last_knock_date = latest(survivor.last_knock_date, loser.last_knock_date);

  // Suppressions only ever tighten.
  patch.do_not_call = Boolean(survivor.do_not_call || loser.do_not_call);
  // A recorded request outranks a list scrub: if either row says the person
  // asked, the survivor says so too.
  patch.dnc_reason = patch.do_not_call
    ? survivor.dnc_reason === "requested" || loser.dnc_reason === "requested"
      ? "requested"
      : "scrubbed"
    : null;
  patch.do_not_knock = Boolean(survivor.do_not_knock || loser.do_not_knock);
  patch.soa_on_file = Boolean(survivor.soa_on_file || loser.soa_on_file);
  patch.ptc_on_file = Boolean(survivor.ptc_on_file || loser.ptc_on_file);
  patch.soa_date = firstOf(survivor.soa_date, loser.soa_date);
  if (loser.do_not_call && !survivor.do_not_call) kept.push("do-not-call flag from the other row");

  // Consent goes the other way: an explicit NO on either row wins, and
  // otherwise you take whatever is actually known.
  //
  // These columns are nullable, and null means "nobody ever asked" — not "they
  // said no". AND-ing them would turn silence into a denial, so merging a
  // SmartAsset lead who really did opt in with a tracker row that has no
  // consent column at all would quietly revoke a permission you legitimately
  // hold. Only a recorded `false` may take consent away.
  const noWorse = (a: boolean | null, b: boolean | null): boolean | null =>
    a === false || b === false ? false : a ?? b;
  patch.callable = noWorse(survivor.callable, loser.callable);
  patch.sms_consent = noWorse(survivor.sms_consent, loser.sms_consent);
  patch.email_consent = noWorse(survivor.email_consent, loser.email_consent);

  // The soonest commitment wins — you keep the earlier promise.
  patch.next_follow_up_date = earliest(survivor.next_follow_up_date, loser.next_follow_up_date);
  patch.appointment_datetime = firstOf(survivor.appointment_datetime, loser.appointment_datetime);
  if (!survivor.appointment_datetime && loser.appointment_datetime) {
    kept.push("appointment from the other row");
  } else if (
    survivor.appointment_datetime &&
    loser.appointment_datetime &&
    survivor.appointment_datetime !== loser.appointment_datetime
  ) {
    // Two booked appointments for one person is a real thing to know about,
    // and dropping one silently is how somebody gets stood up.
    conflicts.push(
      `appointment: keeping ${new Date(survivor.appointment_datetime).toLocaleString()}, the other row was booked for ${new Date(loser.appointment_datetime).toLocaleString()}`
    );
  }

  // The loser's tags come across whole, which is what carries its mailer drops
  // onto the surviving record. Nothing synthesizes a list: tag for the loser's
  // source any more — the source column already says where the row came from.
  patch.tags = mergeTags(survivor.tags, loser.tags || []);

  // Both note blobs, both labelled. Anything the loop above refused to
  // overwrite is written down here so it survives in readable form.
  const trail = [
    `[${todayStr()} merged] Folded in a duplicate row (${loser.source || "unknown list"}).`,
    ...conflicts.map((c) => `  ${c}`),
    String(loser.raw_notes || loser.notes || "").trim(),
  ]
    .filter(Boolean)
    .join("\n");
  patch.raw_notes = [trail, String(survivor.raw_notes || "").trim()].filter(Boolean).join("\n\n");

  return { patch, kept, conflicts };
}

/**
 * Do it. The survivor is updated, the loser's history is repointed, and the
 * loser becomes a tombstone that every screen already knows to ignore.
 */
export async function mergeLeads(
  survivor: LeadWithBucket,
  loser: LeadWithBucket,
  me: string
): Promise<void> {
  if (survivor.id === loser.id) throw new Error("A lead can't be merged into itself.");

  // Read the survivor back before computing anything.
  //
  // The caller holds whatever row it was rendering, which is stale in two ways
  // that both lose data. Folding three rows into one runs this twice, and the
  // second pass built its patch from the ORIGINAL survivor — so
  // dials_count came out as original + third, silently dropping the second
  // row's dials, and raw_notes overwrote the first merge's audit trail. The
  // other way is two people merging different duplicates of the same person at
  // the same desk. Both are fixed by reading the current row here rather than
  // trusting the copy in the browser.
  const { data: fresh, error: readError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", survivor.id)
    .single();
  if (readError) throw readError;
  const current = { ...survivor, ...(fresh as Lead) };

  const { patch, kept } = previewMerge(current, loser);

  const { error: updateError } = await supabase
    .from("leads")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", survivor.id);
  if (updateError) throw updateError;

  // Re-attach the history. Best-effort per table: `calls` only exists once the
  // telephony migration has run, and a project without it must still merge.
  await supabase.from("activity_log").update({ lead_id: survivor.id }).eq("lead_id", loser.id);
  await supabase.from("lead_actions").update({ lead_id: survivor.id }).eq("lead_id", loser.id);
  await supabase.from("calls").update({ lead_id: survivor.id }).eq("lead_id", loser.id).then(
    () => undefined,
    () => undefined
  );

  const { error: tombError } = await supabase
    .from("leads")
    .update({
      status: MERGED_STATUS,
      stage_bucket: "Closed",
      next_follow_up_date: null,
      appointment_datetime: null,
      raw_notes: `[${todayStr()} merged by ${me}] This row was folded into lead ${survivor.id} (${current.name || "unnamed"}). Kept for the audit trail; it is not a lead any more.`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", loser.id);
  if (tombError) throw tombError;

  await logActivity(
    survivor.id,
    "Merge",
    "Folded in a duplicate",
    [`Merged the ${loser.source || "duplicate"} row for ${loser.name || "this person"}.`, ...kept].join(" · "),
    me
  ).catch(() => {});
}
