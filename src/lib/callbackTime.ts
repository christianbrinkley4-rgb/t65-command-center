// When to try again.
//
// Calling the same person at the same hour twice is the most common way to
// waste a dial. Five no-answers this morning all landed between 10:04 and
// 10:07 — that isn't five bad leads, it's one bad hour tried five times. So a
// retry never comes back in the slot that just failed: it rotates.
//
// The slots are the ones that behave differently for a 64-year-old. Mornings
// catch retired people before they go out. Midday catches almost nobody.
// Late afternoon catches someone home from work, and early evening catches
// the working spouse, which is who you usually need.
//
// The HOURS are no longer a guess. Six weeks of dialing, every call outcome
// grouped by the hour it was placed in, reach = someone actually picked up:
//
//     9am   260 calls    6.5%      2pm    44 calls   13.6%
//    10am   236 calls   10.6%      3pm    55 calls    5.5%
//    11am   144 calls    9.0%      4pm    59 calls   15.3%
//    12pm     1 call     0.0%      5pm   121 calls   10.7%
//     1pm     9 calls   44.4%      6pm   224 calls    7.1%
//                                  7pm    29 calls   13.8%
//
// Two hours carried nearly half the volume and are among the worst on the
// board: 9am and 6pm, at 6.5% and 7.1%. The hour directly after each is
// materially better — 10am at 10.6%, and the 4-5pm block at 15.3% and 10.7%.
// Retries were being booked at 9:30 and 17:45, which is to say into the two
// weak hours, several hundred times. Moving them an hour is the cheapest
// answer-rate change available: no spend, no new number, no extra dials.
//
// 1pm and 2pm look strong and are not: nine and forty-four calls. Midday
// stays out of the retry rotation until there's volume behind it.

export type Slot = { key: string; label: string; hour: number; minute: number };

export const SLOTS: Slot[] = [
  { key: "morning", label: "morning", hour: 10, minute: 15 },
  { key: "midday", label: "midday", hour: 12, minute: 30 },
  { key: "afternoon", label: "afternoon", hour: 16, minute: 15 },
  { key: "evening", label: "late afternoon", hour: 17, minute: 15 },
];

/** Which slot an attempt at this hour belongs to. */
export function slotOfHour(hour: number): Slot {
  if (hour < 11) return SLOTS[0];
  if (hour < 14) return SLOTS[1];
  if (hour < 16.5) return SLOTS[2];
  return SLOTS[3];
}

/**
 * Slots a retry may be BOOKED into, in time order.
 *
 * Midday is missing on purpose. It is a slot a call can land in — someone
 * dialling at 1pm is doing midday — but it is never somewhere to send a retry:
 * it catches almost nobody, and the Stats hour panel bears that out.
 */
export const RETRY_SLOTS: Slot[] = SLOTS.filter((s) => s.key !== "midday");

/** Sunday is not a calling day. */
const isCallingDay = (d: Date) => d.getDay() !== 0;

/**
 * A dated, timed callback: at least `days` from now, at the first hour that
 * isn't the one that just failed.
 *
 * "Whichever is first", not a fixed rotation. A morning no-answer used to walk
 * one step round a four-slot cycle and land at midday, which is the worst hour
 * on the board. Now it takes the earliest remaining slot on the target day —
 * afternoon, or late afternoon if the afternoon has already gone — so the retry
 * is as soon as it can be while still being a genuinely different time of day.
 *
 * Returns null when the disposition doesn't earn a retry.
 */
export function scheduleCallback(days: number | null, lastAttemptHour: number | null): Date | null {
  if (days === null) return null;
  const failed = lastAttemptHour === null ? null : slotOfHour(lastAttemptHour).key;
  const candidates = RETRY_SLOTS.filter((s) => s.key !== failed);
  if (!candidates.length) return null;

  const start = Math.max(days, 0);
  // Walk forward a day at a time. The inner loop is in time order, so the first
  // hit is genuinely the earliest moment that qualifies.
  for (let offset = start; offset < start + 8; offset++) {
    const day = new Date();
    day.setDate(day.getDate() + offset);
    if (!isCallingDay(day)) continue;
    for (const slot of candidates) {
      const when = new Date(day);
      when.setHours(slot.hour, slot.minute, 0, 0);
      // Never book something already in the past — a same-day retry at 9:30
      // booked at 4pm would land overdue the moment it was made.
      if (when.getTime() > Date.now()) return when;
    }
  }
  return null;
}

/** "Thursday morning" — what the retry actually means, in words. */
export function describeCallback(when: Date): string {
  const slot = slotOfHour(when.getHours());
  const day = when.toLocaleDateString(undefined, { weekday: "long" });
  return `${day} ${slot.label}`;
}
