"use client";

import { useState } from "react";
import { Sparkles, ArrowRight, RotateCcw } from "lucide-react";
import { useApp } from "@/lib/context";
import { applyCapture, interpret, type CapturePlan } from "@/lib/smartCapture";
import { plusDays, todayStr } from "@/lib/sequences";
import { ACTION_TYPES, ACTION_ASSIGNEES, type ActionAssignee, type ActionType } from "@/lib/types";
import type { LeadWithBucket } from "@/lib/types";

const CLOSING = new Set(["dnc", "not_interested", "sold"]);

function friendlyDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export default function SmartCapture({
  lead,
  onApplied,
}: {
  lead: LeadWithBucket;
  onApplied: () => void;
}) {
  const { me } = useApp();
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<"input" | "review">("input");
  const [plan, setPlan] = useState<CapturePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Editable answers to the "few questions"
  const [dueDate, setDueDate] = useState("");
  const [channel, setChannel] = useState<ActionType>("Call");
  const [assignee, setAssignee] = useState<ActionAssignee>("Either");
  const [applyStatus, setApplyStatus] = useState(true);
  const [apptDatetime, setApptDatetime] = useState("");
  const [noteFinal, setNoteFinal] = useState("");

  async function read() {
    if (!note.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await interpret(note, lead, me);
      setPlan(p);
      setDueDate(p.dueDate);
      setChannel(p.channel);
      setAssignee(p.assignee);
      setNoteFinal(p.note);
      setApplyStatus(true);
      setApptDatetime("");
      setPhase("review");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not read that");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!plan || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await applyCapture(
        lead,
        plan,
        { dueDate, channel, assignee, note: noteFinal, applyStatus, apptDatetime: apptDatetime || undefined },
        me
      );
      reset();
      onApplied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhase("input");
    setPlan(null);
    setNote("");
    setErr(null);
  }

  const closing = plan ? CLOSING.has(plan.intent) : false;

  return (
    <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-brand/[0.07] to-transparent p-4">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-brand-dark">
        <Sparkles size={15} /> Smart Capture
      </p>

      {phase === "input" && (
        <>
          <p className="mt-1 text-xs text-worked">
            Say what happened in plain English. It&apos;ll schedule the follow-up and bring the lead
            back when it&apos;s time.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") read();
            }}
            rows={3}
            placeholder="e.g. Had a good call, wants to follow up in a month or so, potential for the future"
            className="mt-2 w-full rounded-xl border border-line bg-white/70 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          <button
            onClick={read}
            disabled={busy || !note.trim()}
            className="mt-2 flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
          >
            {busy ? "Reading…" : "Read it"}
            {!busy && <ArrowRight size={14} />}
          </button>
        </>
      )}

      {phase === "review" && plan && (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-worked">
            Here&apos;s what I got{plan.source === "ai" ? " (AI)" : ""}. Tweak anything, then
            confirm.
          </p>

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
              When should it come back? {!plan.dateExplicit && <span className="text-due">(guess — pick one)</span>}
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm"
              />
              <span className="text-xs text-worked">{plan.dueLabel}</span>
              {[
                { l: "+1w", n: 7 },
                { l: "+1m", n: 30 },
                { l: "+3m", n: 90 },
              ].map((c) => (
                <button
                  key={c.l}
                  onClick={() => setDueDate(plusDays(todayStr(), c.n))}
                  className="rounded-md border border-line bg-white px-2 py-1 text-xs text-worked hover:border-brand hover:text-brand-dark"
                >
                  {c.l}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-later">Brings back {friendlyDate(dueDate)}.</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
                What&apos;s the move?
              </label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as ActionType)}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm"
              >
                {ACTION_TYPES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
                Who takes it?
              </label>
              <select
                value={assignee}
                onChange={(e) => setAssignee(e.target.value as ActionAssignee)}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm"
              >
                {ACTION_ASSIGNEES.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>

          {plan.intent === "appointment" && (
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
                When&apos;s the appointment?
              </label>
              <input
                type="datetime-local"
                value={apptDatetime}
                onChange={(e) => setApptDatetime(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm"
              />
            </div>
          )}

          {plan.status && (
            <label
              className={
                closing
                  ? "flex items-start gap-2 rounded-lg bg-overdue-50 px-3 py-2 text-xs text-overdue"
                  : "flex items-start gap-2 text-xs text-worked"
              }
            >
              <input
                type="checkbox"
                checked={applyStatus}
                onChange={(e) => setApplyStatus(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Set status to <span className="font-semibold">{plan.status}</span>
                {closing ? " and close this lead" : ""}
                {plan.intent === "dnc" ? " (also flags Do-Not-Call)" : ""}.
              </span>
            </label>
          )}

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
              Note to remember
            </label>
            <textarea
              value={noteFinal}
              onChange={(e) => setNoteFinal(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm"
            />
          </div>

          {err && <p className="text-xs text-overdue">{err}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={confirm}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
            >
              {busy ? "Saving…" : "Confirm & schedule"}
            </button>
            <button
              onClick={reset}
              disabled={busy}
              className="flex items-center gap-1 rounded-xl border border-line px-3 py-2 text-xs text-worked hover:bg-white"
            >
              <RotateCcw size={12} /> Start over
            </button>
          </div>
        </div>
      )}

      {err && phase === "input" && <p className="mt-2 text-xs text-overdue">{err}</p>}
    </div>
  );
}
