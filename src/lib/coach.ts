// "Who should I dial right now."
//
// WHAT "LEARNS" MEANS HERE, BECAUSE IT MATTERS
//
// A language model does not learn from being asked. There is no weight update
// at the end of a conversation, and anything claiming otherwise is claiming
// something that is not happening. So the learning in this file is real and it
// is somewhere else: the numbers underneath the answer are recomputed from the
// activity log on EVERY ask. Dial a hundred leads at 4pm and the 4pm reach rate
// moves before the next question is asked. Nothing is baked in, nothing is
// trained, and nothing goes stale, because there is no stored model to go
// stale. The book teaches it, continuously, by being the only thing it reads.
//
// The second half is answerability. Every recommendation is written to
// assistant_asks with the lead ids it named and the hour it named them at, so
// what it suggested can be joined against what actually happened afterwards.
// That is what makes "is this any good" a question with an answer instead of a
// feeling, and it is the only honest route to it getting better.
//
// THE SPLIT
//
// This file does the arithmetic. The model does the sentences. That division
// is deliberate: a model asked to rank 9,000 leads by counting will get it
// confidently wrong, and a mistake here is a wasted morning. Everything
// numeric — who is due, what the hour is worth, which line is a mobile — is
// computed in TypeScript from live rows, and the model only ever receives a
// finished shortlist to explain.

import { effectiveDueDate } from "./buckets";
import { classifyOutcome, isConversation, isDial } from "./callOutcomes";
import { iepPhase, IEP_LABEL, nextDueMoment, workedToday } from "./priority";
import { askedNotToBeCalled, isClosedStatus, needsInfo } from "./types";
import { canonicalPhone } from "./phone";
import type { Activity, LeadWithBucket } from "./types";

/**
 * Below this an hour's rate is noise, and acting on noise costs a morning.
 *
 * Set to 50 after watching 20 fail. At a floor of 20, the 1pm hour qualified on
 * 24 calls with 5 pickups and produced a 3.09x multiplier — which would have
 * told an agent to drop everything and dial through lunch on the strength of
 * five people answering the phone. Every hour that clears 50 here has hundreds
 * behind it, and the ones that don't are genuinely hours nobody works.
 */
const MIN_HOUR_SAMPLE = 50;

/**
 * How far the hour is allowed to move the ranking.
 *
 * The hour should nudge and never decide. Even a well-sampled hour is a
 * statement about the average call, and it must not be able to push a cold
 * lead above someone who said they were interested three weeks ago. Clamping
 * also means one freak afternoon cannot distort tomorrow morning's list.
 */
const FACTOR_MIN = 0.7;
const FACTOR_MAX = 1.4;

export type HourStat = { hour: number; attempts: number; reached: number; pct: number | null };

/**
 * Reach rate by hour of the day, from this book's own calls.
 *
 * Recomputed on every ask, which is the whole mechanism: this table is the
 * thing that gets smarter, and it does so simply by there being more calls in
 * it. As of writing, with dead numbers excluded, 9am sat at 4.9% across 697
 * attempts while 4pm sat at 10.3% across 146 — and 9am carried more volume
 * than any other hour on the board.
 *
 * Hours with fewer than MIN_HOUR_SAMPLE attempts return a null rate rather
 * than a flattering one. One pickup out of three is not a 33% hour.
 */
export function reachByHour(activity: Activity[]): HourStat[] {
  const buckets = new Map<number, { attempts: number; reached: number }>();
  for (const a of activity) {
    if (!isDial(a.activity_type, a.outcome)) continue;
    // A dead number tells you nothing about the hour, it tells you about the
    // list. Leaving them in the denominator drags every hour down together and
    // makes the headline rate read far worse than the hours actually are.
    if (classifyOutcome(a.outcome) === "bad-number") continue;
    const d = a.activity_date ? new Date(a.activity_date) : null;
    if (!d || isNaN(d.getTime())) continue;
    const h = d.getHours(); // local, deliberately: an 8pm call is an evening call
    const b = buckets.get(h) || { attempts: 0, reached: 0 };
    b.attempts++;
    if (isConversation(a.outcome)) b.reached++;
    buckets.set(h, b);
  }
  return [...buckets.entries()]
    .map(([hour, b]) => ({
      hour,
      attempts: b.attempts,
      reached: b.reached,
      pct: b.attempts >= MIN_HOUR_SAMPLE ? (100 * b.reached) / b.attempts : null,
    }))
    .sort((a, b) => a.hour - b.hour);
}

/** How this hour compares with the day's average. 1 means typical. */
export function hourFactor(stats: HourStat[], hour: number): number {
  const rated = stats.filter((s) => s.pct !== null);
  if (!rated.length) return 1;
  const overall =
    rated.reduce((sum, s) => sum + s.reached, 0) / rated.reduce((sum, s) => sum + s.attempts, 0);
  const here = rated.find((s) => s.hour === hour);
  if (!here || !overall) return 1;
  const raw = here.pct! / 100 / overall;
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, raw));
}

export type Pick = {
  lead: LeadWithBucket;
  score: number;
  /** Why this person, in the order the reasons matter. */
  why: string[];
};

/**
 * Is this lead callable at all, right now.
 *
 * Deliberately the same set of exclusions the dial queue uses, because an
 * assistant that recommends someone the Dial Session refuses to show is worse
 * than no assistant: you go looking for them and they are not there.
 */
function callableNow(l: LeadWithBucket, workedIds: Set<string>): boolean {
  if (askedNotToBeCalled(l)) return false;
  if (isClosedStatus(l.status) || l._bucket === "Closed") return false;
  if (needsInfo(l)) return false;
  if (workedToday(l) || workedIds.has(l.id)) return false;
  if (!canonicalPhone(l.phone) && !canonicalPhone(l.phone2)) return false;
  // Booked is not callable, and neither is a past appointment nobody closed
  // out — that is an outcome to record, not a call to make.
  if (l.appointment_datetime && new Date(l.appointment_datetime) > new Date()) return false;
  // Both numbers confirmed dead by a switch query, if one was ever bought.
  if (l.phone_status === "disconnected" && (!l.phone2 || l.phone2_status === "disconnected")) return false;
  return true;
}

const daysSince = (d: string | null | undefined): number | null => {
  if (!d) return null;
  const t = new Date(String(d).slice(0, 10) + "T00:00:00").getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
};

/**
 * The shortlist, ranked.
 *
 * The weights encode what this book has actually shown, in order:
 *
 *   A promise you made and broke beats anything cold. Someone who said they
 *   were interested and has been sitting for three weeks is the single most
 *   valuable name on the board, and the reason they get the largest number
 *   here is that the pile of them was found rotting inside the overdue bucket.
 *
 *   Being inside the enrollment window is the next biggest fact, because it is
 *   the only one with a deadline attached.
 *
 *   Then the line: 68.8% of the landlines anyone dialed here turned out to be
 *   dead against 11.8% of the mobiles, so a landline is a real penalty rather
 *   than a tiebreak.
 *
 *   The hour scales the whole thing rather than adding to it. A good hour does
 *   not change WHO is worth calling, it changes how much a call is worth, and
 *   it should never be able to outvote an overdue promise.
 */
export function rankNow(
  leads: LeadWithBucket[],
  activity: Activity[],
  workedIds: Set<string> = new Set(),
  now = new Date()
): { picks: Pick[]; hours: HourStat[]; factor: number } {
  const hours = reachByHour(activity);
  const factor = hourFactor(hours, now.getHours());
  const today = now.toISOString().slice(0, 10);

  const picks: Pick[] = [];
  for (const l of leads) {
    if (!callableNow(l, workedIds)) continue;

    let score = 0;
    const why: string[] = [];

    // Said yes, and nobody went back.
    if (/^talked - interested$/i.test(String(l.status || "").trim())) {
      const d = daysSince(l.last_contact_date || l.updated_at);
      score += 300 + Math.min(d ?? 0, 60);
      why.push(d === null ? "said they were interested" : `said they were interested ${d} days ago`);
    } else if (/^talked - not ready$/i.test(String(l.status || "").trim())) {
      score += 90;
      why.push("talked before, not ready then");
    }

    // A callback whose day has come or gone.
    const due = effectiveDueDate(l, l._enr);
    if (due) {
      const overdue = daysSince(due);
      if (overdue !== null && overdue > 0) {
        score += 200 + Math.min(overdue, 60);
        why.push(`callback ${overdue} days overdue`);
      } else if (due.slice(0, 10) === today) {
        score += 150;
        why.push("callback due today");
      }
    }

    // A planned action whose hour has arrived.
    const action = nextDueMoment(l);
    if (action && action.getTime() <= now.getTime()) {
      score += 180;
      why.push("planned action due");
    }

    const phase = iepPhase(l.birthday);
    if (phase === "hot" || phase === "birthday" || phase === "closing") {
      score += 120;
      why.push(IEP_LABEL[phase]);
    } else if (phase === "approaching") {
      score += 40;
      why.push(IEP_LABEL[phase]);
    }

    const types = [l.phone_type, l.phone2_type].filter(Boolean);
    if (types.includes("mobile")) {
      score += 30;
      why.push("mobile");
    } else if (types.includes("fixed_line")) {
      score -= 40;
      why.push("landline, 69% of which are dead here");
    }

    if (l._bucket === "New") {
      score += 20;
      why.push("never dialed");
    }

    if (score <= 0) continue;
    picks.push({ lead: l, score: score * factor, why });
  }

  picks.sort((a, b) => b.score - a.score);
  return { picks, hours, factor };
}

/**
 * The whole situation, as short plain text for the model to write from.
 *
 * Short on purpose. Handing a model 9,000 rows and asking it to choose invites
 * it to invent a name; handing it twenty finished picks and the reasoning
 * behind them leaves it with nothing to do but write. Every number in here was
 * computed above, so the model is never the thing doing arithmetic.
 */
export function buildBrief(
  question: string,
  ranked: { picks: Pick[]; hours: HourStat[]; factor: number },
  now = new Date()
): string {
  const { picks, hours, factor } = ranked;
  const hourLine = hours
    .filter((h) => h.pct !== null)
    .sort((a, b) => b.pct! - a.pct!)
    .map((h) => `${h.hour}:00 ${h.pct!.toFixed(0)}% (n=${h.attempts})`)
    .join(", ");

  const top = picks.slice(0, 20).map((p, i) => {
    const l = p.lead;
    const bits = [
      `${i + 1}. ${l.name || "unnamed"}`,
      l.city ? `(${l.city})` : "",
      "-",
      p.why.join("; "),
    ].filter(Boolean);
    return bits.join(" ");
  });

  return [
    `Time: ${now.toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}`,
    `This hour historically reaches ${factor >= 1 ? `${factor.toFixed(2)}x` : `${factor.toFixed(2)}x`} the daily average.`,
    `Reach rate by hour, this book's own calls: ${hourLine || "not enough data yet"}`,
    ``,
    `${picks.length} leads are callable right now. The top 20 by the ranking:`,
    ...top,
    ``,
    `Question: ${question}`,
  ].join("\n");
}
