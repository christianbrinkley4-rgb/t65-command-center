"use client";

// What happened last time, on screen before the phone connects.
//
// Dialing someone whose history you can't see is how you open with "is now a
// good time" to a person who told you last month they're with another advisor.
// Everything already known about this lead, newest first: who they are from
// the survey, then every logged touch, then the free-text history that came in
// from the trackers and SmartAsset.

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import type { Activity, LeadWithBucket } from "@/lib/types";

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
      .limit(limit)
      .then(({ data }) => {
        if (!cancelled) setRows((data as Activity[]) || []);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id, limit]);

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

      {rows !== null && rows.length > 0 && (
        <ul className="mb-2 space-y-1">
          {rows.map((a) => (
            <li key={a.id} className="text-xs leading-snug">
              <span className="tabular-nums text-later">
                {a.activity_date
                  ? new Date(a.activity_date).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "2-digit",
                    })
                  : "—"}
              </span>{" "}
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
