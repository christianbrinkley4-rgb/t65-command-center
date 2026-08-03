import type { Lead } from "./types";
import { canonicalPhone } from "./phone";
import { turns65Label } from "./priority";

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Each column knows how to read itself, so a derived column (tags, the T65
// month) is written the same way as a plain one. The old shape was a list of
// column KEYS with a special case for "tags" that could never fire, because
// "tags" wasn't in the list — so every export since tags shipped has quietly
// dropped the segmentation the whole Power List filters on. Address and the
// appointment were missing too, which made an exported view useless for
// planning a drive.
const COLUMNS: { label: string; get: (l: Lead) => unknown }[] = [
  { label: "OSCR Lead ID", get: (l) => l.oscr_lead_id },
  { label: "Set in OSCR", get: (l) => l.oscr_writeback_note },
  { label: "Name", get: (l) => l.name },
  { label: "Phone", get: (l) => l.phone },
  { label: "Phone 2", get: (l) => l.phone2 },
  { label: "Email", get: (l) => l.email },
  { label: "Address", get: (l) => l.address },
  { label: "City", get: (l) => l.city },
  { label: "County", get: (l) => l.county },
  { label: "State", get: (l) => l.state },
  { label: "ZIP", get: (l) => l.zip },
  { label: "Birthday", get: (l) => l.birthday },
  { label: "Turns 65", get: (l) => turns65Label(l.birthday) },
  { label: "Source", get: (l) => l.source },
  { label: "Tags", get: (l) => (l.tags || []).join("; ") },
  { label: "Tier", get: (l) => l.tier },
  { label: "Status", get: (l) => l.status },
  { label: "Stage", get: (l) => l.stage_bucket },
  { label: "Next Follow-Up", get: (l) => l.next_follow_up_date },
  { label: "Appointment", get: (l) => l.appointment_datetime },
  { label: "Last Contact", get: (l) => l.last_contact_date },
  { label: "Assigned To", get: (l) => l.assigned_to },
  { label: "Do Not Call", get: (l) => l.do_not_call },
  { label: "Dials", get: (l) => l.dials_count },
  { label: "Notes", get: (l) => l.raw_notes },
];

export function leadsToCsv(leads: Lead[]): string {
  const header = COLUMNS.map((c) => c.label).join(",");
  const rows = leads.map((l) => COLUMNS.map((c) => cell(c.get(l))).join(","));
  return [header, ...rows].join("\n");
}

// DeftSales (SmartAsset AMP) import template — exact headers and E.164 phones
// the import wizard expects. Leads without a dialable 10-digit number and DNC
// leads are excluded, and numbers are deduped so the same household can't be
// FastCalled twice. Import these ONLY into the call-only OSCR/T65 Lead Type:
// none of these leads carry SMS/email consent, so they must never land on a
// campaign with text or email steps.
export function deftSalesCsv(leads: Lead[]): { csv: string; rows: number; skipped: number } {
  const header = "FirstName,LastName,Email,PhoneNumber,ZipCode";
  const seen = new Set<string>();
  const rows: string[] = [];
  let skipped = 0;
  for (const l of leads) {
    const ph = canonicalPhone(l.phone) || canonicalPhone(l.phone2);
    if (ph.length !== 10 || l.do_not_call || seen.has(ph)) {
      skipped += 1;
      continue;
    }
    seen.add(ph);
    const name = String(l.name || "").trim();
    const sp = name.indexOf(" ");
    const first = sp > 0 ? name.slice(0, sp) : name;
    const last = sp > 0 ? name.slice(sp + 1) : "";
    rows.push([cell(first), cell(last), cell(l.email || ""), `+1${ph}`, cell(l.zip || "")].join(","));
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
