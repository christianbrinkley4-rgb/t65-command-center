"use client";

// The touch record, as chips. Mail, phone, door — what we already did here.
//
// Colour carries the channel so it reads without being read: mail is the brand
// terracotta, a dial is the cool one, a knock is the green you already use for
// a door that produced something. Standing in a driveway you get the answer
// from the shape of the row, not by parsing a sentence.

import { Mail, Phone, DoorOpen } from "lucide-react";
import { contactTrail, householdTrail, type TouchKind } from "@/lib/trail";
import type { Lead } from "@/lib/types";

const ICON: Record<TouchKind, typeof Mail> = {
  mailer: Mail,
  dial: Phone,
  knock: DoorOpen,
};

const TONE: Record<TouchKind, string> = {
  mailer: "border-brand/40 bg-brand-light/40 text-brand-dark",
  dial: "border-month/40 bg-white text-month",
  knock: "border-newlead/40 bg-white text-newlead",
};

export default function ContactTrail({
  lead,
  occupants,
  size = "sm",
  className = "",
}: {
  lead?: Lead;
  /** A whole door. Knocks reach everyone inside, so they merge, not stack. */
  occupants?: Lead[];
  /** `xs` for dense list rows, `sm` for a card you're reading. */
  size?: "xs" | "sm";
  className?: string;
}) {
  const touches = occupants ? householdTrail(occupants) : lead ? contactTrail(lead) : [];
  if (touches.length === 0) return null;

  const box =
    size === "xs"
      ? "gap-1 rounded px-1.5 py-0.5 text-[10px]"
      : "gap-1 rounded-md px-2 py-0.5 text-[11px]";
  const icon = size === "xs" ? 10 : 12;

  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
      {touches.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <span
            key={t.kind}
            title={t.detail}
            className={`inline-flex items-center border font-semibold ${box} ${TONE[t.kind]}`}
          >
            <Icon size={icon} aria-hidden />
            {t.label}
          </span>
        );
      })}
    </span>
  );
}
