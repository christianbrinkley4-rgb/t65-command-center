#!/usr/bin/env node
// Backfill leads.home_value (+ owner-occupied / property-type) from the NC
// OneMap statewide parcel layer — free, no API key, matched live per address.
//
// Why per-address instead of bulk-caching a whole county (the approach the
// C:\dialer Python dialer uses): that system re-matches thousands of contacts
// every day at power-dialer speed, so caching pays for itself. This CRM only
// needs to check each lead once (home_value_checked_at is the checkpoint), and
// the book is ~2,700 leads — a live query per lead is simpler to maintain and
// avoids owning a second copy of county parcel data.
//
// Run after any OSCR/T65 import that added leads without a home value:
//   node scripts/enrich-home-value.mjs
//   node scripts/enrich-home-value.mjs --limit 200      (smaller batch)
//   node scripts/enrich-home-value.mjs --recheck-misses  (retry old no_match rows)
//
// Auth: signs in with the shared team login (same one the app itself uses),
// which is all RLS requires (authenticated read/write on leads) — no service
// role key needed or stored.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
// Credentials come from env so this file never carries a secret:
//   T65_EMAIL=team@bankerst65.com T65_PASSWORD=... npm run enrich:home-value
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

const NC_PARCELS_LAYER =
  "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query";
const PULL_FIELDS =
  "cntyname,saddno,saddstr,siteadd,scity,szip,parval,parvaltype,parusedesc,ownname,mailadd,mcity";
const SLEEP_BETWEEN_MS = 150;
const CONCURRENCY = 4;

// ── address normalization (ported from C:\dialer\command_center\property_values.py) ──

const UNIT_TOKENS = new Set(["APT", "UNIT", "STE", "SUITE", "LOT", "RM", "ROOM", "FL", "FLOOR", "BLDG", "#", "TRLR"]);
const DIRECTIONALS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "NORTH", "SOUTH", "EAST", "WEST"]);
const SUFFIXES = new Set([
  "AVE", "AVENUE", "ST", "STREET", "RD", "ROAD", "DR", "DRIVE", "LN", "LANE", "CT", "COURT", "PL", "PLACE",
  "BLVD", "BOULEVARD", "WAY", "TRL", "TRAIL", "PKWY", "PARKWAY", "CIR", "CIRCLE", "HWY", "HIGHWAY", "LOOP",
  "RUN", "PT", "POINT", "TER", "TERRACE", "XING", "CROSSING", "RDG", "RIDGE", "CV", "COVE", "SQ", "SQUARE",
  "PASS", "PATH", "ROW", "BND", "BEND", "CRK", "CREEK", "FRK", "EXT", "EXTENSION", "PLZ", "PLAZA", "GROVE",
  "GRV", "MNR", "MANOR", "HOLW", "HOLLOW", "CRES", "CRESCENT", "WALK", "GLEN", "GLN", "KNOLL", "KNL",
]);
const ORDINALS = {
  FIRST: "1ST", SECOND: "2ND", THIRD: "3RD", FOURTH: "4TH", FIFTH: "5TH", SIXTH: "6TH",
  SEVENTH: "7TH", EIGHTH: "8TH", NINTH: "9TH", TENTH: "10TH", ELEVENTH: "11TH", TWELFTH: "12TH",
};
const COMPANY_HINTS = [
  "LLC", "L L C", "INC", "CORP", "PROPERT", "RENTAL", "HOMES", "HOLDING", "INVEST", "ENTERPRISE",
  "ASSOC", "PARTNERS", " LP", "L P", "TRUST", "BANK", "REALTY", " CO ", "MANAGEMENT", "GROUP",
  "VENTURES", "CAPITAL", "EQUITY", "FUND",
];

function canonicalStreet(street) {
  const text = String(street || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ");
  let toks = text.split(/\s+/).filter(Boolean);
  const kept = [];
  for (const t of toks) {
    if (UNIT_TOKENS.has(t)) break;
    kept.push(t);
  }
  toks = kept;
  while (toks.length && DIRECTIONALS.has(toks[0])) toks.shift();
  while (toks.length && (SUFFIXES.has(toks[toks.length - 1]) || DIRECTIONALS.has(toks[toks.length - 1]))) toks.pop();
  toks = toks.map((t) => ORDINALS[t] || t);
  return toks.join(" ").trim();
}

function splitHouseAndStreet(fullStreet) {
  const s = String(fullStreet || "").trim();
  const m = s.match(/^\s*(\d+)\s+(.*)$/);
  return m ? [m[1], m[2]] : ["", s];
}

function parseAddressField(address) {
  const first = String(address || "").split(",")[0];
  const [num, street] = splitHouseAndStreet(first);
  const zm = String(address || "").match(/\b(\d{5})\b/);
  return { num, streetKey: canonicalStreet(street), zip5: zm ? zm[1] : "" };
}

function looksLikeCompany(ownerName) {
  const o = ` ${String(ownerName || "").toUpperCase()} `;
  return COMPANY_HINTS.some((h) => o.includes(h));
}

function ownerOccupied(ownerName, ownerMailCity, siteCity) {
  if (looksLikeCompany(ownerName)) return false;
  const mc = String(ownerMailCity || "").toUpperCase().replace(/[^A-Z]/g, "");
  const sc = String(siteCity || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (mc && sc) return mc === sc;
  return null;
}

function normPropertyType(parusedesc) {
  const t = String(parusedesc || "").trim().toUpperCase();
  if (!t) return "";
  if (t.includes("MOBILE") || t.includes("MANUF") || t.includes("MFG")) return "MOBILE";
  return t;
}

// ── NC OneMap live lookup ──

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeSql(s) {
  return String(s).replace(/'/g, "''");
}

async function queryParcels(where) {
  const params = new URLSearchParams({
    where,
    outFields: PULL_FIELDS,
    returnGeometry: "false",
    f: "json",
    resultRecordCount: "50",
  });
  const resp = await fetch(`${NC_PARCELS_LAYER}?${params.toString()}`);
  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error).slice(0, 200));
  return data.features || [];
}

/**
 * The street key for a parcel row, whichever way its county files addresses.
 *
 * Counties are not consistent in this statewide layer. Guilford splits the
 * address into saddno + saddstr; Forsyth leaves BOTH of those empty and puts
 * the whole thing in siteadd ("2996 Yankee Hollow TRL"). Keying only off
 * saddstr silently loses every Forsyth parcel — which is what made the first
 * Kernersville pass match 25% instead of 85%.
 */
function parcelStreetKey(a) {
  if (String(a.saddstr || "").trim()) return canonicalStreet(a.saddstr);
  const [, street] = splitHouseAndStreet(String(a.siteadd || "").trim());
  return canonicalStreet(street);
}

/** Does this parcel's siteadd start with the house number we asked for?
 *
 *  Davie zero-pads it to six digits and sometimes double-spaces after it:
 *  "000123 W ROLLINGMEADOW RD" is house 123. Comparing the raw token missed
 *  every one of them, so the county sat at a 25% match rate with the correct
 *  values sitting right there in the response. */
function siteaddHouseNoMatches(a, num) {
  if (String(a.saddno || "").trim()) return true; // split-field row, already filtered by the query
  const [houseNo] = splitHouseAndStreet(String(a.siteadd || "").trim());
  const strip = (v) => String(v || "").replace(/^0+(?=\d)/, "");
  return strip(houseNo) === strip(num);
}

/**
 * Is this parcel even in the right place?
 *
 * There was no check at all, and the last-resort attempt searches the WHOLE
 * STATE by house number and street token — so "602 Stonehill" in Chapel Hill
 * could quietly take its value from a parcel in Charlotte. A wrong value is
 * worse than none: it looks authoritative, and it feeds both the value-band
 * filter and the lead score. `szip` in this layer is dirty enough that a
 * szip='27516' query returns Mecklenburg rows, so the county is the only
 * trustworthy check; when we don't know the lead's county, fall back to ZIP.
 */
function parcelIsInTheRightPlace(a, county, zip5) {
  const pc = String(a.cntyname || "").trim().toLowerCase();
  const lc = String(county || "").trim().toLowerCase();
  if (lc && pc) return pc === lc;
  if (zip5 && String(a.szip || "").trim()) return String(a.szip).trim().slice(0, 5) === zip5;
  return false; // no way to tell — refuse rather than guess
}

// Mirrors src/lib/homeValue.ts — keep the two in step.
const IMPLAUSIBLE_HOME_VALUE = 1_500_000;
const UNIT_MARKERS = new Set(["APT", "UNIT", "STE", "SUITE", "LOT", "RM", "ROOM", "FL", "FLOOR", "BLDG", "TRLR"]);
const NON_HOME_USE = [
  "APARTMENT", "APARTMENTS", "MULTI", "DUPLEX", "TRIPLEX", "QUAD", "FOURPLEX",
  "COMMERCIAL", "OFFICE", "RETAIL", "STORE", "INDUSTRIAL", "WAREHOUSE",
  "VACANT", "CHURCH", "SCHOOL", "EXEMPT", "HOTEL", "MOTEL", "NURSING",
  "ASSISTED", "GROUP HOME", "MOBILE HOME PARK", "AGRICULT", "UTILITY",
];

function hasUnitMarker(address) {
  const first = String(address || "").split(",")[0].toUpperCase();
  if (first.includes("#")) return true;
  return first.replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).some((t) => UNIT_MARKERS.has(t));
}

function isNonHomeUse(t) {
  const v = String(t || "").toUpperCase();
  return v !== "" && NON_HOME_USE.some((u) => v.includes(u));
}

async function matchAddress(address, county) {
  const { num, streetKey, zip5 } = parseAddressField(address);
  if (!num || !streetKey) return null;
  const token = streetKey.split(" ")[0];
  const cty = (county || "").trim();

  const attempts = [];
  if (cty) {
    attempts.push(
      `cntyname='${escapeSql(cty)}' AND saddno='${escapeSql(num)}' AND UPPER(saddstr) LIKE '%${escapeSql(token)}%'`
    );
    // Forsyth-style rows: house number and street live together in siteadd.
    attempts.push(
      `cntyname='${escapeSql(cty)}' AND UPPER(siteadd) LIKE '${escapeSql(num)} %${escapeSql(token)}%'`
    );
    // Davie-style rows: the same thing, zero-padded to six digits
    // ("000123 W ROLLINGMEADOW RD"). The leading % lets it match; the
    // house-number guard below is what stops "005123" answering for "123".
    attempts.push(
      `cntyname='${escapeSql(cty)}' AND UPPER(siteadd) LIKE '%${escapeSql(num)} %${escapeSql(token)}%'`
    );
  }
  if (zip5) {
    attempts.push(`szip='${escapeSql(zip5)}' AND saddno='${escapeSql(num)}' AND UPPER(saddstr) LIKE '%${escapeSql(token)}%'`);
    attempts.push(`szip='${escapeSql(zip5)}' AND UPPER(siteadd) LIKE '${escapeSql(num)} %${escapeSql(token)}%'`);
  }
  attempts.push(`saddno='${escapeSql(num)}' AND UPPER(saddstr) LIKE '%${escapeSql(token)}%'`);

  for (const where of attempts) {
    let feats;
    try {
      feats = await queryParcels(where);
    } catch {
      continue;
    }
    if (!feats.length) continue;
    // Pick the candidate whose canonicalized street matches exactly. NOT the
    // most expensive one: ranking by value is how an apartment address landed
    // on the complex's multi-million parcel every single time.
    const cands = feats
      .map((f) => f.attributes)
      .filter((a) => siteaddHouseNoMatches(a, num))
      .filter((a) => parcelIsInTheRightPlace(a, cty, zip5));
    if (!cands.length) continue;
    const exact = cands
      .filter((a) => parcelStreetKey(a) === streetKey)
      .sort((a, b) => (Number(a.parval) || 0) - (Number(b.parval) || 0));
    const pool = exact.length
      ? exact
      : cands.slice().sort((a, b) => (Number(a.parval) || 0) - (Number(b.parval) || 0));
    const best = pool[0];
    const parval = Number(best.parval) || 0;
    if (parval <= 0) continue;
    const propertyType = normPropertyType(best.parusedesc);
    const suspect = hasUnitMarker(address)
      ? "apartment or unit"
      : isNonHomeUse(propertyType)
        ? "not a home"
        : exact.length > 1
          ? "several parcels at this address"
          : parval >= IMPLAUSIBLE_HOME_VALUE
            ? "implausible for a house"
            : null;
    return {
      value: parval,
      ownerOccupied: ownerOccupied(best.ownname, best.mcity, best.scity),
      propertyType,
      suspect,
    };
  }
  return null;
}

// ── main ──

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
      await sleep(SLEEP_BETWEEN_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 2000;
  const recheckMisses = args.includes("--recheck-misses");
  // --county Forsyth  narrows the batch. Without it, --recheck-misses just
  // re-pulls the same first N no_match rows every run, so rows deeper in the
  // table never get retried after a matcher fix.
  const countyArg = args.indexOf("--county");
  const county = countyArg >= 0 ? args[countyArg + 1] : "";

  if (!LOGIN_PASSWORD) {
    throw new Error("Set T65_PASSWORD (and optionally T65_EMAIL) in the environment first.");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  let query = supabase
    .from("leads")
    .select("id, address, county")
    .not("address", "is", null)
    .neq("address", "");
  // Never re-match a lead that already has a value (tracker imports are parcel
  // data too) — a fresh fuzzy match could replace a good value with a wrong one.
  query = recheckMisses
    ? query.eq("home_value_source", "no_match")
    : query.is("home_value_checked_at", null).is("home_value", null);
  if (county) query = query.eq("county", county);
  // PostgREST returns at most 1,000 rows regardless of .limit(), so asking for
  // 2,000 silently got half the book and reported success. Page until we have
  // what was asked for.
  let leads = [];
  for (let page = 0; leads.length < limit && page < 20; page++) {
    const lo = page * 1000;
    const { data, error: fetchErr } = await query.range(lo, Math.min(lo + 999, limit - 1));
    if (fetchErr) throw new Error(`Fetch failed: ${fetchErr.message}`);
    leads = leads.concat(data);
    if (data.length < 1000) break;
  }

  console.log(`Checking ${leads.length} lead(s) against NC OneMap parcel data...`);
  let matched = 0;
  let noMatch = 0;

  await mapLimit(leads, CONCURRENCY, async (lead) => {
    let res = null;
    try {
      res = await matchAddress(lead.address, lead.county);
    } catch (exc) {
      console.warn(`  lookup failed for ${lead.id}: ${exc.message}`);
    }
    const now = new Date().toISOString();
    if (res) {
      matched++;
      await supabase
        .from("leads")
        .update({
          // A parcel we can't attribute to this person's home records the
          // finding, never the number.
          home_value: res.suspect ? null : res.value,
          home_owner_occupied: res.ownerOccupied,
          home_property_type: res.propertyType,
          home_value_source: res.suspect ? "multi_unit" : "parcel_match",
          home_value_checked_at: now,
        })
        .eq("id", lead.id);
    } else {
      noMatch++;
      await supabase
        .from("leads")
        .update({ home_value_source: "no_match", home_value_checked_at: now })
        .eq("id", lead.id);
    }
  });

  console.log(`Done. Matched: ${matched}  No match: ${noMatch}  Total checked: ${leads.length}`);
}

main().catch((exc) => {
  console.error(exc);
  process.exit(1);
});
