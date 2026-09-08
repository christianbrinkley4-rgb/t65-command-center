import { supabase } from "./supabaseClient";
import { logActivity, plusDays, todayStr } from "./sequences";
import { createLeadActions } from "./actions";
import { ACTION_ASSIGNEES } from "./types";
import type { ActionAssignee, ActionType, Lead, LeadWithBucket } from "./types";

// Smart Capture turns a plain-English note ("had appointment, follow up in a
// month or so, potential in future") into a structured, scheduled follow-up:
// a channel, a date to resurface it, an owner, a status, and a clean note.
// It parses locally so it works offline and free; if a Claude edge function is
// wired up (see interpret()), that runs first and this is the fallback.

export type CaptureIntent =
  | "follow_up"
  | "appointment"
  | "not_interested"
  | "dnc"
  | "sold";

export type CapturePlan = {
  channel: ActionType;
  dueDate: string; // YYYY-MM-DD, when to bring it back
  dueLabel: string; // human phrasing of the timeframe
  dateExplicit: boolean; // did they actually say a time?
  assignee: ActionAssignee;
  intent: CaptureIntent;
  status: string | null; // suggested lead status
  stage: string | null;
  note: string;
  source: "ai" | "local";
  /**
   * True when the fallback ran because the project has no GEMINI_API_KEY, as
   * opposed to because the model call failed. The difference matters to
   * whoever is looking at the screen: one is a hiccup, the other means the
   * feature has never once done what its name says.
   */
  unconfigured?: boolean;
  /** The edge function's own words for why it couldn't read the note. */
  reason?: string | null;
};

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Next occurrence of a given month/day from `base` (this year or next).
function nextDate(base: Date, month: number, day: number): Date {
  const y = base.getFullYear();
  const candidate = new Date(y, month, day);
  return candidate < base ? new Date(y + 1, month, day) : candidate;
}

type TimeGuess = { date: string; label: string; explicit: boolean };

// "64 years" in "he's 64 years old" is an age, not a timeframe. Without these
// the number-and-unit rule matched it and scheduled the callback for August
// 2090, marked as a firm date so nothing on screen looked wrong. On a book of
// people turning 65, writing the age in the note is the likeliest thing there is.
const AGE_TRAILING = /\bold\b/;
const AGE_LEADING = /\b(is|are|was|'s|age|aged|turns?|turning)\s*$/;

function parseTimeframe(text: string, base: Date, lead: Lead): TimeGuess {
  const t = text.toLowerCase();
  const add = (days: number, label: string): TimeGuess => ({
    date: plusDays(ymd(base), days),
    label,
    explicit: true,
  });

  // Explicit "in N days/weeks/months/years".
  //
  // The age guard is not hypothetical. This matched any number next to a unit
  // anywhere in the note, so "he's 64 years old" parsed as a timeframe and
  // scheduled the callback 23,360 days out — August 2090 — and flagged it as a
  // firm date rather than a guess, so nothing on screen suggested anything was
  // wrong. On a book of people turning 65, writing their age in the note is the
  // single most likely thing an agent does.
  const m = t.match(/(\d+)\s*(day|week|month|year)s?/);
  if (m) {
    const at = m.index ?? 0;
    const before = t.slice(Math.max(0, at - 14), at);
    const after = t.slice(at + m[0].length, at + m[0].length + 6);
    const isAge = AGE_TRAILING.test(after) || AGE_LEADING.test(before);
    if (!isAge) {
      const n = Number(m[1]);
      const unit = m[2];
      const days = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
      return add(days, `in ${n} ${unit}${n === 1 ? "" : "s"}`);
    }
  }

  if (/before (he|she|they)?\s*turns?\s*65|before 65|ahead of (his|her|their) (65|birthday)/.test(t) && lead.birthday) {
    const b = new Date(lead.birthday + "T00:00:00");
    const sixtyFive = new Date(b.getFullYear() + 65, b.getMonth(), b.getDate());
    const target = new Date(sixtyFive);
    target.setMonth(target.getMonth() - 4); // start of the hot IEP window
    if (target > base) return { date: ymd(target), label: "before he turns 65", explicit: true };
  }

  if (/tomorrow/.test(t)) return add(1, "tomorrow");

  // "Come back Tuesday." The most common thing anyone says at a door or on a
  // call, and nothing here parsed it: every one of these fell through to the
  // generic week-out guess, which is most of why the date was usually wrong.
  //
  // Bare "mon" / "sat" / "sun" are deliberately not accepted — they turn up
  // inside "sat down with them" and "sunroom". Full names and the shorthands
  // people actually write are enough.
  const WEEKDAYS: Array<[RegExp, number]> = [
    [/\bsunday\b/, 0],
    [/\bmonday\b/, 1],
    [/\btues(day)?\b/, 2],
    [/\bwed(nes)?(day)?\b/, 3],
    [/\bthurs(day)?\b/, 4],
    [/\bfriday\b/, 5],
    [/\bsaturday\b/, 6],
  ];
  for (const [re, target] of WEEKDAYS) {
    if (!re.test(t)) continue;
    // Next occurrence, 1 to 7 days out. Saying "Tuesday" on a Tuesday means the
    // next one, not today — today would have been "later" or a time.
    let delta = (target - base.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    // "Next Tuesday" when Tuesday is tomorrow means the one after.
    if (/\bnext\s+\w*(sun|mon|tues|wed|thurs|fri|satur)/.test(t) && delta <= 3) delta += 7;
    const d = new Date(base);
    d.setDate(d.getDate() + delta);
    return {
      date: ymd(d),
      // The date is spelled out so a wrong guess is visible at a glance rather
      // than hidden behind a word.
      label: d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
      explicit: true,
    };
  }
  if (/(couple|few|couple of)\s*days|in a few\b|day or two/.test(t)) return add(3, "in a few days");
  if (/next week|a week|in a week/.test(t)) return add(7, "next week");
  if (/(couple|few|two)\s*weeks/.test(t)) return add(14, "in a couple weeks");
  if (/month or so|next month|in a month|about a month|a month/.test(t)) return add(30, "about a month out");
  if (/(couple|few|two|2|3)\s*months|few months out|down the road|in the future|future|later on/.test(t))
    return add(60, "a few months out");
  if (/next quarter|quarter|90 days/.test(t)) return add(90, "next quarter");
  if (/six months|6 months|half a year/.test(t)) return add(182, "in six months");
  if (/next year|a year/.test(t)) return add(365, "next year");

  if (/after aep/.test(t)) return { date: ymd(nextDate(base, 11, 8)), label: "after AEP", explicit: true };
  if (/\baep\b|open enrollment/.test(t)) return { date: ymd(nextDate(base, 9, 15)), label: "at AEP (Oct 15)", explicit: true };
  if (/spring/.test(t)) return { date: ymd(nextDate(base, 2, 20)), label: "in the spring", explicit: true };
  if (/summer/.test(t)) return { date: ymd(nextDate(base, 5, 21)), label: "in the summer", explicit: true };
  if (/fall|autumn/.test(t)) return { date: ymd(nextDate(base, 8, 22)), label: "in the fall", explicit: true };
  if (/winter/.test(t)) return { date: ymd(nextDate(base, 11, 21)), label: "in the winter", explicit: true };

  // "On a group plan til March", "call him in January". A month with a
  // preposition in front of it is a real date and was landing on the generic
  // guess. The preposition is required: "March" also shows up as a surname and
  // in "marched right in".
  const MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const monthHit = t.match(
    /\b(?:in|til|till|until|by|after|around|early|mid|late)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/
  );
  if (monthHit) {
    const idx = MONTHS.indexOf(monthHit[1]);
    // The 1st of that month, this year or next.
    const d = nextDate(base, idx, 1);
    return {
      date: ymd(d),
      label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      explicit: true,
    };
  }

  // MM/DD or Month name day
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const mo = Number(slash[1]) - 1;
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : base.getFullYear();
    if (year < 100) year += 2000;
    let d = new Date(year, mo, day);
    if (!slash[3] && d < base) d = new Date(year + 1, mo, day);
    if (!isNaN(d.getTime())) return { date: ymd(d), label: `on ${d.toLocaleDateString()}`, explicit: true };
  }

  // Nothing said: default to a week out, flagged as a guess.
  return { date: plusDays(ymd(base), 7), label: "a week out (no time given)", explicit: false };
}

function parseChannel(text: string): ActionType {
  const t = text.toLowerCase();
  if (/\btext(ed|ing)?\b|\bsms\b|shoot (him|her|them) a text/.test(t)) return "Text";
  if (/\bemail(ed|ing)?\b|\be-?mail\b/.test(t)) return "Email";
  if (/\bmail(ed|ing)?\b|\bletter\b|send (him|her|them) (something|a mailer|info)/.test(t)) return "Mail";
  if (/knock|door|stop by|swing by|drop in/.test(t)) return "Door Knock";
  return "Call";
}

// "Will" is a teammate's name and also the most common auxiliary verb in a
// follow-up note, which is a genuinely nasty collision. The old pattern matched
// `will call`, `will follow`, `will take` and the rest, so every one of these
// handed the task to Will:
//
//   "i will call her tuesday"        → Will
//   "i will follow up friday"        → Will
//   "she said she will call back"    → Will   (the prospect's own words)
//
// Nobody was told. The note looked right, the task went to the wrong queue, and
// the person who made the promise never got the reminder.
//
// Two rules fix it. Strip the auxiliary uses first: a subject in front of
// "will" makes it a verb, every time. Then require a genuinely nominal signal
// before reading what survives as the person — a possessive, a handoff
// preposition, or a verb that can only follow a subject ("Will can", "Will
// needs"). Bare "will call" stays ambiguous and is deliberately NOT read as a
// name.
//
// The tie-break is asymmetric on purpose. Assigning your own task to yourself
// when you meant a teammate is visible: it sits in your queue and you move it.
// Assigning it to a teammate when you meant yourself is silent, and that is the
// failure that actually lost work. Ambiguity resolves to whoever is speaking.

// A subject in front of "will" makes it the verb. Removed before any name test.
const WILL_AS_VERB =
  /\b(i|we|you|he|she|it|they|that|this|who|somebody|someone|anyone|nobody|prospect|client|husband|wife|spouse|son|daughter|neighbor|daughter'?s|son'?s)\s+will\b/g;

// What "Will" looks like when it really is the person.
const WILL_AS_NAME =
  /\bwill'?s\b|\b(for|to|with|ask|tell|have|let|email|text|send)\s+will\b|\bwill\s+(can|should|shall|needs?|has|had|is|was|owns?|knows?|already)\b/;

// First person. Checked after the name test so an explicit handoff wins.
const SPEAKER =
  /\bi'?ll\b|\bi will\b|\bmyself\b|\bfor me\b|\bme\b|\bmy\b|\bi\s+(call|handle|take|follow|reach|do|got)/;

/**
 * Who the captured task belongs to.
 *
 * `me` is whoever is signed in. When they aren't a known assignee (a new agent,
 * before the team list stops being two hardcoded names) this returns "Either"
 * rather than guessing a name: a shared task is visible to everyone, where a
 * wrong name is visible to no one.
 */
function parseAssignee(text: string, me: string): ActionAssignee {
  const t = text.toLowerCase();
  const speaker: ActionAssignee = (ACTION_ASSIGNEES as readonly string[]).includes(me)
    ? (me as ActionAssignee)
    : "Either";

  const withoutAuxiliary = t.replace(WILL_AS_VERB, " ");
  if (WILL_AS_NAME.test(withoutAuxiliary)) return "Will";
  if (/\bchristian\b/.test(t)) return "Christian";
  if (SPEAKER.test(t)) return speaker;
  return "Either";
}

// Somebody ELSE already covered them. Tested BEFORE the sale rule, because
// "already signed up with Humana" and "she signed with another agent" both used
// to hit a bare /signed/ and close the lead as SOLD: a lost lead recorded as
// revenue, counted on the Stats sold tile, and pulled out of the queue where it
// might have been worked again at AEP.
const ALREADY_COVERED =
  /already (signed up|enrolled|has|got|have)|signed up (with|through|at|for)|(with|has) another agent|placed with|has an advisor|already covered|(on|for|has|through) (a |an |his |her |their )?group plan|through (his|her|their) (employer|work|union)/;

// A sale is something WE did. The old rule was a bare /\bsold\b/ and a bare
// /signed/, so "he sold his house last year" and "sold cars for 30 years, nice
// guy" both closed the lead as a sale.
const IS_A_SALE =
  /\bsold (him|her|them|it|the)|wrote (him|her|them|it) up|wrote (him|her|them) (a|the)|\bapp(lication)? (is )?(in|done|submitted|signed)\b|closed the deal|got the sale|took the app|(he|she|they) bought|signed the app|signed with (me|us)/;

function parseIntent(text: string): { intent: CaptureIntent; status: string | null; stage: string | null } {
  const t = text.toLowerCase();
  if (/\bdnc\b|do ?not ?call|don'?t call( me| him| her| again| back)|stop calling|take (me|him|her) off/.test(t))
    return { intent: "dnc", status: "Closed - DNC", stage: "Closed" };
  if (ALREADY_COVERED.test(t))
    return { intent: "not_interested", status: "Closed - Already Enrolled", stage: "Closed" };
  if (IS_A_SALE.test(t)) return { intent: "sold", status: "Closed - Sold", stage: "Closed" };
  if (/not interested|no thanks|no thank you|not (a )?fit|wants nothing|hung up mad/.test(t))
    return { intent: "not_interested", status: "Closed - Not Interested", stage: "Closed" };
  if (/(set|schedule|book|booked|scheduled).{0,14}(appointment|appt|meeting|time)|appointment (on|at|for|set)|meeting (on|at|set)|coming (by|over)/.test(t))
    return { intent: "appointment", status: "Appointment Set", stage: "Appointment Upcoming" };
  if (/future|down the road|later on|not ready|not now|check back|reconnect|revisit|nurture/.test(t))
    return { intent: "follow_up", status: "Talked - Not Ready", stage: "Worked - Follow Up" };
  if (/interested|warm|potential|good (call|convo|conversation)|promising|call back|callback|follow ?up|touch base/.test(t))
    return { intent: "follow_up", status: "Talked - Interested", stage: "Worked - Follow Up" };
  return { intent: "follow_up", status: null, stage: "Worked - Follow Up" };
}

export function localParse(
  note: string,
  lead: Lead,
  me: string,
  base: Date = new Date()
): CapturePlan {
  const clean = note.trim();
  const time = parseTimeframe(clean, base, lead);
  const { intent, status, stage } = parseIntent(clean);
  return {
    channel: parseChannel(clean),
    dueDate: time.date,
    dueLabel: time.label,
    dateExplicit: time.explicit,
    assignee: parseAssignee(clean, me),
    intent,
    status,
    stage,
    note: clean,
    source: "local",
  };
}

// Tries a Claude-powered edge function first (real natural-language
// understanding), falls back to the local parser when it isn't configured.
export async function interpret(note: string, lead: Lead, me: string): Promise<CapturePlan> {
  try {
    const { data, error } = await supabase.functions.invoke("smart-capture", {
      body: { note, lead: { birthday: lead.birthday, name: lead.name }, today: todayStr() },
    });
    // The edge function answers `{configured: false}` in about 100ms when
    // GEMINI_API_KEY isn't set on the project, and that is exactly what it has
    // been doing. Every capture has been running the keyword parser below
    // while looking, on screen, like it read the sentence. Falling back is
    // right; doing it silently is not, and it is why this feature reads as
    // broken rather than as switched off.
    if (data && data.configured === false) {
      const local = localParse(note, lead, me);
      return { ...local, source: "local", unconfigured: true, reason: data.reason || null };
    }
    if (error || !data || !data.dueDate) throw error || new Error("no plan");
    const plan = data as CapturePlan;
    // The model is told the team is two named agents, so it can return a name
    // that is no longer valid (or, for a third agent, one that was never the
    // point). An unrecognized assignee becomes a shared task rather than a
    // silent handoff to whoever the prompt happened to mention.
    const assignee: ActionAssignee = (ACTION_ASSIGNEES as readonly string[]).includes(
      plan.assignee
    )
      ? plan.assignee
      : "Either";
    return { ...plan, assignee, source: "ai" };
  } catch {
    return localParse(note, lead, me);
  }
}

// Writes the confirmed plan: a scheduled action (so it resurfaces at the right
// time), an optional status/stage change, an optional appointment, and a log.
export async function applyCapture(
  lead: LeadWithBucket,
  plan: CapturePlan,
  opts: { dueDate: string; channel: ActionType; assignee: ActionAssignee; note: string; applyStatus: boolean; apptDatetime?: string },
  me: string
): Promise<void> {
  const dueIso = new Date(`${opts.dueDate}T09:00:00`).toISOString();
  await createLeadActions(
    lead.id,
    [{ action_type: opts.channel, due_at: dueIso, note: opts.note || undefined, assigned_to: opts.assignee }],
    me
  );

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    last_contact_date: todayStr(),
  };
  if (opts.applyStatus && plan.status) patch.status = plan.status;
  if (opts.applyStatus && plan.stage) patch.stage_bucket = plan.stage;
  // Captured from something a human wrote about a conversation ("told me not to
  // call again"), so this is a request, not a list.
  if (plan.intent === "dnc") {
    patch.do_not_call = true;
    patch.dnc_reason = "requested";
  }
  if (plan.intent === "appointment" && opts.apptDatetime) {
    patch.appointment_datetime = new Date(opts.apptDatetime).toISOString();
    patch.status = "Appointment Set";
    patch.stage_bucket = "Appointment Upcoming";
  }

  const { error } = await supabase.from("leads").update(patch).eq("id", lead.id);
  if (error) throw error;

  await logActivity(
    lead.id,
    "Smart Capture",
    plan.status || "Follow-up scheduled",
    `${opts.channel} ${opts.assignee !== "Either" ? `(${opts.assignee}) ` : ""}on ${opts.dueDate} — ${opts.note}`,
    me
  );
}
