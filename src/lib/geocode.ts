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
