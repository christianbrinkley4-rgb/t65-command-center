"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Undo2, Focus, RefreshCw, Download, PlayCircle } from "lucide-react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { buildQueue, iepPhase, isFresh, scoreLead, withinCallingHours } from "@/lib/priority";
import { revertLead, type LeadSnapshot } from "@/lib/dispositions";
import { leadsToCsv, deftSalesCsv, downloadCsv } from "@/lib/csv";
import { needsInfo, NEEDS_INFO_STATUS } from "@/lib/types";
import { supabase } from "@/lib/supabaseClient";
import PowerListRow from "@/components/PowerListRow";
import LeadFilters from "@/components/LeadFilters";
import { emptyFilter, matchesFilter, type LeadFilterState } from "@/lib/leadFilter";
import { useFilterOrigin } from "@/hooks/useFilterOrigin";
import { householdKey, multiUnitAddressKeys } from "@/lib/knock";
import EditDrawer from "@/components/EditDrawer";
import SeasonBanner from "@/components/SeasonBanner";
import type { LeadWithBucket } from "@/lib/types";
import type { ScoredLead } from "@/lib/priority";

const PAGE = 40;

const SEGMENTS = [
  { key: "all", label: "All" },
  { key: "fresh", label: "Fresh" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due today" },
  { key: "week", label: "This week" },
  { key: "t65", label: "T65 hot" },
  { key: "new", label: "Never dialed" },
  { key: "appts", label: "Appointments" },
  { key: "apptdue", label: "Needs outcome" },
  { key: "dnc", label: "DNC" },
  { key: "badinfo", label: "Needs info" },
  { key: "oscr", label: "Needs OSCR update" },
] as const;

type SegKey = (typeof SEGMENTS)[number]["key"];

function inSegment(l: ScoredLead, seg: SegKey): boolean {
  switch (seg) {
    case "fresh": return isFresh(l);
    case "overdue": return l._bucket === "Overdue";
    case "today": return l._bucket === "DueToday";
    case "week": return l._bucket === "ThisWeek";
    case "new": return l._bucket === "New";
    case "t65": {
      const p = iepPhase(l.birthday);
      return p === "hot" || p === "birthday" || p === "closing";
    }
    default: return true;
  }
}

export default function PowerListPage() {
  const { leads, leadsLoading, who, me, reload, worked, markWorked, unmarkWorked, clearWorked } = useApp();
  const [lastUndo, setLastUndo] = useState<{ snap: LeadSnapshot; name: string; id: string } | null>(null);
  const [drawerLead, setDrawerLead] = useState<LeadWithBucket | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [undoing, setUndoing] = useState(false);
  const [seg, setSeg] = useState<SegKey>("all");
  const [filter, setFilter] = useState<LeadFilterState>({ ...emptyFilter });

  // Street addresses with enough leads to be a building, not a house — the
  // reason an apartment could carry a seven-figure "home value".
  const multiUnit = useMemo(() => multiUnitAddressKeys(leads), [leads]);
  const sharedAddress = (l: { id: string; address: string | null; city: string | null }) =>
    multiUnit.has(householdKey(l as never));

  // Segment first: which pile am I working. Some piles deliberately bypass
  // buildQueue — a DNC lead, a wrong-info lead or a past appointment is not
  // callable, but you still have to be able to see and export it.
  const preValue = useMemo(() => {
    const scoped = leads.filter((l) => matchesWho(l, who));
    let q: ScoredLead[];
    if (seg === "dnc") {
      q = scoped.filter((l) => l.do_not_call || l._dncSuppressed).map(scoreLead).sort((a, b) => b._score - a._score);
    } else if (seg === "appts") {
      q = scoped
        .filter((l) => l.appointment_datetime && new Date(l.appointment_datetime) >= new Date())
        .map(scoreLead)
        .sort((a, b) => String(a.appointment_datetime).localeCompare(String(b.appointment_datetime)));
    } else if (seg === "apptdue") {
      q = scoped
        .filter(
          (l) =>
            l.appointment_datetime &&
            new Date(l.appointment_datetime) < new Date() &&
            !/held|no-show|sold/i.test(String(l.status || ""))
        )
        .map(scoreLead)
        .sort((a, b) => String(b.appointment_datetime).localeCompare(String(a.appointment_datetime)));
    } else if (seg === "badinfo") {
      q = scoped.filter(needsInfo).map(scoreLead).sort((a, b) => b._score - a._score);
    } else if (seg === "oscr") {
      q = scoped.filter((l) => l.needs_oscr_writeback).map(scoreLead).sort((a, b) => b._score - a._score);
    } else {
      q = buildQueue(scoped);
      if (seg !== "all") q = q.filter((l) => inSegment(l, seg));
    }
    return q.filter((l) => !worked.has(l.id));
  }, [leads, who, worked, seg]);

  // Then the shared filter — the same matcher the Dial Session and the door
  // router use, so "Kernersville, May birthdays, up to $500k" means one thing.
  const { origin } = useFilterOrigin(filter);
  const queue = useMemo(
    () => preValue.filter((l) => matchesFilter(l, filter, sharedAddress(l), origin)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preValue, filter, multiUnit, origin]
  );

  const dueCount = queue.filter((l) => l._score >= 200).length;

  // After you've pushed these results into OSCR, clear the flag in one pass.
  async function markSynced() {
    const ids = queue.map((l) => l.id);
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 200) {
      await supabase
        .from("leads")
        .update({ needs_oscr_writeback: false, oscr_writeback_note: null })
        .in("id", ids.slice(i, i + 200));
    }
    await reload();
  }

  function exportCsv() {
    const name = `t65-${seg}${filter.lists.length ? "-" + filter.lists.join("-") : ""}.csv`;
    downloadCsv(name.replace(/[^\w.-]+/g, "_"), leadsToCsv(queue));
  }

  // The exact import template DeftSales' CSV wizard expects. Remind on every
  // export: these leads have no SMS/email consent — call-only Lead Type.
  function exportDeftSales() {
    const { csv, rows, skipped } = deftSalesCsv(queue);
    if (rows === 0) {
      window.alert("No dialable leads in this view to export.");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`DeftSales_Import_${seg}_${rows}_${stamp}.csv`.replace(/[^\w.-]+/g, "_"), csv);
    window.alert(
      `${rows} leads exported (${skipped} skipped: DNC, no dialable number, or duplicate phone).\n\n` +
        "Import into the call-only OSCR/T65 Lead Type in DeftSales — these leads have no SMS or email consent, so they must never join a campaign with text or email steps."
    );
  }

  function onDone(id: string, snap: LeadSnapshot, name: string) {
    markWorked(id);
    setLastUndo({ snap, name, id });
  }

  async function undo() {
    if (!lastUndo || undoing) return;
    setUndoing(true);
    try {
      await revertLead(lastUndo.snap, me);
      unmarkWorked(lastUndo.id);
      setLastUndo(null);
    } finally {
      setUndoing(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Power List</h1>
          <p className="text-sm text-worked tabular-nums">
            {leadsLoading ? "Loading…" : `${dueCount} due now · ${queue.length.toLocaleString()} to work`}
            {worked.size > 0 ? ` · ${worked.size} worked this session` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {seg === "oscr" && queue.length > 0 && (
            <button
              onClick={markSynced}
              title="Clear the flag once you've entered these results in OSCR"
              className="flex items-center gap-1.5 rounded-lg bg-newlead px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              Mark {queue.length} synced
            </button>
          )}
          <button
            onClick={exportCsv}
            disabled={queue.length === 0}
            title="Download this view as CSV (dialer-ready)"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked hover:bg-paper disabled:opacity-50"
          >
            <Download size={13} /> Export
          </button>
          <button
            onClick={exportDeftSales}
            disabled={queue.length === 0}
            title="Download this view in DeftSales' exact import template (FirstName, LastName, Email, PhoneNumber, ZipCode — E.164 phones, DNC and duplicates removed)"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked hover:bg-paper disabled:opacity-50"
          >
            <Download size={13} /> DeftSales
          </button>
          <button
            onClick={() => {
              clearWorked();
              setLastUndo(null);
              reload();
            }}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked hover:bg-paper"
          >
            <RefreshCw size={13} className={leadsLoading ? "animate-spin" : ""} /> Refresh
          </button>
          <Link
            href="/session/"
            className="flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark"
          >
            <PlayCircle size={14} /> Dial session
          </Link>
          <Link
            href="/next/"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked hover:bg-paper"
          >
            <Focus size={13} /> One at a time
          </Link>
        </div>
      </div>

      <SeasonBanner />

      {/* Which pile, then narrow it. Two decisions instead of twenty controls. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              setSeg(s.key);
              setLimit(PAGE);
            }}
            className={
              seg === s.key
                ? "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                : "rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-worked hover:bg-paper"
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mb-4">
        <LeadFilters
          pool={leads}
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setLimit(PAGE);
          }}
        />
      </div>

      {seg === "appts" && (
        <p className="mb-4 rounded-xl border border-line bg-white px-4 py-2.5 text-sm text-worked">
          Everything still ahead of you, soonest first. Each row has an{" "}
          <strong>Outlook</strong> button that drops the appointment straight into your calendar with
          the phone, address, notes and an hour&apos;s reminder.
        </p>
      )}

      {seg === "apptdue" && (
        <p className="mb-4 rounded-xl border border-due/40 bg-due-50 px-4 py-2.5 text-sm text-due">
          These appointments have already happened and nobody recorded whether they were held. Open
          one and mark Held or No-Show — the show rate on Stats is only worth reading if these get
          answered.
        </p>
      )}

      {seg === "badinfo" && (
        <p className="mb-4 rounded-xl border border-line bg-white px-4 py-2.5 text-sm text-worked">
          Leads someone marked as wrong info — bad address, wrong name, moved, someone else living
          there. They&apos;re held out of the call and knock queues so nobody repeats the trip. Open one,
          fix what&apos;s wrong, and change the status off &ldquo;{NEEDS_INFO_STATUS}&rdquo; to put it back in play.
        </p>
      )}

      {!withinCallingHours() && (
        <p className="mb-4 rounded-xl border border-due/40 bg-due-50 px-4 py-2.5 text-sm text-due">
          Outside the 8am–9pm calling window — dialing and call results are paused. Good time for texts,
          emails, or setting callbacks.
        </p>
      )}

      {lastUndo && (
        <div role="status" className="mb-3 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-2 text-sm shadow-card">
          <span className="text-worked">Logged {lastUndo.name}.</span>
          <button
            onClick={undo}
            disabled={undoing}
            className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-worked hover:bg-paper disabled:opacity-50"
          >
            <Undo2 size={13} /> Undo
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
        <div className="hidden grid-cols-[minmax(0,1.7fr)_138px_minmax(0,1fr)_92px] gap-3 border-b border-line bg-paper/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-later sm:grid">
          <span>Lead</span>
          <span>Phone</span>
          <span>Status</span>
          <span className="text-right">Next due</span>
        </div>

        {queue.slice(0, limit).map((l) => (
          <PowerListRow
            key={l.id}
            lead={l as ScoredLead}
            sharedAddress={sharedAddress(l)}
            onDone={onDone}
            onOpen={(x) => setDrawerLead(x)}
          />
        ))}

        {!leadsLoading && queue.length === 0 && (
          <p className="p-10 text-center text-sm text-later">
            Nothing to work in this view. Try a different segment, or you&apos;re all caught up — nice.
          </p>
        )}
      </div>

      {limit < queue.length && (
        <button
          onClick={() => setLimit((v) => v + PAGE)}
          className="mt-3 w-full rounded-xl border border-line bg-white py-2.5 text-sm text-worked hover:bg-paper"
        >
          Show {Math.min(PAGE, queue.length - limit)} more
        </button>
      )}

      <EditDrawer lead={drawerLead} onClose={() => setDrawerLead(null)} />
    </div>
  );
}
