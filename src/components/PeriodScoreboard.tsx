"use client";

// The scoreboard, with one period control driving everything on it.
//
// Stats used to be a pile of cards that each chose their own window: a 7-day
// activity fetch, a 90-day knock fetch, and a set of all-time lead counts,
// stacked in one column with nothing tying them together. You could not answer
// "how did this week go" from it, because no two panels were describing the
// same week.
//
// So: pick Today, This week or This month once, at the top, and every number
// below is that period, measured against the one before it. The funnel reads
// left to right in the order the work actually happens, and the rate between
// each pair of stages sits between them, because the rate is the thing you can
// change. Dials you control by showing up. Reach rate you control by WHO and
// WHEN you dial. Book rate is the conversation itself.

import { useMemo } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { isConversation, isDial } from "@/lib/callOutcomes";
import type { Activity } from "@/lib/types";

export type PeriodKey = "day" | "week" | "month";

export const PERIODS: { key: PeriodKey; label: string; noun: string }[] = [
  { key: "day", label: "Today", noun: "yesterday" },
  { key: "week", label: "This week", noun: "last week" },
  { key: "month", label: "This month", noun: "last month" },
];

/**
 * Start of the current period and of the one before it.
 *
 * Weeks start Monday, because a Sunday-start week splits the working week in
 * half and makes every Monday look like a collapse. Local time throughout: a
 * call at 8pm Eastern is already tomorrow in UTC, which would file a third of
 * every evening session under the wrong day.
 */
export function periodBounds(period: PeriodKey, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week") {
    // getDay(): 0 = Sunday. Monday-start means Sunday counts as day 7.
    const back = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - back);
  } else if (period === "month") {
    start.setDate(1);
  }
  const prevStart = new Date(start);
  if (period === "day") prevStart.setDate(prevStart.getDate() - 1);
  else if (period === "week") prevStart.setDate(prevStart.getDate() - 7);
  else prevStart.setMonth(prevStart.getMonth() - 1);
  return { start, prevStart, prevEnd: start };
}

export type Tally = {
  dials: number;
  conversations: number;
  appts: number;
  held: number;
  noShow: number;
  sold: number;
  doors: number;
  doorTalks: number;
};

const EMPTY: Tally = { dials: 0, conversations: 0, appts: 0, held: 0, noShow: 0, sold: 0, doors: 0, doorTalks: 0 };

export function tally(rows: Activity[]): Tally {
  const t = { ...EMPTY };
  for (const a of rows) {
    const type = a.activity_type || "";
    const out = a.outcome || "";
    if (isDial(type, out)) {
      t.dials++;
      if (isConversation(out)) t.conversations++;
    }
    if (type === "Appointment") {
      if (out === "Set") t.appts++;
      else if (/held/i.test(out)) t.held++;
      else if (/no-?show/i.test(out)) t.noShow++;
    }
    if (type === "Sale") t.sold++;
    // "Note" rows are annotations somebody added later, not doors walked to.
    // Counting them inflates the denominator and flatters the contact rate.
    if (type === "Door Knock" && out && out !== "Note") {
      t.doors++;
      if (/^talked/i.test(out)) t.doorTalks++;
    }
  }
  return t;
}

const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);

/**
 * A rate is only worth printing when there's enough behind it to mean
 * something. Two dials and one pickup is not a 50% reach rate, and shown as
 * one it will get acted on.
 */
const MIN_SAMPLE = 8;

function Delta({ now, before }: { now: number; before: number }) {
  if (before === 0 && now === 0) return null;
  const diff = now - before;
  const Icon = diff > 0 ? ArrowUp : diff < 0 ? ArrowDown : Minus;
  const tone = diff > 0 ? "text-newlead" : diff < 0 ? "text-overdue" : "text-later";
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${tone}`}>
      <Icon size={11} />
      {diff === 0 ? "same" : `${Math.abs(diff)}`}
    </span>
  );
}

/** One stage of the funnel. */
function Stage({ label, value, before }: { label: string; value: number; before: number }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-line bg-white px-3 py-3 text-center shadow-card">
      <p className="font-display text-2xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="truncate text-[11px] text-worked">{label}</p>
      <div className="mt-0.5 h-4">
        <Delta now={value} before={before} />
      </div>
    </div>
  );
}

/** The conversion between two stages, which is the number you can move. */
function Rate({ n, d, label }: { n: number; d: number; label: string }) {
  const p = pct(n, d);
  const thin = d < MIN_SAMPLE;
  return (
    <div className="hidden w-16 shrink-0 flex-col items-center justify-center sm:flex">
      <p className={thin ? "text-xs font-semibold text-later" : "text-xs font-semibold text-brand-dark"}>
        {p === null || thin ? "—" : `${p.toFixed(0)}%`}
      </p>
      <p className="text-[10px] leading-tight text-later">{label}</p>
    </div>
  );
}

export default function PeriodScoreboard({
  period,
  onPeriod,
  activity,
}: {
  period: PeriodKey;
  onPeriod: (p: PeriodKey) => void;
  activity: Activity[];
}) {
  const { now, before } = useMemo(() => {
    const { start, prevStart, prevEnd } = periodBounds(period);
    const at = (a: Activity) => new Date(a.activity_date || 0).getTime();
    return {
      now: tally(activity.filter((a) => at(a) >= start.getTime())),
      before: tally(
        activity.filter((a) => at(a) >= prevStart.getTime() && at(a) < prevEnd.getTime())
      ),
    };
  }, [activity, period]);

  const label = PERIODS.find((p) => p.key === period)!;
  const showRate = pct(now.held, now.held + now.noShow);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => onPeriod(p.key)}
              className={
                period === p.key
                  ? "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                  : "rounded-lg border border-line px-3 py-1.5 text-xs text-worked hover:bg-paper"
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-later">Arrows compare with {label.noun}</p>
      </div>

      {/* The calling funnel, in the order the work happens. */}
      <div className="flex items-stretch gap-1.5">
        <Stage label="Dials" value={now.dials} before={before.dials} />
        <Rate n={now.conversations} d={now.dials} label="reached" />
        <Stage label="Conversations" value={now.conversations} before={before.conversations} />
        <Rate n={now.appts} d={now.conversations} label="booked" />
        <Stage label="Appointments" value={now.appts} before={before.appts} />
        <Rate n={now.held} d={now.held + now.noShow} label="showed" />
        <Stage label="Sold" value={now.sold} before={before.sold} />
      </div>

      {/* Doors are a different funnel with a different contact rate, so they
          get their own line rather than being averaged into the calling one. */}
      <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Stage label="Doors knocked" value={now.doors} before={before.doors} />
        <Stage label="Door conversations" value={now.doorTalks} before={before.doorTalks} />
        <Stage label="Appointments held" value={now.held} before={before.held} />
        <Stage label="No-shows" value={now.noShow} before={before.noShow} />
      </div>

      {/* One plain sentence, because a row of numbers does not tell you which
          one is the problem. */}
      <p className="mt-3 rounded-xl border border-line bg-white px-4 py-2.5 text-xs leading-relaxed text-worked shadow-card">
        {now.dials < MIN_SAMPLE && now.doors < MIN_SAMPLE ? (
          <>Not enough activity {period === "day" ? "today" : `this ${period}`} to read anything into yet.</>
        ) : (
          <>
            {now.dials} dials produced {now.conversations} conversations
            {pct(now.conversations, now.dials) !== null && now.dials >= MIN_SAMPLE && (
              <> ({pct(now.conversations, now.dials)!.toFixed(0)}%)</>
            )}
            {now.doors > 0 && <> and {now.doors} doors produced {now.doorTalks}</>}.{" "}
            {now.appts > 0 ? (
              <>
                That is {now.appts} appointment{now.appts === 1 ? "" : "s"}
                {now.conversations >= MIN_SAMPLE && (
                  <>, one for every {Math.round(now.conversations / now.appts)} conversations</>
                )}
                .
              </>
            ) : (
              <>No appointments booked yet.</>
            )}
            {showRate !== null && now.held + now.noShow >= 3 && (
              <> {showRate.toFixed(0)}% of booked appointments were held.</>
            )}
          </>
        )}
      </p>
    </div>
  );
}
