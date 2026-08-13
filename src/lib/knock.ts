// Door-knock mode: the field twin of dispositions.ts.
//
// Knocking has its own compliance axis. do_not_call means the PHONE is off
// limits — those leads are often the best knock targets (it's the only way
// left to reach them, and the team's real routes are built exactly that way).
// do_not_knock means the DOOR is off limits (resident said don't come back).
// The two never imply each other.

import { localYmd, plusDays, todayStr } from "./sequences";
import { writeOrQueue } from "./offline";
import { canonicalStreet, MULTI_UNIT_LEADS } from "./homeValue";
import { isClosedStatus, NEEDS_INFO_STAGE, NEEDS_INFO_STATUS } from "./types";
import type { Activity, Lead, LeadWithBucket } from "./types";

export type KnockOutcome = {
  key: string;
  label: string;
  /** null = leave lead status alone (a knock attempt isn't a contact) */
  status: string | null;
  stage: string | null;
  followUpDays: number | null;
  closes: boolean;
  doNotKnock?: boolean;
};

export const KNOCK_OUTCOMES: KnockOutcome[] = [
  { key: "nh", label: "Not home", status: null, stage: null, followUpDays: null, closes: false },
  { key: "flyer", label: "Left flyer", status: null, stage: null, followUpDays: null, closes: false },
  { key: "int", label: "Talked - Interested", status: "Talked - Interested", stage: "Worked - Follow Up", followUpDays: 3, closes: false },
  { key: "nr", label: "Talked - Not Ready", status: "Talked - Not Ready", stage: "Worked - Follow Up", followUpDays: 30, closes: false },
  { key: "ni", label: "Not interested", status: "Closed - Not Interested", stage: "Closed", followUpDays: null, closes: true },
  // Wrong house, wrong name, they moved, someone else lives here. The record is
  // bad, not the lead — it drops off the knock list and waits in the Needs info
  // segment for a correction instead of being closed out.
  { key: "info", label: "Wrong info", status: NEEDS_INFO_STATUS, stage: NEEDS_INFO_STAGE, followUpDays: null, closes: false },
  { key: "dnk", label: "Do not knock", status: null, stage: null, followUpDays: null, closes: false, doNotKnock: true },
];

export type KnockResult = "sent" | "queued";

export async function applyKnock(
  lead: LeadWithBucket,
  o: KnockOutcome,
  me: string
): Promise<KnockResult> {
  const patch: Record<string, unknown> = {
    knock_count: (lead.knock_count || 0) + 1,
    last_knock_date: todayStr(),
    updated_at: new Date().toISOString(),
  };
  if (o.status) {
    patch.status = o.status;
    patch.stage_bucket = o.stage;
    patch.last_contact_date = todayStr();
    patch.next_follow_up_date = o.followUpDays !== null ? plusDays(todayStr(), o.followUpDays) : null;
  }
  if (o.doNotKnock) patch.do_not_knock = true;
  if (lead.oscr_lead_id && o.status) {
    patch.needs_oscr_writeback = true;
    patch.oscr_writeback_note = `Door knock: ${o.status}`;
  }
  // Never throws on a network failure — the write is queued on the phone and
  // replayed later. Losing a knock because a driveway had no bars is not an
  // acceptable outcome, and neither is telling the agent it saved when it did
  // not, so the return value says which happened.
  const where = `${lead.name || "lead"} — ${String(lead.address || "").split(",")[0]}`;
  const leadWrite = await writeOrQueue({
    table: "leads",
    op: "update",
    match: { id: lead.id },
    payload: patch,
    label: `${o.label} · ${where}`,
  });
  const logWrite = await writeOrQueue({
    table: "activity_log",
    op: "insert",
    payload: {
      lead_id: lead.id,
      activity_type: "Door Knock",
      outcome: o.label,
      notes: null,
      logged_by: me,
      activity_date: new Date().toISOString(),
    },
    label: `Log: ${o.label} · ${where}`,
  });

  if (o.key === "int" && leadWrite === "sent") {
    // Only chase the follow-up action when we're actually online; queued knocks
    // get theirs on the next sync rather than failing noisily here.
    const { autoFollowUpOnInterested } = await import("./dispositions");
    await autoFollowUpOnInterested(lead, me).catch(() => {});
  }
  return leadWrite === "sent" && logWrite === "sent" ? "sent" : "queued";
}

// ── households ───────────────────────────────────────────────────────────────
//
// A married couple is two leads at one front door. Rendered as two cards you
// knock the same house twice and the route counts it as two stops, so the unit
// of work in the field is the HOUSEHOLD, not the lead.

export type Household = {
  key: string;
  /** Whoever we lead with — the highest-value / soonest-T65 occupant. */
  primary: Lead;
  occupants: Lead[];
  address: string;
  city: string;
  lat: number | null;
  lng: number | null;
};

export function householdKey(lead: Lead): string {
  const first = String(lead.address || "").split(",")[0].trim().toUpperCase();
  const num = (first.match(/^\s*(\d+)/) || [])[1] || "";
  const street = canonicalStreet(first.replace(/^\d+\s*/, ""));
  const city = String(lead.city || "").trim().toUpperCase();
  // No usable address: keep the lead on its own so it can't be merged wrongly.
  if (!num || !street) return `LEAD:${lead.id}`;
  return `${city}|${num}|${street}`;
}

/**
 * Street addresses carrying enough leads to be a building rather than a house.
 *
 * The apartment rows in this book mostly have NO unit number — that's exactly
 * why the parcel matcher stamped the whole complex's value on them without
 * anything looking wrong. Six people at one street address is the tell.
 */
export function multiUnitAddressKeys(leads: Lead[]): Set<string> {
  const counts = new Map<string, number>();
  for (const l of leads) {
    const k = householdKey(l);
    if (k.startsWith("LEAD:")) continue; // no usable address, can't say
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = new Set<string>();
  for (const [k, n] of counts) if (n >= MULTI_UNIT_LEADS) out.add(k);
  return out;
}

export function groupByHousehold(leads: Lead[]): Household[] {
  const map = new Map<string, Lead[]>();
  for (const l of leads) {
    const k = householdKey(l);
    const arr = map.get(k);
    if (arr) arr.push(l);
    else map.set(k, [l]);
  }
  const out: Household[] = [];
  for (const [key, occupants] of map) {
    // Lead with the occupant whose 65th birthday lands soonest; that's the one
    // whose enrollment window drives the conversation at the door.
    const sorted = [...occupants].sort((a, b) => {
      const ab = a.birthday || "9999";
      const bb = b.birthday || "9999";
      return ab.localeCompare(bb);
    });
    const primary = sorted[0];
    const withCoords = occupants.find((o) => o.latitude != null && o.longitude != null);
    out.push({
      key,
      primary,
      occupants: sorted,
      address: primary.address || "",
      city: primary.city || "",
      lat: withCoords ? (withCoords.latitude as number) : null,
      lng: withCoords ? (withCoords.longitude as number) : null,
    });
  }
  return out;
}

// ── knocked history ──────────────────────────────────────────────────────────
//
// The other half of a knock list: the doors already worked and what happened at
// them. The lead row only remembers how many times and on what day, so the
// result itself comes back out of the activity log.

export type KnockRecord = {
  /** ISO timestamp of the knock. */
  at: string;
  outcome: string;
  by: string | null;
  note: string | null;
};

/** A knock with no logged outcome — an old import, or a log row we never got. */
export const UNLOGGED_OUTCOME = "Knocked";

// A note is something typed at a door that may not have been dispositioned yet,
// so it can't stand as the door's result.
const NOT_A_RESULT = new Set(["Note"]);

/**
 * What the door-knock undo writes. The phone side logs its own Undo rows
 * ("Reverted last disposition"), and counting those as knock reversals would
 * quietly erase a real result on any lead that was both called and knocked.
 */
export const KNOCK_UNDO_OUTCOME = "Reverted last door knock";

/**
 * Newest door-knock outcome per lead id, out of raw activity_log rows.
 *
 * Undo doesn't delete anything — the log is append-only, so a reverted knock
 * leaves its row behind next to an "Undo" row. Pass the Undo rows in and each
 * one cancels the knock it reverted, otherwise a door you fixed ten seconds
 * later still reads back as "not interested".
 */
export function latestKnockByLead(rows: Activity[]): Map<string, KnockRecord> {
  const byLead = new Map<string, Activity[]>();
  for (const r of rows) {
    if (!r.lead_id || !r.activity_date) continue;
    if (r.activity_type !== "Door Knock" && r.activity_type !== "Undo") continue;
    if (!Number.isFinite(Date.parse(r.activity_date))) continue;
    const arr = byLead.get(r.lead_id);
    if (arr) arr.push(r);
    else byLead.set(r.lead_id, [r]);
  }
  const out = new Map<string, KnockRecord>();
  for (const [id, list] of byLead) {
    // Newest first, so "the knock an undo reverted" is simply the next one down.
    list.sort((a, b) => Date.parse(b.activity_date as string) - Date.parse(a.activity_date as string));
    let reverted = 0;
    for (const r of list) {
      if (r.activity_type === "Undo") {
        if (String(r.outcome || "").trim() === KNOCK_UNDO_OUTCOME) reverted += 1;
        continue;
      }
      const outcome = String(r.outcome || "").trim();
      if (!outcome || NOT_A_RESULT.has(outcome)) continue;
      if (reverted > 0) {
        reverted -= 1;
        continue;
      }
      out.set(id, { at: r.activity_date as string, outcome, by: r.logged_by, note: r.notes });
      break;
    }
  }
  return out;
}

export type KnockedDoor = {
  hh: Household;
  /** What happened last time. Null when the knock predates the activity log. */
  result: KnockRecord | null;
  /** Local calendar day of the last knock, YYYY-MM-DD. "" if never recorded. */
  day: string;
  /** Most knocks any occupant has taken — the door's count, not the lead's. */
  knocks: number;
  /** Resident asked us not to come back. */
  doNotKnock: boolean;
  /** Every occupant is closed out, so the door is finished either way. */
  closed: boolean;
  /** Sort key: the knock's timestamp where we have one, else noon on its day. */
  at: number;
};

/**
 * Turn worked households into results, newest first.
 *
 * The day comes from whichever is later: the log row or the lead's
 * last_knock_date. They disagree whenever a knock was recorded offline and the
 * activity row is still sitting in the queue, and in that case the lead row is
 * the one telling the truth about when someone stood at the door.
 */
export function knockedDoors(
  households: Household[],
  byLead: Map<string, KnockRecord>
): KnockedDoor[] {
  const out: KnockedDoor[] = [];
  for (const hh of households) {
    let result: KnockRecord | null = null;
    for (const o of hh.occupants) {
      const r = byLead.get(o.id);
      if (r && (!result || Date.parse(r.at) > Date.parse(result.at))) result = r;
    }
    const stamped = hh.occupants
      .map((o) => (o.last_knock_date || "").slice(0, 10))
      .filter(Boolean)
      .sort()
      .pop();
    const loggedDay = result ? localYmd(new Date(result.at)) : "";
    const day = stamped && stamped > loggedDay ? stamped : loggedDay;
    if (!day) continue; // nothing says this door was ever knocked
    out.push({
      hh,
      result: day === loggedDay ? result : null,
      day,
      knocks: Math.max(...hh.occupants.map((o) => o.knock_count || 0), 0),
      doNotKnock: hh.occupants.some((o) => o.do_not_knock === true),
      closed: hh.occupants.every((o) => o.stage_bucket === "Closed" || isClosedStatus(o.status)),
      at:
        day === loggedDay && result
          ? Date.parse(result.at)
          : Date.parse(day + "T12:00:00"),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

export function knockOutcome(d: KnockedDoor): string {
  return d.result?.outcome || UNLOGGED_OUTCOME;
}

/** Counts per outcome, in the order the buttons sit at a door. */
export function knockOutcomeTally(doors: KnockedDoor[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const d of doors) {
    const k = knockOutcome(d);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const known = KNOCK_OUTCOMES.map((o) => o.label);
  const rest = Array.from(counts.keys())
    .filter((k) => !known.includes(k) && k !== UNLOGGED_OUTCOME)
    .sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
  return [...known, ...rest, UNLOGGED_OUTCOME]
    .filter((label) => counts.has(label))
    .map((label) => ({ label, count: counts.get(label) as number }));
}

export type KnockDay = { day: string; label: string; doors: KnockedDoor[] };

export function knockDayLabel(day: string): string {
  const today = todayStr();
  if (day === today) return "Today";
  if (day === plusDays(today, -1)) return "Yesterday";
  const d = new Date(day + "T12:00:00");
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Group results into days, newest day first. Input must already be sorted. */
export function groupKnockedByDay(doors: KnockedDoor[]): KnockDay[] {
  const map = new Map<string, KnockedDoor[]>();
  for (const d of doors) {
    const arr = map.get(d.day);
    if (arr) arr.push(d);
    else map.set(d.day, [d]);
  }
  return Array.from(map.entries()).map(([day, list]) => ({
    day,
    label: knockDayLabel(day),
    doors: list,
  }));
}

// ── walking-order grouping ────────────────────────────────────────────────────

export type StreetGroup = { city: string; street: string; households: Household[] };

function houseNumber(address: string | null): number {
  const m = String(address || "").match(/^\s*(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Display name for a street: the part of the address after the house number. */
function streetLabel(address: string | null): string {
  const first = String(address || "").split(",")[0].trim();
  return first.replace(/^\d+\s*/, "") || "No street on file";
}

/**
 * Group leads by (city, canonical street) and order for walking: streets
 * alphabetically inside each city, house numbers ascending inside each street.
 * Canonicalization folds "W Friendly Ave" / "Friendly Avenue" together.
 */
/** Takes households (not leads) so "already worked" filtering happens once. */
export function groupByStreet(households: Household[]): StreetGroup[] {
  const groups = new Map<string, StreetGroup>();
  for (const h of households) {
    const city = (h.city || "Unknown city").trim();
    const label = streetLabel(h.address);
    const key = `${city.toUpperCase()}|${canonicalStreet(label) || label.toUpperCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { city, street: label, households: [] };
      groups.set(key, g);
    }
    g.households.push(h);
  }
  const out = Array.from(groups.values());
  for (const g of out) {
    g.households.sort((a, b) => houseNumber(a.address) - houseNumber(b.address));
  }
  out.sort((a, b) => a.city.localeCompare(b.city) || a.street.localeCompare(b.street));
  return out;
}
