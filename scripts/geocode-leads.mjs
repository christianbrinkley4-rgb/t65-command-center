#!/usr/bin/env node
// Backfill leads.latitude/longitude via the US Census BATCH geocoder — one
// POST per 5,000 addresses instead of one request per lead. Free, no key.
//
//   T65_PASSWORD=... node scripts/geocode-leads.mjs
//
// Re-runnable: only touches leads with an address and geocoded_at null.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

const BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const BATCH_SIZE = 2500;

async function main() {
  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  // PostgREST caps a response at 1,000 rows no matter what .limit() says, so
  // this has to page. Without it a 1,800-lead import needed two manual runs and
  // looked finished after the first.
  let targets = [];
  for (let page = 0; page < 12; page++) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, address, city, state, zip")
      .not("address", "is", null)
      .neq("address", "")
      .is("geocoded_at", null)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    targets = targets.concat(data);
    if (data.length < 1000) break;
  }
  if (!targets.length) {
    console.log("Nothing to geocode.");
    return;
  }
  console.log(`Geocoding ${targets.length} leads via Census batch API...`);

  let matched = 0;
  for (let b = 0; b < targets.length; b += BATCH_SIZE) {
    const batch = targets.slice(b, b + BATCH_SIZE);
    // Batch CSV format: id,street,city,state,zip (no header)
    const csv = batch
      .map((l) => {
        const street = String(l.address || "").split(",")[0].replace(/"/g, "").trim();
        const cell = (v) => `"${String(v || "").replace(/"/g, "")}"`;
        return [cell(l.id), cell(street), cell(l.city), cell(l.state || "NC"), cell(l.zip)].join(",");
      })
      .join("\n");

    // The Census batch endpoint throws a 502 now and then under load. It used
    // to abort the whole run, which on a 1,800-lead import meant losing every
    // batch after the first hiccup and having no idea how far it got. Retry
    // with a backoff, and if a batch still won't go, skip it and keep moving —
    // those leads keep geocoded_at null and get picked up on the next run.
    let text = null;
    for (let attempt = 1; attempt <= 4 && text === null; attempt++) {
      const form = new FormData();
      form.append("addressFile", new Blob([csv], { type: "text/csv" }), "batch.csv");
      form.append("benchmark", "Public_AR_Current");
      try {
        const resp = await fetch(BATCH_URL, { method: "POST", body: form });
        if (resp.ok) {
          text = await resp.text();
          break;
        }
        console.warn(`  batch ${b / BATCH_SIZE + 1}: HTTP ${resp.status}, attempt ${attempt}/4`);
      } catch (e) {
        console.warn(`  batch ${b / BATCH_SIZE + 1}: ${e.message}, attempt ${attempt}/4`);
      }
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 4000));
    }
    if (text === null) {
      console.warn(`  batch ${b / BATCH_SIZE + 1}: giving up, left for the next run`);
      continue;
    }

    // Result rows: "id","input addr","Match|No_Match|Tie","Exact|Non_Exact","matched addr","lng,lat",tigerid,side
    const results = new Map();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, ""));
      if (!cols || cols.length < 6) continue;
      const [id, , status, , , coords] = cols;
      if (status === "Match" && coords && coords.includes(",")) {
        const [lng, lat] = coords.split(",").map(Number);
        if (isFinite(lat) && isFinite(lng)) results.set(id, { lat, lng });
      }
    }

    const now = new Date().toISOString();
    for (const l of batch) {
      const pt = results.get(l.id);
      if (pt) matched++;
      const { error: upErr } = await supabase
        .from("leads")
        .update({ latitude: pt?.lat ?? null, longitude: pt?.lng ?? null, geocoded_at: now })
        .eq("id", l.id);
      if (upErr) console.warn(`update failed for ${l.id}: ${upErr.message}`);
    }
    console.log(`  batch ${b / BATCH_SIZE + 1}: ${results.size}/${batch.length} matched`);
  }
  console.log(`Done. ${matched}/${targets.length} leads now have coordinates.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
