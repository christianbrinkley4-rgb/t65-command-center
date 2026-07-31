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

export type Slot = { key: string; label: string; hour: number; minute: number };

export const SLOTS: Slot[] = [
  { key: "morning", label: "morning", hour: 9, minute: 30 },
  { key: "midday", label: "midday", hour: 12, minute: 30 },
  { key: "afternoon", label: "afternoon", hour: 15, minute: 30 },
  { key: "evening", label: "early evening", hour: 17, minute: 45 },
];

/** Which slot an attempt at this hour belongs to. */
export function slotOfHour(hour: number): Slot {
  if (hour < 11) return SLOTS[0];
  if (hour < 14) return SLOTS[1];
  if (hour < 16.5) return SLOTS[2];
  return SLOTS[3];
}

/**
 * The next slot to try. Evening is the most valuable, so the rotation walks
 * toward it rather than cycling back to the morning you already burned.
 */
export function nextSlot(lastHour: number | null): Slot {
  if (lastHour === null) return SLOTS[0];
  const i = SLOTS.indexOf(slotOfHour(lastHour));
  return SLOTS[(i + 1) % SLOTS.length];
}

/** Sunday is not a calling day, and neither is before 8am or after 9pm. */
function nudgeIntoAWorkingDay(d: Date): Date {
  const out = new Date(d);
  if (out.getDay() === 0) out.setDate(out.getDate() + 1); // Sunday -> Monday
  return out;
}

/**
 * A dated, timed callback: `days` from now, in a slot that isn't the one that
 * just failed. Returns null when the disposition doesn't earn a retry.
 */
export function scheduleCallback(days: number | null, lastAttemptHour: number | null): Date | null {
  if (days === null) return null;
  const slot = nextSlot(lastAttemptHour);
  const d = new Date();
  d.setDate(d.getDate() + Math.max(days, 0));
  d.setHours(slot.hour, slot.minute, 0, 0);
  const when = nudgeIntoAWorkingDay(d);
  // Never schedule something already in the past (a same-day retry booked at
  // 9:30 when it's already 4pm would land overdue the moment it was made).
  if (when.getTime() <= Date.now()) {
    when.setDate(when.getDate() + 1);
    return nudgeIntoAWorkingDay(when);
  }
  return when;
}

/** "Thursday morning" — what the retry actually means, in words. */
export function describeCallback(when: Date): string {
  const slot = slotOfHour(when.getHours());
  const day = when.toLocaleDateString(undefined, { weekday: "long" });
  return `${day} ${slot.label}`;
}
