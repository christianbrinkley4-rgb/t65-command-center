// The handful of places a route starts or ends at: the office, home, the
// coffee shop before a 9am, campus. Six of them, on this phone, in
// localStorage — small enough that syncing it to Supabase would cost more than
// it's worth, and personal enough that it shouldn't be shared with Will anyway.
//
// This used to live inside RoutePlanner. It moved here so the map picker can
// save a dropped pin without importing the dialog that opens it.

export type SavedPlace = {
  /** Short name for a chip: "400 Bellemeade", "Home". */
  label: string;
  /**
   * Something Google can geocode, or "lat,lng" for a dropped pin. Empty is
   * legal and means the point is all we have.
   */
  address: string;
  lat: number;
  lng: number;
};

const PLACES_KEY = "t65-places";
const MAX_PLACES = 6;

export function loadPlaces(): SavedPlace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PLACES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, MAX_PLACES) : [];
  } catch {
    return [];
  }
}

/**
 * Most recent first, deduped. A dropped pin with no address dedupes on its
 * rounded coordinates instead, so tapping roughly the same spot twice doesn't
 * push the office out of the list.
 */
export function savePlace(p: SavedPlace): SavedPlace[] {
  const key = placeKey(p);
  const next = [p, ...loadPlaces().filter((x) => placeKey(x) !== key)].slice(0, MAX_PLACES);
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked localStorage must never stop a route from being built.
  }
  return next;
}

function placeKey(p: SavedPlace): string {
  const addr = p.address.trim().toLowerCase();
  if (addr) return addr;
  return `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
}

/** Five decimals is about a metre — plenty for a driveway, short enough to read. */
export function coordLabel(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
