// Home value as a BAND, not a floor.
//
// The old filter could only say "$250k and up", which is the wrong shape for
// door work. The doors that buy a Med Supp sit in a middle range. Under it,
// people are often on Medicaid, a dual-eligible plan, or genuinely can't afford
// a supplement. Over about $750k they have an advisor, a gate, an employer
// retiree plan, or all three, and a cold door is the worst possible way to
// reach them. Being able to say "up to $750k" removes a whole category of
// wasted driving.
//
// The $750k+ doors are not junk, they're a different product. Annuity and LTC
// money, and the kind of household William works. So they stay in the book and
// get their own band rather than being deleted.

export type ValueBand = {
  key: string;
  label: string;
  /** Inclusive floor. */
  min: number;
  /** Exclusive ceiling; null means no ceiling. */
  max: number | null;
  group: "Caps" | "Bands" | "Everything else";
};

export const VALUE_BANDS: ValueBand[] = [
  { key: "any", label: "Any home value", min: 0, max: null, group: "Caps" },
  { key: "upto500", label: "Up to $500k", min: 0, max: 500_000, group: "Caps" },
  { key: "upto750", label: "Up to $750k", min: 0, max: 750_000, group: "Caps" },
  { key: "under250", label: "Under $250k", min: 0, max: 250_000, group: "Bands" },
  { key: "b250_500", label: "$250k to $500k", min: 250_000, max: 500_000, group: "Bands" },
  { key: "b500_750", label: "$500k to $750k", min: 500_000, max: 750_000, group: "Bands" },
  { key: "over250", label: "$250k and up", min: 250_000, max: null, group: "Everything else" },
  { key: "over750", label: "$750k+ (annuity / advisor play)", min: 750_000, max: null, group: "Everything else" },
  { key: "unknown", label: "No value on file", min: 0, max: null, group: "Everything else" },
];

export const BAND_GROUPS: ValueBand["group"][] = ["Caps", "Bands", "Everything else"];

export function findBand(key: string): ValueBand {
  return VALUE_BANDS.find((b) => b.key === key) || VALUE_BANDS[0];
}

/**
 * `includeUnknown` is the whole ballgame on a capped band. Hundreds of doors
 * have no parcel match (PO boxes, new construction, a county that formats
 * addresses differently), and silently dropping them would quietly delete a
 * third of the book the first time someone picked "up to $750k". Default to
 * keeping them: you can't rule out a house you've never priced.
 */
export function matchesValueBand(
  value: number | null | undefined,
  bandKey: string,
  includeUnknown: boolean
): boolean {
  const v = Number(value || 0);
  const known = v > 0;
  if (bandKey === "any") return true;
  if (bandKey === "unknown") return !known;
  if (!known) return includeUnknown;
  const band = findBand(bandKey);
  if (v < band.min) return false;
  if (band.max !== null && v >= band.max) return false;
  return true;
}

// Occupancy comes from the same NC OneMap parcel record as the value. An
// absentee owner means the name on the list may not answer that door at all,
// which is a wasted stop before you knock it. Unknown occupancy stays in the
// "Any" view only, since most of the book has never been matched.
export type Occupancy = "any" | "owner" | "absentee";

export const OCCUPANCY_OPTIONS: { key: Occupancy; label: string }[] = [
  { key: "any", label: "Any occupancy" },
  { key: "owner", label: "Owner-occupied only" },
  { key: "absentee", label: "Absentee / rental" },
];

export function matchesOccupancy(ownerOccupied: boolean | null | undefined, want: Occupancy): boolean {
  if (want === "any") return true;
  if (ownerOccupied === null || ownerOccupied === undefined) return false;
  return want === "owner" ? ownerOccupied === true : ownerOccupied === false;
}

/**
 * Old saved views stored a bare minimum. Map them onto the nearest band, and
 * when there isn't one, widen rather than narrow — a saved view that quietly
 * hides leads is worse than one that shows a few extra.
 */
export function bandFromLegacyMin(minValue: number): string {
  if (minValue >= 750_000) return "over750";
  if (minValue >= 250_000) return "over250";
  return "any";
}
