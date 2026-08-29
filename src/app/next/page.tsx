"use client";

import { useEffect, useMemo, useState } from "react";
import { Phone, PhoneCall, SkipForward, PencilLine, CalendarPlus, DollarSign, Undo2, Sparkles } from "lucide-react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { buildQueue, iepPhase, IEP_LABEL, withinCallingHours } from "@/lib/priority";
import T65Badge from "@/components/T65Badge";
import ContactTrail from "@/components/ContactTrail";
import { applyDisposition, DISPOSITIONS, setAppointment, markSold, revertLead, snapshotLead } from "@/lib/dispositions";
import { logActivity } from "@/lib/sequences";
import { actionBelongsTo, completeLeadAction, createLeadActions, formatActionDue, nextPendingAction, type ActionDraft } from "@/lib/actions";
import LeadPanel from "@/components/LeadPanel";
import ActionPlanner, { actionInDays } from "@/components/ActionPlanner";
import SeasonBanner from "@/components/SeasonBanner";
import LeadAddress, { zipOf } from "@/components/LeadAddress";
import CallHistory from "@/components/CallHistory";
import { trustedHomeValue } from "@/lib/homeValue";
import type { Disposition, LeadSnapshot } from "@/lib/dispositions";
import type { LeadWithBucket } from "@/lib/types";
import { formatPhone } from "@/lib/phone";

// Keyboard hotkeys for power dialing: number keys fire dispositions in the
// order they appear, letters for the rest. Fast path applies the house-default
// follow-up without opening the planner.
const HOTKEY_LABEL: Record<string, string> = { na: "1", vm: "2", int: "3", nr: "4", ni: "5", bad: "6", dnc: "7", info: "8" };

export default function NextUpPage() {
  const { leads, leadsLoading, who, me, sequences, steps, reload, actionsError } = useApp();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [drawerLead, setDrawerLead] = useState<LeadWithBucket | null>(null);
  // "Full editor" must open the editor; everything else opens the card.
  const [drawerMode, setDrawerMode] = useState<"card" | "editor">("card");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAppt, setShowAppt] = useState(false);
  const [apptValue, setApptValue] = useState("");
  const [pendingDisposition, setPendingDisposition] = useState<Disposition | null>(null);
  const [lastUndo, setLastUndo] = useState<{ snap: LeadSnapshot; name: string } | null>(null);

  const queue = useMemo(
    () => buildQueue(leads.filter((l) => matchesWho(l, who))).filter((l) => !skipped.has(l.id)),
    [leads, who, skipped]
  );
  const dueCount = useMemo(() => queue.filter((l) => l._score >= 200).length, [queue]);
  const lead = queue[0] ?? null;

  const enrSeq = lead?._enr ? sequences.find((s) => s.id === lead._enr!.sequence_id) : null;
  const currStep =
    lead?._enr && enrSeq
      ? steps.find(
          (s) => s.sequence_id === enrSeq.id && s.step_number === lead._enr!.current_step
        )
      : null;
  const phase = lead ? iepPhase(lead.birthday) : null;
  const nextAction = lead ? nextPendingAction(lead._actions) : null;

  function resetInline() {
    setShowAppt(false);
    setApptValue("");
    setPendingDisposition(null);
    setErr(null);
  }

  async function saveDisposition(d: Disposition, actions: ActionDraft[] = [], customPlan = false) {
    if (!lead || busy) return;
    const snap = snapshotLead(lead);
    const name = lead.name || "lead";
    setBusy(true);
    setErr(null);
    try {
      await applyDisposition(lead, d, me, sequences, steps, !customPlan);
      // Only complete an action that belongs to me (or is shared) — never close
      // out the other agent's task just because it was the soonest pending one.
      const mineAction = (lead._actions || []).find((a) => a.status === "pending" && actionBelongsTo(a, me));
      if (mineAction) await completeLeadAction(mineAction, me, d.status);
      if (actions.length) await createLeadActions(lead.id, actions, me);
      setLastUndo({ snap, name });
      await reload();
      resetInline();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to log");
      await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  // Fast path used by hotkeys: apply the disposition with its default follow-up,
  // no planner. Closing dispositions always take this path.
  function quickDisposition(d: Disposition) {
    if (!lead || busy) return;
    void saveDisposition(d);
  }

  async function doUndo() {
    if (!lastUndo || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await revertLead(lastUndo.snap, me);
      setLastUndo(null);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setBusy(false);
    }
  }

  function onDisposition(key: string) {
    if (!lead || busy) return;
    const d = DISPOSITIONS.find((x) => x.key === key);
    if (!d) return;
    if (d.closes || actionsError) {
      void saveDisposition(d);
      return;
    }
    setShowAppt(false);
    setPendingDisposition(d);
    setErr(null);
  }

  async function onAppointment() {
    if (!lead || !apptValue || busy) return;
    const snap = snapshotLead(lead);
    const name = lead.name || "lead";
    setBusy(true);
    setErr(null);
    try {
      await setAppointment(lead, apptValue, me);
      setLastUndo({ snap, name });
      await reload();
      resetInline();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to set appointment");
    } finally {
      setBusy(false);
    }
  }

  async function onSold() {
    if (!lead || busy) return;
    const snap = snapshotLead(lead);
    const name = lead.name || "lead";
    setBusy(true);
    setErr(null);
    try {
      await markSold(lead, me);
      setLastUndo({ snap, name });
      await reload();
      resetInline();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to mark sold");
    } finally {
      setBusy(false);
    }
  }

  async function onDial(phoneUsed: string) {
    if (!lead) return;
    try {
      await logActivity(lead.id, "Call", "Dial", `Dialed ${phoneUsed}`, me);
    } catch {
      // best effort, the tel: link already fired
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === "u") {
        if (lastUndo) { e.preventDefault(); void doUndo(); }
        return;
      }
      if (!lead || busy || pendingDisposition || showAppt) return;
      if (k >= "1" && k <= "8") {
        const d = DISPOSITIONS[Number(k) - 1];
        if (d) { e.preventDefault(); quickDisposition(d); }
      } else if (k === "s") {
        e.preventDefault();
        void onSold();
      } else if (k === "a") {
        e.preventDefault();
        resetInline();
        setShowAppt(true);
      } else if (k === "e") {
        e.preventDefault();
        setDrawerMode("editor");
        setDrawerLead(lead);
      } else if (k === "x") {
        e.preventDefault();
        setSkipped((s) => new Set(s).add(lead.id));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead, busy, pendingDisposition, showAppt, lastUndo]);

  if (leadsLoading) {
    return <p className="text-sm text-slate-400">Loading the queue…</p>;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="font-display text-2xl font-semibold text-ink">Next Up</h1>
        <p className="text-sm text-worked tabular-nums">
          {dueCount} due now · {queue.length.toLocaleString()} in queue
        </p>
      </div>

      <SeasonBanner />

      {lastUndo && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-2 text-sm shadow-card">
          <span className="text-slate-500">Last action on {lastUndo.name} logged.</span>
          <button
            onClick={doUndo}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <Undo2 size={13} /> Undo (U)
          </button>
        </div>
      )}

      {!withinCallingHours() && (
        <p className="mb-4 rounded-xl border border-due/40 bg-due-50 px-4 py-3 text-sm text-due">
          Outside the 8am to 9pm calling window. Log texts or emails, or prep for tomorrow.
        </p>
      )}

      {!lead && (
        <p className="rounded-xl border border-dashed border-line bg-white p-10 text-center text-sm text-slate-400">
          Queue is empty for this filter. Switch the who filter or reload.
        </p>
      )}

      {lead && (
        <div className="rounded-2xl border border-line bg-white p-6 shadow-lift">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {/* T65 month sits with the name on every screen you dial from. */}
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-display text-2xl font-semibold text-ink">{lead.name || "Unnamed lead"}</h2>
                <T65Badge birthday={lead.birthday} size="md" showMissing />
                <ContactTrail lead={lead} showEmpty />
              </div>
              <LeadAddress lead={lead} className="mt-1 text-sm" size={14} />
              <p className="mt-0.5 text-sm text-slate-500">
                {[
                  zipOf(lead) ? `ZIP ${zipOf(lead)}` : "",
                  lead.tier ? `Tier ${lead.tier}` : "",
                  trustedHomeValue(lead) ? `$${Number(trustedHomeValue(lead)).toLocaleString()} home` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {phase && phase !== "outside" && (
                <span className="rounded bg-newlead px-2 py-0.5 text-[11px] font-semibold text-white">
                  {IEP_LABEL[phase]}
                </span>
              )}
              {lead._dupe && (
                <span className="rounded bg-due px-2 py-0.5 text-[11px] font-semibold text-white">
                  Duplicate phone
                </span>
              )}
            </div>
          </div>

          <p className="mt-2 text-xs text-slate-400">
            Why now: {(lead._why || []).join(" · ") || "next in line"} · {lead.dials_count || 0}{" "}
            dials so far · status {lead.status || "New"}
          </p>

          <div className="mt-3">
            <CallHistory lead={lead} />
          </div>

          {currStep && (
            <div className="mt-3 rounded-xl bg-verify-50 px-4 py-3">
              <p className="text-xs font-semibold text-verify">
                {enrSeq?.name} · step {lead._enr!.current_step} · {currStep.channel}
              </p>
              {currStep.instructions && (
                <p className="mt-0.5 text-xs text-slate-600">{currStep.instructions}</p>
              )}
            </div>
          )}

          {nextAction && (
            <div className="mt-3 rounded-xl border border-brand/20 bg-brand-light/30 px-4 py-3">
              <p className="text-xs font-semibold text-brand-dark">
                Next planned action · {nextAction.action_type} · {formatActionDue(nextAction.due_at)}
                {nextAction.assigned_to && nextAction.assigned_to !== "Either" ? ` · for ${nextAction.assigned_to}` : ""}
              </p>
              {nextAction.note && <p className="mt-0.5 text-xs text-slate-600">{nextAction.note}</p>}
              {(lead._actions || []).length > 1 && (
                <p className="mt-1 text-xs text-slate-500">
                  Plus {(lead._actions || []).length - 1} more planned action{(lead._actions || []).length === 2 ? "" : "s"}.
                </p>
              )}
            </div>
          )}

          {(lead.raw_notes || lead.notes) && (
            <p className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-xl bg-paper px-4 py-3 text-xs text-slate-600">
              {lead.raw_notes || lead.notes}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            {lead.phone && (
              <a
                href={`tel:${lead.phone}`}
                onClick={() => onDial(lead.phone!)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-base font-semibold text-white hover:bg-brand-dark"
              >
                <Phone size={18} /> {formatPhone(lead.phone)}
              </a>
            )}
            {lead.phone2 && (
              <a
                href={`tel:${lead.phone2}`}
                onClick={() => onDial(lead.phone2!)}
                className="flex items-center justify-center gap-2 rounded-xl border border-line px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <PhoneCall size={16} /> {lead.phone2}
              </a>
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DISPOSITIONS.map((d) => (
              <button
                key={d.key}
                onClick={() => onDisposition(d.key)}
                disabled={busy}
                className={
                  d.closes
                    ? "rounded-lg border border-line py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                    : "rounded-lg border border-brand/30 bg-brand-light/40 py-2 text-xs font-medium text-brand-dark hover:bg-brand-light disabled:opacity-50"
                }
              >
                <span className="mr-1 text-slate-400">{HOTKEY_LABEL[d.key]}</span>
                {d.label}
              </button>
            ))}
            <button
              onClick={() => {
                resetInline();
                setShowAppt(true);
              }}
              disabled={busy}
              className="flex items-center justify-center gap-1 rounded-lg border border-newlead/40 bg-newlead/10 py-2 text-xs font-semibold text-newlead hover:bg-newlead/20 disabled:opacity-50"
            >
              <CalendarPlus size={13} /> Appointment <span className="text-newlead/60">A</span>
            </button>
            <button
              onClick={() => {
                resetInline();
                void onSold();
              }}
              disabled={busy}
              className="flex items-center justify-center gap-1 rounded-lg border border-newlead/40 bg-newlead/10 py-2 text-xs font-semibold text-newlead hover:bg-newlead/20 disabled:opacity-50"
            >
              <DollarSign size={13} /> Sold <span className="text-newlead/60">S</span>
            </button>
          </div>

          <p className="mt-2 text-center text-[11px] text-slate-400">
            Keyboard: 1-8 disposition · A appointment · S sold · E editor · X skip · U undo. Number
            keys apply the default follow-up; click a blue disposition to customize the plan.
          </p>

          {actionsError && (
            <p className="mt-3 rounded-lg bg-due-50 px-3 py-2 text-xs text-due">
              Action planning will be available once the lead-actions database migration is applied.
            </p>
          )}

          {pendingDisposition && !actionsError && (
            <div className="mt-3">
              <ActionPlanner
                initialActions={
                  pendingDisposition.followUpDays === null
                    ? []
                    : [actionInDays("Call", pendingDisposition.followUpDays)]
                }
                onSave={(actions) => saveDisposition(pendingDisposition, actions, true)}
                onCancel={() => setPendingDisposition(null)}
                saving={busy}
                saveLabel={`Log ${pendingDisposition.label} & schedule`}
              />
            </div>
          )}

          {showAppt && (
            <div className="mt-3 flex gap-2">
              <input
                type="datetime-local"
                value={apptValue}
                onChange={(e) => setApptValue(e.target.value)}
                className="flex-1 rounded-lg border border-line px-3 py-2 text-sm"
              />
              <button
                onClick={onAppointment}
                disabled={busy || !apptValue}
                className="rounded-lg bg-newlead px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Book it
              </button>
            </div>
          )}

          {err && <p className="mt-3 text-sm text-overdue">{err}</p>}

          <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setDrawerMode("card"); setDrawerLead(lead); }}
                className="flex items-center gap-1.5 text-xs font-medium text-brand-dark hover:text-brand"
              >
                <Sparkles size={13} /> Capture note
              </button>
              <button
                onClick={() => { setDrawerMode("editor"); setDrawerLead(lead); }}
                className="flex items-center gap-1.5 text-xs text-worked hover:text-ink"
              >
                <PencilLine size={13} /> Full editor
              </button>
            </div>
            <button
              onClick={() => setSkipped((s) => new Set(s).add(lead.id))}
              className="flex items-center gap-1.5 text-xs text-worked hover:text-ink"
            >
              Skip for now <SkipForward size={13} />
            </button>
          </div>
        </div>
      )}

      {queue.length > 1 && (
        <p className="mt-3 text-center text-xs text-slate-400">
          Up next: {queue.slice(1, 4).map((l) => l.name || "Unnamed").join(" · ")}
        </p>
      )}

      <LeadPanel lead={drawerLead} openTo={drawerMode} onClose={() => setDrawerLead(null)} />
    </div>
  );
}
