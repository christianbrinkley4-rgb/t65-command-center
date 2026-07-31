"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Phone, PhoneCall, PhoneOff, Play, Voicemail, SkipForward, Undo2, X, Copy, Check } from "lucide-react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { buildQueue, iepPhase, IEP_LABEL, isFresh, withinCallingHours, scoreLead } from "@/lib/priority";
import {
  applyDisposition,
  DISPOSITIONS,
  markSold,
  setAppointment,
  revertLead,
  snapshotLead,
  type Disposition,
  type LeadSnapshot,
} from "@/lib/dispositions";
import { logActivity } from "@/lib/sequences";
import { fetchTemplates, fillTemplate } from "@/lib/templates";
import { startLine, endLine, dialLead, hangupCall } from "@/lib/telnyx";
import { agentPhone } from "@/lib/agents";
import { altPhone } from "@/lib/phone";
import { useFilterOrigin } from "@/hooks/useFilterOrigin";
import { distanceLabel, milesFrom, OFFICE } from "@/lib/distance";
import { supabase } from "@/lib/supabaseClient";
import LeadAddress, { zipOf } from "@/components/LeadAddress";
import { listLabel } from "@/lib/categories";
import SmartCapture from "@/components/SmartCapture";
import CallHistory from "@/components/CallHistory";
import LeadFilters from "@/components/LeadFilters";
import { emptyFilter, matchesFilter, type LeadFilterState } from "@/lib/leadFilter";
import { householdKey, multiUnitAddressKeys } from "@/lib/knock";
import { trustedHomeValue } from "@/lib/homeValue";
import type { ScoredLead } from "@/lib/priority";
import type { Template } from "@/lib/types";

const SEGMENTS = [
  { key: "all", label: "Everything due" },
  { key: "fresh", label: "Fresh leads" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due today" },
  { key: "week", label: "This week" },
  { key: "followup", label: "Follow-ups" },
  { key: "t65", label: "T65 hot window" },
  { key: "new", label: "Never dialed" },
  { key: "talked", label: "Talked before" },
] as const;
type SegKey = (typeof SEGMENTS)[number]["key"];

const HOTKEY: Record<string, string> = { na: "1", vm: "2", int: "3", nr: "4", ni: "5", bad: "6", dnc: "7", info: "8" };

function inSeg(l: ScoredLead, seg: SegKey): boolean {
  switch (seg) {
    case "fresh": return isFresh(l);
    case "overdue": return l._bucket === "Overdue";
    case "today": return l._bucket === "DueToday";
    case "week": return l._bucket === "ThisWeek";
    // A promise you made: a callback date or a planned action, either way
    // somebody is expecting to hear from you.
    case "followup":
      return Boolean(l.next_follow_up_date) || (l._actions || []).some((a) => a.status === "pending");
    // Someone picked up before. Warmer than a cold list and a different pitch.
    case "talked":
      return /talked|contacted|interested|not ready|callback/i.test(String(l.status || ""));
    case "new": return l._bucket === "New";
    case "t65": { const p = iepPhase(l.birthday); return p === "hot" || p === "birthday" || p === "closing"; }
    default: return true;
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export default function SessionPage() {
  const { leads, who, me, sequences, steps, reload, worked, markWorked, unmarkWorked } = useApp();

  const [seg, setSeg] = useState<SegKey>("all");
  const [filter, setFilter] = useState<LeadFilterState>({ ...emptyFilter });
  const [started, setStarted] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [now, setNow] = useState(0);
  const [counts, setCounts] = useState({ dials: 0, contacts: 0, appts: 0, sold: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastUndo, setLastUndo] = useState<{ snap: LeadSnapshot; name: string; id: string } | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tmplId, setTmplId] = useState("");
  const [copied, setCopied] = useState(false);
  const [apptDt, setApptDt] = useState("");
  const [callMsg, setCallMsg] = useState<string | null>(null);
  const [lineId, setLineId] = useState<string | null>(null);
  const [lineStatus, setLineStatus] = useState<string>("");
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  // How the Call button dials. "phone" = your own handset via a tel: link,
  // which is the default because it needs no carrier config and no waiting on
  // a bridge; "line" is the Telnyx persistent line. Remembered per device.
  const [callMode, setCallMode] = useState<"phone" | "line">("phone");
  // What was actually said on this call. Typed while you talk, saved with the
  // disposition, so the timeline reads like a conversation and not a list of
  // outcomes. Cleared when the next lead comes up.
  const [note, setNote] = useState("");
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("t65-call-mode");
    if (saved === "line" || saved === "phone") setCallMode(saved);
  }, []);
  function chooseCallMode(m: "phone" | "line") {
    setCallMode(m);
    localStorage.setItem("t65-call-mode", m);
    setCallMsg(null);
  }

  useEffect(() => {
    fetchTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Watch the persistent line's status live (starting → active → on_call → ended).
  useEffect(() => {
    if (!lineId) return;
    const ch = supabase
      .channel(`line-${lineId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dial_lines", filter: `id=eq.${lineId}` }, (payload: any) => {
        const s = payload.new?.status || "";
        setLineStatus(s);
        if (s === "ended") setLineId(null);
        if (s === "active") setCurrentCallId(null); // lead call ended, line free
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [lineId]);

  // Session HUD clock.
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [started]);

  // Buildings, so an apartment's parcel value can't put a renter in a
  // "$400k+ homes" calling session.
  const multiUnit = useMemo(() => multiUnitAddressKeys(leads), [leads]);

  const { origin, usingFallback } = useFilterOrigin(filter);

  const preview = useMemo(() => {
    let q = buildQueue(leads.filter((l) => matchesWho(l, who))).filter((l) => !worked.has(l.id));
    if (seg !== "all") q = q.filter((l) => inSeg(l, seg));
    return q.filter((l) => matchesFilter(l, filter, multiUnit.has(householdKey(l)), origin));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, who, worked, seg, filter, multiUnit, origin]);

  const lead = useMemo<ScoredLead | null>(() => {
    if (!started) return null;
    for (let i = idx; i < ids.length; i++) {
      const l = leads.find((x) => x.id === ids[i]);
      if (l) return scoreLead(l);
    }
    return null;
  }, [started, ids, idx, leads]);

  const done = started && !lead;
  const vmTemplate = templates.find((t) => /voicemail/i.test(t.channel) || /voicemail/i.test(t.name));
  const activeTemplate = templates.find((t) => t.id === tmplId) || null;

  function start() {
    const q = preview;
    setIds(q.map((l) => l.id));
    setIdx(0);
    setStartTime(Date.now());
    setNow(Date.now());
    setCounts({ dials: 0, contacts: 0, appts: 0, sold: 0 });
    setStarted(true);
    setLastUndo(null);
    if (!tmplId && templates.length) {
      const opener = templates.find((t) => /opener|call/i.test(t.name) || t.channel === "Call");
      if (opener) setTmplId(opener.id);
    }
  }

  function advance(id: string) {
    // Ending the current lead's call (if one is live) is part of moving on — a
    // disposition or skip hangs up the call and keeps the agent's line open.
    if (currentCallId) {
      void hangupCall(currentCallId);
      setCurrentCallId(null);
    }
    markWorked(id);
    setIdx((i) => i + 1);
    setApptDt("");
    setNote("");
    setCapturing(false);
    setCopied(false);
  }

  async function doDisposition(d: Disposition) {
    if (!lead || busy) return;
    const snap = snapshotLead(lead);
    const name = lead.name || "lead";
    setBusy(true);
    setErr(null);
    try {
      await applyDisposition(lead, d, me, sequences, steps, true, note);
      setCounts((c) => ({
        dials: c.dials + 1,
        contacts: c.contacts + (d.key === "int" || d.key === "nr" ? 1 : 0),
        appts: c.appts,
        sold: c.sold,
      }));
      setLastUndo({ snap, name, id: lead.id });
      advance(lead.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function doAppt() {
    if (!lead || !apptDt || busy) return;
    setBusy(true);
    try {
      await setAppointment(lead, apptDt, me);
      setCounts((c) => ({ ...c, dials: c.dials + 1, contacts: c.contacts + 1, appts: c.appts + 1 }));
      const id = lead.id; setLastUndo({ snap: snapshotLead(lead), name: lead.name || "lead", id });
      advance(id);
    } finally { setBusy(false); }
  }

  async function doSold() {
    if (!lead || busy) return;
    setBusy(true);
    try {
      const snap = snapshotLead(lead); const id = lead.id; const name = lead.name || "lead";
      await markSold(lead, me);
      setCounts((c) => ({ ...c, dials: c.dials + 1, contacts: c.contacts + 1, sold: c.sold + 1 }));
      setLastUndo({ snap, name, id });
      advance(id);
    } finally { setBusy(false); }
  }

  function onDial() {
    if (lead?.phone) logActivity(lead.id, "Call", "Dial", `Dialed ${lead.phone}`, me).catch(() => {});
  }

  async function hangUp() {
    if (currentCallId) {
      await hangupCall(currentCallId);
      setCurrentCallId(null);
    }
    setCallMsg("Call ended — your line is still open. Pick a result, then dial the next.");
    setTimeout(() => setCallMsg(null), 8000);
  }

  async function startCallingLine() {
    const r = await startLine({ agent: me, agentPhone: agentPhone(me) });
    if (!r.configured) {
      setCallMsg("Telnyx isn't set up yet — calls use your device dialer. See TELEPHONY_SETUP.md.");
      return;
    }
    if (r.ok === false || !r.lineId) { setCallMsg("Could not start the line."); return; }
    setLineId(r.lineId);
    setLineStatus("starting");
    setCallMsg(`Your phone ${agentPhone(me)} is ringing — answer once to open your line, then hit Call on each lead.`);
  }

  async function endCallingLine() {
    if (lineId) await endLine(lineId);
    setLineId(null);
    setLineStatus("");
  }

  // `alt` dials the second number. Merging duplicates put a lot of real second
  // numbers on the book (same person, two lines from two different lists), and
  // a no-answer on the cell is often a pickup on the landline. Reaching it has
  // to be one tap, not a trip through the drawer.
  async function bridgeCall(alt = false) {
    if (!lead) return;
    const leadPhone = (alt ? altPhone(lead) : lead.phone) || lead.phone || altPhone(lead) || "";
    if (!leadPhone) return;
    const first = (lead.name || "the lead").split(" ")[0];
    onDial();

    // Your own phone: hand off to the handset immediately. No edge function,
    // no round trip, no waiting to find out Telnyx is switched off — the dial
    // is still logged, which is the part that matters for the history.
    if (callMode === "phone") {
      window.location.href = `tel:${leadPhone}`;
      return;
    }

    // Preferred path: dial the lead into the agent's open line.
    if (lineId) {
      if (lineStatus === "starting") {
        setCallMsg("Answer your phone first to open the line, then hit Call.");
        return;
      }
      const r = await dialLead({ leadId: lead.id, leadPhone, agent: me, lineId });
      if (r.ok === false) {
        setCallMsg(r.error === "line_not_ready" ? "Line isn't ready yet — answer your phone." : "Dial failed.");
        return;
      }
      if (r.callId) setCurrentCallId(r.callId);
      setCallMsg(`Dialing ${first} on ${r.from}… they'll drop into your line when they pick up.`);
      setTimeout(() => setCallMsg(null), 12000);
      return;
    }

    // No open line: one-shot bridge, falling back to the device dialer if Telnyx is off.
    const r = await dialLead({ leadId: lead.id, leadPhone, agent: me, agentPhone: agentPhone(me) });
    if (!r.configured || r.ok === false) {
      window.location.href = `tel:${leadPhone}`;
      return;
    }
    setCallMsg(`Ringing your phone ${r.agentPhone} — pick up and we'll connect ${first} on ${r.from}.`);
    setTimeout(() => setCallMsg(null), 12000);
  }

  function dropVoicemail() {
    if (!lead) return;
    const body = vmTemplate
      ? fillTemplate(vmTemplate.body, { first: (lead.name || "").split(" ")[0] || "there", name: lead.name || "", me, city: lead.city || "" })
      : `Hi ${(lead.name || "").split(" ")[0] || "there"}, this is ${me} in Greensboro about your Medicare options for turning 65. Give me a call back when you get a chance. Thanks!`;
    navigator.clipboard.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
    const vm = DISPOSITIONS.find((d) => d.key === "vm");
    if (vm) doDisposition(vm);
  }

  async function undo() {
    if (!lastUndo || busy) return;
    setBusy(true);
    try {
      await revertLead(lastUndo.snap, me);
      unmarkWorked(lastUndo.id);
      // step back so the reverted lead is shown again
      setIdx((i) => Math.max(0, i - 1));
      setLastUndo(null);
    } finally { setBusy(false); }
  }

  // Keyboard-first controls.
  useEffect(() => {
    if (!started) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      const k = e.key.toLowerCase();
      if (k === "u") { if (lastUndo) { e.preventDefault(); void undo(); } return; }
      if (!lead || busy) return;
      if (k >= "1" && k <= "8") { const d = DISPOSITIONS[Number(k) - 1]; if (d) { e.preventDefault(); void doDisposition(d); } }
      else if (k === "c") { e.preventDefault(); void bridgeCall(); }
      else if (k === "h") { e.preventDefault(); void hangUp(); }
      else if (k === "v") { e.preventDefault(); dropVoicemail(); }
      else if (k === "s") { e.preventDefault(); void doSold(); }
      else if (k === "n") {
        // N = note. Skip moved to X alone; typing a note is more common than
        // skipping, and losing what a prospect just said is unrecoverable.
        e.preventDefault();
        document.getElementById("call-note")?.focus();
      }
      else if (k === "x") { e.preventDefault(); if (lead) advance(lead.id); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, lead, busy, lastUndo]);

  // ---- Setup screen ----
  if (!started) {
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="font-display text-2xl font-semibold text-ink">Dial Session</h1>
        <p className="mt-1 text-sm text-worked">
          Load a list and power through it — one lead at a time, script on screen, one key per
          result, auto-advance. The dial opens your phone/softphone; everything else is one tap.
        </p>

        <div className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-card">
          <label className="block text-xs font-medium uppercase tracking-wide text-worked">Who to call</label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SEGMENTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSeg(s.key)}
                className={
                  seg === s.key
                    ? "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                    : "rounded-lg border border-line px-3 py-1.5 text-xs text-worked hover:bg-paper"
                }
              >
                {s.label}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-worked">
            Narrow it down
          </label>
          <div className="mt-1">
            <LeadFilters pool={leads} value={filter} onChange={setFilter} />
          </div>
          <p className="mt-1 text-[11px] text-later">
            Towns, ZIPs, list, the month they turn 65, home value, how far out they are. Same filters
            as a door route, so you can build a calling session the same way you build a walk.
          </p>
          {usingFallback && (
            <p role="status" className="mt-1 text-[11px] text-due">
              Still finding your location — measuring from the office until it lands.
            </p>
          )}

          {templates.length > 0 && (
            <>
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-worked">Opening script (optional)</label>
              <select
                value={tmplId}
                onChange={(e) => setTmplId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm"
              >
                <option value="">No script</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.channel} · {t.name}</option>
                ))}
              </select>
            </>
          )}

          <p className="mt-4 text-sm text-worked">
            <span className="font-display text-2xl font-semibold text-ink">{preview.length}</span> leads ready in this session.
          </p>
          <button
            onClick={start}
            disabled={preview.length === 0}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3 text-base font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            <Play size={18} /> Start session
          </button>
          {!withinCallingHours() && (
            <p className="mt-3 text-xs text-due">Heads up: it&apos;s outside the 8am–9pm calling window.</p>
          )}
        </div>
      </div>
    );
  }

  // ---- Session complete ----
  if (done) {
    return (
      <div className="mx-auto max-w-xl text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">Session done</h1>
        <p className="mt-1 text-sm text-worked">Nice work. Here&apos;s how it went.</p>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { l: "Dials", v: counts.dials },
            { l: "Conversations", v: counts.contacts },
            { l: "Appointments", v: counts.appts },
            { l: "Sold", v: counts.sold },
          ].map((s) => (
            <div key={s.l} className="rounded-2xl border border-line bg-white p-4 shadow-card">
              <p className="font-display text-3xl font-semibold text-ink">{s.v}</p>
              <p className="text-xs text-worked">{s.l}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-sm text-worked">Time: {fmtElapsed(now - startTime)}</p>
        <button
          onClick={() => setStarted(false)}
          className="mt-5 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
        >
          New session
        </button>
      </div>
    );
  }

  // ---- Active session ----
  const phase = lead ? iepPhase(lead.birthday) : null;
  const filledScript =
    activeTemplate && lead
      ? fillTemplate(activeTemplate.body, { first: (lead.name || "").split(" ")[0] || "there", name: lead.name || "", me, city: lead.city || "" })
      : null;

  return (
    <div className="mx-auto max-w-2xl">
      {/* HUD */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-night px-4 py-2.5 text-paper">
        <div className="flex items-center gap-4 text-sm tabular-nums">
          <span className="font-display text-lg font-semibold">{fmtElapsed(now - startTime)}</span>
          <span>{counts.dials} dials</span>
          <span className="text-newlead">{counts.contacts} talks</span>
          <span className="text-week">{counts.appts} appts</span>
          <span className="text-brand">{counts.sold} sold</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-night-soft">
          <span>{ids.length - idx} left</span>
          <button onClick={() => setStarted(false)} className="flex items-center gap-1 rounded-md border border-night-line px-2 py-1 hover:bg-white/10">
            <X size={12} /> End
          </button>
        </div>
      </div>

      {callMode === "phone" ? (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-2 text-sm shadow-card">
          <span className="text-worked">
            Calling from your own phone. Tap Call and your handset dials; the result still logs here.
          </span>
          <button
            onClick={() => chooseCallMode("line")}
            className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-worked hover:bg-paper"
          >
            Use the Telnyx line
          </button>
        </div>
      ) : (
      <div className="mb-3 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-2 text-sm shadow-card">
        <span className="text-worked">
          {lineStatus === "" && "Calls ring your phone per lead (or use your device dialer). Open a line to answer once and stay on."}
          {lineStatus === "starting" && "Line starting — answer your phone to open it."}
          {lineStatus === "active" && "Line is live — hit Call on each lead to dial them into your line."}
          {lineStatus === "on_call" && "On a call. Disposition to free the line for the next dial."}
        </span>
        {lineId ? (
          <button onClick={endCallingLine} className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-worked hover:bg-paper">
            End line
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <button onClick={startCallingLine} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-dark">
              Start calling line
            </button>
            <button onClick={() => chooseCallMode("phone")} className="rounded-md border border-line px-2.5 py-1 text-xs text-worked hover:bg-paper">
              Use my phone
            </button>
          </div>
        )}
      </div>
      )}

      {lastUndo && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-2 text-sm shadow-card">
          <span className="text-worked">Logged {lastUndo.name}.</span>
          <button onClick={undo} disabled={busy} className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-worked hover:bg-paper disabled:opacity-50">
            <Undo2 size={13} /> Undo (U)
          </button>
        </div>
      )}

      {lead && (
        <div className="rounded-2xl border border-line bg-white p-6 shadow-lift">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-3xl font-semibold text-ink">{lead.name || "Unnamed lead"}</h2>
              {/* Address up top: you need it before you talk, not after. */}
              <LeadAddress lead={lead} className="mt-1 text-sm" size={14} />
              <p className="mt-0.5 text-sm text-worked">
                {zipOf(lead) ? `ZIP ${zipOf(lead)} · ` : ""}
                {listLabel(lead.source)}
                {lead.tier ? ` · Tier ${lead.tier}` : ""}
                {trustedHomeValue(lead) ? ` · $${Math.round(Number(trustedHomeValue(lead)) / 1000)}k home` : ""}
                {/* How far you'd be driving if this call books. Worth knowing
                    before you offer a time, not after. */}
                {milesFrom(lead, OFFICE) !== null
                  ? ` · ${distanceLabel(milesFrom(lead, OFFICE))} out`
                  : ""}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {isFresh(lead) && <span className="rounded bg-brand px-2 py-0.5 text-[11px] font-bold uppercase text-white">New</span>}
              {phase && phase !== "outside" && <span className="rounded bg-newlead px-2 py-0.5 text-[11px] font-semibold text-white">{IEP_LABEL[phase]}</span>}
            </div>
          </div>

          <p className="mt-2 text-xs text-later">Why now: {(lead._why || []).join(" · ") || "next in line"}</p>

          {filledScript && (
            <div className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl bg-paper px-4 py-3 text-sm text-slate-700">
              {filledScript}
            </div>
          )}
          {templates.length > 0 && (
            <select
              value={tmplId}
              onChange={(e) => setTmplId(e.target.value)}
              className="mt-2 w-full rounded-lg border border-line px-2.5 py-1.5 text-xs text-worked"
            >
              <option value="">No script on screen</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.channel} · {t.name}</option>
              ))}
            </select>
          )}

          {/* Call + voicemail */}
          <div className="mt-4 flex gap-2">
            {(lead.phone || lead.phone2) && (
              <button
                onClick={() => bridgeCall()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-base font-semibold text-white hover:bg-brand-dark"
              >
                <Phone size={18} /> Call {lead.phone || lead.phone2} <span className="text-white/60">(C)</span>
              </button>
            )}
            {lead.phone && altPhone(lead) && (
              <button
                onClick={() => bridgeCall(true)}
                title={`Try their other number: ${altPhone(lead)}`}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-line px-3 py-3 text-sm font-medium text-worked hover:bg-paper"
              >
                <PhoneCall size={16} /> 2nd
              </button>
            )}
            <button
              onClick={dropVoicemail}
              disabled={busy}
              title="Copy the voicemail script and log a voicemail"
              className="flex items-center justify-center gap-1.5 rounded-xl border border-line px-4 py-3 text-sm font-medium text-worked hover:bg-paper disabled:opacity-50"
            >
              {copied ? <Check size={16} className="text-newlead" /> : <Voicemail size={16} />} VM <span className="text-later">(V)</span>
            </button>
            {currentCallId && (
              <button
                onClick={hangUp}
                title="Hang up this call, keep your line open"
                className="flex items-center justify-center gap-1.5 rounded-xl bg-overdue px-4 py-3 text-sm font-semibold text-white hover:opacity-90"
              >
                <PhoneOff size={16} /> Hang up <span className="text-white/60">(H)</span>
              </button>
            )}
          </div>
          {callMsg && <p className="mt-2 rounded-lg bg-newlead/10 px-3 py-2 text-xs font-medium text-newlead">{callMsg}</p>}

          <div className="mt-4">
            <CallHistory lead={lead} />
          </div>

          {/* What they said. Above the dispositions on purpose: you type it
              while they're talking, then hit the outcome. */}
          <div className="mt-3">
            <textarea
              id="call-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              // Escape hands the keyboard back, so the number keys work again
              // without reaching for the mouse.
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
              rows={2}
              placeholder="What did they say? Saved with whatever outcome you pick. (N)"
              className="w-full rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            <div className="mt-1 flex items-center justify-between">
              <p className="text-[11px] text-later">
                Goes on the call in the timeline and on the lead. Nothing is overwritten.
              </p>
              <button
                onClick={() => setCapturing((v) => !v)}
                className="rounded-md border border-line px-2 py-1 text-[11px] text-worked hover:bg-paper"
              >
                {capturing ? "Hide Smart Capture" : "Smart Capture"}
              </button>
            </div>
            {/* The full parse: "call him back Tuesday at 6, wife handles it"
                becomes a scheduled, assigned action rather than just text. */}
            {capturing && (
              <div className="mt-2">
                <SmartCapture lead={lead} onApplied={() => { setCapturing(false); void reload(); }} />
              </div>
            )}
          </div>

          {/* Dispositions — one key each, auto-advance */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DISPOSITIONS.map((d) => (
              <button
                key={d.key}
                onClick={() => doDisposition(d)}
                disabled={busy}
                className={
                  d.closes
                    ? "rounded-lg border border-line py-2 text-xs font-medium text-worked hover:bg-paper disabled:opacity-50"
                    : "rounded-lg border border-brand/30 bg-brand/5 py-2 text-xs font-medium text-brand-dark hover:bg-brand hover:text-white disabled:opacity-50"
                }
              >
                <span className="mr-1 text-later">{HOTKEY[d.key]}</span>{d.label}
              </button>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              value={apptDt}
              onChange={(e) => setApptDt(e.target.value)}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs"
            />
            <button onClick={doAppt} disabled={busy || !apptDt} className="rounded-lg border border-newlead/40 px-3 py-1.5 text-xs font-semibold text-newlead hover:bg-newlead/10 disabled:opacity-50">
              Appointment
            </button>
            <button onClick={doSold} disabled={busy} className="rounded-lg border border-newlead/40 px-3 py-1.5 text-xs font-semibold text-newlead hover:bg-newlead/10 disabled:opacity-50">
              Sold <span className="text-later">(S)</span>
            </button>
            <button onClick={() => lead && advance(lead.id)} disabled={busy} className="ml-auto flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs text-worked hover:bg-paper">
              Skip <SkipForward size={12} />
            </button>
          </div>

          {err && <p className="mt-3 text-sm text-overdue">{err}</p>}
          <p className="mt-3 text-center text-[11px] text-later">
            Keys: 1-8 result · N note · V voicemail · S sold · X skip · U undo. Auto-advances after each.
          </p>
        </div>
      )}
    </div>
  );
}
