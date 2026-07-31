// Medicare enrollment seasons that apply to the whole book, on top of each
// lead's individual IEP:
//   AEP  Oct 15 - Dec 7  : anyone can change MA/PDP for the next plan year.
//   OEP  Jan 1  - Mar 31 : one MA switch allowed.
// These drive a book-wide push, so the app surfaces where we are relative to
// them the same way it surfaces each lead's IEP window.

export type SeasonInfo = {
  inSeason: "AEP" | "OEP" | null;
  seasonEndsInDays: number | null;
  nextSeason: "AEP" | "OEP";
  daysToNextSeason: number;
  message: string;
};

function atMidnight(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((atMidnight(b).getTime() - atMidnight(a).getTime()) / 86400000);
}

export function seasonInfo(now: Date = new Date()): SeasonInfo {
  const y = now.getFullYear();
  const aepStart = new Date(y, 9, 15); // Oct 15
  const aepEnd = new Date(y, 11, 7); // Dec 7
  const oepStart = new Date(y, 0, 1); // Jan 1
  const oepEnd = new Date(y, 2, 31); // Mar 31
  const t = atMidnight(now);

  if (t >= atMidnight(aepStart) && t <= atMidnight(aepEnd)) {
    const ends = daysBetween(now, aepEnd);
    return {
      inSeason: "AEP",
      seasonEndsInDays: ends,
      nextSeason: "OEP",
      daysToNextSeason: daysBetween(now, new Date(y + 1, 0, 1)),
      message: `AEP is live — ${ends} day${ends === 1 ? "" : "s"} left to move MA/PDP for next year. Prioritize the book.`,
    };
  }
  if (t >= atMidnight(oepStart) && t <= atMidnight(oepEnd)) {
    const ends = daysBetween(now, oepEnd);
    return {
      inSeason: "OEP",
      seasonEndsInDays: ends,
      nextSeason: "AEP",
      daysToNextSeason: daysBetween(now, aepStart),
      message: `OEP is live — ${ends} day${ends === 1 ? "" : "s"} left for MA switches.`,
    };
  }

  // After AEP ends (Dec 8-31) the next window is OEP on Jan 1, not next October.
  if (t > atMidnight(aepEnd)) {
    const toOep = daysBetween(now, new Date(y + 1, 0, 1));
    return {
      inSeason: null,
      seasonEndsInDays: null,
      nextSeason: "OEP",
      daysToNextSeason: toOep,
      message: `OEP starts in ${toOep} day${toOep === 1 ? "" : "s"} (Jan 1) — one MA switch opens up.`,
    };
  }
  // Otherwise we're before this year's AEP — point at the big one.
  const toAep = daysBetween(now, aepStart);
  return {
    inSeason: null,
    seasonEndsInDays: null,
    nextSeason: "AEP",
    daysToNextSeason: toAep,
    message: `AEP starts in ${toAep} days (Oct 15). Fill the pipeline now so the book is ready.`,
  };
}
