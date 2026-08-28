"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Phone, PhoneCall, History, UserRound, ChevronDown, ChevronRight } from "lucide-react";
import { useApp } from "@/lib/context";
import {
  enrollLeads,
  exitEnrollment,
  fetchActivity,
  logActivity,
  logTouch,
  stepsFor,
} from "@/lib/sequences";
import { cancelPendingLeadActions, completeLeadAction, createLeadActions, formatActionDue, type ActionDraft } from "@/lib/actions";
import { applyApptOutcome, APPT_OUTCOMES } from "@/lib/dispositions";
import { fetchTemplates, fillTemplate } from "@/lib/templates";
import ActionPlanner from "@/components/ActionPlanner";
import SmartCapture from "@/components/SmartCapture";
import { zipOf } from "@/components/LeadAddress";
import { altPhone, formatPhone } from "@/lib/phone";
import { canonicalPhone } from "@/lib/phone";
import T65Badge from "@/components/T65Badge";
import LeadIdentityFields, {
  emptyIdentity,
  identityChanged,
  identityFromLead,
  identityPatch,
  type LeadIdentity,
} from "@/components/LeadIdentityFields";
import { supabase } from "@/lib/supabaseClient";
import { askedNotToBeCalled, needsInfo, onScrubList, NEEDS_INFO_STATUS } from "@/lib/types";
import type { Activity, LeadWithBucket, Template } from "@/lib/types";

// One chronological feed per lead: activity_log rows (dials, dispositions,
// knocks, sequence touches, notes) merged with telephony calls. Everything
// that happened, one order, no tab-hopping.
type TimelineItem = {
  id: string;
  kind: string;
  outcome: string | null;
  detail: string | null;
  date: string | null;
  by: string | null;
};

function callToTimeline(c: {
  id: string;
  agent: string | null;
  answered: boolean;
  duration_seconds: number;
  status: string;
  started_at: string;
  disposition: string | null;
}): TimelineItem {
  const mins = Math.floor((c.duration_seconds || 0) / 60);
  const secs = (c.duration_seconds || 0) % 60;
  const talk = c.answered ? ` · ${mins}m ${secs}s` : "";
  return {
    id: `call-${c.id}`,
    kind: "Phone call",
    outcome: c.answered ? "Answered" : c.status,
    detail: `${c.disposition || ""}${talk}`.trim() || null,
    date: c.started_at,
    by: c.agent,
  };
}

const STATUS_SUGGESTIONS = [
  "New",
  "No Answer",
  "Voicemail Left",
  "Talked - Interested",
  "Talked - Not Ready",
  NEEDS_INFO_STATUS,
  "Appointment Set",
  "Closed - Sold",
  "Closed - Not Interested",
  "Closed - DNC",
  "Closed - Bad Number",
  "Closed - Invalid",
  "Closed - Advisor",
];

const STAGE_SUGGESTIONS = [
  "New Prospecting",
  "Recently Worked",
  "Worked - Follow Up",
  "Appointment Upcoming",
  "Appointment - Verify",
  "Post Appointment",
  "Overdue",
  "Due Today",
  "This Week",
  "This Month",
  "Next 1-2 Mo",
  "AEP Future",
  "Stale - Reactivate",
  "Unscheduled",
  "Closed",
];

const TOUCH_OUTCOMES = [
  "No Answer",
  "Voicemail Left",
  "Talked",
  "Text Sent",
  "Email Sent",
  "Bad Number",
];

const EXIT_REASONS = [
  "Booked appointment",
  "Answered - working manually",
  "Not interested",
  "DNC",
  "Bad number",
  "Other",
];

function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Statuses that should automatically pull a lead out of its nurture sequence.
function isSequenceExitStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s.startsWith("closed") || s === "appointment set";
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function EditDrawer({
  lead,
  onClose,
}: {
  lead: LeadWithBucket | null;
  onClose: () => void;
}) {
  const { updateLead, reload, sequences, steps, me, actionsError, leads } = useApp();
  const [status, setStatus] = useState("");
  const [stageBucket, setStageBucket] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [identity, setIdentity] = useState<LeadIdentity>(emptyIdentity);
  const [showIdentity, setShowIdentity] = useState(false);
  const [appt, setAppt] = useState("");
  const [doNotCall, setDoNotCall] = useState(false);
  const [soaOnFile, setSoaOnFile] = useState(false);
  const [soaDate, setSoaDate] = useState("");
  const [ptcOnFile, setPtcOnFile] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [assignedTo, setAssignedTo] = useState("Both");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [calls, setCalls] = useState<TimelineItem[]>([]);
  const [touchOutcome, setTouchOutcome] = useState(TOUCH_OUTCOMES[0]);
  const [exitReason, setExitReason] = useState(EXIT_REASONS[0]);
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [showActionPlanner, setShowActionPlanner] = useState(false);

  // Escape closes the drawer, matching the backdrop click.
  useEffect(() => {
    if (!lead) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id]);

  useEffect(() => {
    if (lead) {
      setStatus(lead.status || "");
      setStageBucket(lead.stage_bucket || "");
      setFollowUp(lead.next_follow_up_date || "");
      setFollowUpNote(lead.next_follow_up_note || "");
      setIdentity(identityFromLead(lead));
      // Open the details automatically on a record somebody flagged as wrong.
      // That flag IS a request to come here and fix something.
      setShowIdentity(needsInfo(lead));
      setAppt(lead.appointment_datetime ? toLocalInput(lead.appointment_datetime) : "");
      setSoaOnFile(!!lead.soa_on_file);
      setSoaDate(lead.soa_date || "");
      setPtcOnFile(!!lead.ptc_on_file);
      setTags(lead.tags || []);
      setTagInput("");
      setAssignedTo(lead.assigned_to || "Both");
      setNotes(lead.raw_notes || lead.notes || "");
      setErr(null);
      setActivity(null);
      setTouchOutcome(TOUCH_OUTCOMES[0]);
      setExitReason(EXIT_REASONS[0]);
      setEnrollSeqId("");
      setShowActionPlanner(false);
      fetchActivity(lead.id)
        .then(setActivity)
        .catch(() => setActivity([]));
      setCalls([]);
      supabase
        .from("calls")
        .select("id, agent, answered, duration_seconds, status, started_at, disposition")
        .eq("lead_id", lead.id)
        .order("started_at", { ascending: false })
        .limit(50)
        .then(({ data }) => setCalls((data || []).map(callToTimeline)));
      if (templates.length === 0) fetchTemplates().then(setTemplates).catch(() => {});
    }
    // Keyed on the ID, never the object.
    //
    // LeadPanel re-resolves the lead from the live book on every render, so
    // `lead` is a NEW object every time the book reloads — and the book
    // reloads on a 1.5s debounce whenever either agent touches any lead, via
    // the realtime channel. Depending on the object meant this effect refired
    // and reset every field: Will typing a note in the drawer would have it
    // wiped the moment Christian logged a call on someone else entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id]);

  // Every number in the book except this lead's own, so retyping a phone can
  // warn you before it creates the duplicate somebody has to merge later.
  const takenPhones = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) {
      if (lead && l.id === lead.id) continue;
      const p = canonicalPhone(l.phone);
      if (p) set.add(p);
      const p2 = canonicalPhone(l.phone2);
      if (p2) set.add(p2);
    }
    return set;
  }, [leads, lead]);

  if (!lead) return null;

  const enr = lead._enr && lead._enr.status === "active" ? lead._enr : null;
  const enrSeq = enr ? sequences.find((s) => s.id === enr.sequence_id) : null;
  const enrSteps = enr ? stepsFor(enr.sequence_id, steps) : [];
  const currStep = enr ? enrSteps.find((s) => s.step_number === enr.current_step) : null;

  async function save() {
    if (!lead) return;
    setSaving(true);
    setErr(null);
    try {
      await updateLead(lead.id, {
        ...identityPatch(identity),
        status: status || null,
        stage_bucket: stageBucket || null,
        next_follow_up_date: followUp || null,
        next_follow_up_note: followUpNote || null,
        appointment_datetime: appt ? new Date(appt).toISOString() : null,
        // Deliberately absent: do_not_call and dnc_reason. Saving an unrelated
        // field must never touch a suppression. They're written by the DNC
        // disposition, by an import, or by the explicit button on the banner.
        soa_on_file: soaOnFile,
        soa_date: soaDate || null,
        ptc_on_file: ptcOnFile,
        tags,
        assigned_to: assignedTo,
        raw_notes: notes || null,
        updated_at: new Date().toISOString(),
      });

      // Note: editing a lead is NOT a contact, so we do not stamp
      // last_contact_date here — that field (and "worked" in Stats) should only
      // move when a dial/disposition/note actually happens.
      const changes: string[] = [];
      if ((lead.status || "") !== status) changes.push(`status → ${status || "cleared"}`);
      if ((lead.stage_bucket || "") !== stageBucket)
        changes.push(`stage → ${stageBucket || "cleared"}`);
      if ((lead.next_follow_up_date || "") !== followUp)
        changes.push(`follow-up → ${followUp || "cleared"}`);
      if ((lead.next_follow_up_note || "") !== followUpNote) changes.push("follow-up note updated");
      // Name it field by field. "details updated" in the timeline is useless
      // six weeks later when you're trying to work out who changed the phone
      // number and why the calls stopped connecting.
      const before = identityFromLead(lead);
      for (const key of Object.keys(identity) as (keyof LeadIdentity)[]) {
        if (before[key].trim() !== identity[key].trim()) {
          changes.push(`${key} → ${identity[key].trim() || "cleared"}`);
        }
      }
      if ((lead.assigned_to || "Both") !== assignedTo) changes.push(`assigned → ${assignedTo}`);
      if ((lead.raw_notes || lead.notes || "") !== notes) changes.push("notes updated");
      if (changes.length) {
        await logActivity(lead.id, "Update", status || null, changes.join(" · "), me);
      }

      if (enr && status && isSequenceExitStatus(status)) {
        await exitEnrollment(enr, `Auto-exit: status changed to ${status}`, me);
      }
      if (status && isSequenceExitStatus(status)) {
        await cancelPendingLeadActions(lead.id, `Status changed to ${status}`, me).catch(() => {});
      }

      await reload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function logDial(phoneUsed: string) {
    if (!lead) return;
    setSaving(true);
    try {
      await updateLead(lead.id, {
        dials_count: (lead.dials_count || 0) + 1,
        last_contact_date: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      });
      await logActivity(lead.id, "Call", "Dial", `Dialed ${phoneUsed}`, me);
      fetchActivity(lead.id).then(setActivity).catch(() => {});
      await reload();
    } catch {
      // dial logging is best-effort; the tel: link already fired
    } finally {
      setSaving(false);
    }
  }

  async function doLogTouch() {
    if (!lead || !enr || !enrSeq) return;
    setSaving(true);
    setErr(null);
    try {
      await logTouch(enr, enrSeq, steps, touchOutcome, me);
      await reload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to log touch");
    } finally {
      setSaving(false);
    }
  }

  async function doExit() {
    if (!lead || !enr) return;
    setSaving(true);
    setErr(null);
    try {
      await exitEnrollment(enr, exitReason, me);
      await reload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to exit sequence");
    } finally {
      setSaving(false);
    }
  }

  async function doEnroll() {
    if (!lead || !enrollSeqId) return;
    const seq = sequences.find((s) => s.id === enrollSeqId);
    if (!seq) return;
    const seqSteps = stepsFor(seq.id, steps);
    if (seqSteps.length === 0) {
      setErr("That sequence has no steps yet. Add steps on the Sequences tab first.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await enrollLeads([lead.id], seq, seqSteps[0], me);
      await reload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to enroll");
    } finally {
      setSaving(false);
    }
  }

  async function addActions(actions: ActionDraft[]) {
    if (!lead) return;
    setSaving(true);
    setErr(null);
    try {
      await createLeadActions(lead.id, actions, me);
      await logActivity(
        lead.id,
        "Action plan",
        "Scheduled",
        actions.map((action) => `${action.action_type} ${action.due_at}`).join(" · "),
        me
      );
      await reload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not schedule actions");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Undo a do-not-call REQUEST. Any bulk scrub underneath stays, because that
   * came from a list and this button has no authority over it — the lead just
   * goes back to being callable like the other 1,831.
   */
  async function clearDncRequest() {
    if (!lead) return;
    setSaving(true);
    setErr(null);
    try {
      const stillScrubbed = onScrubList(lead);
      await updateLead(lead.id, {
        do_not_call: stillScrubbed,
        dnc_reason: stillScrubbed ? "scrubbed" : null,
        updated_at: new Date().toISOString(),
      });
      await logActivity(lead.id, "Update", "Do-not-call request cleared", "Recorded as a misclick", me);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not clear that");
    } finally {
      setSaving(false);
    }
  }

  async function doApptOutcome(key: string) {
    if (!lead) return;
    const o = APPT_OUTCOMES.find((x) => x.key === key);
    if (!o) return;
    setSaving(true);
    setErr(null);
    try {
      await applyApptOutcome(lead, o, me);
      await reload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not log outcome");
    } finally {
      setSaving(false);
    }
  }

  async function finishAction(actionId: string) {
    const action = lead?._actions?.find((item) => item.id === actionId);
    if (!lead || !action) return;
    setSaving(true);
    setErr(null);
    try {
      await completeLeadAction(action, me);
      await logActivity(lead.id, "Action", `${action.action_type} completed`, action.note, me);
      await reload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not complete action");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit lead ${lead.name || "Unnamed"}`}
        className="flex h-full w-full max-w-md flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <div className="flex flex-wrap items-baseline gap-1.5">
              <h2 className="text-base font-semibold text-ink">{lead.name || "Unnamed lead"}</h2>
              {/* Same rule as the dialing screens: the month they turn 65 goes
                  with the name, because there are dial buttons on this panel. */}
              <T65Badge birthday={lead.birthday} showMissing />
            </div>
            {/* Where they are. The import source and row number are plumbing
                and mean nothing on a live call, so they aren't here. */}
            <p className="text-xs text-slate-500">
              {lead.city || "—"}, {lead.state || "NC"}
              {zipOf(lead) ? ` ${zipOf(lead)}` : ""}
              {lead.county ? ` (${lead.county} County)` : ""}
            </p>
            {lead.address && (
              <p className="mt-0.5 text-xs font-medium text-ink">{lead.address}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close editor"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {(askedNotToBeCalled(lead) || lead._dncSuppressed) && (
            <div className="rounded-lg border border-overdue/40 bg-overdue-50 px-3 py-2 text-xs text-overdue">
              <p className="font-semibold">
                {askedNotToBeCalled(lead)
                  ? "This person asked not to be called."
                  : "Someone at this number asked not to be called."}{" "}
                Kept out of every calling queue.
              </p>
              {/* The only way back. Removing the checkbox would otherwise have
                  made a misclicked DNC permanent and unfixable in the UI. */}
              {askedNotToBeCalled(lead) && (
                <button
                  type="button"
                  onClick={clearDncRequest}
                  disabled={saving}
                  className="mt-1.5 rounded-md border border-overdue/40 bg-white px-2.5 py-1 text-[11px] font-medium text-overdue hover:bg-overdue-50 disabled:opacity-50"
                >
                  That was a misclick — allow calls again
                </button>
              )}
            </div>
          )}
          {onScrubList(lead) && (
            <div className="rounded-lg border border-due/40 bg-due-50 px-3 py-2 text-xs text-due">
              <span className="font-semibold">On a DNC list.</span> Flagged by a bulk scrub inherited
              from OSCR, not by anyone here — nobody at this number has asked you to stop, and most
              leads with this flag have never been contacted at all. Stays in the calling queue.
            </div>
          )}
          <div className="flex gap-2">
            {lead.phone && (
              <a
                href={`tel:${lead.phone}`}
                onClick={() => logDial(lead.phone!)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand py-2 text-sm font-medium text-white hover:bg-brand-dark"
              >
                <Phone size={14} /> {formatPhone(lead.phone)}
              </a>
            )}
            {altPhone(lead) && (
              <a
                href={`tel:${altPhone(lead)}`}
                onClick={() => logDial(altPhone(lead)!)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <PhoneCall size={14} /> {altPhone(lead)}
              </a>
            )}
          </div>
          {/* Who they told SmartAsset they were. On a lead that cost money this
              is the whole reason to call, and it should never be buried in the
              notes blob at the bottom of the drawer. */}
          {lead.lead_profile && (
            <div className="rounded-xl border border-brand/30 bg-brand-light/40 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-dark">
                <UserRound size={12} aria-hidden /> What they told SmartAsset
              </p>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-brand-dark">
                {lead.lead_profile}
              </p>
            </div>
          )}

          <p className="text-xs text-slate-400">
            Dials logged: {lead.dials_count ?? 0} · Home value:{" "}
            {lead.home_value ? `$${Number(lead.home_value).toLocaleString()}` : "—"} · Tier:{" "}
            {lead.tier || "—"}
          </p>
          {lead._dupe && (
            <p className="rounded-lg bg-due-50 px-3 py-2 text-xs text-due">
              Another lead shares this phone number. Search the number before dialing so you and
              Will don&apos;t work the same person twice.
            </p>
          )}

          {/* The record itself. Collapsed by default because you usually open a
              lead to work them, not to retype their address — but one tap away,
              and already open if someone flagged the record as wrong. */}
          <div className="rounded-xl border border-line">
            <button
              type="button"
              onClick={() => setShowIdentity((v) => !v)}
              aria-expanded={showIdentity}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left"
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                {showIdentity ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                Contact details
                {identityChanged(identityFromLead(lead), identity) && (
                  <span className="rounded bg-due-50 px-1.5 py-0.5 text-[10px] font-semibold text-due">
                    unsaved
                  </span>
                )}
              </span>
              <span className="text-[11px] text-slate-400">name · phone · DOB · address</span>
            </button>
            {showIdentity && (
              <div className="border-t border-line px-3 py-3">
                {needsInfo(lead) && (
                  <p className="mb-3 rounded-lg bg-due-50 px-3 py-2 text-[11px] text-due">
                    This record was marked wrong info. Correct what&apos;s off, then change the status
                    below off &ldquo;{NEEDS_INFO_STATUS}&rdquo; and it goes straight back into the call
                    and knock queues.
                  </p>
                )}
                <LeadIdentityFields
                  value={identity}
                  onChange={setIdentity}
                  takenPhones={takenPhones}
                />
              </div>
            )}
          </div>

          <SmartCapture
            lead={lead}
            onApplied={async () => {
              await reload();
              onClose();
            }}
          />

          {enr && enrSeq ? (
            <div className="rounded-xl border border-verify/30 bg-verify-50 p-3">
              <p className="text-sm font-semibold text-verify">
                {enrSeq.name}
                {enrSeq.is_draft && (
                  <span className="ml-2 rounded bg-verify px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                    Draft
                  </span>
                )}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Step {enr.current_step} of {enrSteps.length}
                {currStep ? ` · ${currStep.channel}` : ""} · due {enr.next_touch_date || "—"}
              </p>
              {currStep?.instructions && (
                <p className="mt-1 text-xs italic text-slate-500">{currStep.instructions}</p>
              )}
              <div className="mt-2 flex gap-1.5">
                <select
                  value={touchOutcome}
                  onChange={(e) => setTouchOutcome(e.target.value)}
                  className="flex-1 rounded-md border border-line px-2 py-1.5 text-xs"
                >
                  {TOUCH_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                <button
                  onClick={doLogTouch}
                  disabled={saving}
                  className="rounded-md bg-verify px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  Log touch
                </button>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <select
                  value={exitReason}
                  onChange={(e) => setExitReason(e.target.value)}
                  className="flex-1 rounded-md border border-line px-2 py-1.5 text-xs"
                >
                  {EXIT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  onClick={doExit}
                  disabled={saving}
                  className="rounded-md border border-line px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                >
                  Exit sequence
                </button>
              </div>
            </div>
          ) : (
            !(lead.status || "").toLowerCase().startsWith("closed") &&
            sequences.length > 0 && (
              <div className="flex gap-1.5">
                <select
                  value={enrollSeqId}
                  onChange={(e) => setEnrollSeqId(e.target.value)}
                  className="flex-1 rounded-md border border-line px-2 py-1.5 text-xs"
                >
                  <option value="">Enroll in a nurture sequence…</option>
                  {sequences
                    .filter((s) => s.active)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.is_draft ? " (draft)" : ""}
                      </option>
                    ))}
                </select>
                <button
                  onClick={doEnroll}
                  disabled={saving || !enrollSeqId}
                  className="rounded-md border border-line px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  Enroll
                </button>
              </div>
            )
          )}

          <div>
            <label className="block text-xs font-medium text-slate-600">Status</label>
            <input
              list="status-list"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            <datalist id="status-list">
              {STATUS_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {enr && status && isSequenceExitStatus(status) && (
              <p className="mt-1 text-xs text-verify">
                Saving with this status will exit the nurture sequence automatically.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">Stage / bucket</label>
            <input
              list="stage-list"
              value={stageBucket}
              onChange={(e) => setStageBucket(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            <datalist id="stage-list">
              {STAGE_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">Next follow-up date</label>
            <input
              type="date"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            <div className="mt-2 flex gap-1.5">
              {[
                { n: 1, l: "+1d" },
                { n: 3, l: "+3d" },
                { n: 7, l: "+7d" },
                { n: 30, l: "+30d" },
              ].map((b) => (
                <button
                  key={b.n}
                  type="button"
                  onClick={() => setFollowUp(addDays(b.n))}
                  className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  {b.l}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setFollowUp("")}
                className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-400 hover:bg-slate-50"
              >
                Clear
              </button>
            </div>
            <input
              value={followUpNote}
              onChange={(e) => setFollowUpNote(e.target.value)}
              placeholder="Why this date? e.g. wife handles insurance, call after 3pm"
              className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-slate-600">Planned actions</label>
              {!actionsError && !showActionPlanner && (
                <button
                  type="button"
                  onClick={() => setShowActionPlanner(true)}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  Add actions
                </button>
              )}
            </div>
            {actionsError ? (
              <p className="mt-1 text-xs text-due">Action planning is available after the lead-actions database migration is applied.</p>
            ) : (
              <>
                {(lead._actions || []).length === 0 && !showActionPlanner && (
                  <p className="mt-1 text-xs text-slate-400">No planned actions. Add a text, call, mail, or door-knock reminder.</p>
                )}
                {(lead._actions || []).length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {(lead._actions || []).map((action) => (
                      <div key={action.id} className="flex items-center gap-2 rounded-lg bg-brand-light/30 px-3 py-2 text-xs">
                        <span className="font-semibold text-brand-dark">{action.action_type}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-600">
                          {formatActionDue(action.due_at)}{action.note ? ` · ${action.note}` : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => finishAction(action.id)}
                          disabled={saving}
                          className="shrink-0 rounded border border-brand/30 bg-white px-2 py-1 text-[11px] font-medium text-brand-dark hover:bg-brand-light disabled:opacity-50"
                        >
                          Done
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {showActionPlanner && (
                  <div className="mt-2">
                    <ActionPlanner
                      initialActions={[]}
                      onSave={addActions}
                      onCancel={() => setShowActionPlanner(false)}
                      saving={saving}
                      saveLabel="Schedule actions"
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">Appointment</label>
            <input
              type="datetime-local"
              value={appt}
              onChange={(e) => setAppt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            {lead.appointment_datetime && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="self-center text-xs text-slate-500">Outcome:</span>
                {APPT_OUTCOMES.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => doApptOutcome(o.key)}
                    disabled={saving}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-paper/60 p-3">
            <p className="text-xs font-semibold text-slate-600">Compliance</p>
            {/* No do-not-call checkbox. It's set by pressing DNC on a live
                call, which is the only moment anyone actually asks — a tickbox
                in a drawer just invited it to be set by accident. Clearing a
                mistake lives on the banner at the top of this panel. */}
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={ptcOnFile} onChange={(e) => setPtcOnFile(e.target.checked)} />
              Permission to contact on file
            </label>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={soaOnFile} onChange={(e) => setSoaOnFile(e.target.checked)} />
              Scope of Appointment on file
            </label>
            {soaOnFile && (
              <div className="mt-2">
                <label className="block text-[11px] text-slate-500">SOA date</label>
                <input
                  type="date"
                  value={soaDate}
                  onChange={(e) => setSoaDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-line px-3 py-1.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">Tags</label>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-line px-2 py-1.5">
              {tags.map((t) => (
                <span key={t} className="flex items-center gap-1 rounded-full bg-brand-light px-2 py-0.5 text-xs font-medium text-brand-dark">
                  {t}
                  <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} className="text-brand-dark/60 hover:text-overdue">
                    ×
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    const v = tagInput.trim().replace(/,$/, "");
                    if (v && !tags.includes(v)) setTags([...tags, v]);
                    setTagInput("");
                  }
                }}
                placeholder={tags.length ? "add tag" : "add a tag, press Enter"}
                className="min-w-[7rem] flex-1 border-none bg-transparent text-xs outline-none"
              />
            </div>
          </div>

          {templates.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-600">Drop in a script</label>
              <select
                defaultValue=""
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  e.currentTarget.value = "";
                  if (!t) return;
                  const filled = fillTemplate(t.body, {
                    first: (lead.name || "").split(" ")[0] || "there",
                    name: lead.name || "",
                    me,
                    city: lead.city || "",
                  });
                  setNotes(notes ? `${notes}\n\n${filled}` : filled);
                }}
                className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="">Pick a script to drop into notes…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.channel} · {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-600">Assigned to</label>
            <select
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            >
              <option value="Both">Both</option>
              <option value="Christian">Christian</option>
              <option value="Will">Will</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <History size={13} /> Timeline
            </p>
            {activity === null && <p className="text-xs text-slate-400">Loading…</p>}
            {activity !== null && activity.length + calls.length === 0 && (
              <p className="text-xs text-slate-400">
                Nothing logged yet. Dials, dispositions, door knocks, sequence touches, and in-app
                calls will show up here.
              </p>
            )}
            {activity !== null && activity.length + calls.length > 0 && (
              <div className="space-y-2 border-l-2 border-line pl-3">
                {[
                  ...activity.map((a) => ({
                    id: a.id,
                    kind: a.activity_type,
                    outcome: a.outcome,
                    detail: a.notes,
                    date: a.activity_date,
                    by: a.logged_by,
                  })),
                  ...calls,
                ]
                  .sort((x, y) => (y.date || "").localeCompare(x.date || ""))
                  .map((item) => (
                    <div key={item.id}>
                      <p className="text-xs text-ink">
                        <span className="font-medium">{item.kind}</span>
                        {item.outcome ? ` · ${item.outcome}` : ""}
                        <span className="text-slate-400">
                          {" "}
                          · {fmtDateTime(item.date)}
                          {item.by ? ` · ${item.by}` : ""}
                        </span>
                      </p>
                      {item.detail && <p className="text-xs text-slate-500">{item.detail}</p>}
                    </div>
                  ))}
              </div>
            )}
          </div>

          {err && <p className="text-sm text-overdue">{err}</p>}
        </div>

        <div className="border-t border-line px-5 py-4">
          <button
            onClick={() => save()}
            disabled={saving}
            className="w-full rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
