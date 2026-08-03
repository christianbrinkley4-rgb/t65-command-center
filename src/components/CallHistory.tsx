"use client";

// What happened last time, on screen before the phone connects.
//
// Dialing someone whose history you can't see is how you open with "is now a
// good time" to a person who told you last month they're with another advisor.
// Everything already known about this lead, newest first: who they are from
// the survey, then every logged touch, then the free-text history that came in
// from the trackers and SmartAsset.

import { useEffect, useMemo, useState } from "react";
import { History } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { isDial } from "@/lib/callOutcomes";
import { RETRY_SLOTS, SLOTS, slotOfHour } from "@/lib/callbackTime";
import type { Activity, LeadWithBucket } from "@/lib/types";

/**
 * "Jul 31, 4:46 PM" — and the year only when it isn't this one. Asking for a
 * 2-digit year inline gave "Jul 31, 26, 4:46 PM", where the year reads as part
 * of the time.
 */
function stamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CallHistory({
  lead,
  limit = 6,
}: {
  lead: LeadWithBucket;
  limit?: number;
}) {
  const [rows, setRows] = useState<Activity[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    supabase
      .from("activity_log")
      .select("id, lead_id, activity_type, activity_date, outcome, notes, logged_by")
      .eq("lead_id", lead.id)
      .order("activity_date", { ascending: false })
      // Fetch more than we show: the list stays short, but the "already tried"
      // summary above it is counted over the fuller history.
      .limit(Math.max(limit, 25))
      .then(({ data }) => {
        if (!cancelled) setRows((data as Activity[]) || []);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id, limit]);

  // Slots already burned, and the one that hasn't been. Counted over every row
  // fetched, not just the handful shown, so the summary isn't a lie of omission.
  const { tried, untried } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of rows || []) {
      if (!isDial(a.activity_type, a.outcome) || !a.activity_date) continue;
      const d = new Date(a.activity_date);
      if (isNaN(d.getTime())) continue;
      const slot = slotOfHour(d.getHours());
      counts.set(slot.label, (counts.get(slot.label) || 0) + 1);
    }
    const list = SLOTS.filter((s) => counts.has(s.label)).map((s) => ({
      label: s.label,
      count: counts.get(s.label)!,
    }));
    // Only worth naming a gap once they've actually tried a couple of times.
    const total = list.reduce((n, t) => n + t.count, 0);
    const gap =
      total >= 2 ? RETRY_SLOTS.find((s) => !counts.has(s.label))?.label ?? null : null;
    return { tried: list, untried: gap };
  }, [rows]);

  const notes = String(lead.raw_notes || lead.notes || "").trim();
  const nothing = !lead.lead_profile && !notes && rows !== null && rows.length === 0;

  return (
    <div className="rounded-xl border border-line bg-paper/50 p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-later">
        <History size={12} aria-hidden /> Before you dial
      </p>

      {/* Who they are. For a SmartAsset lead this is the whole reason to call. */}
      {lead.lead_profile && (
        <p className="mb-2 rounded-lg bg-brand-light/50 px-2.5 py-1.5 text-xs leading-relaxed text-brand-dark">
          {lead.lead_profile}
        </p>
      )}

      {rows === null && <p className="text-xs text-later">Loading history…</p>}

      {/* Which hours are already burned. The single most useful thing to know
          before you press dial: three attempts that all say 10-something are
          not three bad leads, they're one bad hour tried three times. */}
      {tried.length > 0 && (
        <p className="mb-2 text-[11px] text-worked">
          <span className="font-semibold uppercase tracking-wide text-later">Already tried</span>{" "}
          {tried.map((t) => `${t.label} ×${t.count}`).join(" · ")}
          {untried && <span className="text-brand-dark"> — never tried {untried}</span>}
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="mb-2 space-y-1">
          {rows.slice(0, limit).map((a) => (
            <li key={a.id} className="text-xs leading-snug">
              {/* Date AND time. The date alone tells you they didn't pick up;
                  the time tells you what to do differently. */}
              <span className="tabular-nums text-later">{stamp(a.activity_date)}</span>{" "}
              <span className="font-medium text-ink">{a.outcome || a.activity_type}</span>
              {a.logged_by ? <span className="text-later"> · {a.logged_by}</span> : null}
              {a.notes ? <span className="text-worked"> — {a.notes}</span> : null}
            </li>
          ))}
        </ul>
      )}

      {/* The hand-typed running history from the trackers and SmartAsset. */}
      {notes && (
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white px-2.5 py-1.5 text-xs leading-relaxed text-worked">
          {notes}
        </p>
      )}

      {nothing && (
        <p className="text-xs text-later">
          Nothing logged yet. First contact — whatever you type below becomes the history.
        </p>
      )}
    </div>
  );
}
