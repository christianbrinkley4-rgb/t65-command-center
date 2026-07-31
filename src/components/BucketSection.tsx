"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import clsx from "clsx";
import LeadRow from "@/components/LeadRow";
import type { LeadWithBucket, UiBucket } from "@/lib/types";

export default function BucketSection({
  bucket,
  label,
  color,
  leads,
  defaultOpen,
  onSelect,
}: {
  bucket: UiBucket;
  label: string;
  color: string;
  leads: LeadWithBucket[];
  defaultOpen?: boolean;
  onSelect: (lead: LeadWithBucket) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (leads.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-card">
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx("flex w-full items-center justify-between px-4 py-3", `bg-${color}-50`)}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className={clsx("h-2 w-2 rounded-full", `dot-${color}`)} />
          {label}
          <span className="text-xs font-normal text-slate-400">({leads.length})</span>
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && (
        <div>
          {leads.map((l) => (
            <LeadRow key={l.id} lead={l} onClick={() => onSelect(l)} />
          ))}
        </div>
      )}
    </div>
  );
}
