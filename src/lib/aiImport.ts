// Assistant-tab lead parsing. The edge function (Claude, Gemini fallback)
// handles truly messy text; this local parser is the always-works fallback for
// reasonably line-shaped pastes, and the preview/import path is shared.

import { supabase } from "./supabaseClient";
import { canonicalPhone } from "./phone";
import { normalizeDate } from "./leadImport";

export type ParsedLead = {
  name: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  county: string | null;
  birthday: string | null;
  notes: string | null;
  dnc_mentioned: boolean;
};

export type ParseResult = {
  leads: ParsedLead[];
  provider: "claude" | "gemini" | "local";
  configured: boolean;
};

export async function parseLeadText(text: string): Promise<ParseResult> {
  try {
    const { data, error } = await supabase.functions.invoke("ai-import", { body: { text } });
    if (!error && data && data.configured !== false && Array.isArray(data.leads)) {
      return {
        leads: data.leads.map(normalizeParsed),
        provider: data.provider === "claude" ? "claude" : "gemini",
        configured: true,
      };
    }
  } catch {
    // fall through to local
  }
  return { leads: localParse(text), provider: "local", configured: false };
}

function normalizeParsed(raw: Record<string, unknown>): ParsedLead {
  const s = (v: unknown) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t || null;
  };
  return {
    name: s(raw.name),
    phone: s(raw.phone),
    phone2: s(raw.phone2),
    email: s(raw.email),
    address: s(raw.address),
    city: s(raw.city),
    zip: s(raw.zip),
    county: s(raw.county),
    birthday: normalizeDate(s(raw.birthday) || undefined),
    notes: s(raw.notes),
    dnc_mentioned: raw.dnc_mentioned === true,
  };
}

const PHONE_RE = /(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/;
const ZIP_RE = /\b(2[5-8]\d{3})\b/;
const ADDR_RE = /^\s*\d{1,6}\s+[A-Za-z]/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const MONTH_YEAR_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d{2})\b/i;

/**
 * Heuristic fallback: walk lines, start a new lead on a name-looking line,
 * attach phones/addresses/zips/birthdays to the current lead. Handles the
 * knock-route and simple-list shapes; anything weirder needs the AI path.
 */
export function localParse(text: string): ParsedLead[] {
  const out: ParsedLead[] = [];
  let cur: ParsedLead | null = null;
  const blank = (): ParsedLead => ({
    name: null, phone: null, phone2: null, email: null, address: null,
    city: null, zip: null, county: null, birthday: null, notes: null, dnc_mentioned: false,
  });

  // Words that mean a line is a heading, not a person
  const HEADER_WORDS = /route|list|report|knock|priority|leads?$|birthday|address|phone|order|name|status|county|neighborhood/i;

  const isNameLine = (line: string) => {
    const t = line.trim();
    if (!t || t.length > 40) return false;
    if (PHONE_RE.test(t) || ADDR_RE.test(t) || EMAIL_RE.test(t) || /\d/.test(t)) return false;
    if (HEADER_WORDS.test(t)) return false;
    const words = t.split(/\s+/);
    return words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-z'.-]+$/.test(w));
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isNameLine(line)) {
      if (cur && (cur.name || cur.phone || cur.address)) out.push(cur);
      cur = blank();
      cur.name = line;
      continue;
    }
    if (!cur) {
      cur = blank();
    }
    const phoneM = line.match(PHONE_RE);
    if (phoneM) {
      const p = phoneM[1];
      if (!cur.phone) cur.phone = p;
      else if (!cur.phone2) cur.phone2 = p;
      if (/do\s*not\s*call|dnc/i.test(line)) cur.dnc_mentioned = true;
      continue;
    }
    if (/^do\s*not\s*call$|^dnc$/i.test(line)) {
      cur.dnc_mentioned = true;
      continue;
    }
    const emailM = line.match(EMAIL_RE);
    if (emailM && !cur.email) {
      cur.email = emailM[0];
      continue;
    }
    if (ADDR_RE.test(line) && !cur.address) {
      cur.address = line.split(",")[0].trim();
      const zipM = line.match(ZIP_RE);
      if (zipM) cur.zip = zipM[1];
      continue;
    }
    // "Greensboro, NC 27405" style city line
    const cityM = line.match(/^([A-Za-z .]+),?\s+NC\b/);
    if (cityM && !cur.city) {
      cur.city = cityM[1].trim();
      const zipM = line.match(ZIP_RE);
      if (zipM && !cur.zip) cur.zip = zipM[1];
      continue;
    }
    const my = line.match(MONTH_YEAR_RE);
    if (my && !cur.birthday) {
      cur.birthday = normalizeDate(`${my[1]} ${my[2]}`);
      continue;
    }
    // anything else: keep the first interesting leftover as a note
    if (!cur.notes && line.length > 3 && !/^\d+$/.test(line)) cur.notes = line.slice(0, 200);
  }
  if (cur && (cur.name || cur.phone || cur.address)) out.push(cur);
  return out;
}

export function dedupeKey(l: ParsedLead): string {
  const p = canonicalPhone(l.phone);
  if (p) return `p:${p}`;
  return `a:${(l.name || "").toLowerCase()}|${(l.address || "").toLowerCase()}`;
}
