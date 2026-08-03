import { supabase } from "./supabaseClient";
import { writeOrQueue } from "./offline";
import { localYmd } from "./sequences";
import type { ActionAssignee, ActionType, LeadAction } from "./types";

export type ActionDraft = {
  action_type: ActionType;
  due_at: string;
  note?: string;
  assigned_to?: ActionAssignee;
};

// An action "belongs to" a person if it's assigned to them or to Either.
export function actionBelongsTo(action: LeadAction, person: string): boolean {
  return action.assigned_to === person || action.assigned_to === "Either";
}

export async function fetchPendingActions(): Promise<{ actions: LeadAction[]; error: string | null }> {
  const { data, error } = await supabase
    .from("lead_actions")
    .select("*")
    .eq("status", "pending")
    .order("due_at", { ascending: true });
  if (error) return { actions: [], error: error.message };
  return { actions: (data || []) as LeadAction[], error: null };
}

export function actionMap(actions: LeadAction[]) {
  const map = new Map<string, LeadAction[]>();
  for (const action of actions) {
    const current = map.get(action.lead_id) || [];
    current.push(action);
    map.set(action.lead_id, current);
  }
  return map;
}

export async function createLeadActions(leadId: string, drafts: ActionDraft[], me: string) {
  const rows = drafts
    .filter((draft) => draft.due_at)
    .map((draft) => ({
      lead_id: leadId,
      action_type: draft.action_type,
      due_at: new Date(draft.due_at).toISOString(),
      note: draft.note?.trim() || null,
      assigned_to: draft.assigned_to || "Either",
      created_by: me,
    }));
  if (!rows.length) return;
  const { error } = await supabase.from("lead_actions").insert(rows);
  if (error) throw error;
}

/**
 * Book a specific day AND time to come back to this lead.
 *
 * "Follow up in 3 days" is a guess; "Tuesday at 6:15, after he's home from
 * work" is the appointment before the appointment, and it's what people
 * actually say at the door. The time lives on the action (lead_actions.due_at),
 * which is what the queue sorts on, so the lead surfaces at 6:15 rather than
 * somewhere on Tuesday. next_follow_up_date is kept in step so every other view
 * still shows the right day.
 *
 * Goes through the offline queue: the driveway where you agree on Tuesday is
 * often the driveway with no signal.
 */
export async function scheduleFollowUp(opts: {
  leadId: string;
  leadLabel: string;
  /** A datetime-local value ("2026-08-04T18:15") or any parseable date-time. */
  when: string;
  actionType?: ActionType;
  note?: string;
  assignee: ActionAssignee;
  me: string;
  /** Merged into the lead row — e.g. the door-knock counters. */
  extraLeadPatch?: Record<string, unknown>;
}): Promise<"sent" | "queued"> {
  const due = new Date(opts.when);
  if (isNaN(due.getTime())) throw new Error("That date and time didn't parse.");
  const note = opts.note?.trim() || null;
  const when = formatActionDue(due.toISOString());

  const actionWrite = await writeOrQueue({
    table: "lead_actions",
    op: "insert",
    payload: {
      lead_id: opts.leadId,
      action_type: opts.actionType || "Call",
      due_at: due.toISOString(),
      note,
      assigned_to: opts.assignee,
      created_by: opts.me,
    },
    label: `Follow up ${when} · ${opts.leadLabel}`,
  });
  const leadWrite = await writeOrQueue({
    table: "leads",
    op: "update",
    match: { id: opts.leadId },
    payload: {
      next_follow_up_date: localYmd(due),
      ...(note ? { next_follow_up_note: note } : {}),
      updated_at: new Date().toISOString(),
      ...(opts.extraLeadPatch || {}),
    },
    label: `Follow-up date · ${opts.leadLabel}`,
  });
  await writeOrQueue({
    table: "activity_log",
    op: "insert",
    payload: {
      lead_id: opts.leadId,
      activity_type: "Follow-up",
      outcome: `Scheduled ${when}`,
      notes: note,
      logged_by: opts.me,
      activity_date: new Date().toISOString(),
    },
    label: `Follow-up log · ${opts.leadLabel}`,
  });
  return actionWrite === "sent" && leadWrite === "sent" ? "sent" : "queued";
}

export async function completeLeadAction(action: LeadAction, me: string, note?: string) {
  const { error } = await supabase
    .from("lead_actions")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: me,
      completion_note: note?.trim() || null,
    })
    .eq("id", action.id);
  if (error) throw error;
}

export async function cancelPendingLeadActions(leadId: string, reason: string, me: string) {
  const { error } = await supabase
    .from("lead_actions")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      completed_by: me,
      completion_note: reason,
    })
    .eq("lead_id", leadId)
    .eq("status", "pending");
  if (error) throw error;
}

/**
 * Cancel every pending action on this lead EXCEPT the ones that were already
 * there. Used by undo: a disposition schedules its own retry, so reverting the
 * disposition has to revert the retry too, without touching the callback
 * somebody planned deliberately last week.
 */
export async function cancelActionsCreatedSince(
  leadId: string,
  keepIds: string[],
  reason: string,
  me: string
) {
  const { data, error } = await supabase
    .from("lead_actions")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "pending");
  if (error) throw error;
  const keep = new Set(keepIds);
  const doomed = (data || []).map((r) => r.id as string).filter((id) => !keep.has(id));
  if (!doomed.length) return;
  const { error: updateError } = await supabase
    .from("lead_actions")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      completed_by: me,
      completion_note: reason,
    })
    .in("id", doomed);
  if (updateError) throw updateError;
}

export function nextPendingAction(actions: LeadAction[] | undefined) {
  return (actions || []).find((action) => action.status === "pending") || null;
}

export function formatActionDue(dueAt: string) {
  return new Date(dueAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
