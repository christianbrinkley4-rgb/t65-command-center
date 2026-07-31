// Home-value enrichment from the NC OneMap statewide parcel layer (public,
// no API key). Ported from C:\dialer\command_center\property_values.py so the
// CRM and the Python dialer agree on how an address matches a parcel.
//
// Assessed value >= $250k is the strong "can actually buy" signal the team
// filters on; owner-occupancy and property type guard against counting an
// apartment complex or investor-owned rental as the prospect's own home.
// scripts/enrich-home-value.mjs is the batch CLI twin of this module.

import { supabase } from "./supabaseClient";

const NC_PARCELS_LAYER =
  "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query";
const PULL_FIELDS = "cntyname,saddno,saddstr,scity,szip,parval,parusedesc,ownname,mcity";
const SLEEP_BETWEEN_MS = 120;
const CONCURRENCY = 3;

const UNIT_TOKENS = new Set(["APT", "UNIT", "STE", "SUITE", "LOT", "RM", "ROOM", "FL", "FLOOR", "BLDG", "#", "TRLR"]);
const DIRECTIONALS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "NORTH", "SOUTH", "EAST", "WEST"]);
const SUFFIXES = new Set([
  "AVE", "AVENUE", "ST", "STREET", "RD", "ROAD", "DR", "DRIVE", "LN", "LANE", "CT", "COURT", "PL", "PLACE",
  "BLVD", "BOULEVARD", "WAY", "TRL", "TRAIL", "PKWY", "PARKWAY", "CIR", "CIRCLE", "HWY", "HIGHWAY", "LOOP",
  "RUN", "PT", "POINT", "TER", "TERRACE", "XING", "CROSSING", "RDG", "RIDGE", "CV", "COVE", "SQ", "SQUARE",
  "PASS", "PATH", "ROW", "BND", "BEND", "CRK", "CREEK", "FRK", "EXT", "EXTENSION", "PLZ", "PLAZA", "GROVE",
  "GRV", "MNR", "MANOR", "HOLW", "HOLLOW", "CRES", "CRESCENT", "WALK", "GLEN", "GLN", "KNOLL", "KNL",
]);
const ORDINALS: Record<string, string> = {
  FIRST: "1ST", SECOND: "2ND", THIRD: "3RD", FOURTH: "4TH", FIFTH: "5TH", SIXTH: "6TH",
  SEVENTH: "7TH", EIGHTH: "8TH", NINTH: "9TH", TENTH: "10TH", ELEVENTH: "11TH", TWELFTH: "12TH",
};
const COMPANY_HINTS = [
  "LLC", "L L C", "INC", "CORP", "PROPERT", "RENTAL", "HOMES", "HOLDING", "INVEST", "ENTERPRISE",
  "ASSOC", "PARTNERS", " LP", "L P", "TRUST", "BANK", "REALTY", " CO ", "MANAGEMENT", "GROUP",
  "VENTURES", "CAPITAL", "EQUITY", "FUND",
];

export function canonicalStreet(street: string): string {
  const text = String(street || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ");
  let toks = text.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
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

function parseAddressField(address: string) {
  const first = String(address || "").split(",")[0];
  const m = first.trim().match(/^(\d+)\s+(.*)$/);
  const zm = String(address || "").match(/\b(\d{5})\b/);
  return {
    num: m ? m[1] : "",
    streetKey: m ? canonicalStreet(m[2]) : "",
    zip5: zm ? zm[1] : "",
  };
}

function ownerOccupied(ownerName: string, ownerMailCity: string, siteCity: string): boolean | null {
  const o = ` ${String(ownerName || "").toUpperCase()} `;
  if (COMPANY_HINTS.some((h) => o.includes(h))) return false;
  const mc = String(ownerMailCity || "").toUpperCase().replace(/[^A-Z]/g, "");
  const sc = String(siteCity || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (mc && sc) return mc === sc;
  return null;
}

function normPropertyType(parusedesc: string): string {
  const t = String(parusedesc || "").trim().toUpperCase();
  if (!t) return "";
  if (t.includes("MOBILE") || t.includes("MANUF") || t.includes("MFG")) return "MOBILE";
  return t;
}

// ── is this parcel value actually THIS person's home? ───────────────────────
//
// A parcel is a piece of land, not a residence. An apartment complex is ONE
// parcel worth several million with a hundred front doors on it, so stamping
// that number on a tenant reads as "$1.2M home" when they rent a one-bedroom.
// Same for a mobile home park, a commercial building with a unit upstairs, and
// a church parsonage. The value isn't slightly wrong, it's the wrong thing
// entirely, and it's the single worst kind of error here because it drives who
// gets called and knocked.

export const MULTI_UNIT_SOURCE = "multi_unit";

/** No house in this book is worth this. Above it, assume a parcel, not a home. */
export const IMPLAUSIBLE_HOME_VALUE = 1_500_000;

/** Addresses carrying this many leads are a building, not a household. */
export const MULTI_UNIT_LEADS = 4;

// Parcel use codes that mean "not one family's house". CONDO is deliberately
// absent: condos are individually parceled, so their value is the unit's.
const NON_HOME_USE = [
  "APARTMENT", "APARTMENTS", "MULTI", "DUPLEX", "TRIPLEX", "QUAD", "FOURPLEX",
  "COMMERCIAL", "OFFICE", "RETAIL", "STORE", "INDUSTRIAL", "WAREHOUSE",
  "VACANT", "CHURCH", "SCHOOL", "EXEMPT", "HOTEL", "MOTEL", "NURSING",
  "ASSISTED", "GROUP HOME", "MOBILE HOME PARK", "AGRICULT", "UTILITY",
];

/** "1200 W Friendly Ave APT 12", "… #4B" — one parcel, many front doors. */
export function hasUnitMarker(address: string | null | undefined): boolean {
  const first = String(address || "").split(",")[0].toUpperCase();
  if (first.includes("#")) return true;
  return first
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .some((t) => UNIT_TOKENS.has(t));
}

export function isNonHomeUse(propertyType: string | null | undefined): boolean {
  const t = String(propertyType || "").toUpperCase();
  return t !== "" && NON_HOME_USE.some((u) => t.includes(u));
}

type ValuedLead = {
  address?: string | null;
  home_value?: number | null;
  home_property_type?: string | null;
};

/**
 * Why this lead's home value can't be believed, or null when it can.
 * `sharedAddress` is the caller's answer to "do several leads live at this
 * street address" — the giveaway for a building whose rows carry no unit
 * number, which is exactly how these got a seven-figure value in silence.
 */
export function homeValueSuspect(
  lead: ValuedLead,
  sharedAddress = false
): "apartment or unit" | "not a home" | "whole building" | "implausible" | null {
  const v = Number(lead.home_value || 0);
  if (v <= 0) return null; // nothing to distrust
  if (hasUnitMarker(lead.address)) return "apartment or unit";
  if (isNonHomeUse(lead.home_property_type)) return "not a home";
  if (sharedAddress) return "whole building";
  if (v >= IMPLAUSIBLE_HOME_VALUE) return "implausible";
  return null;
}

/** The value if we believe it, otherwise null. Use this for display and filters. */
export function trustedHomeValue(lead: ValuedLead, sharedAddress = false): number | null {
  const v = Number(lead.home_value || 0);
  if (v <= 0) return null;
  return homeValueSuspect(lead, sharedAddress) ? null : v;
}

type ParcelAttrs = {
  cntyname: string;
  saddno: string;
  saddstr: string;
  scity: string;
  szip: string;
  parval: number;
  parusedesc: string;
  ownname: string;
  mcity: string;
};

/**
 * Is this parcel even in the right place?
 *
 * Nothing checked, and the last matching attempt searches the whole state by
 * house number and street token — so a Chapel Hill address could take its
 * value from a parcel two hundred miles away. `szip` in this layer is dirty
 * (a szip='27516' query returns Mecklenburg rows), so the county is the only
 * trustworthy check; ZIP is the fallback when the lead has no county, and with
 * neither we refuse rather than guess.
 */
function parcelIsInTheRightPlace(a: ParcelAttrs, county: string, zip5: string): boolean {
  const pc = String(a.cntyname || "").trim().toLowerCase();
  const lc = String(county || "").trim().toLowerCase();
  if (lc && pc) return pc === lc;
  if (zip5 && String(a.szip || "").trim()) return String(a.szip).trim().slice(0, 5) === zip5;
  return false;
}

const escapeSql = (s: string) => String(s).replace(/'/g, "''");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function queryParcels(where: string): Promise<ParcelAttrs[]> {
  const params = new URLSearchParams({
    where,
    outFields: PULL_FIELDS,
    returnGeometry: "false",
    f: "json",
    resultRecordCount: "50",
  });
  const resp = await fetch(`${NC_PARCELS_LAYER}?${params.toString()}`);
  const data = await resp.json();
  if (data.error) throw new Error(String(data.error.message || "parcel query error"));
  return (data.features || []).map((f: { attributes: ParcelAttrs }) => f.attributes);
}

export type ParcelMatch = {
  value: number;
  ownerOccupied: boolean | null;
  propertyType: string;
  /** Set when the parcel is a building or a lot, not this person's house. */
  suspect: string | null;
};

export async function matchAddress(address: string, county: string | null): Promise<ParcelMatch | null> {
  const { num, streetKey, zip5 } = parseAddressField(address);
  if (!num || !streetKey) return null;
  const token = streetKey.split(" ")[0];
  const cty = (county || "").trim();

  const attempts: string[] = [];
  if (cty) attempts.push(`cntyname='${escapeSql(cty)}' AND saddno='${escapeSql(num)}' AND UPPER(saddstr) LIKE '%${escapeSql(token)}%'`);
  if (zip5) attempts.push(`szip='${escapeSql(zip5)}' AND saddno='${escapeSql(num)}' AND UPPER(saddstr) LIKE '%${escapeSql(token)}%'`);
  attempts.push(`saddno='${escapeSql(num)}' AND UPPER(saddstr) LIKE '%${escapeSql(token)}%'`);

  for (const where of attempts) {
    let feats: ParcelAttrs[];
    try {
      feats = await queryParcels(where);
    } catch {
      continue;
    }
    if (!feats.length) continue;
    // The last attempt above searches the WHOLE STATE by house number and
    // street token, and nothing checked that the winner was anywhere near the
    // lead. "100 Brookstone Ct, Chapel Hill" took its value from a parcel in
    // Hendersonville, 200 miles away. A wrong value is worse than none: it
    // looks authoritative and it drives the value-band filter and the score.
    const placed = feats.filter((a) => parcelIsInTheRightPlace(a, cty, zip5));
    if (!placed.length) continue;
    // Ranking candidates by value was the original sin here: when an address
    // matched several parcels it deliberately took the MOST EXPENSIVE one, so
    // an apartment address landed on the complex's parcel every time. Sort by
    // value only to make the pick deterministic, then judge it.
    const exact = placed
      .filter((a) => canonicalStreet(a.saddstr) === streetKey)
      .sort((a, b) => (Number(a.parval) || 0) - (Number(b.parval) || 0));
    const pool = exact.length ? exact : placed.slice().sort((a, b) => (Number(a.parval) || 0) - (Number(b.parval) || 0));
    const best = pool[0];
    const parval = Number(best.parval) || 0;
    if (parval <= 0) continue;
    const propertyType = normPropertyType(best.parusedesc);
    // More than one parcel at the same number and street means the address
    // doesn't identify a single home — a complex, or a split lot.
    const ambiguous = exact.length > 1;
    const suspect =
      hasUnitMarker(address)
        ? "apartment or unit"
        : isNonHomeUse(propertyType)
          ? "not a home"
          : ambiguous
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

export type EnrichProgress = { checked: number; matched: number; total: number };

/**
 * Enrich every lead that has an address but has never been checked against the
 * parcel table. Leads that already carry a home value (tracker imports) are
 * left alone — a fuzzy re-match must never replace a known-good value.
 * Returns the final tally; onProgress fires after each lead.
 */
export async function enrichUncheckedLeads(
  onProgress?: (p: EnrichProgress) => void,
  batchLimit = 500
): Promise<EnrichProgress> {
  const { data: targets, error } = await supabase
    .from("leads")
    .select("id, address, county")
    .not("address", "is", null)
    .neq("address", "")
    .is("home_value_checked_at", null)
    .is("home_value", null)
    .limit(batchLimit);
  if (error) throw error;

  const progress: EnrichProgress = { checked: 0, matched: 0, total: targets?.length || 0 };
  if (!targets || targets.length === 0) return progress;

  let i = 0;
  async function worker() {
    while (i < targets!.length) {
      const lead = targets![i++];
      let res: ParcelMatch | null = null;
      try {
        res = await matchAddress(lead.address as string, lead.county as string | null);
      } catch {
        // network blip — leave unchecked so a later pass retries it
        progress.checked++;
        onProgress?.({ ...progress });
        continue;
      }
      const now = new Date().toISOString();
      if (res) {
        progress.matched++;
        // A parcel we can't attribute to this person's home stores the FINDING
        // but not the number. Writing the number and hoping the UI hides it is
        // how a $2.4M apartment complex ends up on a call list.
        await supabase
          .from("leads")
          .update({
            home_value: res.suspect ? null : res.value,
            home_owner_occupied: res.ownerOccupied,
            home_property_type: res.propertyType,
            home_value_source: res.suspect ? MULTI_UNIT_SOURCE : "parcel_match",
            home_value_checked_at: now,
          })
          .eq("id", lead.id);
      } else {
        await supabase
          .from("leads")
          .update({ home_value_source: "no_match", home_value_checked_at: now })
          .eq("id", lead.id);
      }
      progress.checked++;
      onProgress?.({ ...progress });
      await sleep(SLEEP_BETWEEN_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return progress;
}
