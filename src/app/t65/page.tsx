"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { iepPhase, turning65Date, type IepPhase } from "@/lib/priority";
import LeadRow from "@/components/LeadRow";
import LeadPanel from "@/components/LeadPanel";
import type { LeadWithBucket } from "@/lib/types";

const GROUPS: { phase: Exclude<IepPhase, null | "outside">; title: string; blurb: string }[] = [
  {
    phase: "closing",
    title: "IEP closing — last months to enroll",
    blurb: "Birthday month has passed. They have up to 3 months left and coverage is already delayed. Call first.",
  },
  {
    phase: "birthday",
    title: "Turning 65 this month",
    blurb: "Enrolling now means coverage starts next month. Urgent but still in the clean part of the window.",
  },
  {
    phase: "hot",
    title: "Hot window — 1 to 3 months out",
    blurb: "Enrolling now means coverage starts the month they turn 65. This is the money window.",
  },
  {
    phase: "approaching",
    title: "Approaching — 4 to 6 months out",
    blurb: "Perfect for first-touch education calls before every other agent's mailer lands.",
  },
];

function fmtT65(lead: LeadWithBucket): string {
  const d = turning65Date(lead.birthday);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function T65RadarPage() {
  const { leads, leadsLoading, who } = useApp();
  const [selected, setSelected] = useState<LeadWithBucket | null>(null);

  const grouped = useMemo(() => {
    const scoped = leads.filter(
      (l) => matchesWho(l, who) && l._bucket !== "Closed" && l.birthday
    );
    const map = new Map<string, LeadWithBucket[]>();
    for (const g of GROUPS) map.set(g.phase, []);
    for (const l of scoped) {
      const p = iepPhase(l.birthday);
      if (p && map.has(p)) map.get(p)!.push(l);
    }
    for (const g of GROUPS) {
      map.get(g.phase)!.sort((a, b) => {
        const ta = turning65Date(a.birthday)?.getTime() ?? 0;
        const tb = turning65Date(b.birthday)?.getTime() ?? 0;
        return ta - tb;
      });
    }
    return map;
  }, [leads, who]);

  const inWindow = GROUPS.reduce((sum, g) => sum + (grouped.get(g.phase)?.length || 0), 0);

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-ink">T65 Radar</h1>
        <p className="text-sm text-slate-500">
          {leadsLoading ? "Loading…" : `${inWindow} open leads in or near their IEP window`}
        </p>
      </div>

      <div className="space-y-4">
        {GROUPS.map((g) => {
          const list = grouped.get(g.phase) || [];
          if (list.length === 0) return null;
          return (
            <div key={g.phase} className="overflow-hidden rounded-xl border border-line bg-white shadow-card">
              <div className="border-b border-line bg-newlead/5 px-4 py-3">
                <p className="text-sm font-semibold text-ink">
                  {g.title} <span className="font-normal text-slate-400">({list.length})</span>
                </p>
                <p className="text-xs text-slate-500">{g.blurb}</p>
              </div>
              {list.map((l) => (
                <LeadRow key={l.id} lead={l} onClick={() => setSelected(l)} rightNote={`65 on ${fmtT65(l)}`} />
              ))}
            </div>
          );
        })}
        {!leadsLoading && inWindow === 0 && (
          <p className="rounded-xl border border-dashed border-line bg-white p-8 text-center text-sm text-slate-400">
            No open leads with birthdays in or near the IEP window.
          </p>
        )}
      </div>

      <LeadPanel lead={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
