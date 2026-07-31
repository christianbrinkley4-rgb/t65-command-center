import { supabase } from "./supabaseClient";
import { logActivity, plusDays, todayStr } from "./sequences";
import { createLeadActions } from "./actions";
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

function parseTimeframe(text: string, base: Date, lead: Lead): TimeGuess {
  const t = text.toLowerCase();
  const add = (days: number, label: string): TimeGuess => ({
    date: plusDays(ymd(base), days),
    label,
    explicit: true,
  });

  // Explicit "in N days/weeks/months/years"
  const m = t.match(/(\d+)\s*(day|week|month|year)s?/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const days = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
    return add(days, `in ${n} ${unit}${n === 1 ? "" : "s"}`);
  }

  if (/before (he|she|they)?\s*turns?\s*65|before 65|ahead of (his|her|their) (65|birthday)/.test(t) && lead.birthday) {
    const b = new Date(lead.birthday + "T00:00:00");
    const sixtyFive = new Date(b.getFullYear() + 65, b.getMonth(), b.getDate());
    const target = new Date(sixtyFive);
    target.setMonth(target.getMonth() - 4); // start of the hot IEP window
    if (target > base) return { date: ymd(target), label: "before he turns 65", explicit: true };
  }

  if (/tomorrow/.test(t)) return add(1, "tomorrow");
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

function parseAssignee(text: string): ActionAssignee {
  const t = text.toLowerCase();
  if (/\bwill(\s+(call|handle|take|follow|reach|do|has|should|can|will))|for will\b|give (it |this )?to will\b|will'?s\b|have will\b/.test(t))
    return "Will";
  if (/\bchristian\b|\bi'?ll\b|\bi will\b|\bme\b|myself|for me\b|i (call|handle|take|follow|reach)/.test(t))
    return "Christian";
  return "Either";
}

function parseIntent(text: string): { intent: CaptureIntent; status: string | null; stage: string | null } {
  const t = text.toLowerCase();
  if (/\bdnc\b|do ?not ?call|don'?t call( me| him| her| again| back)|stop calling|take (me|him|her) off/.test(t))
    return { intent: "dnc", status: "Closed - DNC", stage: "Closed" };
  if (/\bsold\b|wrote (it|him|her|the|up)|signed|application (in|done)|closed the deal|got the sale/.test(t))
    return { intent: "sold", status: "Closed - Sold", stage: "Closed" };
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

export function localParse(note: string, lead: Lead, base: Date = new Date()): CapturePlan {
  const clean = note.trim();
  const time = parseTimeframe(clean, base, lead);
  const { intent, status, stage } = parseIntent(clean);
  return {
    channel: parseChannel(clean),
    dueDate: time.date,
    dueLabel: time.label,
    dateExplicit: time.explicit,
    assignee: parseAssignee(clean),
    intent,
    status,
    stage,
    note: clean,
    source: "local",
  };
}

// Tries a Claude-powered edge function first (real natural-language
// understanding), falls back to the local parser when it isn't configured.
export async function interpret(note: string, lead: Lead): Promise<CapturePlan> {
  try {
    const { data, error } = await supabase.functions.invoke("smart-capture", {
      body: { note, lead: { birthday: lead.birthday, name: lead.name }, today: todayStr() },
    });
    if (error || !data || !data.dueDate) throw error || new Error("no plan");
    return { ...(data as CapturePlan), source: "ai" };
  } catch {
    return localParse(note, lead);
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
  if (plan.intent === "dnc") patch.do_not_call = true;
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
