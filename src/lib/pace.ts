// Ten appointments a week, translated into what to do before lunch.
//
// A target nobody can convert into today's actions is a poster, not a plan.
// "Book 10 a week" is true and useless at 9am on a Wednesday; "you are 3 behind
// and that is 95 mobile dials or 40 doors today" is something a person can act
// on. This file does that translation, and it does it from measured rates
// rather than assumed ones, so the number moves as the book does.
//
// Everything here is computed from the activity log on each render. Nothing is
// stored, nothing is trained, and the numbers correct themselves as more calls
// land. The same principle as lib/coach.ts, for the same reason.
//
// THE MEASURED CHAIN, AS OF WRITING
//
// Dialing leads that carry a mobile, over 1,262 such dials:
//
//   12.8% hit a dead number
//   10.1% of the live ones reach a real conversation
//   15.3% of conversations book an appointment
//
// Multiplied out that is one appointment per 74 mobile dials. Across the whole
// book, mobiles and landlines together, it is one per 116, because 30.6% of
// all dials hit a dead number against 12.8% of mobile ones. Dialing mobiles
// first is worth about a third of the work.
//
// Ten a week therefore costs roughly 743 mobile dials, or 149 a working day.
// That is a real number and it is a big one; it is the honest cost of the
// target and the reason doors and the interested backlog matter so much.
//
// Doors are a separate chain with a far better contact rate and, so far, a
// booking rate of zero across 114 knocks. Rather than pretend, perDoor stays
// null until the door has actually booked something. A plan built on a
// conversion nobody has ever achieved is a plan to miss the target.

import { isConversation, isDial, classifyOutcome } from "./callOutcomes";
import type { Activity } from "./types";

/** Fewer than this behind a rate and it is a guess, not a measurement. */
const MIN_SAMPLE = 40;

export type Rates = {
  /** Share of dials that hit a dead number. */
  deadRate: number;
  /** Share of LIVE dials that reach a real conversation. */
  reachRate: number;
  /** Share of conversations that produce a booked appointment. */
  bookRate: number;
  /** Appointments per dial, the whole chain multiplied out. */
  perDial: number;
  /** Door knocks per appointment, or null when doors have never booked one. */
  perDoor: number | null;
  /** True when any link in the chain is below MIN_SAMPLE. */
  thin: boolean;
};

/**
 * The conversion chain, measured.
 *
 * `mobileOnly` restricts the dial rates to leads carrying a mobile, which is
 * what the queue now serves first. Passing the full set instead would quote a
 * blended rate that nobody actually experiences.
 */
export function measureRates(activity: Activity[], mobileLeadIds?: Set<string>): Rates {
  let dials = 0;
  let dead = 0;
  let conversations = 0;
  let doors = 0;
  let appts = 0;
  let doorAppts = 0;

  for (const a of activity) {
    const type = a.activity_type || "";
    if (isDial(type, a.outcome)) {
      // When a mobile set is supplied, only count dials to those leads.
      if (mobileLeadIds && (!a.lead_id || !mobileLeadIds.has(a.lead_id))) continue;
      dials++;
      if (classifyOutcome(a.outcome) === "bad-number") dead++;
      else if (isConversation(a.outcome)) conversations++;
    }
    // Appointments must be filtered by the SAME lead set as the dials, or the
    // book rate counts every appointment in the business against only the
    // mobile conversations and reports a rate nobody has ever achieved. That
    // bug quoted 20.7% against a true 12.8% and would have set a daily dial
    // target roughly half what it needed to be.
    if (type === "Appointment" && a.outcome === "Set") {
      if (!mobileLeadIds || (a.lead_id && mobileLeadIds.has(a.lead_id))) appts++;
    }
    if (type === "Door Knock" && a.outcome && a.outcome !== "Note") doors++;
  }

  const live = dials - dead;
  const deadRate = dials > 0 ? dead / dials : 0;
  const reachRate = live > 0 ? conversations / live : 0;
  const bookRate = conversations > 0 ? appts / conversations : 0;
  const perDial = (1 - deadRate) * reachRate * bookRate;

  return {
    deadRate,
    reachRate,
    bookRate,
    perDial,
    // Doors have produced no appointments at all so far. Returning a number
    // here would be inventing one.
    perDoor: doorAppts > 0 ? doors / doorAppts : null,
    thin: dials < MIN_SAMPLE || conversations < 10,
  };
}

export type Pace = {
  target: number;
  booked: number;
  behind: number;
  /** Working days left this week, counting today. Sunday is not one. */
  daysLeft: number;
  /** Appointments needed per remaining working day. */
  perDay: number;
  /** Mobile dials that implies today, or null when the rates are too thin. */
  dialsToday: number | null;
  onTrack: boolean;
};

/** Monday start, Sunday excluded, matching the Stats week. */
export function workingDaysLeft(now = new Date()): number {
  const dow = now.getDay(); // 0 Sunday
  if (dow === 0) return 0;
  return 6 - dow + 1; // Mon=5 ... Sat=1
}

export function pacing(
  bookedThisWeek: number,
  rates: Rates,
  target = 10,
  now = new Date()
): Pace {
  const behind = Math.max(0, target - bookedThisWeek);
  const daysLeft = Math.max(workingDaysLeft(now), 0);
  const perDay = daysLeft > 0 ? behind / daysLeft : behind;
  // Guard the divide: an untested book has perDial 0 and would ask for
  // infinity dials, which is worse than admitting we don't know yet.
  const dialsToday = rates.perDial > 0.0005 && !rates.thin ? Math.ceil(perDay / rates.perDial) : null;
  return {
    target,
    booked: bookedThisWeek,
    behind,
    daysLeft,
    perDay,
    dialsToday,
    onTrack: bookedThisWeek >= target,
  };
}

/** Appointments booked since Monday, from the log rather than lead status. */
export function bookedThisWeek(activity: Activity[], now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return activity.filter(
    (a) =>
      a.activity_type === "Appointment" &&
      a.outcome === "Set" &&
      a.activity_date &&
      new Date(a.activity_date).getTime() >= start.getTime()
  ).length;
}
