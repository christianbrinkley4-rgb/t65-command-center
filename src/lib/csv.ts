import type { Lead } from "./types";
import { leadPhones } from "./phone";

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS: { key: keyof Lead; label: string }[] = [
  { key: "oscr_lead_id", label: "OSCR Lead ID" },
  { key: "oscr_writeback_note", label: "Set in OSCR" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "phone2", label: "Phone 2" },
  { key: "email", label: "Email" },
  { key: "city", label: "City" },
  { key: "county", label: "County" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
  { key: "birthday", label: "Birthday" },
  { key: "source", label: "Source" },
  { key: "tier", label: "Tier" },
  { key: "status", label: "Status" },
  { key: "stage_bucket", label: "Stage" },
  { key: "next_follow_up_date", label: "Next Follow-Up" },
  { key: "assigned_to", label: "Assigned To" },
  { key: "do_not_call", label: "Do Not Call" },
  { key: "dials_count", label: "Dials" },
  { key: "raw_notes", label: "Notes" },
];

export function leadsToCsv(leads: Lead[]): string {
  const header = COLUMNS.map((c) => c.label).join(",");
  const rows = leads.map((l) =>
    COLUMNS.map((c) => {
      if (c.key === "tags") return cell((l.tags || []).join("; "));
      return cell(l[c.key]);
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

// DeftSales (SmartAsset AMP) import template — exact headers and E.164 phones
// the import wizard expects. DNC leads are included and both valid numbers
// are exported as separate rows. Identical phone numbers are deduplicated.
export function deftSalesCsv(leads: Lead[]): { csv: string; rows: number; skipped: number } {
  const header = "FirstName,LastName,Email,PhoneNumber,ZipCode";
  const seen = new Set<string>();
  const rows: string[] = [];
  let skipped = 0;
  for (const l of leads) {
    const phones = leadPhones(l);
    if (!phones.length) skipped += 1;
    for (const ph of phones) {
      if (seen.has(ph)) { skipped += 1; continue; }
      seen.add(ph);
      const name = String(l.name || "").trim();
      const sp = name.indexOf(" ");
      const first = sp > 0 ? name.slice(0, sp) : name;
      const last = sp > 0 ? name.slice(sp + 1) : "";
      rows.push([cell(first), cell(last), cell(l.email || ""), ph, cell(l.zip || "")].join(","));
    }
  }
  return { csv: [header, ...rows].join("\n"), rows: rows.length, skipped };
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
