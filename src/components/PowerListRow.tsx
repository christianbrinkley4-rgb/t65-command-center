"use client";

import { useState } from "react";
import { Phone, StickyNote, CalendarPlus, DollarSign, MoreHorizontal } from "lucide-react";
import { useApp } from "@/lib/context";
import {
  applyDisposition,
  DISPOSITIONS,
  markSold,
  setAppointment,
  snapshotLead,
  type LeadSnapshot,
} from "@/lib/dispositions";
import { logActivity, plusDays, todayStr } from "@/lib/sequences";
import { scheduleFollowUp } from "@/lib/actions";
import { downloadIcs } from "@/lib/calendar";
import LeadAddress from "@/components/LeadAddress";
import T65Badge from "@/components/T65Badge";
import { homeValueSuspect, trustedHomeValue } from "@/lib/homeValue";
import { effectiveDueDate } from "@/lib/buckets";
import { isFresh, withinCallingHours, type ScoredLead } from "@/lib/priority";
import { askedNotToBeCalled, onScrubList } from "@/lib/types";
import { formatPhone } from "@/lib/phone";
import ContactTrail from "@/components/ContactTrail";

// Short labels for the one-tap call results, in the order agents actually use.
const RESULT_LABEL: Record<string, string> = {
  na: "No answer",
  vm: "Voicemail",
  int: "Interested",
  nr: "Not ready",
  ni: "Not interested",
  bad: "Bad #",
  info: "Wrong info",
  dnc: "DNC",
};

function dueText(lead: ScoredLead): { text: string; tone: string } {
  // The same date the row is SORTED by. Reading only next_follow_up_date and
  // the sequence touch meant a lead whose soonest commitment was a planned
  // action ("Call Tuesday 6:15") sat at the top of the list showing "—" in the
  // Next due column: ranked first, and looking like nothing was owed.
  const d = effectiveDueDate(lead, lead._enr);
  if (!d) {
    if (lead._bucket === "New") return { text: "never dialed", tone: "text-newlead" };
    return { text: "—", tone: "text-later" };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d.slice(0, 10) + "T00:00:00");
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  const label = target.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (diff < 0) return { text: `${label} · ${-diff}d late`, tone: "text-overdue font-semibold" };
  if (diff === 0) return { text: "today", tone: "text-due font-semibold" };
  if (diff <= 7) return { text: `${label} · ${diff}d`, tone: "text-week" };
  return { text: label, tone: "text-later" };
}

export default function PowerListRow({
  lead,
  onDone,
  onOpen,
  sharedAddress = false,
}: {
  lead: ScoredLead;
  onDone: (id: string, snap: LeadSnapshot, name: string) => void;
  onOpen: (lead: ScoredLead) => void;
  /** Several leads at this street address, so a parcel value isn't theirs. */
  sharedAddress?: boolean;
}) {
  const { me, sequences, steps, updateLead } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pane, setPane] = useState<"none" | "note" | "appt">("none");
  const [note, setNote] = useState("");
  const [cbDate, setCbDate] = useState("");
  const [cbTime, setCbTime] = useState("");
  const [apptDt, setApptDt] = useState("");

  // A parcel value we can't attribute to this person is worse than none: it
  // sorts and filters as if it were their house.
  // Everything already done to this lead, from any system, in one line.
  const priorWork = (() => {
    const bits: string[] = [];
    const disp = String(lead.oscr_latest_disp || "").trim();
    if (disp && disp.toLowerCase() !== "no_disposition") bits.push(`OSCR: ${disp}`);
    const when = lead.last_contact_date || lead.oscr_last_disp_date;
    if (when) {
      const d = new Date(String(when).slice(0, 10) + "T00:00:00");
      if (!isNaN(d.getTime())) {
        bits.push(`last worked ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`);
      }
    }
    if ((lead.dials_count || 0) > 0) bits.push(`${lead.dials_count} dials`);
    // Knocks are work too, and until now the only screen that knew about them
    // was Door Knock mode. A lead someone stood in front of twice reads as
    // never-worked here without this.
    if ((lead.knock_count || 0) > 0) {
      const when = lead.last_knock_date
        ? ` ${new Date(String(lead.last_knock_date).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
        : "";
      bits.push(`${lead.knock_count} knock${lead.knock_count === 1 ? "" : "s"}${when}`);
    }
    return bits.join(" · ");
  })();
  const trusted = trustedHomeValue(lead, sharedAddress);
  const suspectValue = homeValueSuspect(lead, sharedAddress);
  const due = dueText(lead);
  const callingOpen = withinCallingHours();
  const dialNum = lead.phone || lead.phone2 || "";

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const snap = snapshotLead(lead);
    try {
      await fn();
      onDone(lead.id, snap, lead.name || "lead");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  }

  const disp = (key: string) => {
    const d = DISPOSITIONS.find((x) => x.key === key);
    if (d) run(() => applyDisposition(lead, d, me, sequences, steps));
  };

  async function saveNote() {
    if (busy) return;
    if (!cbDate && !note.trim()) {
      setPane("none");
      return;
    }
    // A bare note (no callback date) is not a "next step" — save it but keep the
    // lead visible; it's still due today. Only a callback date reschedules and
    // drops it from today's list.
    // A time turns a callback into a real appointment with yourself: the action
    // carries the exact moment, so the lead surfaces at 6:15 rather than
    // sitting in Tuesday's pile all day.
    if (cbDate && cbTime) {
      run(async () => {
        await scheduleFollowUp({
          leadId: lead.id,
          leadLabel: lead.name || "lead",
          when: `${cbDate}T${cbTime}`,
          actionType: "Call",
          note,
          assignee: me === "Will" ? "Will" : "Christian",
          me,
          extraLeadPatch: {
            last_contact_date: todayStr(),
            ...(note.trim()
              ? {
                  raw_notes: `${lead.raw_notes ? lead.raw_notes + "\n" : ""}[${todayStr()}] ${note.trim()}`,
                  ...(!lead.status || lead.status === "New" ? { status: "Worked - Follow Up" } : {}),
                }
              : {}),
          },
        });
      });
      return;
    }
    if (cbDate) {
      run(async () => {
        const patch: Record<string, unknown> = {
          next_follow_up_date: cbDate,
          last_contact_date: todayStr(),
          updated_at: new Date().toISOString(),
        };
        if (note.trim()) {
          patch.next_follow_up_note = note.trim();
          patch.raw_notes = `${lead.raw_notes ? lead.raw_notes + "\n" : ""}[${todayStr()}] ${note.trim()}`;
          if (!lead.status || lead.status === "New") patch.status = "Worked - Follow Up";
        }
        await updateLead(lead.id, patch);
        await logActivity(lead.id, "Note", `Callback ${cbDate}`, note.trim() || null, me);
      });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await updateLead(lead.id, {
        next_follow_up_note: note.trim(),
        raw_notes: `${lead.raw_notes ? lead.raw_notes + "\n" : ""}[${todayStr()}] ${note.trim()}`,
        updated_at: new Date().toISOString(),
      });
      await logActivity(lead.id, "Note", "Note", note.trim(), me);
      setPane("none");
      setNote("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  function bookAppt() {
    if (!apptDt) return;
    if (!lead.soa_on_file && !confirm(
      "No Scope of Appointment on file. CMS requires an SOA before an MA/PDP sales appointment. Set the appointment anyway?"
    )) return;
    run(() => setAppointment(lead, apptDt, me));
  }

  const call = (phone: string) => {
    logActivity(lead.id, "Call", "Dial", `Dialed ${phone}`, me).catch(() => {});
  };

  return (
    <div className="border-b border-line last:border-b-0 hover:bg-paper/40">
      <div className="grid grid-cols-1 gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1.7fr)_138px_minmax(0,1fr)_92px] sm:items-center sm:gap-3">
        {/* Lead */}
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-ink">{lead.name || "Unnamed"}</span>
            {isFresh(lead) && (
              <span className="rounded bg-brand px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">New</span>
            )}
            <T65Badge birthday={lead.birthday} />
            {lead._dupe && (
              <span className="rounded bg-due-50 px-1.5 py-0.5 text-[10px] font-semibold text-due">
                dupe
              </span>
            )}
            {/* Two different facts, two different chips. Red means a person
                asked; amber means a list said so and nobody asked. */}
            {askedNotToBeCalled(lead) && (
              <span
                className="rounded bg-overdue px-1.5 py-0.5 text-[10px] font-bold uppercase text-white"
                title="This person asked not to be called"
              >
                asked to stop
              </span>
            )}
            {onScrubList(lead) && (
              <span
                className="rounded bg-due-50 px-1.5 py-0.5 text-[10px] font-semibold text-due"
                title="Flagged by a bulk list scrub, not by the person. Nobody asked."
              >
                DNC list
              </span>
            )}
            {/* The door's own compliance flag. Nothing to do with the phone:
                a phone-DNC lead is often the best door to knock, and this one
                is the reverse of that. */}
            {lead.do_not_knock && (
              <span
                className="rounded bg-due-50 px-1.5 py-0.5 text-[10px] font-semibold text-due"
                title="Asked us not to come back to the door. Their phone is a separate question."
              >
                do not knock
              </span>
            )}
            {(lead.tags || []).slice(0, 3).map((t) => (
              <span key={t} className="rounded border border-line bg-paper px-1.5 py-0.5 text-[10px] text-worked">
                {t}
              </span>
            ))}
          </p>
          {/* Address on the row you dial from, so you know where they are
              without opening anything. */}
          <LeadAddress lead={lead} className="text-xs" size={11} />
          <ContactTrail lead={lead} size="xs" className="mt-0.5" />
          <p className="truncate text-xs text-later">
            {[
              trusted ? `$${Math.round(trusted / 1000)}k` : "",
              suspectValue ? `${suspectValue}, no home value` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        {/* Phone (tap to call) */}
        <div>
          {dialNum ? (
            callingOpen ? (
              <a
                href={`tel:${dialNum}`}
                onClick={() => call(dialNum)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs font-semibold text-brand-dark transition hover:bg-brand hover:text-white"
              >
                <Phone size={12} /> {formatPhone(dialNum)}
              </a>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-later"
                title="Outside the 8am–9pm calling window"
              >
                <Phone size={12} /> {formatPhone(dialNum)}
              </span>
            )
          ) : (
            <span className="text-xs text-later">no phone</span>
          )}
        </div>

        {/* Status, plus what happened before this CRM existed. An outcome with
            no date can't be ranked, so the date is worth the pixels. */}
        <div className="min-w-0">
          <p className="truncate text-xs text-worked">{lead.status || "New"}</p>
          {priorWork && <p className="truncate text-[11px] text-later">{priorWork}</p>}
        </div>

        {/* Due, or the appointment itself when there is one */}
        <div className="sm:text-right">
          {lead.appointment_datetime ? (
            <>
              <p className="text-xs font-semibold text-newlead">
                {new Date(lead.appointment_datetime).toLocaleString(undefined, {
                  weekday: "short", month: "short", day: "numeric",
                  hour: "numeric", minute: "2-digit",
                })}
              </p>
              <button
                onClick={() => downloadIcs(lead)}
                title="Download the .ics — opens straight into Outlook with the phone, address and notes"
                className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-worked hover:bg-paper"
              >
                <CalendarPlus size={10} /> Outlook
              </button>
            </>
          ) : (
            <p className={`text-xs ${due.tone}`}>{due.text}</p>
          )}
        </div>
      </div>

      {/* One-tap results */}
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2.5">
        {DISPOSITIONS.map((d) => (
          <button
            key={d.key}
            onClick={() => disp(d.key)}
            disabled={busy || !callingOpen}
            title={!callingOpen ? "Call results are disabled outside 8am–9pm" : undefined}
            className={
              // "Wrong info" isn't a close, but it isn't progress either —
              // it shouldn't sit there looking like an outcome you want.
              d.closes || d.key === "info"
                ? "rounded-md border border-line px-2 py-1 text-[11px] font-medium text-worked transition hover:border-overdue hover:bg-overdue-50 hover:text-overdue disabled:opacity-50"
                : "rounded-md border border-brand/25 bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand-dark transition hover:bg-brand hover:text-white disabled:opacity-50"
            }
          >
            {RESULT_LABEL[d.key]}
          </button>
        ))}

        <span className="mx-0.5 h-4 w-px bg-line" />

        <button
          onClick={() => setPane(pane === "note" ? "none" : "note")}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-worked transition hover:bg-paper disabled:opacity-50"
        >
          <StickyNote size={11} /> Note / callback
        </button>
        <button
          onClick={() => setPane(pane === "appt" ? "none" : "appt")}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-newlead/40 px-2 py-1 text-[11px] font-medium text-newlead transition hover:bg-newlead/10 disabled:opacity-50"
        >
          <CalendarPlus size={11} /> Appt
        </button>
        <button
          onClick={() => run(() => markSold(lead, me))}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-newlead/40 px-2 py-1 text-[11px] font-medium text-newlead transition hover:bg-newlead/10 disabled:opacity-50"
        >
          <DollarSign size={11} /> Sold
        </button>
        <button
          onClick={() => onOpen(lead)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-later transition hover:text-ink"
          title="Open full editor (notes history, sequence, Smart Capture)"
        >
          <MoreHorizontal size={13} />
        </button>
        {err && <span className="text-[11px] text-overdue">{err}</span>}
      </div>

      {pane === "note" && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-paper/50 px-3 py-2.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="min-w-[10rem] flex-1 rounded-md border border-line bg-white px-2.5 py-1.5 text-xs outline-none focus:border-brand"
          />
          <input
            type="date"
            value={cbDate}
            onChange={(e) => setCbDate(e.target.value)}
            aria-label="Callback date"
            className="rounded-md border border-line bg-white px-2 py-1.5 text-xs"
          />
          <input
            type="time"
            value={cbTime}
            onChange={(e) => setCbTime(e.target.value)}
            aria-label="Callback time (optional)"
            title="Optional — a time makes this a scheduled task that comes up at that hour"
            className="rounded-md border border-line bg-white px-2 py-1.5 text-xs"
          />
          {[
            { l: "+2d", n: 2 },
            { l: "+1w", n: 7 },
            { l: "+1m", n: 30 },
          ].map((c) => (
            <button
              key={c.l}
              onClick={() => setCbDate(plusDays(todayStr(), c.n))}
              className="rounded-md border border-line bg-white px-2 py-1.5 text-[11px] text-worked hover:border-brand hover:text-brand-dark"
            >
              {c.l}
            </button>
          ))}
          <button
            onClick={saveNote}
            disabled={busy}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}

      {pane === "appt" && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-paper/50 px-3 py-2.5">
          <input
            type="datetime-local"
            value={apptDt}
            onChange={(e) => setApptDt(e.target.value)}
            className="rounded-md border border-line bg-white px-2 py-1.5 text-xs"
          />
          <button
            onClick={bookAppt}
            disabled={busy || !apptDt}
            className="rounded-md bg-newlead px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Book appointment
          </button>
        </div>
      )}
    </div>
  );
}
