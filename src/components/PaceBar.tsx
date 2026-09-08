"use client";

// Ten a week, as today's number.
//
// This sits at the very top of Today because it is the only number the Command
// Center is currently for. Everything else on the page is a means to it.
//
// It deliberately shows the arithmetic rather than just the verdict. "You need
// 95 mobile dials today" invites the question "says who", and an agent who
// cannot check that will stop believing it by Thursday. So the chain is printed
// underneath, measured from his own calls, and it moves when the book moves.

import { useEffect, useMemo, useState } from "react";
import { Target } from "lucide-react";
import { bookedThisWeek, measureRates, pacing } from "@/lib/pace";
import type { Activity } from "@/lib/types";

const KEY = "t65-cc-weekly-appt-goal";

export default function PaceBar({
  activity,
  mobileLeadIds,
}: {
  activity: Activity[];
  mobileLeadIds: Set<string>;
}) {
  const [target, setTarget] = useState(10);
  useEffect(() => {
    const t = Number(localStorage.getItem(KEY));
    if (t > 0) setTarget(t);
  }, []);
  const saveTarget = (n: number) => {
    const v = Math.max(1, n);
    setTarget(v);
    localStorage.setItem(KEY, String(v));
  };

  const { pace, rates, booked } = useMemo(() => {
    const r = measureRates(activity, mobileLeadIds);
    const b = bookedThisWeek(activity);
    return { rates: r, booked: b, pace: pacing(b, r, target) };
  }, [activity, mobileLeadIds, target]);

  const pctOfTarget = Math.min(100, (booked / target) * 100);

  return (
    <div className="mb-4 rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <Target size={15} className="text-brand" />
          <p className="text-sm font-semibold text-ink">Appointments this week</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-worked">
          <span className="font-display text-xl font-semibold tabular-nums text-ink">{booked}</span>
          <span>of</span>
          <input
            type="number"
            min={1}
            value={target}
            onChange={(e) => saveTarget(Number(e.target.value))}
            className="w-14 rounded-md border border-line px-2 py-1 text-xs"
            aria-label="Weekly appointment goal"
          />
        </div>
      </div>

      <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100">
        <div
          className={pace.onTrack ? "h-full rounded-full bg-newlead transition-all" : "h-full rounded-full bg-brand transition-all"}
          style={{ width: `${pctOfTarget}%` }}
        />
      </div>

      <p className="mt-2.5 text-sm leading-relaxed text-ink">
        {pace.onTrack ? (
          <>Target hit. Everything from here is ahead of the number.</>
        ) : pace.daysLeft === 0 ? (
          <>
            {pace.behind} short with the week gone. Monday starts at zero, so the interested list
            is where to open.
          </>
        ) : (
          <>
            <span className="font-semibold">{pace.behind} to go</span> across {pace.daysLeft}{" "}
            working day{pace.daysLeft === 1 ? "" : "s"}, so about{" "}
            <span className="font-semibold">{pace.perDay.toFixed(1)} a day</span>
            {pace.dialsToday !== null ? (
              <>
                . At your measured rates that is{" "}
                <span className="font-semibold">{pace.dialsToday} mobile dials today</span>.
              </>
            ) : (
              <>. Not enough call history yet to say what that is in dials.</>
            )}
          </>
        )}
      </p>

      {/* Show the working. An agent who cannot check the number stops trusting
          it, and these are his own rates, not benchmarks from somewhere else. */}
      {!rates.thin && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-later">
          Measured on your own calls to leads with a mobile:{" "}
          {(100 * rates.deadRate).toFixed(0)}% of dials hit a dead number,{" "}
          {(100 * rates.reachRate).toFixed(0)}% of the live ones reach a conversation, and{" "}
          {(100 * rates.bookRate).toFixed(0)}% of conversations book. That is one appointment per{" "}
          {Math.round(1 / rates.perDial)} dials.
        </p>
      )}
    </div>
  );
}
