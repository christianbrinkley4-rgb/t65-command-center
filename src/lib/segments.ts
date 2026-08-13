// The piles you can work, defined once.
//
// The Power List and the Dial Session each used to carry their own SEGMENTS
// array and their own inSegment() switch, and they had already drifted: the
// Dial Session knew about "Follow-ups" and "Talked before", the Power List knew
// about "Needs outcome", "DNC" and "Needs info", and neither knew about the
// other's. Two lists that are supposed to mean the same thing and don't is how
// a lead ends up visible in one place and invisible in the other.
//
// One list, with each segment declaring which surfaces offer it.
//
// The important distinction a segment carries is where its leads come from:
//
//   "queue" — runs through buildQueue first, so the pile only ever contains
//             leads that are actually callable right now (no DNC, no booked
//             appointment, no dead record, no missing phone).
//   "book"  — reads the whole book. These piles are deliberately NOT callable;
//             they exist so you can see and fix them. A DNC lead has to be
//             listable or you can't audit your own suppression list.
//
// Getting that backwards is what made the DNC segment come back empty for a
// while: it was being filtered through the queue that exists to hide it.

import {
  awaitingAppointmentOutcome,
  buildQueue,
  iepPhase,
  isFresh,
  nextDueMoment,
  scoreLead,
  workedToday,
} from "./priority";
import { askedNotToBeCalled, needsInfo, onScrubList } from "./types";
import { canonicalPhone } from "./phone";
import type { ScoredLead } from "./priority";
import type { LeadWithBucket } from "./types";

export type Surface = "list" | "session";

export type Segment = {
  key: string;
  label: string;
  /** Where the pile comes from. See the note at the top of this file. */
  source: "queue" | "book";
  match: (lead: LeadWithBucket, ctx: SegmentContext) => boolean;
  /** Ordering, when priority score isn't the right answer. */
  sort?: (a: ScoredLead, b: ScoredLead) => number;
  /** What this pile is and what you're supposed to do with it. */
  blurb: string;
  /** "warn" for piles that mean something is wrong and waiting on you. */
  tone?: "neutral" | "warn";
  on: Surface[];
};

/** Facts a segment can't work out from one lead on its own. */
export type SegmentContext = {
  /** Canonical phone numbers that more than one live lead answers to. */
  duplicatePhones: Set<string>;
};

export function segmentContext(leads: LeadWithBucket[]): SegmentContext {
  const counts = new Map<string, number>();
  for (const l of leads) {
    const p = canonicalPhone(l.phone);
    if (p) counts.set(p, (counts.get(p) || 0) + 1);
  }
  const duplicatePhones = new Set<string>();
  for (const [phone, n] of counts) if (n > 1) duplicatePhones.add(phone);
  return { duplicatePhones };
}

const byAppointmentSoonest = (a: ScoredLead, b: ScoredLead) =>
  String(a.appointment_datetime).localeCompare(String(b.appointment_datetime));
const byAppointmentLatest = (a: ScoredLead, b: ScoredLead) =>
  String(b.appointment_datetime).localeCompare(String(a.appointment_datetime));

export const SEGMENTS: Segment[] = [
  {
    key: "all",
    label: "All",
    source: "queue",
    match: () => true,
    blurb: "Everything callable, best first. Due work floats up; behind it the queue flows into never-dialed leads so it never comes back empty.",
    on: ["list", "session"],
  },
  {
    key: "fresh",
    label: "Fresh",
    source: "queue",
    match: (l) => isFresh(l),
    blurb: "Arrived in the last 72 hours and never worked. Speed-to-lead: these convert several times better called today than called Friday.",
    on: ["list", "session"],
  },
  {
    key: "overdue",
    label: "Overdue",
    source: "queue",
    match: (l) => l._bucket === "Overdue",
    blurb: "You said you'd call and the date has passed. Oldest promise first.",
    on: ["list", "session"],
  },
  {
    key: "today",
    label: "Due today",
    source: "queue",
    match: (l) => l._bucket === "DueToday",
    blurb: "Owed a call today. Clear this before dialing anything cold.",
    on: ["list", "session"],
  },
  {
    key: "week",
    label: "This week",
    source: "queue",
    match: (l) => l._bucket === "ThisWeek",
    blurb: "Coming due in the next seven days. Worth pulling forward on a slow afternoon.",
    on: ["list", "session"],
  },
  {
    key: "followup",
    label: "Follow-ups",
    source: "book",
    // Reads the whole book on purpose. The dial queue now hides anything
    // booked for later, which is right when you're asking "who can I call
    // now" and wrong when you're asking "what have I promised" — this is the
    // second question, so it shows the future ones too, soonest first.
    match: (l) =>
      Boolean(l.next_follow_up_date) || (l._actions || []).some((a) => a.status === "pending"),
    sort: (a, b) => {
      const at = nextDueMoment(a)?.getTime() ?? Infinity;
      const bt = nextDueMoment(b)?.getTime() ?? Infinity;
      return at - bt;
    },
    blurb: "Every promise you've made — a callback date or a planned action — soonest first, including the ones not due yet. The dial queue hides those until their hour comes round; this is where you see them.",
    on: ["list", "session"],
  },
  {
    key: "workedtoday",
    label: "Worked today",
    source: "book",
    match: (l) => workedToday(l),
    sort: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
    blurb: "Everyone you got a result on today. They're deliberately out of the dial queue until their callback comes round — this is where to check what you did, or fix a misclick.",
    on: ["list"],
  },
  {
    key: "knocked",
    label: "Knocked",
    source: "book",
    // The book, not the queue, and deliberately so. A door knock closes leads
    // ("not interested"), takes them off the knock list ("do not knock") or
    // flags the record as wrong, and every one of those is a RESULT you need to
    // be able to look up. Running this through the callable queue would hide
    // exactly the outcomes worth reading.
    match: (l) => (l.knock_count || 0) > 0 || Boolean(l.last_knock_date),
    sort: (a, b) => String(b.last_knock_date || "").localeCompare(String(a.last_knock_date || "")),
    blurb:
      "Every door you've already knocked, most recent first, including the ones a knock closed or marked do not knock. Open a lead to read what was said at the door. Door Knock mode has the same list grouped by day with the outcome on each card.",
    on: ["list"],
  },
  {
    key: "talked",
    label: "Talked before",
    source: "queue",
    match: (l) => /talked|contacted|interested|not ready|callback/i.test(String(l.status || "")),
    blurb: "Someone picked up before. Warmer than a cold list, and a different opening.",
    on: ["list", "session"],
  },
  {
    key: "t65",
    label: "T65 hot",
    source: "queue",
    match: (l) => {
      const p = iepPhase(l.birthday);
      return p === "hot" || p === "birthday" || p === "closing";
    },
    blurb: "Inside the enrollment window — three months out, the birthday month, or the three months before it shuts. This is the money.",
    on: ["list", "session"],
  },
  {
    key: "new",
    label: "Never dialed",
    source: "queue",
    match: (l) => l._bucket === "New",
    blurb: "Nobody has worked these, here or in OSCR. Raw inventory.",
    on: ["list", "session"],
  },
  {
    key: "appts",
    label: "Appointments",
    source: "book",
    match: (l) => Boolean(l.appointment_datetime) && new Date(l.appointment_datetime!) >= new Date(),
    sort: byAppointmentSoonest,
    blurb: "Booked and still ahead of you. These are deliberately out of the dial queue — you don't cold-call someone you're seeing Tuesday.",
    on: ["list"],
  },
  {
    key: "apptdue",
    label: "Needs outcome",
    source: "book",
    match: (l) => awaitingAppointmentOutcome(l),
    sort: byAppointmentLatest,
    blurb: "The appointment has been and gone and nobody said what happened. Mark it held or a no-show and the lead goes back to work — the show rate on Stats is only worth reading if these get answered.",
    tone: "warn",
    on: ["list"],
  },
  {
    key: "dupes",
    label: "Duplicates",
    source: "book",
    match: (l, ctx) => {
      const p = canonicalPhone(l.phone);
      return Boolean(p) && ctx.duplicatePhones.has(p);
    },
    blurb: "Numbers that more than one row answers to. Two rows for one person get a merge button; a couple sharing a landline is listed separately and deliberately can't be merged, because they're two people with two enrollment windows.",
    on: ["list"],
  },
  {
    key: "dnc",
    label: "Asked to stop",
    source: "book",
    match: (l) => askedNotToBeCalled(l) || Boolean(l._dncSuppressed),
    blurb: "People who told us to stop calling, and anyone sharing their number. These are the only leads a do-not-call flag actually suppresses — 22 of them, nearly all recorded on a live call. Bulk list scrubs are a separate thing and stay in the queue.",
    tone: "warn",
    on: ["list"],
  },
  {
    key: "scrublist",
    label: "On a DNC list",
    source: "book",
    match: (l) => onScrubList(l),
    blurb: "Flagged by a bulk list scrub inherited from OSCR, not by the person — most have never been contacted by anyone. They stay in the calling queue and carry a chip so you know what you're looking at.",
    on: ["list"],
  },
  {
    key: "badinfo",
    label: "Needs info",
    source: "book",
    match: (l) => needsInfo(l),
    blurb: "A dead record, not a dead lead: wrong name, wrong address, someone else living there. Fix the details and it goes straight back into the queue.",
    on: ["list"],
  },
  {
    key: "oscr",
    label: "Needs OSCR update",
    source: "book",
    match: (l) => Boolean(l.needs_oscr_writeback),
    blurb: "Results recorded here that haven't been pushed to OSCR, which is still the system of record. Enter them, then clear the flag.",
    on: ["list"],
  },
];

export function segmentsFor(surface: Surface): Segment[] {
  return SEGMENTS.filter((s) => s.on.includes(surface));
}

export function findSegment(key: string): Segment {
  return SEGMENTS.find((s) => s.key === key) || SEGMENTS[0];
}

/**
 * Build one pile. This is the single place that decides whether a segment gets
 * the callable queue or the whole book, so the two surfaces can never disagree.
 */
export function buildSegment(
  key: string,
  scoped: LeadWithBucket[],
  ctx: SegmentContext
): ScoredLead[] {
  const seg = findSegment(key);
  let out: ScoredLead[];
  if (seg.source === "queue") {
    out = buildQueue(scoped);
    if (seg.key !== "all") out = out.filter((l) => seg.match(l, ctx));
  } else {
    out = scoped.filter((l) => seg.match(l, ctx)).map(scoreLead);
  }
  return seg.sort ? out.sort(seg.sort) : out.sort((a, b) => b._score - a._score);
}
