"use client";

import { CalendarClock } from "lucide-react";
import { seasonInfo } from "@/lib/season";

export default function SeasonBanner() {
  const s = seasonInfo();
  const live = s.inSeason !== null;
  return (
    <div
      className={
        live
          ? "mb-4 flex items-center gap-2 rounded-xl border border-newlead/40 bg-newlead/10 px-4 py-2.5 text-sm text-newlead"
          : "mb-4 flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2.5 text-sm text-slate-600 shadow-card"
      }
    >
      <CalendarClock size={16} className="shrink-0" />
      <span>{s.message}</span>
    </div>
  );
}
