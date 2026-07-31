"use client";

// Where this person actually lives, on every screen you dial from.
//
// On the phone the address is doing three jobs at once: it tells you which
// neighborhood you're talking to before you open your mouth, it tells you
// whether they're worth a door if the call goes nowhere, and it's the first
// thing you have to confirm on an application. Having to open the drawer to
// find it costs a beat in the middle of a live call.
//
// Tapping it opens Maps, so a lead you couldn't reach by phone can go straight
// onto a knock route.

import { MapPin } from "lucide-react";
import type { Lead } from "@/lib/types";

type AddressLead = Pick<Lead, "address" | "city" | "state" | "zip">;

/** The ZIP, from the column or from the end of the address line. */
export function zipOf(lead: AddressLead): string {
  const z = String(lead.zip || "").trim();
  if (z) return z.slice(0, 5);
  const m = String(lead.address || "").match(/(\d{5})(?:-\d{4})?\s*$/);
  return m ? m[1] : "";
}

/** "1631 Bantam Rd, Pleasant Garden, NC 27313" from whatever parts exist. */
export function fullAddress(lead: AddressLead): string {
  const street = String(lead.address || "").split(",")[0].trim();
  const cityState = [lead.city, lead.state || "NC"].filter(Boolean).join(", ");
  return [street, cityState, zipOf(lead)].filter(Boolean).join(" ").trim();
}

export default function LeadAddress({
  lead,
  className = "",
  size = 13,
}: {
  lead: AddressLead;
  className?: string;
  size?: number;
}) {
  const street = String(lead.address || "").split(",")[0].trim();
  if (!street) {
    // Say it plainly. A blank line reads as "didn't load"; this reads as a
    // record to fix, and it's the reason a lead can't go on a knock route.
    return (
      <p className={`flex items-center gap-1 text-later ${className}`}>
        <MapPin size={size} className="shrink-0" aria-hidden />
        <span>No address on file</span>
      </p>
    );
  }
  const query = encodeURIComponent(fullAddress(lead));
  return (
    <a
      href={`https://maps.google.com/?q=${query}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Open in Google Maps"
      className={`flex items-center gap-1 text-brand underline-offset-2 hover:underline ${className}`}
    >
      <MapPin size={size} className="shrink-0" aria-hidden />
      <span className="truncate">
        {street}
        {lead.city ? `, ${lead.city}` : ""}
        {zipOf(lead) ? ` ${zipOf(lead)}` : ""}
      </span>
    </a>
  );
}
