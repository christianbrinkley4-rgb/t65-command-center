"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useApp } from "@/lib/context";
import LeadRow from "@/components/LeadRow";
import EditDrawer from "@/components/EditDrawer";
import type { LeadWithBucket } from "@/lib/types";

function normalizePhone(s: string) {
  return s.replace(/\D/g, "");
}

export default function SearchPage() {
  const { leads, leadsLoading } = useApp();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<LeadWithBucket | null>(null);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const phoneQuery = normalizePhone(query);
    return leads
      .filter((l) => {
        const name = (l.name || "").toLowerCase();
        const city = (l.city || "").toLowerCase();
        const source = (l.source || "").toLowerCase();
        const email = (l.email || "").toLowerCase();
        const phone = normalizePhone(l.phone || "");
        const phone2 = normalizePhone(l.phone2 || "");
        if (name.includes(query)) return true;
        if (city.includes(query) || source.includes(query) || email.includes(query)) return true;
        if (phoneQuery.length >= 4 && (phone.includes(phoneQuery) || phone2.includes(phoneQuery)))
          return true;
        return false;
      })
      .slice(0, 200);
  }, [leads, q]);

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold text-ink">Search All Leads</h1>
      <div className="relative mb-4">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, phone, city, source, or email…"
          className="w-full rounded-lg border border-line py-2.5 pl-9 pr-3 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>

      {leadsLoading && <p className="text-sm text-slate-400">Loading leads…</p>}

      {!leadsLoading && q.trim() && (
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-card">
          {results.map((l) => (
            <LeadRow key={l.id} lead={l} onClick={() => setSelected(l)} showAddress />
          ))}
          {results.length === 0 && (
            <p className="p-8 text-center text-sm text-slate-400">No matches for &quot;{q}&quot;.</p>
          )}
        </div>
      )}

      {!q.trim() && !leadsLoading && (
        <p className="rounded-xl border border-dashed border-line bg-white p-8 text-center text-sm text-slate-400">
          {leads.length.toLocaleString()} leads total. Start typing to search.
        </p>
      )}

      <EditDrawer lead={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
