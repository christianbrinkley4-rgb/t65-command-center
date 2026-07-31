import { supabase } from "./supabaseClient";
import type { Activity, Sequence, SequenceEnrollment, SequenceStep } from "./types";

// Local calendar date as YYYY-MM-DD. Using the browser's LOCAL day (not UTC)
// matters: after ~8pm Eastern the UTC date is already tomorrow, which was
// making evening follow-ups land a day late.
export function localYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr(): string {
  return localYmd(new Date());
}

export function plusDays(base: string, n: number): string {
  const d = new Date(base.slice(0, 10) + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localYmd(d);
}

export async function fetchSequenceData(): Promise<{
  sequences: Sequence[];
  steps: SequenceStep[];
  enrollments: SequenceEnrollment[];
}> {
  const [seq, st, enr] = await Promise.all([
    supabase.from("sequences").select("*").order("created_at"),
    supabase.from("sequence_steps").select("*").order("step_number"),
    supabase.from("sequence_enrollments").select("*"),
  ]);
  if (seq.error) throw seq.error;
  if (st.error) throw st.error;
  if (enr.error) throw enr.error;
  return {
    sequences: (seq.data || []) as Sequence[],
    steps: (st.data || []) as SequenceStep[],
    enrollments: (enr.data || []) as SequenceEnrollment[],
  };
}

export function activeEnrollmentMap(
  enrollments: SequenceEnrollment[]
): Map<string, SequenceEnrollment> {
  const map = new Map<string, SequenceEnrollment>();
  for (const e of enrollments) {
    if (e.status === "active") map.set(e.lead_id, e);
  }
  return map;
}

export function stepsFor(sequenceId: string, steps: SequenceStep[]): SequenceStep[] {
  return steps
    .filter((s) => s.sequence_id === sequenceId)
    .sort((a, b) => a.step_number - b.step_number);
}

export async function logActivity(
  leadId: string,
  activityType: string,
  outcome: string | null,
  notes: string | null,
  loggedBy: string
): Promise<void> {
  const { error } = await supabase.from("activity_log").insert({
    lead_id: leadId,
    activity_type: activityType,
    outcome,
    notes,
    logged_by: loggedBy,
  });
  if (error) throw error;
}

export async function fetchActivity(leadId: string): Promise<Activity[]> {
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("lead_id", leadId)
    .order("activity_date", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || []) as Activity[];
}

export async function enrollLeads(
  leadIds: string[],
  seq: Sequence,
  firstStep: SequenceStep,
  me: string
): Promise<void> {
  if (leadIds.length === 0) return;
  const enrolledAt = todayStr();
  const nextTouch = plusDays(enrolledAt, firstStep.day_offset);
  const { error } = await supabase.from("sequence_enrollments").insert(
    leadIds.map((lead_id) => ({
      lead_id,
      sequence_id: seq.id,
      enrolled_at: enrolledAt,
      current_step: firstStep.step_number,
      next_touch_date: nextTouch,
    }))
  );
  if (error) throw error;
  const { error: logErr } = await supabase.from("activity_log").insert(
    leadIds.map((lead_id) => ({
      lead_id,
      activity_type: "Sequence",
      outcome: "Enrolled",
      notes: `Enrolled in ${seq.name}`,
      logged_by: me,
    }))
  );
  if (logErr) throw logErr;
}

// Logs the current step's touch to activity_log, then either advances the
// enrollment or completes it. The gap between step day-offsets is preserved
// from the day the touch is actually logged, so a late touch never schedules
// the next one in the past.
export async function logTouch(
  enr: SequenceEnrollment,
  seq: Sequence,
  allSteps: SequenceStep[],
  outcome: string,
  me: string
): Promise<void> {
  const steps = stepsFor(enr.sequence_id, allSteps);
  const idx = steps.findIndex((s) => s.step_number === enr.current_step);
  const curr = idx >= 0 ? steps[idx] : null;
  const next = idx >= 0 ? steps[idx + 1] : null;

  await logActivity(
    enr.lead_id,
    "Sequence Touch",
    outcome,
    `${seq.name} · step ${enr.current_step}${curr ? ` (${curr.channel})` : ""}`,
    me
  );

  const patch = next
    ? {
        current_step: next.step_number,
        next_touch_date: plusDays(todayStr(), Math.max(1, next.day_offset - (curr?.day_offset ?? 0))),
        updated_at: new Date().toISOString(),
      }
    : {
        status: "completed",
        next_touch_date: null,
        updated_at: new Date().toISOString(),
      };
  const { error } = await supabase.from("sequence_enrollments").update(patch).eq("id", enr.id);
  if (error) throw error;
}

export async function exitEnrollment(
  enr: SequenceEnrollment,
  reason: string,
  me: string
): Promise<void> {
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({
      status: "exited",
      exit_reason: reason,
      next_touch_date: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", enr.id);
  if (error) throw error;
  await logActivity(enr.lead_id, "Sequence", "Exited", reason, me);
}
