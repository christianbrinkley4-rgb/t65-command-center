"use client";

import { useMemo, useState } from "react";
import { Check, Phone, Play, Undo2 } from "lucide-react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { buildDialQueue, nextDialIndex, type DialQueueEntry } from "@/lib/priority";
import { applyDisposition, DISPOSITIONS, type Disposition } from "@/lib/dispositions";
import { useFilterOrigin } from "@/hooks/useFilterOrigin";
import { emptyFilter, matchesFilter, type LeadFilterState } from "@/lib/leadFilter";
import { householdKey, multiUnitAddressKeys } from "@/lib/knock";
import LeadAddress, { zipOf } from "@/components/LeadAddress";
import LeadFilters from "@/components/LeadFilters";
import { birthMonthLabel, leadLists } from "@/lib/categories";
import { trustedHomeValue } from "@/lib/homeValue";
import { distanceLabel, milesFrom, OFFICE } from "@/lib/distance";
import { otherLeadPhone, formatPhone } from "@/lib/phone";
import { logActivity } from "@/lib/sequences";

export default function AutoDialPage() {
  const { leads, who, me, sequences, steps, worked, markWorked, reload } = useApp();
  const [filter, setFilter] = useState<LeadFilterState>({ ...emptyFilter });
  const [queue, setQueue] = useState<DialQueueEntry[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  const multiUnit = useMemo(() => multiUnitAddressKeys(leads), [leads]);
  const { origin, usingFallback } = useFilterOrigin(filter);

  const preview = useMemo(() => {
    let q = buildDialQueue(leads.filter((lead) => matchesWho(lead, who))).filter((lead) => !worked.has(lead.id));
    return q.filter((lead) => matchesFilter(lead, filter, multiUnit.has(householdKey(lead)), origin));
  }, [leads, multiUnit, origin, who, worked, filter]);

  const queuedEntry = queue[queueIndex];
  const currentLead = queuedEntry ? { ...queuedEntry, ...leads.find((l) => l.id === queuedEntry.id) } : null;

  function dialLeadNow(lead: DialQueueEntry) {
    const leadPhone = lead._queuePhone;
    if (!leadPhone) {
      setMessage(`No callable number on file for ${lead.name || "this lead"}.`);
      return;
    }

    if (leadPhone) {
      logActivity(lead.id, "Call", "Dial", `Dialed ${leadPhone}`, me).catch(() => {});
    }

    setMessage(`Dialing ${lead.name || "lead"} on ${leadPhone}…`);
    window.location.href = `tel:${leadPhone}`;
  }

  function beginQueue() {
    const nextQueue = [...preview];
    setQueue(nextQueue);
    setQueueIndex(0);
    setRunning(true);
    setBusy(false);
    setErr(null);
    setNote("");
    if (nextQueue.length === 0) {
      setMessage("No leads match the current filters.");
      return;
    }

    setMessage("Queue loaded — dialing the first lead.");
    window.setTimeout(() => dialLeadNow(nextQueue[0]), 200);
  }

  async function handleDisposition(d: Disposition) {
    if (!currentLead || busy) return;

    setBusy(true);
    setErr(null);
    try {
      await applyDisposition(currentLead, d, me, sequences, steps, true, note);
      await reload();
      // A connected/finished lead is done; an unanswered first phone leaves
      // the other number next in line.
      const finishLead = ["int", "nr", "ni", "info"].includes(d.key);
      const nextIndex = nextDialIndex(queue, queueIndex, finishLead);
      if (finishLead || !queue.slice(nextIndex).some((l) => l.id === currentLead.id)) markWorked(currentLead.id);
      setQueueIndex(nextIndex);
      setNote("");
      setMessage(`Logged ${d.label}. Moving to the next lead.`);

      if (nextIndex < queue.length) {
        const nextLead = queue[nextIndex];
        window.setTimeout(() => {
          if (nextLead) dialLeadNow(nextLead);
        }, 250);
      } else {
        setRunning(false);
        setMessage(`Logged ${d.label}. The current queue is complete.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Disposition failed.");
    } finally {
      setBusy(false);
    }
  }

  function resetSession() {
    setRunning(false);
    setQueue([]);
    setQueueIndex(0);
    setMessage(null);
    setErr(null);
    setNote("");
    setCopied(false);
  }

  if (!running) {
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="font-display text-2xl font-semibold text-ink">Auto Dial</h1>
        <p className="mt-1 text-sm text-worked">
          Load the same ranked queue as the dial session, then let it call through one phone number at a time. Both numbers stay in the queue, including DNC numbers.
        </p>

        <div className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-card">
          <label className="block text-xs font-medium uppercase tracking-wide text-worked">Who to call</label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-lg border border-line bg-paper px-3 py-1.5 text-xs text-worked">
              {who === "Everyone" ? "Everyone" : `${who}'s queue`}
            </span>
          </div>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-worked">
            Narrow it down
          </label>
          <div className="mt-1">
            <LeadFilters pool={leads} value={filter} onChange={setFilter} />
          </div>
          <p className="mt-1 text-[11px] text-later">
            Same filters as the current queue, using the same ranked dial list from the live leads.
          </p>
          {usingFallback && (
            <p role="status" className="mt-1 text-[11px] text-due">
              Still finding your location — measuring from the office until it lands.
            </p>
          )}

          <p className="mt-4 text-sm text-worked">
            <span className="font-display text-2xl font-semibold text-ink">{preview.length}</span> numbers ready in this queue.
          </p>
          <button
            onClick={beginQueue}
            disabled={preview.length === 0}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3 text-base font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            <Play size={18} /> Go
          </button>
        </div>
      </div>
    );
  }

  if (!currentLead) {
    return (
      <div className="mx-auto max-w-xl text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">Queue complete</h1>
        <p className="mt-2 text-sm text-worked">Everything in the current filter set has been worked.</p>
        <button
          onClick={() => {
            void reload();
            resetSession();
          }}
          className="mt-5 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
        >
          New queue
        </button>
      </div>
    );
  }

  const phase = currentLead._why || [];
  const leadPhone = currentLead._queuePhone;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-night px-4 py-2.5 text-paper">
        <div className="flex items-center gap-4 text-sm tabular-nums">
          <span className="font-display text-lg font-semibold">{queueIndex + 1}/{queue.length}</span>
          <span>Auto dial</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-night-soft">
          <button onClick={resetSession} className="rounded-md border border-night-line px-2 py-1 hover:bg-white/10">
            End
          </button>
        </div>
      </div>

      {message && <p className="mb-3 rounded-lg bg-newlead/10 px-3 py-2 text-xs font-medium text-newlead">{message}</p>}

      <div className="rounded-2xl border border-line bg-white p-6 shadow-lift">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-3xl font-semibold text-ink">{currentLead.name || "Unnamed lead"}</h2>
            <LeadAddress lead={currentLead} className="mt-1 text-sm" size={14} />
            <p className="mt-0.5 text-sm text-worked">
              {zipOf(currentLead) ? `ZIP ${zipOf(currentLead)} · ` : ""}
              {birthMonthLabel(currentLead.birthday) ? `T65 ${birthMonthLabel(currentLead.birthday)}` : ""}{leadLists(currentLead).length ? ` · ${leadLists(currentLead).join(" · ")}` : ""}
              {currentLead.tier ? ` · Tier ${currentLead.tier}` : ""}
              {trustedHomeValue(currentLead) ? ` · $${Math.round(Number(trustedHomeValue(currentLead)) / 1000)}k home` : ""}
              {milesFrom(currentLead, OFFICE) !== null ? ` · ${distanceLabel(milesFrom(currentLead, OFFICE))} out` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {otherLeadPhone(currentLead, currentLead._queuePhone) && (
              <span className="rounded bg-brand px-2 py-0.5 text-[11px] font-bold uppercase text-white">Two numbers</span>
            )}
          </div>
        </div>

        <p className="mt-2 text-xs text-later">Why now: {(phase || []).join(" · ") || "next in line"}</p>

        <div className="mt-4 flex gap-2">
          {leadPhone && (
            <button
              onClick={() => dialLeadNow(currentLead)}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-base font-semibold text-white hover:bg-brand-dark"
            >
              <Phone size={18} /> Call {formatPhone(leadPhone)}
            </button>
          )}
          {otherLeadPhone(currentLead, currentLead._queuePhone) && (
            <button
              onClick={() => {
                const alt = otherLeadPhone(currentLead, currentLead._queuePhone);
                if (!alt) return;
                window.location.href = `tel:${alt}`;
              }}
              className="rounded-xl border border-line px-3 py-3 text-sm font-medium text-worked hover:bg-paper"
            >
              Other
            </button>
          )}
        </div>

        <div className="mt-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="What did they say? Saved with the disposition."
            className="w-full rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
          <div className="mt-1 flex items-center justify-between">
            <p className="text-[11px] text-later">Saved with the outcome so the call timeline stays complete.</p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(note).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }).catch(() => {});
              }}
              className="rounded-md border border-line px-2 py-1 text-[11px] text-worked hover:bg-paper"
            >
              {copied ? <span className="inline-flex items-center gap-1"><Check size={12} /> Copied</span> : "Copy note"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DISPOSITIONS.map((d) => (
            <button
              key={d.key}
              onClick={() => void handleDisposition(d)}
              disabled={busy}
              className={
                d.closes
                  ? "rounded-lg border border-line py-2 text-xs font-medium text-worked hover:bg-paper disabled:opacity-50"
                  : "rounded-lg border border-brand/30 bg-brand/5 py-2 text-xs font-medium text-brand-dark hover:bg-brand hover:text-white disabled:opacity-50"
              }
            >
              {d.label}
            </button>
          ))}
        </div>

        {err && <p className="mt-3 text-sm text-overdue">{err}</p>}
        <div className="mt-3 flex items-center justify-between text-[11px] text-later">
          <span>One tap logs the outcome and dials the next lead.</span>
          <button
            onClick={() => {
              const nextIndex = queueIndex + 1;
              if (nextIndex < queue.length) {
                markWorked(currentLead.id);
                setQueueIndex(nextIndex);
                setMessage("Skipped lead — moving to the next one.");
                window.setTimeout(() => dialLeadNow(queue[nextIndex]), 250);
              } else {
                markWorked(currentLead.id);
                setRunning(false);
                setMessage("Skipped lead — queue complete.");
              }
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 hover:bg-paper"
          >
            <Undo2 size={12} /> Skip
          </button>
        </div>
      </div>
    </div>
  );
}
