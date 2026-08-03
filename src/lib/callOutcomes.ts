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
