import { isClosedStatus, needsInfo } from "./types";
import type { Lead } from "./types";

/** A phone-only outcome does not make a known street address unusable. */
export function isKnockableLead(lead: Lead): boolean {
  if (!(lead.address || "").trim() || lead.do_not_knock || needsInfo(lead)) return false;
  const phoneOnly = /^(?:closed\s*[-:]\s*)?(?:dnc|do[ -]?not[ -]?call|bad number|wrong number)$/i
    .test(String(lead.status || "").trim());
  return phoneOnly || (lead.stage_bucket !== "Closed" && !isClosedStatus(lead.status));
}

export function mailerBatches(leads: Lead[]) {
  const batches = new Map<string, { tag: string; label: string; sent: string; count: number }>();
  for (const lead of leads) {
    if (!isKnockableLead(lead)) continue;
    for (const tag of new Set(lead.tags || [])) {
      const match = /^(.*)-mailers-(\d{4}-\d{2}-\d{2})$/.exec(tag);
      if (!match) continue;
      const batch = batches.get(tag) || {
        tag,
        label: match[1].split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") + " mailers",
        sent: match[2],
        count: 0,
      };
      batch.count++;
      batches.set(tag, batch);
    }
  }
  return [...batches.values()].sort((a, b) => b.sent.localeCompare(a.sent));
}
