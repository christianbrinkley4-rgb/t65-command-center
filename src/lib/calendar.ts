// Getting a CRM appointment into Outlook.
//
// There is no Microsoft Graph integration here and there won't be one without
// Bankers Life IT: a real two-way sync needs an Azure app registration and
// admin consent on the CNO tenant. What works today, with no permissions and
// no setup, is the calendar file itself — Outlook, Google and Apple all take
// it, and a downloaded .ics opens straight into the desktop client.

import type { Lead } from "./types";

const APPT_MINUTES = 60;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** iCalendar wants UTC as 20260802T160000Z. */
function icsStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Long lines have to be folded at 75 octets or strict parsers choke, and a
 * comma or semicolon inside a value has to be escaped or it reads as a field
 * separator. Outlook is one of the strict ones.
 */
function icsLine(name: string, value: string): string {
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
  const line = `${name}:${escaped}`;
  const out: string[] = [];
  for (let i = 0; i < line.length; i += 74) {
    out.push((i ? " " : "") + line.slice(i, i + 74));
  }
  return out.join("\r\n");
}

export function appointmentTitle(lead: Pick<Lead, "name">): string {
  return `Medicare appointment — ${lead.name || "lead"}`;
}

function appointmentBody(lead: Lead): string {
  return [
    lead.phone ? `Phone: ${lead.phone}` : "",
    lead.address ? `Address: ${lead.address}` : "",
    lead.birthday ? `DOB: ${lead.birthday}` : "",
    lead.soa_on_file ? "SOA on file" : "NO SOA on file — get it signed before any MA/PDP discussion",
    lead.lead_profile ? `Profile: ${lead.lead_profile}` : "",
    lead.raw_notes ? `Notes: ${String(lead.raw_notes).slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A complete .ics for one appointment. */
export function buildIcs(lead: Lead): string | null {
  if (!lead.appointment_datetime) return null;
  const start = new Date(lead.appointment_datetime);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + APPT_MINUTES * 60_000);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//T65 Command Center//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    icsLine("UID", `t65-${lead.id}@ncwealthprotection.me`),
    icsLine("DTSTAMP", icsStamp(new Date())),
    icsLine("DTSTART", icsStamp(start)),
    icsLine("DTEND", icsStamp(end)),
    icsLine("SUMMARY", appointmentTitle(lead)),
    icsLine("DESCRIPTION", appointmentBody(lead)),
    lead.address ? icsLine("LOCATION", String(lead.address)) : "",
    "BEGIN:VALARM",
    "TRIGGER:-PT60M",
    "ACTION:DISPLAY",
    icsLine("DESCRIPTION", appointmentTitle(lead)),
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

export function downloadIcs(lead: Lead) {
  const ics = buildIcs(lead);
  if (!ics) return;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `appointment-${(lead.name || "lead").replace(/[^\w]+/g, "-")}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Outlook on the web will open a prefilled event from a URL. Handy when you're
 * at the desk and don't want a file in your downloads folder.
 */
export function outlookWebLink(lead: Lead): string | null {
  if (!lead.appointment_datetime) return null;
  const start = new Date(lead.appointment_datetime);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + APPT_MINUTES * 60_000);
  const p = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: appointmentTitle(lead),
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: appointmentBody(lead),
    location: String(lead.address || ""),
  });
  return `https://outlook.office.com/calendar/deeplink/compose?${p.toString()}`;
}
