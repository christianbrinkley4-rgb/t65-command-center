#!/usr/bin/env node
// Strip home values that were never this person's home.
//
//   T65_PASSWORD=... node scripts/fix-home-values.mjs [--dry-run]
//
// A parcel is a piece of land, not a residence. An apartment complex is ONE
// parcel worth several million with a hundred front doors on it, and the
// matcher used to pick the most expensive parcel at an address, so tenants
// landed with seven-figure "home values". Same story for mobile home parks,
// commercial buildings with a flat upstairs, and vacant lots.
//
// This clears the number and records WHY (home_value_source = 'multi_unit'),
// so the lead stays in the book, stays knockable and callable, and simply
// carries no home value — which is the honest answer.
//
// Mirrors homeValueSuspect() in src/lib/homeValue.ts. Keep the two in step.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

const IMPLAUSIBLE = 1_500_000;
const MULTI_UNIT_LEADS = 4;
const UNIT_TOKENS = new Set(["APT", "UNIT", "STE", "SUITE", "LOT", "RM", "ROOM", "FL", "FLOOR", "BLDG", "TRLR"]);
const NON_HOME_USE = [
  "APARTMENT", "APARTMENTS", "MULTI", "DUPLEX", "TRIPLEX", "QUAD", "FOURPLEX",
  "COMMERCIAL", "OFFICE", "RETAIL", "STORE", "INDUSTRIAL", "WAREHOUSE",
  "VACANT", "CHURCH", "SCHOOL", "EXEMPT", "HOTEL", "MOTEL", "NURSING",
  "ASSISTED", "GROUP HOME", "MOBILE HOME PARK", "AGRICULT", "UTILITY",
];

function hasUnitMarker(address) {
  const first = String(address || "").split(",")[0].toUpperCase();
  if (first.includes("#")) return true;
  return first.replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).some((t) => UNIT_TOKENS.has(t));
}

function isNonHomeUse(t) {
  const v = String(t || "").toUpperCase();
  return v !== "" && NON_HOME_USE.some((u) => v.includes(u));
}

// Same shape as householdKey in src/lib/knock.ts, minus the street canonicalizer
// (the house number plus the first street word is enough to spot a building).
function addressKey(lead) {
  const first = String(lead.address || "").split(",")[0].trim().toUpperCase();
  const num = (first.match(/^\s*(\d+)/) || [])[1] || "";
  const street = first.replace(/^\d+\s*/, "").replace(/[^A-Z0-9 ]+/g, " ").trim().split(/\s+/)[0] || "";
  const city = String(lead.city || "").trim().toUpperCase();
  if (!num || !street) return null;
  return `${city}|${num}|${street}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  let rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, name, address, city, home_value, home_property_type, home_value_source")
      .range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`${rows.length} leads in the book`);

  const counts = new Map();
  for (const l of rows) {
    const k = addressKey(l);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }

  const reasonOf = (l) => {
    if (!(Number(l.home_value) > 0)) return null;
    if (hasUnitMarker(l.address)) return "apartment or unit in the address";
    if (isNonHomeUse(l.home_property_type)) return `not a home (${l.home_property_type})`;
    const k = addressKey(l);
    if (k && (counts.get(k) || 0) >= MULTI_UNIT_LEADS) return "several leads at one address";
    if (Number(l.home_value) >= IMPLAUSIBLE) return "implausible for a house";
    return null;
  };

  const bad = rows.map((l) => ({ l, reason: reasonOf(l) })).filter((x) => x.reason);
  const withValue = rows.filter((l) => Number(l.home_value) > 0).length;
  console.log(`${withValue} carry a home value; ${bad.length} of those can't be believed\n`);

  const byReason = new Map();
  for (const { reason } of bad) {
    const head = reason.split(" (")[0];
    byReason.set(head, (byReason.get(head) || 0) + 1);
  }
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${reason}`);
  }

  const worst = [...bad].sort((a, b) => Number(b.l.home_value) - Number(a.l.home_value)).slice(0, 10);
  console.log("\nBiggest offenders:");
  for (const { l, reason } of worst) {
    const v = `$${Math.round(Number(l.home_value) / 1000)}k`;
    console.log(`  ${v.padStart(8)}  ${String(l.address || "").slice(0, 42).padEnd(42)}  ${reason}`);
  }

  if (dryRun) {
    console.log("\n[DRY RUN] nothing written.");
    return;
  }
  if (bad.length === 0) return;

  let done = 0;
  for (const { l } of bad) {
    const { error } = await supabase
      .from("leads")
      .update({
        home_value: null,
        home_value_source: "multi_unit",
        updated_at: new Date().toISOString(),
      })
      .eq("id", l.id);
    if (error) throw error;
    done += 1;
    if (done % 100 === 0) console.log(`  ${done}/${bad.length}`);
  }
  console.log(`\nDone. ${done} leads no longer claim a home value that wasn't theirs.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
