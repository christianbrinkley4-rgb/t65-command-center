"use client";

// The top of a lead card: who they are, where they live, when they turn 65.
//
// This exists as one component because it appears in two places that must look
// identical — the Dial Session card and the card you get from searching someone
// up. Christian's words: "when we search a lead and click it it needs to pull
// up their actual lead card, just like it looks when we have them on the dials."
// Two copies of this markup would drift within a week, and the version you see
// mid-call would stop matching the version you check before dialing.

import LeadAddress, { zipOf } from "@/components/LeadAddress";
import T65Badge from "@/components/T65Badge";
import { listLabel } from "@/lib/categories";
import { iepPhase, IEP_LABEL, isFresh } from "@/lib/priority";
import { trustedHomeValue } from "@/lib/homeValue";
import { distanceLabel, milesFrom, OFFICE } from "@/lib/distance";
import { askedNotToBeCalled, onScrubList, type LeadWithBucket } from "@/lib/types";

export default function LeadCardHeader({
  lead,
  /** The dial card runs at 3xl; the search card is a touch smaller. */
  size = "lg",
}: {
  lead: LeadWithBucket;
  size?: "lg" | "md";
}) {
  const phase = iepPhase(lead.birthday);
  const nameClass =
    size === "lg"
      ? "font-display text-3xl font-semibold text-ink"
      : "font-display text-2xl font-semibold text-ink";

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        {/* The month they turn 65 sits with the name, never further down. It's
            the first thing you have to know on a live call: it sets whether
            this is an enrollment conversation or a "let's talk in the spring"
            conversation. */}
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className={nameClass}>{lead.name || "Unnamed lead"}</h2>
          <T65Badge birthday={lead.birthday} size="md" showMissing />
        </div>

        {/* Address up top: you need it before you talk, not after. */}
        <LeadAddress lead={lead} className="mt-1 text-sm" size={14} />

        <p className="mt-0.5 text-sm text-worked">
          {zipOf(lead) ? `ZIP ${zipOf(lead)} · ` : ""}
          {listLabel(lead.source)}
          {lead.tier ? ` · Tier ${lead.tier}` : ""}
          {trustedHomeValue(lead) ? ` · $${Math.round(Number(trustedHomeValue(lead)) / 1000)}k home` : ""}
          {/* How far you'd be driving if this call books. Worth knowing before
              you offer a time, not after. */}
          {milesFrom(lead, OFFICE) !== null ? ` · ${distanceLabel(milesFrom(lead, OFFICE))} out` : ""}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {isFresh(lead) && (
          <span className="rounded bg-brand px-2 py-0.5 text-[11px] font-bold uppercase text-white">New</span>
        )}
        {phase && phase !== "outside" && (
          <span className="rounded bg-newlead px-2 py-0.5 text-[11px] font-semibold text-white">
            {IEP_LABEL[phase]}
          </span>
        )}
        {askedNotToBeCalled(lead) && (
          <span
            className="rounded bg-overdue px-2 py-0.5 text-[11px] font-semibold text-white"
            title="This person asked not to be called"
          >
            Asked to stop
          </span>
        )}
        {onScrubList(lead) && (
          <span
            className="rounded bg-due-50 px-2 py-0.5 text-[11px] font-semibold text-due"
            title="Flagged by a bulk list scrub, not by the person"
          >
            DNC list
          </span>
        )}
      </div>
    </div>
  );
}
