export type Lead = {
  id: string;
  source: string | null;
  source_row: number | null;
  assigned_to: string | null;
  name: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  city: string | null;
  county: string | null;
  zip: string | null;
  state: string | null;
  lead_type: string | null;
  birthday: string | null;
  home_value: number | null;
  home_value_source: string | null;
  home_value_checked_at: string | null;
  home_owner_occupied: boolean | null;
  home_property_type: string | null;
  tier: string | null;
  housing_flag: string | null;
  status: string | null;
  stage_bucket: string | null;
  next_follow_up_date: string | null;
  next_follow_up_note: string | null;
  last_contact_date: string | null;
  dials_count: number | null;
  appointment_datetime: string | null;
  notes: string | null;
  raw_notes: string | null;
  /** Static facts about the person (SmartAsset survey answers), not a history. */
  lead_profile: string | null;
  created_at: string | null;
  updated_at: string | null;
  address: string | null;
  do_not_call: boolean | null;
  soa_on_file: boolean | null;
  soa_date: string | null;
  ptc_on_file: boolean | null;
  tags: string[] | null;
  // OSCR (system of record) linkage + inherited compliance
  oscr_lead_id: string | null;
  oscr_lead_source: string | null;
  oscr_status: string | null;
  oscr_latest_disp: string | null;
  oscr_last_disp_date: string | null;
  oscr_score: number | null;
  oscr_owner: string | null;
  callable: boolean | null;
  sms_consent: boolean | null;
  email_consent: boolean | null;
  oscr_synced_at: string | null;
  needs_oscr_writeback: boolean | null;
  oscr_writeback_note: string | null;
  // Door knocking (independent of phone compliance — phone-DNC leads are
  // often the best knock targets)
  do_not_knock: boolean | null;
  last_knock_date: string | null;
  knock_count: number | null;
  // Geocoded position for door-knock routing (US Census geocoder)
  latitude: number | null;
  longitude: number | null;
  geocoded_at: string | null;
};

// A record we can't trust: wrong name, wrong address, someone else living
// there, birthday off. Not a dead lead — a dead RECORD. Shared by the phone and
// the door so both write the same thing and one filter finds them all.
export const NEEDS_INFO_STATUS = "Needs Info - Verify";
export const NEEDS_INFO_STAGE = "Needs Info";

export function needsInfo(lead: { status?: string | null; stage_bucket?: string | null }): boolean {
  return lead.stage_bucket === NEEDS_INFO_STAGE || (lead.status || "") === NEEDS_INFO_STATUS;
}

// Two rows, one person. When duplicates are merged the loser keeps its row
// (history is append-only and leads are never deleted) but stops being a lead:
// it is a tombstone pointing at the survivor, who now holds the calls, the
// notes, and the second phone number. Nothing in the app should count it,
// list it, or return it from a search.
export const MERGED_STATUS = "Closed - Merged";

export function isMerged(lead: { status?: string | null }): boolean {
  return String(lead.status || "").trim().toLowerCase() === "closed - merged";
}

// Statuses that mean "done with this lead" but don't start with "Closed -".
// The tracker years used their own vocabulary, and a prefix check alone left
// dead leads sitting in the working queue.
const CLOSED_IN_SPIRIT = [
  "not interested",
  "wrong person",
  "wrong number",
  "closed lost",
  "already enrolled",
  "has advisor",
  "placed w/ another advisor",
  "deceased",
];

export function isClosedStatus(status: string | null | undefined): boolean {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return false;
  // DNC is retained as metadata; it does not remove the lead from work queues.
  if (/^(?:closed\s*[-:]\s*)?(?:dnc|do[ -]?not[ -]?call)$/.test(s)) return false;
  if (s.startsWith("closed")) return true;
  return CLOSED_IN_SPIRIT.some((c) => s.includes(c));
}

/**
 * Has anyone ever worked this lead, anywhere? A status from the tracker years,
 * an OSCR disposition, a logged dial, a contact date. Without this the app
 * treats a lead someone called nine times as brand new, hands it a
 * speed-to-lead bonus, and puts it at the top of the queue.
 */
export function hasPriorWork(lead: {
  status?: string | null;
  dials_count?: number | null;
  last_contact_date?: string | null;
  oscr_latest_disp?: string | null;
  oscr_last_disp_date?: string | null;
}): boolean {
  if ((lead.dials_count || 0) > 0) return true;
  if (lead.last_contact_date) return true;
  const s = String(lead.status || "").trim();
  if (s && s.toLowerCase() !== "new") return true;
  const disp = String(lead.oscr_latest_disp || "").trim();
  if (disp && disp.toLowerCase() !== "no_disposition") return true;
  return Boolean(lead.oscr_last_disp_date);
}

export type SavedView = {
  id: string;
  name: string;
  page: string;
  filters: Record<string, string>;
  created_by: string | null;
  created_at: string | null;
};

export type Template = {
  id: string;
  name: string;
  channel: string;
  category: string | null;
  body: string;
  created_at: string | null;
  updated_at: string | null;
};

export type UiBucket =
  | "Overdue"
  | "DueToday"
  | "ThisWeek"
  | "Verify"
  | "ThisMonth"
  | "Later"
  | "Worked"
  | "New"
  | "Closed";

export type Sequence = {
  id: string;
  name: string;
  description: string | null;
  source_filter: string | null;
  is_draft: boolean;
  active: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type SequenceStep = {
  id: string;
  sequence_id: string;
  step_number: number;
  day_offset: number;
  channel: string;
  instructions: string | null;
  created_at: string | null;
};

export type SequenceEnrollment = {
  id: string;
  lead_id: string;
  sequence_id: string;
  enrolled_at: string;
  current_step: number;
  next_touch_date: string | null;
  status: string;
  exit_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type Activity = {
  id: string;
  lead_id: string | null;
  activity_type: string;
  activity_date: string | null;
  outcome: string | null;
  notes: string | null;
  logged_by: string | null;
};

export const ACTION_TYPES = ["Call", "Text", "Email", "Mail", "Door Knock", "Other"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_ASSIGNEES = ["Either", "Christian", "Will"] as const;
export type ActionAssignee = (typeof ACTION_ASSIGNEES)[number];

export type LeadAction = {
  id: string;
  lead_id: string;
  action_type: ActionType;
  due_at: string;
  note: string | null;
  status: "pending" | "completed" | "cancelled";
  assigned_to: ActionAssignee;
  created_by: string | null;
  created_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  completion_note: string | null;
};

export type LeadWithBucket = Lead & {
  _bucket: UiBucket;
  _enr?: SequenceEnrollment | null;
  _actions?: LeadAction[];
  _dupe?: boolean;
  _dncSuppressed?: boolean; // phone matches a Do-Not-Call record (maybe a twin lead)
};

export const WHO_OPTIONS = ["Everyone", "Christian", "Will"] as const;
export type WhoFilter = (typeof WHO_OPTIONS)[number];
