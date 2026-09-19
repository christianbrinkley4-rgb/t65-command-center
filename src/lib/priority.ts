import { bestPhone, canonicalPhone, leadPhones } from "./phone";
import { effectiveDueDate } from "./buckets";
import { formatActionDue, nextPendingAction } from "./actions";
import { askedNotToBeCalled, hasPriorWork, isClosedStatus, needsInfo } from "./types";
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

  // Mobile first.
  //
  // Measured on this book, not assumed. Of 25 numbers marked Bad Number after
  // somebody dialed them, 22 were landlines. Of 25 that produced a real
  // conversation, 23 were mobiles. The book itself is 38% landline. Turn that
  // around against a 27% overall dead rate and it says roughly 63% of the
  // landlines in this book are dead lines, against about 5% of the mobiles.
  //
  // The received wisdom is that a 64-year-old answers the landline. Not this
  // list: a landline on a bought T65 file is usually a stale broker record on
  // legacy copper. The carrier names give it away, Lumen and Windstream and
  // North State and Surry Telephone Membership and Yadkin Valley.
  //
  // The swing is deliberately kept under the IEP boost. A landline for somebody
  // turning 65 next month still outranks a mobile for somebody a year out,
  // because being in the window is the bigger fact. And nobody is removed: an
  // untyped number, or one from a competitive-carrier block that genuinely
  // cannot be told apart, scores exactly as it always did.
  if (lead.phone_type === "mobile") {
    score += 18;
    why.push("mobile");
  } else if (lead.phone_type === "fixed_line") {
    score -= 25;
    why.push("landline");
  }

  return { ...lead, _score: score, _why: why };
}

// The full ranked queue: every workable lead, best first. Due work floats to
// the top; when it runs out the queue flows into never-dialed leads, so it
// never comes back empty.
// Dialable means there is a number to ring and nobody asked us to stop. Only a
// DNC we recorded ourselves (a person asked, or somebody at their number did)
// removes a lead. A bulk list scrub is a label, not a suppression, and never
// hides anyone. See askedNotToBeCalled().
export function isDialable(lead: LeadWithBucket): boolean {
  return leadPhones(lead).length > 0 && !askedNotToBeCalled(lead) && !lead._dncSuppressed;
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

/** Statuses that mean the appointment has been accounted for. */
const APPOINTMENT_RESOLVED = /held|no-?show|sold|closed|cancel/i;

/**
 * The appointment has been and gone and nobody said what happened.
 *
 * Booking someone also writes a follow-up date on the appointment day, so once
 * that day passes the lead reads as an overdue CALLBACK — Rex Austin sat in the
 * queue as "44d overdue" when what actually happened is that his 16 June
 * appointment was never closed out. That's a lie in both directions: it isn't a
 * call you forgot to make, and burying it among hundreds of overdue callbacks
 * is how an appointment outcome goes unrecorded for six weeks.
 *
 * These leave the dial queue and live in the "Needs outcome" segment and on the
 * Calendar under the day they were booked, which is where someone will actually
 * see them. They come back to the queue the moment an outcome is recorded.
 */
export function awaitingAppointmentOutcome(lead: LeadWithBucket): boolean {
  if (!lead.appointment_datetime) return false;
  const when = new Date(lead.appointment_datetime).getTime();
  if (isNaN(when) || when >= Date.now()) return false;
  return !APPOINTMENT_RESOLVED.test(String(lead.status || ""));
}

/** Local midnight for a YYYY-MM-DD, so a date-only callback means "that day". */
function startOfLocalDay(ymd: string): Date {
  return new Date(ymd.slice(0, 10) + "T00:00:00");
}

/**
 * The next moment this lead is actually owed attention. Null means "no
 * commitment" — raw inventory you can dial whenever.
 *
 * A pending action wins over the date fields, and that is the whole point: the
 * action carries the HOUR. `next_follow_up_date` is a date-only mirror kept in
 * step so other views show the right day, and taking the earliest of the two
 * would collapse "Thursday at 5:45pm" back to "Thursday at midnight" and hand
 * the lead to you at breakfast.
 */
export function nextDueMoment(lead: LeadWithBucket): Date | null {
  const pending = (lead._actions || [])
    .filter((a) => a.status === "pending")
    .map((a) => new Date(a.due_at).getTime())
    .filter((t) => !isNaN(t));
  if (pending.length) return new Date(Math.min(...pending));

  const days: string[] = [];
  if (lead.next_follow_up_date) days.push(String(lead.next_follow_up_date).slice(0, 10));
  if (lead._enr && lead._enr.status === "active" && lead._enr.next_touch_date) {
    days.push(String(lead._enr.next_touch_date).slice(0, 10));
  }
  if (!days.length) return null;
  days.sort();
  return startOfLocalDay(days[0]);
}

/**
 * You already dealt with this one and said when to come back. Until that
 * moment arrives it is not a call you can make.
 *
 * This was the biggest hole in the app. buildQueue filtered out the closed,
 * the DNC and the booked, then RANKED everything else — it never asked whether
 * the work was owed yet. So a lead no-answered at 9am got a callback two days
 * out, scored 70 for "due in 2d" plus a 50-point IEP boost, and came back to
 * the top of the queue ahead of a never-dialed lead scoring 90. You'd redial
 * someone you'd just tried, at the same hour, while six thousand untouched
 * leads sat behind them.
 *
 * Excluding these is also what makes the slot rotation in callbackTime.ts
 * real: booking the retry for Thursday at 5:45pm means nothing if the lead is
 * offered to you on Thursday at 8am.
 */
export function isScheduledForLater(lead: LeadWithBucket, now: Date = new Date()): boolean {
  const due = nextDueMoment(lead);
  return due !== null && due.getTime() > now.getTime();
}

/**
 * Worked today already. Backstop for the case the rule above can't see: a
 * disposition that clears the follow-up date, or a lead someone edited by
 * hand. One conversation a day per person is enough.
 */
export function workedToday(lead: LeadWithBucket): boolean {
  if (!lead.last_contact_date) return false;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(lead.last_contact_date).slice(0, 10) === today;
}

// A just-arrived, never-worked lead — the speed-to-lead window.
export function isFresh(lead: LeadWithBucket): boolean {
  if (hasPriorWork(lead) || !lead.created_at) return false;
  const hrs = (Date.now() - new Date(lead.created_at).getTime()) / 3_600_000;
  return hrs >= 0 && hrs <= 72;
}

export function buildQueue(leads: LeadWithBucket[]): ScoredLead[] {
  return leads
    .filter((l) => l._bucket !== "Closed" || /^(?:closed\s*[-:]\s*)?(?:dnc|do[ -]?not[ -]?call)$/i.test(String(l.status || "").trim()))
    // The tracker years used their own words for dead: "Not Interested",
    // "Wrong Person". A "Closed -" prefix check alone left them in the queue.
    .filter((l) => !isClosedStatus(l.status))
    // Dispositioned "wrong info": dialing it again just repeats the mistake.
    // Not closed — it waits in the Needs info segment until someone fixes it.
    .filter((l) => !needsInfo(l))
    // Booked is not callable. See hasUpcomingAppointment.
    .filter((l) => !hasUpcomingAppointment(l))
    // Neither is a past appointment nobody closed out — that's an outcome to
    // record, not a callback you're late on. See awaitingAppointmentOutcome.
    .filter((l) => !awaitingAppointmentOutcome(l))
    // Nor is a lead you already handled and booked a time to come back to.
    // See isScheduledForLater — this is what stops this morning's no-answers
    // reappearing this afternoon.
    .filter((l) => !isScheduledForLater(l))
    .filter((l) => !workedToday(l))
    .filter(isDialable)
    .filter((l) => (l.phone || l.phone2))
    // A line a switch query says is dead. Not a dead lead and not a closed
    // one: the record is fine, the line is gone. It leaves the dial queue the
    // same way a missing number does, and stays fully visible on the Leads tab
    // so a better number can be found for them.
    //
    // A lead whose second number hasn't been scrubbed keeps its place, because
    // "we know this one is dead and haven't checked the other" is not grounds
    // for dropping someone. Only when BOTH are confirmed dead does the lead
    // leave the queue.
    .filter((l) => {
      if (l.phone_status !== "disconnected") return true;
      if (!l.phone2) return false;
      return l.phone2_status !== "disconnected";
    })
    .map(scoreLead)
    .sort((a, b) => b._score - a._score);
}

/**
 * The leads that WOULD be callable except that you've already handled them.
 *
 * A queue that silently shrinks reads as a broken queue, and the first instinct
 * is to distrust it and go back to the spreadsheet. Saying "38 worked today,
 * 136 booked for later" turns a missing number into a decision the app made on
 * your behalf, which you can then go and look at.
 */
export function heldBackCounts(leads: LeadWithBucket[]): { worked: number; later: number } {
  let worked = 0;
  let later = 0;
  for (const l of leads) {
    if (l._bucket === "Closed" || isClosedStatus(l.status) || needsInfo(l)) continue;
    if (!isDialable(l) || !(l.phone || l.phone2)) continue;
    if (hasUpcomingAppointment(l) || awaitingAppointmentOutcome(l)) continue;
    if (workedToday(l)) worked += 1;
    else if (isScheduledForLater(l)) later += 1;
  }
  return { worked, later };
}

// TCPA safe calling window for consumer calls: 8am to 9pm local time.
export function withinCallingHours(now: Date = new Date()): boolean {
  const h = now.getHours();
  return h >= 8 && h < 21;
}

/** Dial sessions advance through numbers, while the lead book stays one row per person. */
export type DialQueueEntry = ScoredLead & { _queuePhone: string; _queueKey: string };
export function buildDialQueue(leads: LeadWithBucket[]): DialQueueEntry[] {
  return buildQueue(leads).flatMap((lead) => leadPhones(lead).map((phone) => ({
    ...lead, _queuePhone: phone, _queueKey: `${lead.id}:${phone}`,
  })));
}

/**
 * One entry per valid phone number, for any list of leads already chosen (a
 * segment plus filters). The mobile of a landline+mobile pair goes first: on
 * this book a dialed landline is a dead number far more often than a mobile.
 */
export function expandDialPhones<T extends LeadWithBucket>(leads: T[]): (T & { _queuePhone: string; _queueKey: string })[] {
  return leads.flatMap((lead) => {
    const first = canonicalPhone(bestPhone(lead).number);
    const phones = leadPhones(lead).sort((a, b) => Number(canonicalPhone(b) === first) - Number(canonicalPhone(a) === first));
    return phones.map((phone) => ({ ...lead, _queuePhone: phone, _queueKey: `${lead.id}:${phone}` }));
  });
}

/** Advance one number, or finish the current person after a live conversation. */
export function nextDialIndex(entries: { id: string }[], index: number, finishLead = false): number {
  let next = index + 1;
  if (finishLead) while (next < entries.length && entries[next].id === entries[index]?.id) next++;
  return next;
}
