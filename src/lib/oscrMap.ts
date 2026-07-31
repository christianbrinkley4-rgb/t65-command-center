// Normalize any OSCR (Pega) export shape into canonical fields, then into CRM
// lead rows. Ported from C:\dialer\lead_intake\oscr_map.py so both systems agree
// on what a column means. OSCR exports differ by saved view/filter, so we
// normalize the header row rather than writing an adapter per shape.
//
// The important part: OSCR is the system of record for COMPLIANCE. Its
// callable / sms consent / email consent / phone status (DNC) / suppressed
// columns are carrier truth, so the CRM inherits them instead of guessing.

import { normalizeSource } from "./categories";

export const OSCR_ALIASES: Record<string, string[]> = {
  oscr_lead_id: ["oscr lead id", "oscrleadid", "opp id", "oppid", "oscr id", "oscrid", "lead id", "leadid", "opportunity id"],
  last_name: ["last name", "lastname", "last", "surname"],
  first_name: ["first name", "firstname", "first", "given name"],
  full_name: ["name", "full name", "fullname", "contact name"],
  phone: ["primary phone", "primary phone:", "phone", "phone number", "mobile", "cell", "cell phone", "telephone", "number", "formatted number", "primaryphone", "home phone"],
  phone2: ["secondary phone", "alt phone", "work phone", "other phone"],
  email: ["email address", "email", "e-mail", "email addr"],
  address: ["street", "address", "address 1", "street address", "addr"],
  city: ["city", "town"],
  state: ["state"],
  zip: ["zip code", "zip", "zipcode", "postal code", "zip5"],
  county: ["county"],
  age: ["age"],
  birthday: ["birthday", "birthdate", "dob", "date of birth"],
  lead_source: ["lead source", "leadsource", "source"],
  campaign: ["campaign", "campaign name", "campaignname"],
  product: ["product", "product type"],
  latest_disp: ["latest disp", "latest disp.", "latest disposition", "disposition", "last disposition", "latest_disp"],
  last_disp_date: ["last disp. date", "last disp date", "last disposition date"],
  date_assigned: ["date assigned", "orig date", "origdate", "assigned to date", "date_assigned", "created date"],
  callable: ["callable (y/n)", "callable", "call ok", "call_ok", "callok"],
  sms_consent: ["sms consent flag", "sms consent", "text ok", "text_ok", "textok", "sms flag"],
  email_consent: ["email consent flag", "email consent", "email ok", "email_ok", "emailok"],
  phone_status: ["phone status", "phonestatus", "dnc", "dnc status"],
  tier: ["tier", "quality tier", "quality_tier"],
  status: ["status", "lead status", "stage", "lead stage"],
  owner: ["owner", "assigned to", "agent"],
  notes: ["notes", "note", "comments"],
  score: ["appointment score", "appointment_score", "score", "annuity_score"],
  suppressed: ["suppressed", "suppress"],
  suppress_reason: ["suppress reason", "suppress_reason", "why suppressed"],
};

const LOOKUP: Record<string, string> = {};
for (const [canon, spellings] of Object.entries(OSCR_ALIASES)) {
  for (const s of spellings) LOOKUP[s.replace(/[^a-z0-9]/g, "")] = canon;
}

export function normHeader(h: string): string {
  return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** { originalHeader: canonicalField } plus the headers we didn't recognize. */
export function buildOscrMapping(headers: string[]) {
  const mapping: Record<string, string> = {};
  const unmapped: string[] = [];
  for (const h of headers) {
    const canon = LOOKUP[normHeader(h)];
    if (canon) mapping[h] = canon;
    else unmapped.push(h);
  }
  return { mapping, unmapped };
}

/** An export is "OSCR shaped" once we can find its lead id column. */
export function isOscrExport(headers: string[]): boolean {
  return Object.values(buildOscrMapping(headers).mapping).includes("oscr_lead_id");
}

export function canonize(row: Record<string, string>, mapping: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [orig, canon] of Object.entries(mapping)) {
    const raw = row[orig];
    const val = typeof raw === "string" ? raw.trim() : raw;
    if (val === undefined || val === null || val === "") continue;
    if (!(canon in out)) out[canon] = String(val);
  }
  return out;
}

const YES = /^(y|yes|true|1|ok)$/i;
const NO = /^(n|no|false|0)$/i;
function tri(v: string | undefined): boolean | null {
  if (!v) return null;
  if (YES.test(v.trim())) return true;
  if (NO.test(v.trim())) return false;
  return null;
}

function ymd(v: string | undefined): string | null {
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const us = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (us) {
    let y = Number(us[3]);
    if (y < 100) y += y >= 30 ? 1900 : 2000;
    return `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Canonical OSCR fields -> a CRM lead row, inheriting OSCR's compliance truth.
 * A lead is do_not_call if OSCR says the phone is DNC, it isn't callable, or the
 * record is suppressed. Consent is only ever true if OSCR says so.
 */
export function oscrToLead(c: Record<string, string>) {
  const name =
    c.full_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || null;
  const callable = tri(c.callable);
  const dncFlagged =
    /dnc|do not call|do_not_call/i.test(c.phone_status || "") ||
    tri(c.suppressed) === true ||
    callable === false;

  return {
    oscr_lead_id: c.oscr_lead_id || null,
    name,
    phone: c.phone || null,
    phone2: c.phone2 || null,
    email: c.email || null,
    address: c.address || null,
    city: c.city || null,
    county: c.county || null,
    state: c.state || "NC",
    zip: c.zip || null,
    birthday: ymd(c.birthday),
    tier: c.tier || null,
    // "OSCR:Turning 65" is a non-category — the whole book is turning 65. Those
    // leads are filed by the MONTH they turn 65 (derived from the birthday)
    // instead, so the source stays the plain channel. Other OSCR pulls keep
    // their label; an annuity lead really is a different thing.
    source: normalizeSource(c.lead_source ? `OSCR:${c.lead_source}` : "OSCR"),
    oscr_lead_source: c.lead_source || null,
    oscr_status: c.status || null,
    oscr_latest_disp: c.latest_disp || null,
    oscr_last_disp_date: ymd(c.last_disp_date),
    oscr_score: c.score && !isNaN(Number(c.score)) ? Number(c.score) : null,
    oscr_owner: c.owner || null,
    callable,
    sms_consent: tri(c.sms_consent) === true,
    email_consent: tri(c.email_consent) === true,
    do_not_call: dncFlagged,
    raw_notes: c.notes || null,
    oscr_synced_at: new Date().toISOString(),
  };
}
