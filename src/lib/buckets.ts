import { isClosedStatus } from "./types";
import type { Lead, LeadAction, LeadWithBucket, SequenceEnrollment, UiBucket } from "./types";

function daysFromToday(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr.slice(0, 10) + "T00:00:00");
  if (isNaN(target.getTime())) return null;
  const diffMs = target.getTime() - today.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

const LATER_RAW = ["Next 1-2 Mo", "AEP Future", "Stale - Reactivate"];
const VERIFY_RAW = ["Appointment - Verify", "Post Appointment", "Appointment Upcoming"];

// Normalize any date or ISO timestamp to a LOCAL YYYY-MM-DD. Action due_at is a
// full UTC timestamp; slicing its ISO string would use the UTC day and show
// evening tasks a day late, so convert through local calendar components.
function toLocalYmd(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The date that should drive the queue: the soonest of the manual follow-up,
// the active nurture sequence's next touch, and any pending planned action.
export function effectiveDueDate(lead: Lead, enr?: SequenceEnrollment | null): string | null {
  const dates: string[] = [];
  if (lead.next_follow_up_date) dates.push(toLocalYmd(lead.next_follow_up_date));
  if (enr && enr.status === "active" && enr.next_touch_date) dates.push(toLocalYmd(enr.next_touch_date));
  const actions = (lead as LeadWithBucket)._actions || [];
  for (const action of actions) {
    if (action.status === "pending") dates.push(toLocalYmd(action.due_at));
  }
  dates.sort();
  return dates[0] ?? null;
}

export function computeBucket(lead: Lead, enr?: SequenceEnrollment | null): UiBucket {
  if (isClosedStatus(lead.status)) return "Closed";

  const enrolled = enr && enr.status === "active";
  if (!enrolled && lead.stage_bucket === "New Prospecting" && !effectiveDueDate(lead, enr)) return "New";

  const df = daysFromToday(effectiveDueDate(lead, enr));
  if (df !== null) {
    if (df < 0) return "Overdue";
    if (df === 0) return "DueToday";
    if (df <= 7) return "ThisWeek";
    if (df <= 31) return "ThisMonth";
    return "Later";
  }

  const raw = lead.stage_bucket || "";
  if (raw === "New Prospecting") return "New";
  if (raw === "Overdue") return "Overdue";
  if (raw === "Due Today") return "DueToday";
  if (raw === "This Week") return "ThisWeek";
  if (raw === "This Month") return "ThisMonth";
  if (LATER_RAW.includes(raw)) return "Later";
  if (VERIFY_RAW.includes(raw)) return "Verify";
  return "Worked";
}

export function withBuckets(
  leads: Lead[],
  enrByLead?: Map<string, SequenceEnrollment>,
  actionsByLead?: Map<string, LeadAction[]>
): LeadWithBucket[] {
  return leads.map((l) => {
    const enr = enrByLead?.get(l.id) ?? null;
    const actions = actionsByLead?.get(l.id) ?? [];
    const withMeta = { ...l, _enr: enr, _actions: actions };
    return { ...withMeta, _bucket: computeBucket(withMeta, enr) };
  });
}

export const BUCKET_ORDER: UiBucket[] = [
  "Overdue",
  "DueToday",
  "ThisWeek",
  "Verify",
  "ThisMonth",
  "Later",
  "Worked",
];

export const BUCKET_LABEL: Record<UiBucket, string> = {
  Overdue: "Overdue",
  DueToday: "Due Today",
  ThisWeek: "This Week",
  Verify: "Needs Verify",
  ThisMonth: "This Month",
  Later: "Later / Nurture",
  Worked: "Worked — No Date",
  New: "New Prospecting",
  Closed: "Closed",
};

export const BUCKET_COLOR: Record<UiBucket, string> = {
  Overdue: "overdue",
  DueToday: "due",
  ThisWeek: "week",
  Verify: "verify",
  ThisMonth: "month",
  Later: "later",
  Worked: "worked",
  New: "newlead",
  Closed: "later",
};

// Leads are a shared pool, so "Everyone" shows all and a person's view is the
// shared pool minus what's been handed exclusively to the OTHER agent. Shared
// ('Either') actions, unassigned callbacks, and 'Both' leads all still show for
// each person; only a lead hard-assigned to the other, or whose every pending
// action belongs to the other, drops off. (Fixes the bug where a default
// 'Either' callback vanished under a personal filter.)
export function matchesWho(lead: Lead, who: string): boolean {
  if (who === "Everyone") return true;
  const other = who === "Christian" ? "Will" : "Christian";
  if (lead.assigned_to === other) return false;
  const pending = ((lead as LeadWithBucket)._actions || []).filter((a) => a.status === "pending");
  if (pending.length > 0 && pending.every((a) => a.assigned_to === other)) return false;
  return true;
}
