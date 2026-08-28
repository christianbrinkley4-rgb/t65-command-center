import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Census geocoder proxy. The Census API has no browser CORS, so the app calls
// this instead. No key, no cost.
//
// Two shapes in, because the app asks two different questions:
//
//   {addresses: [{id, street, city, state, zip}]}  (≤500)
//     One Census BATCH request. Returns {results: [{id, lat, lng}]} for matches
//     only — the nightly backfill that puts leads on the map.
//
//   {oneline: "400 Bellemeade St, Greensboro NC"}
//     One Census ONELINE request. Returns {point: {lat, lng}} or {point: null}
//     — the route planner resolving a typed start or finish.
//
// The oneline branch was missing while the planner was already calling it,
// so every typed address came back "Couldn't find that address." Dropping a
// pin on the map avoids this path entirely; this makes typing work too.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const ONELINE_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

type Addr = { id: string; street?: string; city?: string; state?: string; zip?: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  let payload: { addresses?: Addr[]; oneline?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  // Single free-text address → one point.
  const oneline = String(payload.oneline || "").trim();
  if (oneline) {
    try {
      const u = new URL(ONELINE_URL);
      u.searchParams.set("address", oneline);
      u.searchParams.set("benchmark", "Public_AR_Current");
      u.searchParams.set("format", "json");
      const resp = await fetch(u.toString());
      if (!resp.ok) return json({ point: null, error: "census_error", status: resp.status });
      const body = await resp.json();
      const m = body?.result?.addressMatches?.[0];
      const lat = Number(m?.coordinates?.y);
      const lng = Number(m?.coordinates?.x);
      if (!isFinite(lat) || !isFinite(lng)) return json({ point: null });
      return json({ point: { lat, lng }, matched: m?.matchedAddress || null });
    } catch (e) {
      return json({ point: null, error: "exception", message: String(e) });
    }
  }

  const addresses = (payload.addresses || []).slice(0, 500);
  if (!addresses.length) return json({ results: [] });

  const cell = (v: unknown) => `"${String(v || "").replace(/"/g, "")}"`;
  const csv = addresses
    .map((a) => {
      const street = String(a.street || "").split(",")[0].trim();
      return [cell(a.id), cell(street), cell(a.city), cell(a.state || "NC"), cell(a.zip)].join(",");
    })
    .join("\n");

  try {
    const form = new FormData();
    form.append("addressFile", new Blob([csv], { type: "text/csv" }), "batch.csv");
    form.append("benchmark", "Public_AR_Current");
    const resp = await fetch(BATCH_URL, { method: "POST", body: form });
    if (!resp.ok) return json({ error: "census_error", status: resp.status }, 200);
    const text = await resp.text();

    const results: { id: string; lat: number; lng: number }[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const cols = line
        .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
        ?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, ""));
      if (!cols || cols.length < 6) continue;
      const [id, , status, , , coords] = cols;
      if (status === "Match" && coords && coords.includes(",")) {
        const [lng, lat] = coords.split(",").map(Number);
        if (isFinite(lat) && isFinite(lng)) results.push({ id, lat, lng });
      }
    }
    return json({ results });
  } catch (e) {
    return json({ error: "exception", message: String(e) }, 200);
  }
});
