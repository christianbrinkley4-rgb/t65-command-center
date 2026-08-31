// What a logged call actually was.
//
// Six years of vocabulary ended up in activity_log.outcome, from three
// different sources: the app's own dispositions, the monthly call trackers, and
// OSCR. There are 516 "No Answer", 196 "Disconnected / Bad Number", 39
// "Answered - Spoke to Prospect", 12 lowercase "vm", and a "Voicemail Left ,
// No Answer" with the comma in the wrong place. Nothing normalized them, so
// every statistic was reading a subset and reporting it as the whole.
//
// Two things that were wrong before this existed:
//
//   1. The contact rate tested `outcome.startsWith("Talked")`, which caught the
//      8 rows saying "Talked - Interested" and missed the 39 saying "Answered -
//      Spoke to Prospect". The headline number on the Stats page was under a
//      fifth of the truth.
//   2. Tap-to-dial rows were excluded by testing for the exact string "Dial",
//      but the lead card writes "Dialed". Seventeen taps were being counted as
//      call results, inflating the dial count and diluting every rate built on
//      it.
//
// Classify once, here, and let every panel read the same answer.

export type DialResult =
  /** Somebody pressed the number. Not an outcome — never counted as a dial. */
  | "tap"
  /** A real conversation with the prospect, whatever they said at the end of it. */
  | "conversation"
  /** A human picked up, but not the person you wanted. */
  | "wrong-person"
  /** It rang out, or went to voicemail, or was busy. */
  | "no-answer"
  /** The number is dead, or the record is too wrong to dial. */
  | "bad-number"
  | "other";

// Order matters. "Answered - Wrong Person" would match the conversation test,
// and "Voicemail Left , No Answer" would match twice, so the more specific
// tests run first.
const TESTS: [RegExp, DialResult][] = [
  [/^\s*dial(ed)?\s*$/i, "tap"],
  [/bad number|disconnected|invalid|needs info|wrong number/i, "bad-number"],
  [/no answer|busy|voicemail|^\s*vm\s*$/i, "no-answer"],
  [/wrong person/i, "wrong-person"],
  [/talked|spoke to|answered|interested|not ready|sent info|do not call|dnc|sold|appointment/i, "conversation"],
];

export function classifyOutcome(outcome: string | null | undefined): DialResult {
  const s = String(outcome || "").trim();
  if (!s) return "other";
  for (const [re, result] of TESTS) if (re.test(s)) return result;
  return "other";
}

/** Was this row a dial that happened, rather than a tap or a non-call note? */
export function isDial(activityType: string | null, outcome: string | null): boolean {
  if (String(activityType || "") !== "Call") return false;
  return classifyOutcome(outcome) !== "tap";
}

/** Did a human pick up — the number that decides when you should be dialling. */
export function isReached(outcome: string | null): boolean {
  const r = classifyOutcome(outcome);
  return r === "conversation" || r === "wrong-person";
}

/** Did you get the person you were calling for. */
export function isConversation(outcome: string | null): boolean {
  return classifyOutcome(outcome) === "conversation";
}

// ── how a lead stands, for picking who to dial ───────────────────────────────
//
// The classifier above answers "what was this one call". This one answers "what
// happened last time anyone worked this person", which is the question you ask
// when you're deciding who to put in front of you for the next hour. Dialing a
// list of voicemails is a different session from dialing a list of people who
// said they were interested, and they want different opening lines.
//
// Reads lead.status, which carries the same six years of vocabulary as the
// activity outcomes: the app's dispositions, the monthly trackers and OSCR.
// Same treatment, one place.

export type LeadResult =
  | "interested"
  | "notready"
  | "appointment"
  | "sold"
  | "voicemail"
  | "noanswer"
  | "notinterested"
  | "covered"
  | "badnumber"
  | "dnc"
  | "needsinfo"
  | "new";

// Order matters, and the first two entries are why. "Not interested" contains
// "interested", and "Appointment - Verify" contains "appointment", so the
// specific reading has to run before the general one.
const LEAD_TESTS: [RegExp, LeadResult][] = [
  [/not interested|no thanks|wants nothing/i, "notinterested"],
  [/\bdnc\b|do ?not ?call/i, "dnc"],
  [/needs info|verify (the )?record|wrong person|wrong info/i, "needsinfo"],
  [/bad number|disconnected|invalid|wrong number/i, "badnumber"],
  [/already enrolled|has advisor|placed w|another advisor|group plan/i, "covered"],
  [/sold|application|closed won/i, "sold"],
  [/appointment|appt|meeting/i, "appointment"],
  [/not ready|call back later|nurture|future/i, "notready"],
  [/voicemail|^\s*vm\b|left a message|lvm/i, "voicemail"],
  [/no answer|busy|didn'?t answer|rang out/i, "noanswer"],
  [/interested|warm|spoke to|talked|answered|sent info/i, "interested"],
];

/**
 * What happened the last time anyone worked this lead.
 *
 * "new" means genuinely untouched, which is not the same as an empty status:
 * a lead imported from OSCR with nine dials behind it has no status here, and
 * calling that "new" is how it ends up in a never-dialed pile.
 */
export function classifyLeadResult(lead: {
  status?: string | null;
  oscr_latest_disp?: string | null;
  dials_count?: number | null;
  last_contact_date?: string | null;
}): LeadResult {
  const s = String(lead.status || "").trim();
  if (s && s.toLowerCase() !== "new") {
    for (const [re, result] of LEAD_TESTS) if (re.test(s)) return result;
  }
  const disp = String(lead.oscr_latest_disp || "").trim();
  if (disp && disp.toLowerCase() !== "no_disposition") {
    for (const [re, result] of LEAD_TESTS) if (re.test(disp)) return result;
  }
  // Worked by somebody, but the vocabulary doesn't say how. Not new.
  if ((lead.dials_count || 0) > 0 || lead.last_contact_date) return "noanswer";
  return "new";
}

/**
 * The results a DIAL SESSION can actually contain.
 *
 * buildQueue drops closed leads, records waiting on a fix, and anything with an
 * appointment on the books, which is correct: none of them are callable right
 * now. But it means picking "Not interested" as a last-result filter in the Dial
 * Session returns an empty session with no explanation, and an empty screen
 * reads as a broken filter rather than a working one. The session uses this to
 * say which picks its queue is going to swallow, and where to work them instead.
 *
 * They are all still worth filtering by on the Leads tab, which reads the whole
 * book — reactivating a pile of six-month-old "not interested" is a real play.
 */
export const DIALABLE_RESULTS: LeadResult[] = [
  "interested",
  "notready",
  "voicemail",
  "noanswer",
  "new",
];

/** Menu order: the piles worth dialing first, then the dead ends. */
export const LEAD_RESULT_OPTIONS: { value: LeadResult; label: string }[] = [
  { value: "interested", label: "Said they were interested" },
  { value: "notready", label: "Not ready / call later" },
  { value: "appointment", label: "Appointment set" },
  { value: "voicemail", label: "Left a voicemail" },
  { value: "noanswer", label: "No answer" },
  { value: "new", label: "Never worked" },
  { value: "notinterested", label: "Not interested" },
  { value: "covered", label: "Already covered elsewhere" },
  { value: "needsinfo", label: "Record needs fixing" },
  { value: "badnumber", label: "Bad number" },
  { value: "sold", label: "Sold" },
  { value: "dnc", label: "Asked not to be called" },
];
