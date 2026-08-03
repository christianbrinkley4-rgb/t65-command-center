"use client";

// The lead card you get from searching someone up.
//
// It is deliberately the same card you see mid-dial: same header component,
// same history block, same one-tap results. Looking a person up and calling
// them is the same job as working the queue, so it should not be a different
// screen with different information in different places.
//
// What it does NOT carry is the session machinery — no HUD, no auto-advance,
// no skip, no hotkeys. Those belong to a dial session, where you're moving
// through a list. Here you came for one person on purpose.

import { useEffect, useState } from "react";
import { CalendarCheck, Phone, PhoneCall, X } from "lucide-react";
import { useApp } from "@/lib/context";
import { applyApptOutcome, applyDisposition, APPT_OUTCOMES, DISPOSITIONS } from "@/lib/dispositions";
import { awaitingAppointmentOutcome } from "@/lib/priority";
import { formatActionDue, nextPendingAction } from "@/lib/actions";
import { logActivity } from "@/lib/sequences";
import { altPhone } from "@/lib/phone";
import LeadCardHeader from "@/components/LeadCardHeader";
import CallHistory from "@/components/CallHistory";
import SmartCapture from "@/components/SmartCapture";
import type { LeadWithBucket } from "@/lib/types";

export default function LeadCard({
  lead,
  onClose,
  onOpenFullRecord,
}: {
  lead: LeadWithBucket;
  onClose: () => void;
  /** Escape hatch to the editor, for the fields this card deliberately omits. */
  onOpenFullRecord: () => void;
}) {
  const { me, reload, sequences, steps } = useApp();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const second = altPhone(lead);
  const appointment = lead.appointment_datetime ? new Date(lead.appointment_datetime) : null;
  const nextAction = nextPendingAction(lead._actions);
  const needsOutcome = awaitingAppointmentOutcome(lead);

  // Escape closes, matching the backdrop click and the editor behind this.
  // This card replaced the editor as what opens on every screen, and it
  // shipped without the key the editor already had.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function apptOutcome(key: string) {
    const o = APPT_OUTCOMES.find((x) => x.key === key);
    if (!o || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await applyApptOutcome(lead, o, me);
      await reload();
      setMsg(`Logged: appointment ${o.label.toLowerCase()}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save that outcome");
    } finally {
      setBusy(false);
    }
  }

  async function dial(number: string) {
    await logActivity(lead.id, "Call", "Dialed", null, me).catch(() => {});
    window.location.href = `tel:${number}`;
  }

  async function disposition(key: string) {
    const d = DISPOSITIONS.find((x) => x.key === key);
    if (!d || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await applyDisposition(lead, d, me, sequences, steps, true, note.trim() || undefined);
      setNote("");
      await reload();
      setMsg(`Logged: ${d.label}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save that result");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/30 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Lead card for ${lead.name || "unnamed lead"}`}
        className="my-4 w-full max-w-2xl rounded-2xl border border-line bg-white p-6 shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex justify-end">
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
            <X size={18} aria-hidden />
          </button>
        </div>

        <LeadCardHeader lead={lead} size="md" />

        {(lead.do_not_call || lead._dncSuppressed) && (
          <p className="mt-3 rounded-lg border border-overdue/40 bg-overdue-50 px-3 py-2 text-xs font-semibold text-overdue">
            DNC — kept out of the calling queue. Only dial for a real reason.
          </p>
        )}

        {/* A booked appointment is the single most important thing to know
            before the phone connects, and it used to live only in the editor.
            Calling to book someone you're already seeing on Tuesday is the
            fastest way to sound like you don't know your own book. */}
        {appointment && (
          <p className="mt-3 rounded-lg border border-brand/40 bg-brand-light/50 px-3 py-2 text-sm font-semibold text-brand-dark">
            <CalendarCheck size={14} className="mr-1.5 inline" aria-hidden />
            Appointment {appointment >= new Date() ? "booked" : "was"}{" "}
            {appointment.toLocaleString(undefined, {
              weekday: "long", month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit",
            })}
            {lead.soa_on_file === false && appointment >= new Date() ? " · no SOA on file" : ""}
          </p>
        )}

        {/* The appointment has been and gone and nobody said what happened.
            This used to be recordable only from the full editor, two taps
            behind a screen that exists to record what happened — which is why
            appointments sat unresolved for six weeks. */}
        {needsOutcome && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-due/40 bg-due-50 px-3 py-2">
            <span className="text-xs font-semibold text-due">Did this one happen?</span>
            {APPT_OUTCOMES.map((o) => (
              <button
                key={o.key}
                onClick={() => apptOutcome(o.key)}
                disabled={busy}
                className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-due shadow-sm hover:bg-paper disabled:opacity-50"
              >
                {o.label}
              </button>
            ))}
            <span className="text-[11px] text-due/80">
              Until you answer, they&apos;re out of the dial queue.
            </span>
          </div>
        )}

        {nextAction && (
          <p className="mt-2 rounded-lg bg-paper px-3 py-2 text-xs text-worked">
            <span className="font-semibold">Next: {nextAction.action_type}</span>{" "}
            {formatActionDue(nextAction.due_at)}
            {nextAction.note ? ` — ${nextAction.note}` : ""}
          </p>
        )}

        <p className="mt-2 text-xs text-later">
          {lead.status || "New"}
          {lead.dials_count ? ` · ${lead.dials_count} dial${lead.dials_count === 1 ? "" : "s"}` : ""}
          {lead.last_contact_date ? ` · last worked ${lead.last_contact_date}` : ""}
        </p>

        <div className="mt-4 flex gap-2">
          {lead.phone && (
            <button
              onClick={() => dial(lead.phone!)}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-base font-semibold text-white hover:bg-brand-dark"
            >
              <Phone size={18} /> Call {lead.phone}
            </button>
          )}
          {second && (
            <button
              onClick={() => dial(second)}
              title={`Try their other number: ${second}`}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-line px-3 py-3 text-sm font-medium text-worked hover:bg-paper"
            >
              <PhoneCall size={16} /> 2nd
            </button>
          )}
          {!lead.phone && !second && (
            <p className="flex-1 rounded-xl bg-paper px-3 py-3 text-center text-sm text-later">
              No phone on file — this one is a door.
            </p>
          )}
        </div>

        <div className="mt-4">
          <CallHistory lead={lead} limit={8} />
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was said? This rides along on the result and is never overwritten."
          rows={2}
          className="mt-3 w-full rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />

        <div className="mt-2 flex flex-wrap gap-1.5">
          {DISPOSITIONS.map((d) => (
            <button
              key={d.key}
              onClick={() => disposition(d.key)}
              disabled={busy}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-worked hover:bg-paper disabled:opacity-50"
            >
              {d.label}
            </button>
          ))}
        </div>

        {msg && (
          <p role="status" className="mt-2 rounded-lg bg-newlead/10 px-3 py-2 text-xs font-medium text-newlead">
            {msg}
          </p>
        )}

        <div className="mt-4">
          <SmartCapture lead={lead} onApplied={async () => { await reload(); }} />
        </div>

        <button
          onClick={onOpenFullRecord}
          className="mt-4 w-full rounded-lg border border-line py-2 text-xs font-medium text-worked hover:bg-paper"
        >
          Open the full record to edit fields, appointments and tags
        </button>
      </div>
    </div>
  );
}
