// One canonical form for a phone number so dedup, duplicate-flagging, and DNC
// suppression all agree. Strips an extension, drops a US country-code 1, and
// reduces to the last 10 digits. "(336) 273-7565", "1-336-273-7565",
// "+13362737565", and "336.273.7565 ext 4" all canonicalize to "3362737565".
export function canonicalPhone(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v).split(/\s*(?:x|ext\.?|extension)\b/i)[0];
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return d;
}

/**
 * How a number is WRITTEN DOWN: 336-273-7565.
 *
 * Bought lists arrive as bare ten-digit strings, trackers arrive as
 * "(336) 421-9302", and the book ended up holding both next to each other. A
 * column of 3369405598 is unreadable at a glance, and reading a number off the
 * screen onto a keypad is something that happens dozens of times a day.
 *
 * canonicalPhone() is the comparison form and stays digits-only. This is the
 * human form, and it refuses to guess: anything that isn't exactly ten digits,
 * or that carries an extension worth keeping, comes back untouched rather than
 * mangled into a shape it isn't.
 */
export function formatPhone(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const raw = String(v).trim();
  if (!raw) return "";
  if (/\b(?:x|ext\.?|extension)\b/i.test(raw)) return raw;
  const d = canonicalPhone(raw);
  if (d.length !== 10) return raw;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalPhone(a);
  return ca.length === 10 && ca === canonicalPhone(b);
}

/**
 * The other number, only when it's genuinely another line.
 *
 * The same phone routinely arrives twice in two formats — "(336) 688 - 3740"
 * from one list and "(336) 688-3740" from another — and merging two records
 * for one person is exactly when that happens. A second Call button that
 * redials the number you just tried is worse than no button: mid-call, it
 * reads as a real second chance at reaching them.
 */
export function altPhone(lead: { phone?: string | null; phone2?: string | null }): string | null {
  const p2 = String(lead.phone2 || "").trim();
  if (!p2) return null;
  return samePhone(lead.phone, p2) ? null : p2;
}
