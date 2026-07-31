// How far away is this person, and is that too far to be worth a call?
//
// The May list is 1,801 people across fourteen counties — Chapel Hill, Salisbury,
// Mount Airy, Roxboro. Those are real turning-65 leads and some of them will
// answer the phone, but an appointment out there is most of a day in the car for
// one application. Distance is the filter that was missing: it lets a calling
// session be built the same way a door route is, around where you actually are.
//
// The anchor is the branch by default, because that's where an appointment
// usually happens, with the option to anchor on wherever the phone is instead.

import { haversineMiles, type LatLng } from "./route";
import type { Lead } from "./types";

/** Bankers Life, 400 Bellemeade St, Greensboro. Where appointments happen. */
export const OFFICE: LatLng = { lat: 36.075586, lng: -79.79394 };
export const OFFICE_LABEL = "the Greensboro office";

export type DistanceOrigin = "office" | "me";

export const DISTANCE_BANDS: { value: number; label: string }[] = [
  { value: 0, label: "Any distance" },
  { value: 10, label: "Within 10 miles" },
  { value: 15, label: "Within 15 miles" },
  { value: 20, label: "Within 20 miles" },
  { value: 30, label: "Within 30 miles" },
  { value: 50, label: "Within 50 miles" },
];

export function hasPosition(lead: Lead): boolean {
  return typeof lead.latitude === "number" && typeof lead.longitude === "number";
}

/** Straight-line miles from `origin`, or null when the lead was never mapped. */
export function milesFrom(lead: Lead, origin: LatLng | null): number | null {
  if (!origin || !hasPosition(lead)) return null;
  return haversineMiles(origin.lat, origin.lng, lead.latitude as number, lead.longitude as number);
}

/**
 * Within the ring?
 *
 * `includeUnmapped` exists for the same reason the value filter has one: a few
 * hundred leads have an address the county never matched, and a distance cap
 * that silently deleted them would quietly shrink the book with no explanation.
 * Unknown distance is not the same as "too far", so by default it stays.
 *
 * Straight-line understates driving, so a 20-mile ring is really closer to a
 * 25-minute drive. That's the right way to be wrong here: it errs toward
 * keeping a lead rather than hiding one.
 */
export function withinMiles(
  lead: Lead,
  origin: LatLng | null,
  maxMiles: number,
  includeUnmapped = true
): boolean {
  if (!maxMiles) return true;
  const d = milesFrom(lead, origin);
  if (d === null) return includeUnmapped;
  return d <= maxMiles;
}

/** "12 mi" — short enough to sit on a dialing card without crowding it. */
export function distanceLabel(miles: number | null): string {
  if (miles === null) return "";
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}
