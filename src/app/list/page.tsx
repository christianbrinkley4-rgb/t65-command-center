"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Undo2, Focus, RefreshCw, Download, PlayCircle, UserRoundPlus } from "lucide-react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { heldBackCounts, withinCallingHours } from "@/lib/priority";
import { buildSegment, findSegment, segmentContext, segmentsFor } from "@/lib/segments";
import { revertLead, type LeadSnapshot } from "@/lib/dispositions";
import { leadsToCsv, deftSalesCsv, downloadCsv } from "@/lib/csv";
import { NEEDS_INFO_STATUS } from "@/lib/types";
import { supabase } from "@/lib/supabaseClient";
import PowerListRow from "@/components/PowerListRow";
import LeadFilters from "@/components/LeadFilters";
import { emptyFilter, matchesFilter, type LeadFilterState } from "@/lib/leadFilter";
import { useFilterOrigin } from "@/hooks/useFilterOrigin";
import { householdKey, multiUnitAddressKeys } from "@/lib/knock";
import LeadPanel from "@/components/LeadPanel";
import NewLeadDialog from "@/components/NewLeadDialog";
import DuplicateGroups from "@/components/DuplicateGroups";
import SeasonBanner from "@/components/SeasonBanner";
import type { LeadWithBucket } from "@/lib/types";
import type { ScoredLead } from "@/lib/priority";

const PAGE = 40;

const SEGMENTS = segmentsFor("list");

export default function PowerListPage() {
  const { leads, leadsLoading, who, me, reload, worked, markWorked, unmarkWorked, clearWorked } = useApp();
  const [lastUndo, setLastUndo] = useState<{ snap: LeadSnapshot; name: string; id: string } | null>(null);
  const [drawerLead, setDrawerLead] = useState<LeadWithBucket | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [undoing, setUndoing] = useState(false);
  const [seg, setSeg] = useState<string>("all");
  const [adding, setAdding] = useState(false);

  // ?seg=dupes opens straight into that pile. This is what makes the Data
  // health panel on Stats an actual control surface instead of a wall of
  // numbers: "104 duplicate phone" is only useful if clicking it takes you
  // somewhere you can do something about it.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("seg");
    if (wanted && SEGMENTS.some((s) => s.key === wanted)) setSeg(wanted);
  }, []);
  const [filter, setFilter] = useState<LeadFilterState>({ ...emptyFilter });

  // Street addresses with enough leads to be a building, not a house — the
  // reason an apartment could carry a seven-figure "home value".
  const multiUnit = useMemo(() => multiUnitAddressKeys(leads), [leads]);
  const sharedAddress = (l: { id: string; address: string | null; city: string | null }) =>
    multiUnit.has(householdKey(l as never));

  // Which pile am I working. Whether a pile runs through the callable queue or
  // reads the whole book is declared in lib/segments.ts, so this screen and the
  // Dial Session can't drift apart about what a segment means.
  const segCtx = useMemo(() => segmentContext(leads), [leads]);
  const currentSegment = findSegment(seg);
  // What the queue is deliberately holding back, so a shrinking list reads as
  // a decision rather than a bug.
  const held = useMemo(
    () => heldBackCounts(leads.filter((l) => matchesWho(l, who))),
    [leads, who]
  );
  const preValue = useMemo(
    () =>
      buildSegment(seg, leads.filter((l) => matchesWho(l, who)), segCtx).filter(
        (l) => !worked.has(l.id)
      ),
    [leads, who, worked, seg, segCtx]
  );

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
            {held.worked > 0 ? ` · ${held.worked} done today` : ""}
            {held.later > 0 ? ` · ${held.later} booked for later` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding(true)}
            title="Type in one person — a referral, someone you met, a name off a Nextdoor thread"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked hover:bg-paper"
          >
            <UserRoundPlus size={13} /> Add lead
          </button>
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

      {/* Every pile says what it is. Three of the twelve used to carry an
          explanation and the other nine left you to infer it from the label —
          "Needs OSCR update" means nothing until someone tells you once. */}
      <p
        className={
          currentSegment.tone === "warn"
            ? "mb-4 rounded-xl border border-due/40 bg-due-50 px-4 py-2.5 text-sm text-due"
            : "mb-4 rounded-xl border border-line bg-white px-4 py-2.5 text-sm text-worked"
        }
      >
        {currentSegment.blurb}
        {seg === "badinfo" && (
          <>
            {" "}
            Fix the details on the card and change the status off{" "}
            <span className="font-medium">&ldquo;{NEEDS_INFO_STATUS}&rdquo;</span> to put it back in play.
          </>
        )}
      </p>

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

      {/* Duplicates aren't a worklist, they're a decision per household — so
          they get their own side-by-side view rather than a row of call
          buttons you'd be pressing on the wrong record half the time. */}
      {seg === "dupes" ? (
        <DuplicateGroups
          leads={queue}
          onOpen={(l) => setDrawerLead(l)}
          onMerged={() => void reload()}
        />
      ) : (
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
      )}

      {seg !== "dupes" && limit < queue.length && (
        <button
          onClick={() => setLimit((v) => v + PAGE)}
          className="mt-3 w-full rounded-xl border border-line bg-white py-2.5 text-sm text-worked hover:bg-paper"
        >
          Show {Math.min(PAGE, queue.length - limit)} more
        </button>
      )}

      <LeadPanel lead={drawerLead} onClose={() => setDrawerLead(null)} />

      {adding && (
        <NewLeadDialog
          onClose={() => setAdding(false)}
          onCreated={(existing) => {
            if (existing) setDrawerLead(existing);
          }}
        />
      )}
    </div>
  );
}
