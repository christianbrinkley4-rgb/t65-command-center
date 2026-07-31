"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import LeadRow from "@/components/LeadRow";
import EditDrawer from "@/components/EditDrawer";
import type { LeadWithBucket } from "@/lib/types";

const PAGE_SIZE = 100;

export default function NewProspectingPage() {
  const { leads, leadsLoading, who } = useApp();
  const [selected, setSelected] = useState<LeadWithBucket | null>(null);
  const [cohort, setCohort] = useState("All");
  const [tier, setTier] = useState("All");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const newLeads = useMemo(
    () => leads.filter((l) => l._bucket === "New" && matchesWho(l, who)),
    [leads, who]
  );

  const cohorts = useMemo(
    () => ["All", ...Array.from(new Set(newLeads.map((l) => l.source || "Unknown"))).sort()],
    [newLeads]
  );
  const tiers = useMemo(
    () => ["All", ...Array.from(new Set(newLeads.map((l) => l.tier || "Unrated"))).sort()],
    [newLeads]
  );

  const filtered = useMemo(() => {
    let list = newLeads;
    if (cohort !== "All") list = list.filter((l) => (l.source || "Unknown") === cohort);
    if (tier !== "All") list = list.filter((l) => (l.tier || "Unrated") === tier);
    return [...list].sort((a, b) => Number(b.home_value || 0) - Number(a.home_value || 0));
  }, [newLeads, cohort, tier]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">New Prospecting</h1>
        <p className="text-sm text-slate-500">
          {leadsLoading ? "Loading…" : `${filtered.length} never-dialed leads, sorted by home value`}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={cohort}
          onChange={(e) => {
            setCohort(e.target.value);
            setVisible(PAGE_SIZE);
          }}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
        >
          {cohorts.map((c) => (
            <option key={c} value={c}>
              {c === "All" ? "All cohorts" : c}
            </option>
          ))}
        </select>
        <select
          value={tier}
          onChange={(e) => {
            setTier(e.target.value);
            setVisible(PAGE_SIZE);
          }}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
        >
          {tiers.map((t) => (
            <option key={t} value={t}>
              {t === "All" ? "All tiers" : t}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-white shadow-card">
        {filtered.slice(0, visible).map((l) => (
          <LeadRow key={l.id} lead={l} onClick={() => setSelected(l)} />
        ))}
        {filtered.length === 0 && !leadsLoading && (
          <p className="p-8 text-center text-sm text-slate-400">No leads match this filter.</p>
        )}
      </div>

      {visible < filtered.length && (
        <button
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="mt-3 w-full rounded-lg border border-line bg-white py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          Load {Math.min(PAGE_SIZE, filtered.length - visible)} more
        </button>
      )}

      <EditDrawer lead={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
