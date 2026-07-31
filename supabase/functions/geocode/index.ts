import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Census geocoder proxy. The Census API has no browser CORS, so the app calls
// this instead. Takes {addresses: [{id, street, city, state, zip}]} (≤500),
// runs one Census BATCH request, returns {results: [{id, lat, lng}]} for
// matches only. No key, no cost.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";

type Addr = { id: string; street?: string; city?: string; state?: string; zip?: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  let payload: { addresses?: Addr[] };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
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
