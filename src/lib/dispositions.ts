import { supabase } from "./supabaseClient";
import { effectiveDueDate } from "./buckets";
import { exitEnrollment, logActivity, logTouch, plusDays, todayStr } from "./sequences";
import { cancelActionsCreatedSince, cancelPendingLeadActions, createLeadActions } from "./actions";
import { describeCallback, scheduleCallback } from "./callbackTime";
import { NEEDS_INFO_STAGE, NEEDS_INFO_STATUS } from "./types";
import type { LeadWithBucket, Sequence, SequenceStep } from "./types";

// Workflow trigger: an interested lead must never dangle. Whoever logged the
// conversation gets a Call action for tomorrow morning, unless something is
// already planned for this lead. Best-effort — a trigger failure never blocks
// the disposition itself.
export async function autoFollowUpOnInterested(lead: LeadWithBucket, me: string): Promise<void> {
  const hasPending = (lead._actions || []).some((a) => a.status === "pending");
  if (hasPending) return;
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(10, 0, 0, 0);
  const assignee = me === "Will" ? "Will" : "Christian";
  await createLeadActions(
    lead.id,
    [{ action_type: "Call", due_at: due.toISOString(), note: "Auto: they were interested — strike while it's warm", assigned_to: assignee }],
    me
  ).catch(() => {});
}

export type Disposition = {
  key: string;
  label: string;
  status: string;
  followUpDays: number | null; // null = clear the follow-up
  stage: string;
  closes: boolean;
};

// One tap = status + retry date + stage + activity row, and the sequence
// advances or exits on its own. followUpDays are the house defaults.
export const DISPOSITIONS: Disposition[] = [
  { key: "na", label: "No Answer", status: "No Answer", followUpDays: 2, stage: "Worked - Follow Up", closes: false },
  { key: "vm", label: "Voicemail", status: "Voicemail Left", followUpDays: 3, stage: "Worked - Follow Up", closes: false },
  { key: "int", label: "Talked - Interested", status: "Talked - Interested", followUpDays: 3, stage: "Worked - Follow Up", closes: false },
  { key: "nr", label: "Talked - Not Ready", status: "Talked - Not Ready", followUpDays: 30, stage: "Worked - Follow Up", closes: false },
  { key: "ni", label: "Not Interested", status: "Closed - Not Interested", followUpDays: null, stage: "Closed", closes: true },
  { key: "bad", label: "Bad Number", status: "Closed - Bad Number", followUpDays: null, stage: "Closed", closes: true },
  { key: "dnc", label: "DNC", status: "Closed - DNC", followUpDays: null, stage: "Closed", closes: true },
  // Appended, never inserted: the number keys 1-7 are muscle memory and DNC has
  // to stay on 7. Not a dead lead — a dead RECORD. Wrong name, wrong address,
  // someone else living there, birthday off. It leaves the working queue
  // (dialing it again just repeats the mistake) but never closes: it waits in
  // the "Needs info" segment to be corrected, with the record intact.
  { key: "info", label: "Wrong Info", status: NEEDS_INFO_STATUS, followUpDays: null, stage: NEEDS_INFO_STAGE, closes: false },
];

function isTouchDue(lead: LeadWithBucket): boolean {
  if (!lead._enr || lead._enr.status !== "active" || !lead._enr.next_touch_date) return false;
  return lead._enr.next_touch_date <= todayStr();
}

export async function applyDisposition(
  lead: LeadWithBucket,
  d: Disposition,
  me: string,
  sequences: Sequence[],
  steps: SequenceStep[],
  useDispositionFollowUp = true,
  /** What was actually said. Rides along on the call's activity row, so the
   *  timeline reads like a conversation instead of a list of outcomes. */
  note?: string
): Promise<void> {
  const callNote = note?.trim() || null;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: d.status,
    stage_bucket: d.stage,
    next_follow_up_date:
      useDispositionFollowUp && d.followUpDays !== null ? plusDays(todayStr(), d.followUpDays) : null,
    last_contact_date: todayStr(),
    dials_count: (lead.dials_count || 0) + 1,
    updated_at: now,
  };
  // DNC is a hard, permanent suppression, not just a status.
  if (d.key === "dnc") patch.do_not_call = true;
  // If this lead came from OSCR, flag it so the result gets pushed back there.
  if (lead.oscr_lead_id) {
    patch.needs_oscr_writeback = true;
    patch.oscr_writeback_note = d.status;
  }
  if (callNote) {
    // Dated and prepended, never replacing: the next call must not erase this one.
    const stamp = todayStr();
    patch.raw_notes = `[${stamp} call · ${me}] ${callNote}${lead.raw_notes ? "\n" + lead.raw_notes : ""}`;
    patch.next_follow_up_note = callNote;
  }
  const { error } = await supabase.from("leads").update(patch).eq("id", lead.id);
  if (error) throw error;

  const enr = lead._enr && lead._enr.status === "active" ? lead._enr : null;
  const enrSeq = enr ? sequences.find((s) => s.id === enr.sequence_id) : null;

  if (enr && d.closes) {
    await logActivity(lead.id, "Call", d.status, callNote, me);
    await exitEnrollment(enr, `Auto-exit: disposition ${d.status}`, me);
  } else if (enr && enrSeq && isTouchDue(lead)) {
    // The due touch was this call: log it as the sequence touch and advance.
    await logTouch(enr, enrSeq, steps, d.status, me);
  } else {
    await logActivity(lead.id, "Call", d.status, callNote, me);
  }
  if (d.closes) {
    // Do not leave a call or text reminder on a closed/DNC lead. This is
    // best-effort so the existing disposition flow remains available until
    // the lead_actions migration has been applied.
    await cancelPendingLeadActions(lead.id, `Closed: ${d.status}`, me).catch(() => {});
  }
  if (d.key === "int") {
    await autoFollowUpOnInterested(lead, me);
  } else if (useDispositionFollowUp && d.followUpDays !== null && !d.closes) {
    // A no-answer isn't a dead end, it's an appointment with yourself. Book it
    // at a DIFFERENT hour than the one that just failed (see callbackTime) and
    // put it on the calendar, rather than leaving a bare date nobody sees.
    const when = scheduleCallback(d.followUpDays, new Date().getHours());
    if (when) {
      const already = (lead._actions || []).some((a) => a.status === "pending");
      if (!already) {
        await createLeadActions(
          lead.id,
          [{
            action_type: "Call",
            due_at: when.toISOString(),
            note: [`${d.status} — retry ${describeCallback(when)}`, callNote].filter(Boolean).join(" · "),
            assigned_to: me === "Will" ? "Will" : "Christian",
          }],
          me
        ).catch(() => {});
      }
    }
  }
}

export async function setAppointment(
  lead: LeadWithBucket,
  apptIso: string,
  me: string
): Promise<void> {
  const appt = new Date(apptIso);
  const { error } = await supabase
    .from("leads")
    .update({
      status: "Appointment Set",
      stage_bucket: "Appointment Upcoming",
      appointment_datetime: appt.toISOString(),
      next_follow_up_date: apptIso.slice(0, 10),
      last_contact_date: todayStr(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id);
  if (error) throw error;
  await logActivity(
    lead.id,
    "Appointment",
    "Set",
    `Appointment ${appt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    me
  );
  if (lead._enr && lead._enr.status === "active") {
    await exitEnrollment(lead._enr, "Auto-exit: appointment set", me);
  }
  await cancelPendingLeadActions(lead.id, "Appointment set", me).catch(() => {});
}

// Outcomes for a lead that already has an appointment set. Held/No-Show keep
// the funnel honest (show rate), and each schedules the sensible next step.
export type ApptOutcome = { key: string; label: string; status: string; stage: string; followUpDays: number | null };
export const APPT_OUTCOMES: ApptOutcome[] = [
  { key: "held", label: "Held", status: "Appointment Held", stage: "Post Appointment", followUpDays: 2 },
  { key: "noshow", label: "No-Show", status: "Appointment No-Show", stage: "Worked - Follow Up", followUpDays: 1 },
];

export async function applyApptOutcome(
  lead: LeadWithBucket,
  o: ApptOutcome,
  me: string
): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({
      status: o.status,
      stage_bucket: o.stage,
      next_follow_up_date: o.followUpDays === null ? null : plusDays(todayStr(), o.followUpDays),
      last_contact_date: todayStr(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id);
  if (error) throw error;
  await logActivity(lead.id, "Appointment", o.status, null, me);
}

// Snapshot of the mutable fields a disposition touches, so Next Up can undo a
// misclick. We restore lead fields and log the correction; we do not rewrite
// append-only history (the log correctly shows both the mistake and the undo).
export type LeadSnapshot = {
  id: string;
  status: string | null;
  stage_bucket: string | null;
  next_follow_up_date: string | null;
  dials_count: number | null;
  do_not_call: boolean | null;
  /**
   * The appointment, which undo used to leave behind.
   *
   * Booking someone writes appointment_datetime AND flips the status. Undo
   * restored the status and nothing else, so the lead came back reading "New"
   * while still holding a future appointment — and a future appointment takes
   * a lead out of every dial queue (hasUpcomingAppointment). The lead vanished
   * silently and showed a meeting nobody had agreed to on the Calendar. A
   * mistyped date on the datetime picker was enough to lose someone.
   */
  appointment_datetime: string | null;
  /**
   * Pending actions that existed BEFORE the thing being undone. A disposition
   * schedules its own callback ("No Answer — retry Thursday 6:15"), so undoing
   * it has to take that callback with it or the lead keeps a task nobody
   * planned. Anything pending that isn't in this list was created by the
   * disposition and gets cancelled.
   */
  pendingActionIds: string[];
};

export function snapshotLead(lead: LeadWithBucket): LeadSnapshot {
  return {
    id: lead.id,
    status: lead.status,
    stage_bucket: lead.stage_bucket,
    next_follow_up_date: lead.next_follow_up_date,
    dials_count: lead.dials_count,
    do_not_call: lead.do_not_call ?? false,
    appointment_datetime: lead.appointment_datetime ?? null,
    pendingActionIds: (lead._actions || [])
      .filter((a) => a.status === "pending")
      .map((a) => a.id),
  };
}

export async function revertLead(snap: LeadSnapshot, me: string): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({
      status: snap.status,
      stage_bucket: snap.stage_bucket,
      next_follow_up_date: snap.next_follow_up_date,
      dials_count: snap.dials_count,
      do_not_call: snap.do_not_call,
      appointment_datetime: snap.appointment_datetime,
      updated_at: new Date().toISOString(),
    })
    .eq("id", snap.id);
  if (error) throw error;
  // Best-effort, like every other action write: a lead_actions table that
  // isn't migrated yet must not turn undo into an error.
  await cancelActionsCreatedSince(snap.id, snap.pendingActionIds, "Undone", me).catch(() => {});
  await logActivity(snap.id, "Undo", "Reverted last disposition", null, me);
}

export async function markSold(lead: LeadWithBucket, me: string): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({
      status: "Closed - Sold",
      stage_bucket: "Closed",
      next_follow_up_date: null,
      last_contact_date: todayStr(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id);
  if (error) throw error;
  await logActivity(lead.id, "Sale", "Closed - Sold", null, me);
  if (lead._enr && lead._enr.status === "active") {
    await exitEnrollment(lead._enr, "Auto-exit: sold", me);
  }
  await cancelPendingLeadActions(lead.id, "Sold", me).catch(() => {});
}

export { effectiveDueDate };
