import type { Lead } from "./types";
import { canonicalPhone } from "./phone";

export type ImportField =
  | "name"
  | "phone"
  | "phone2"
  | "email"
  | "address"
  | "city"
  | "county"
  | "zip"
  | "state"
  | "birthday"
  | "home_value"
  | "tier"
  | "lead_type"
  | "status"
  | "stage_bucket"
  | "next_follow_up_date"
  | "next_follow_up_note"
  | "last_contact_date"
  | "assigned_to"
  | "notes"
  | "source";

export type ParsedFile = {
  headers: string[];
  rows: Record<string, string>[];
};

export type ImportRow = Record<string, string | number | null>;

export const IMPORT_FIELDS: { key: ImportField; label: string }[] = [
  { key: "name", label: "Full name" },
  { key: "phone", label: "Primary phone" },
  { key: "phone2", label: "Second phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "county", label: "County" },
  { key: "zip", label: "ZIP" },
  { key: "state", label: "State" },
  { key: "birthday", label: "Birthday / DOB" },
  { key: "home_value", label: "Home value" },
  { key: "tier", label: "Tier" },
  { key: "lead_type", label: "Lead type" },
  { key: "status", label: "Status" },
  { key: "stage_bucket", label: "Stage / bucket" },
  { key: "next_follow_up_date", label: "Next follow-up date" },
  { key: "next_follow_up_note", label: "Follow-up note" },
  { key: "last_contact_date", label: "Last contacted" },
  { key: "assigned_to", label: "Assigned to" },
  { key: "notes", label: "Notes" },
  { key: "source", label: "Source (overrides page source)" },
];

const ALIASES: Record<ImportField, string[]> = {
  name: ["name", "full name", "contact name", "customer name", "prospect name"],
  phone: ["phone", "phone number", "primary phone", "mobile", "cell", "cell phone", "telephone"],
  phone2: ["phone 2", "phone2", "secondary phone", "alt phone", "alternate phone", "home phone"],
  email: ["email", "email address", "e-mail"],
  address: ["address", "street", "street address", "mailing address"],
  city: ["city", "town"],
  county: ["county"],
  zip: ["zip", "zip code", "zipcode", "postal code"],
  state: ["state"],
  birthday: ["birthday", "birth date", "date of birth", "dob", "birth month", "birth month age"],
  home_value: ["home value", "homevalue", "estimated home value", "property value", "value"],
  tier: ["tier", "priority tier"],
  lead_type: ["lead type", "leadtype", "type"],
  status: ["status", "lead status", "disposition"],
  stage_bucket: ["stage", "stage bucket", "bucket", "pipeline stage"],
  next_follow_up_date: ["next follow up", "next follow-up", "follow up date", "callback date", "next call date"],
  next_follow_up_note: ["follow up note", "follow-up note", "callback note", "next action"],
  last_contact_date: ["last contact", "last contacted", "last contact date"],
  assigned_to: ["assigned to", "owner", "agent", "assigned"],
  notes: ["notes", "note", "comments", "raw notes"],
  source: ["source", "lead source", "campaign", "tracker"],
};

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

/** Parses CSV or tab-delimited text, including quoted fields and escaped quotes. */
export function parseLeadFile(text: string): ParsedFile {
  const content = text.replace(/^\uFEFF/, "");
  const firstLine = content.split(/\r?\n/, 1)[0] || "";
  const delimiter = countUnquoted(firstLine, "\t") > countUnquoted(firstLine, ",") ? "\t" : ",";
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char === '"') {
      // RFC 4180: a quote only opens a field at the start of an empty cell.
      // A stray quote mid-cell (an inches mark, a nickname) is a literal, not a
      // mode toggle — the old toggle-on-any-quote swallowed delimiters and
      // shifted every following column, which could dial a wrong number.
      if (inQuotes) {
        if (content[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (cell === "") {
        inQuotes = true;
      } else {
        cell += '"';
      }
    } else if (!inQuotes && char === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && content[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) matrix.push(row);

  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = matrix[0].map((header, index) => header || `Column ${index + 1}`);
  const rows = matrix.slice(1).map((values) => {
    const item: Record<string, string> = {};
    headers.forEach((header, index) => {
      item[header] = values[index]?.trim() || "";
    });
    return item;
  });
  return { headers, rows };
}

function countUnquoted(line: string, target: string) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && line[i] === target) {
      count += 1;
    }
  }
  return count;
}

export function detectMappings(headers: string[]): Partial<Record<ImportField, string>> {
  const normalized = headers.map((header) => ({ header, normalized: normalizeHeader(header) }));
  const mappings: Partial<Record<ImportField, string>> = {};
  const used = new Set<string>();

  // Exact matches first (all fields), then partial — and each source header maps
  // to at most one field, so a header can't silently fill two columns.
  for (const field of IMPORT_FIELDS) {
    const exact = normalized.find(
      ({ header, normalized: h }) => !used.has(header) && ALIASES[field.key].includes(h)
    );
    if (exact) {
      mappings[field.key] = exact.header;
      used.add(exact.header);
    }
  }
  for (const field of IMPORT_FIELDS) {
    if (mappings[field.key]) continue;
    const partial = normalized.find(
      ({ header, normalized: h }) =>
        !used.has(header) &&
        ALIASES[field.key].some((alias) => alias.length >= 3 && (h.includes(alias) || alias.includes(h)))
    );
    if (partial) {
      mappings[field.key] = partial.header;
      used.add(partial.header);
    }
  }
  return mappings;
}

function clean(value: string | undefined) {
  const result = value?.trim();
  return result || null;
}

function cleanNumber(value: string | undefined) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// Date-only database columns need a stable YYYY-MM-DD value. Invalid values
// are left blank instead of corrupting a lead import.
export function normalizeDate(value: string | undefined) {
  const raw = clean(value);
  if (!raw) return null;
  const pad2 = (n: number) => n.toString().padStart(2, "0");

  // Excel serial date (days since 1899-12-30) — common when a date column is
  // pasted as numbers. Bound to a plausible 1955-2065 window.
  if (/^\d{5}$/.test(raw)) {
    const serial = Number(raw);
    if (serial >= 20000 && serial <= 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
  }
  // Year-only DOB (e.g. "1961") → Jan 1 of that year, so it still lands on the
  // T65 radar instead of being silently dropped.
  if (/^(19|20)\d{2}$/.test(raw)) return `${raw}-01-01`;

  // Month-name + year ("Dec 1961", "December 1961 (64 yrs)") — the shape door
  // knock route lists and Nextdoor research sheets carry. Day defaults to the
  // 1st; close enough for the IEP radar, which works in months.
  const monthYear = raw.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d{2})/i
  );
  if (monthYear) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const m = months.indexOf(monthYear[1].slice(0, 3).toLowerCase()) + 1;
    return `${monthYear[2]}-${pad2(m)}-01`;
  }

  // Trailing time is tolerated (no end anchor) so "7/22/2026 10:00" parses.
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
    if (year < 100) year += year >= 30 ? 1900 : 2000;
  } else {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function valueFor(row: Record<string, string>, mappings: Partial<Record<ImportField, string>>, field: ImportField) {
  const header = mappings[field];
  return header ? row[header] : undefined;
}

export function makeImportRows(
  rows: Record<string, string>[],
  mappings: Partial<Record<ImportField, string>>,
  pageSource: string
): ImportRow[] {
  return rows.map((row, index) => {
    const firstName = row[Object.keys(row).find((header) => normalizeHeader(header) === "first name") || ""];
    const lastName = row[Object.keys(row).find((header) => normalizeHeader(header) === "last name") || ""];
    const fullName = clean(valueFor(row, mappings, "name")) || [firstName, lastName].filter(Boolean).join(" ") || null;
    const mappedSource = clean(valueFor(row, mappings, "source"));
    const stage = clean(valueFor(row, mappings, "stage_bucket"));

    return {
      source: mappedSource || pageSource.trim() || "Uncategorized",
      source_row: index + 2,
      assigned_to: clean(valueFor(row, mappings, "assigned_to")) || "Both",
      name: fullName,
      phone: clean(valueFor(row, mappings, "phone")),
      phone2: clean(valueFor(row, mappings, "phone2")),
      email: clean(valueFor(row, mappings, "email")),
      address: clean(valueFor(row, mappings, "address")),
      city: clean(valueFor(row, mappings, "city")),
      county: clean(valueFor(row, mappings, "county")),
      zip: clean(valueFor(row, mappings, "zip")),
      state: clean(valueFor(row, mappings, "state")),
      birthday: normalizeDate(valueFor(row, mappings, "birthday")),
      home_value: cleanNumber(valueFor(row, mappings, "home_value")),
      tier: clean(valueFor(row, mappings, "tier")),
      lead_type: clean(valueFor(row, mappings, "lead_type")),
      status: clean(valueFor(row, mappings, "status")) || "New",
      stage_bucket: stage || "New Prospecting",
      next_follow_up_date: normalizeDate(valueFor(row, mappings, "next_follow_up_date")),
      next_follow_up_note: clean(valueFor(row, mappings, "next_follow_up_note")),
      last_contact_date: normalizeDate(valueFor(row, mappings, "last_contact_date")),
      raw_notes: clean(valueFor(row, mappings, "notes")),
    };
  });
}

export function normalizedPhone(value: string | number | null | undefined) {
  return canonicalPhone(value);
}

export function exactLeadKey(lead: Pick<Lead, "phone" | "source"> | ImportRow) {
  const phone = normalizedPhone(lead.phone);
  const source = String(lead.source || "").trim().toLowerCase();
  return phone && source ? `${phone}|${source}` : null;
}
