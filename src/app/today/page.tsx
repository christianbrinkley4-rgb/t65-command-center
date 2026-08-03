"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/lib/context";
import { BUCKET_ORDER, BUCKET_LABEL, BUCKET_COLOR, effectiveDueDate, matchesWho } from "@/lib/buckets";
import BucketSection from "@/components/BucketSection";
import LeadPanel from "@/components/LeadPanel";
import SeasonBanner from "@/components/SeasonBanner";
import { actionBelongsTo, formatActionDue } from "@/lib/actions";
import type { LeadWithBucket } from "@/lib/types";

export default function TodayPage() {
  const { leads, leadsLoading, who, actionsError } = useApp();
  const [selected, setSelected] = useState<LeadWithBucket | null>(null);

  const grouped = useMemo(() => {
    const scoped = leads.filter((l) => matchesWho(l, who));
    const map: Record<string, LeadWithBucket[]> = {};
    for (const b of BUCKET_ORDER) map[b] = [];
    for (const l of scoped) {
      if (map[l._bucket]) map[l._bucket].push(l);
    }
    // Date-driven buckets sort by soonest due date, then name; the rest by name
    const dateBuckets = ["Overdue", "DueToday", "ThisWeek", "ThisMonth"];
    for (const b of BUCKET_ORDER) {
      map[b].sort((a, c) => {
        if (dateBuckets.includes(b)) {
          const da = effectiveDueDate(a, a._enr) || "9999-12-31";
          const dc = effectiveDueDate(c, c._enr) || "9999-12-31";
          if (da !== dc) return da.localeCompare(dc);
        }
        return (a.name || "").localeCompare(c.name || "");
      });
    }
    return map;
  }, [leads, who]);

  const totalToday = BUCKET_ORDER.reduce((sum, b) => sum + grouped[b].length, 0);

  const appointments = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 2);
    return leads
      .filter((l) => {
        if (!l.appointment_datetime || !matchesWho(l, who)) return false;
        const t = new Date(l.appointment_datetime).getTime();
        return t >= start.getTime() && t < end.getTime();
      })
      .sort(
        (a, c) =>
          new Date(a.appointment_datetime!).getTime() - new Date(c.appointment_datetime!).getTime()
      );
  }, [leads, who]);

  const actionTimeline = useMemo(() => {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    return leads
      .filter((lead) => lead._bucket !== "Closed" && matchesWho(lead, who))
      .flatMap((lead) =>
        (lead._actions || [])
          .filter((action) => action.status === "pending")
          // "Either" belongs to whoever is looking. Testing assigned_to === who
          // made every shared task disappear the moment Will picked his own
          // name — which is exactly when he needs to see it, since an unassigned
          // callback is still somebody's job.
          .filter((action) => who === "Everyone" || actionBelongsTo(action, who))
          .filter((action) => new Date(action.due_at).getTime() <= endOfToday.getTime())
          .map((action) => ({ lead, action }))
      )
      .sort((a, b) => new Date(a.action.due_at).getTime() - new Date(b.action.due_at).getTime());
  }, [leads, who]);

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-ink">Today&apos;s Queue</h1>
        <p className="text-sm text-slate-500">{leadsLoading ? "Loading…" : `${totalToday} leads in queue`}</p>
      </div>

      <SeasonBanner />

      {appointments.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-xl border border-newlead/40 bg-white shadow-card">
          <p className="border-b border-line bg-newlead/5 px-4 py-2.5 text-sm font-semibold text-ink">
            Appointments — today and tomorrow ({appointments.length})
          </p>
          {appointments.map((l) => (
            <button
              key={l.id}
              onClick={() => setSelected(l)}
              className="flex w-full items-center justify-between border-b border-line px-4 py-2.5 text-left last:border-b-0 hover:bg-slate-50"
            >
              <span className="truncate text-sm font-medium text-ink">{l.name || "Unnamed"}</span>
              <span className="shrink-0 text-xs font-semibold text-newlead">
                {new Date(l.appointment_datetime!).toLocaleString(undefined, {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </button>
          ))}
        </div>
      )}

      {!actionsError && actionTimeline.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-xl border border-brand/20 bg-white shadow-card">
          <p className="border-b border-brand/15 bg-brand-light/30 px-4 py-2.5 text-sm font-semibold text-brand-dark">
            Action timeline — due today ({actionTimeline.length})
          </p>
          {actionTimeline.map(({ lead, action }) => {
            const overdue = new Date(action.due_at).getTime() < Date.now();
            return (
              <button
                key={action.id}
                onClick={() => setSelected(lead)}
                className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-b-0 hover:bg-slate-50"
              >
                <span className={overdue ? "text-xs font-semibold text-overdue" : "text-xs font-semibold text-brand"}>
                  {overdue ? "Overdue" : formatActionDue(action.due_at).split(", ").slice(-1)[0]}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  <span className="font-medium">{action.action_type}</span> · {lead.name || "Unnamed lead"}
                  {action.note ? ` · ${action.note}` : ""}
                </span>
                {action.assigned_to && action.assigned_to !== "Either" && (
                  <span className="shrink-0 rounded bg-brand-light px-1.5 py-0.5 text-[10px] font-semibold text-brand-dark">
                    {action.assigned_to}
                  </span>
                )}
                <span className="hidden shrink-0 text-xs text-slate-400 sm:inline">{lead.source}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="space-y-3">
        {BUCKET_ORDER.map((b) => (
          <BucketSection
            key={b}
            bucket={b}
            label={BUCKET_LABEL[b]}
            color={BUCKET_COLOR[b]}
            leads={grouped[b]}
            defaultOpen={b === "Overdue" || b === "DueToday"}
            onSelect={setSelected}
          />
        ))}
        {!leadsLoading && totalToday === 0 && (
          <p className="rounded-xl border border-dashed border-line bg-white p-8 text-center text-sm text-slate-400">
            Nothing in the queue right now. Check New Prospecting for fresh leads.
          </p>
        )}
      </div>

      <LeadPanel lead={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
