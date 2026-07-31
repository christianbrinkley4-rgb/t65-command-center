import { effectiveDueDate } from "./buckets";
import { formatActionDue, nextPendingAction } from "./actions";
import { hasPriorWork, isClosedStatus, needsInfo } from "./types";
import { trustedHomeValue } from "./homeValue";
import type { LeadWithBucket } from "./types";

// Medicare IEP: 7 months around the 65th birthday month (3 before, the month,
// 3 after). "Hot" is the 3 months before the birthday month, when enrolling
// means coverage starts on time. "Closing" is the 3 months after, when the
// window is about to slam shut.
export type IepPhase = "approaching" | "hot" | "birthday" | "closing" | "outside" | null;

export function turning65Date(birthday: string | null): Date | null {
  if (!birthday) return null;
  const b = new Date(birthday + "T00:00:00");
  if (isNaN(b.getTime())) return null;
  return new Date(b.getFullYear() + 65, b.getMonth(), b.getDate());
}

// Whole months from the current month to the 65th-birthday month.
// Positive = birthday month is ahead of us.
export function monthsToBirthdayMonth(birthday: string | null): number | null {
  const t65 = turning65Date(birthday);
  if (!t65) return null;
  const now = new Date();
  return (t65.getFullYear() - now.getFullYear()) * 12 + (t65.getMonth() - now.getMonth());
}

export function iepPhase(birthday: string | null): IepPhase {
  const m = monthsToBirthdayMonth(birthday);
  if (m === null) return null;
  if (m >= 4 && m <= 6) return "approaching";
  if (m >= 1 && m <= 3) return "hot";
  if (m === 0) return "birthday";
  if (m >= -3 && m <= -1) return "closing";
  return "outside";
}

/**
 * "Jun 2027" — the month they turn 65. At a door this is the fact that decides
 * what you say, so it's shown on every card regardless of IEP phase (most of a
 * neighborhood list is a year out, which the phase badge alone hides).
 */
export function turns65Label(birthday: string | null): string | null {
  const t65 = turning65Date(birthday);
  if (!t65) return null;
  return t65.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export const IEP_LABEL: Record<Exclude<IepPhase, null>, string> = {
  approaching: "IEP in 4-6 mo",
  hot: "IEP hot window",
  birthday: "Turns 65 this month",
  closing: "IEP closing",
  outside: "Outside IEP",
};

const IEP_BOOST: Record<Exclude<IepPhase, null>, number> = {
  approaching: 25,
  hot: 50,
  birthday: 40,
  closing: 45,
  outside: 0,
};

function daysFromToday(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr.slice(0, 10) + "T00:00:00");
  if (isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export type ScoredLead = LeadWithBucket & { _score: number; _why: string[] };

export function scoreLead(lead: LeadWithBucket): ScoredLead {
  let score = 0;
  const why: string[] = [];

  const due = effectiveDueDate(lead, lead._enr);
  const df = daysFromToday(due);
  const action = nextPendingAction(lead._actions);
  const actionTime = action ? new Date(action.due_at) : null;

  if (action && actionTime && !isNaN(actionTime.getTime()) && actionTime.getTime() <= Date.now()) {
    const overdueDays = Math.floor((Date.now() - actionTime.getTime()) / 86400000);
    score += 230 + Math.min(overdueDays, 60);
    why.push(overdueDays > 0 ? `${action.action_type} action ${overdueDays}d overdue` : `${action.action_type} due now`);
  } else if (action && df === 0) {
    score += 95;
    why.push(`${action.action_type} today at ${formatActionDue(action.due_at).split(", ").slice(-1)[0]}`);
  } else if (df !== null && df <= 0) {
    const overdueDays = -df;
    score += 200 + Math.min(overdueDays, 60);
    why.push(overdueDays > 0 ? `${overdueDays}d overdue` : "due today");
  } else if (lead._bucket === "Verify") {
    score += 180;
    why.push("appointment needs verify");
  } else if (df !== null && df <= 7) {
    score += 80 - df * 5;
    why.push(`due in ${df}d`);
  } else if (lead._bucket === "New") {
    score += 40;
    why.push("never dialed");
  } else {
    score += 10;
  }

  if (lead._enr && lead._enr.status === "active" && df !== null && df <= 0) {
    why.push(`sequence step ${lead._enr.current_step}`);
  }

  const phase = iepPhase(lead.birthday);
  if (phase && phase !== "outside") {
    score += IEP_BOOST[phase];
    why.push(IEP_LABEL[phase]);
  }

  // Speed-to-lead: a brand-new, never-dialed lead is worth the most in its first
  // hours (aged/paid leads like SmartAsset convert far better called fast).
  // hasPriorWork, not dials_count: a lead imported from a tracker or OSCR with
  // nine attempts behind it has dials_count 0 here, and was being handed a
  // +170 "call now" bonus for work someone already did.
  if (!hasPriorWork(lead) && lead.created_at) {
    const hrs = (Date.now() - new Date(lead.created_at).getTime()) / 3_600_000;
    if (hrs >= 0 && hrs <= 24) {
      score += 170;
      why.unshift("just arrived — call now");
    } else if (hrs <= 72) {
      score += 80;
      why.push("fresh lead");
    }
  }

  // Trusted only: an apartment complex's parcel value would otherwise push a
  // renter to the top of the queue.
  const hv = Number(trustedHomeValue(lead) || 0);
  if (hv > 0) {
    score += Math.min(10, hv / 100000);
    if (hv >= 300000) why.push(`$${Math.round(hv / 1000)}k home`);
  }
  if ((lead.tier || "").toUpperCase().startsWith("A")) {
    score += 10;
    why.push("Tier A");
  }

  return { ...lead, _score: score, _why: why };
}

// The full ranked queue: every workable lead, best first. Due work floats to
// the top; when it runs out the queue flows into never-dialed leads, so it
// never comes back empty.
// A lead is dialable only if neither it nor any lead sharing its phone is DNC.
export function isDialable(lead: LeadWithBucket): boolean {
  return !lead.do_not_call && !lead._dncSuppressed;
}

/**
 * You booked them. They are not a call.
 *
 * This was the worst bug in the app: setting an appointment left the lead in
 * the dial queue with a due date, so the power dialer would cheerfully offer
 * up someone you're seeing on Sunday. A booked lead belongs on the Calendar
 * and in the Appointments view, and comes back to the queue only if the
 * appointment passes without an outcome, or it gets cancelled.
 */
export function hasUpcomingAppointment(lead: LeadWithBucket): boolean {
  if (!lead.appointment_datetime) return false;
  const when = new Date(lead.appointment_datetime).getTime();
  return !isNaN(when) && when >= Date.now();
}

// A just-arrived, never-worked lead — the speed-to-lead window.
export function isFresh(lead: LeadWithBucket): boolean {
  if (hasPriorWork(lead) || !lead.created_at) return false;
  const hrs = (Date.now() - new Date(lead.created_at).getTime()) / 3_600_000;
  return hrs >= 0 && hrs <= 72;
}

export function buildQueue(leads: LeadWithBucket[]): ScoredLead[] {
  return leads
    .filter((l) => l._bucket !== "Closed")
    // The tracker years used their own words for dead: "Not Interested",
    // "Wrong Person". A "Closed -" prefix check alone left them in the queue.
    .filter((l) => !isClosedStatus(l.status))
    // Dispositioned "wrong info": dialing it again just repeats the mistake.
    // Not closed — it waits in the Needs info segment until someone fixes it.
    .filter((l) => !needsInfo(l))
    // Booked is not callable. See hasUpcomingAppointment.
    .filter((l) => !hasUpcomingAppointment(l))
    .filter(isDialable)
    .filter((l) => (l.phone || l.phone2))
    .map(scoreLead)
    .sort((a, b) => b._score - a._score);
}

// TCPA safe calling window for consumer calls: 8am to 9pm local time.
export function withinCallingHours(now: Date = new Date()): boolean {
  const h = now.getHours();
  return h >= 8 && h < 21;
}
