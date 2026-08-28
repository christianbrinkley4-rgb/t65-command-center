// Address → coordinates for door-knock routing. The US Census geocoder is
// free and keyless but blocks browser CORS, so the app goes through the
// `geocode` Supabase edge function, which batches up to 500 addresses per
// Census request. A lead with no match simply can't be routed (it still shows
// in the normal street-grouped list).

import { supabase } from "./supabaseClient";

export type GeocodeProgress = { checked: number; matched: number; total: number };

/**
 * Geocode every lead that has an address but has never been tried. Misses
 * still get geocoded_at stamped so they aren't retried every pass.
 */
export async function geocodeUncheckedLeads(
  onProgress?: (p: GeocodeProgress) => void,
  batchLimit = 500
): Promise<GeocodeProgress> {
  const { data: targets, error } = await supabase
    .from("leads")
    .select("id, address, city, state, zip")
    .not("address", "is", null)
    .neq("address", "")
    .is("geocoded_at", null)
    .limit(batchLimit);
  if (error) throw error;

  const progress: GeocodeProgress = { checked: 0, matched: 0, total: targets?.length || 0 };
  if (!targets || targets.length === 0) return progress;

  const { data, error: fnError } = await supabase.functions.invoke("geocode", {
    body: {
      addresses: targets.map((l) => ({
        id: l.id,
        street: l.address,
        city: l.city,
        state: l.state || "NC",
        zip: l.zip,
      })),
    },
  });
  if (fnError) throw fnError;

  const points = new Map<string, { lat: number; lng: number }>();
  for (const r of data?.results || []) {
    if (r?.id && isFinite(r.lat) && isFinite(r.lng)) points.set(r.id, { lat: r.lat, lng: r.lng });
  }

  const now = new Date().toISOString();
  for (const lead of targets) {
    const pt = points.get(lead.id);
    if (pt) progress.matched++;
    await supabase
      .from("leads")
      .update({ latitude: pt?.lat ?? null, longitude: pt?.lng ?? null, geocoded_at: now })
      .eq("id", lead.id);
    progress.checked++;
    onProgress?.({ ...progress });
  }
  return progress;
}

/**
 * Coordinates → a street address, for labelling a pin the agent dropped on the
 * map. OpenStreetMap's Nominatim, because the Census batch geocoder only runs
 * one direction and reverse-geocoding a single point doesn't justify a second
 * edge function.
 *
 * Best effort by design. The route math never needs this — a dropped pin is
 * already a point, and the Google Maps handoff falls back to "lat,lng", which
 * it accepts. So every failure path here returns null and the pin still works.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<{ label: string; address: string } | null> {
  const url =
    "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1" +
    `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
  try {
    const resp = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const a = data?.address;
    if (!a) return null;

    const street = [a.house_number, a.road].filter(Boolean).join(" ").trim();
    const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || "";
    const label = street || town || data.name || null;
    if (!label) return null;

    const address = [street || town, town && street ? town : "", a.state, a.postcode]
      .filter(Boolean)
      .join(", ")
      .replace(/, (\d{5})$/, " $1");
    return { label, address: address || label };
  } catch {
    // Aborted, offline, rate-limited, CORS — all the same answer to the caller.
    return null;
  }
}
