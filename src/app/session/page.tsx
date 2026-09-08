"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Phone, PhoneCall, Play, Voicemail, MessageSquare, ShieldCheck, SkipForward, Undo2, X, Copy, Check } from "lucide-react";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { heldBackCounts, iepPhase, withinCallingHours, scoreLead } from "@/lib/priority";
import { buildSegment, findSegment, segmentContext, segmentsFor } from "@/lib/segments";
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
import { altPhone, bestPhone, formatPhone } from "@/lib/phone";
import { canText, grantSmsConsent, logText, smsBody, smsHref, textBlockReason } from "@/lib/sms";
import { useFilterOrigin } from "@/hooks/useFilterOrigin";
import { distanceLabel, milesFrom, OFFICE } from "@/lib/distance";
import LeadAddress, { zipOf } from "@/components/LeadAddress";
import SmartCapture from "@/components/SmartCapture";
import CallHistory from "@/components/CallHistory";
import LeadCardHeader from "@/components/LeadCardHeader";
import LeadFilters from "@/components/LeadFilters";
import { emptyFilter, matchesFilter, type LeadFilterState } from "@/lib/leadFilter";
import { DIALABLE_RESULTS, LEAD_RESULT_OPTIONS, type LeadResult } from "@/lib/callOutcomes";
import { householdKey, multiUnitAddressKeys } from "@/lib/knock";
import { trustedHomeValue } from "@/lib/homeValue";
import type { ScoredLead } from "@/lib/priority";
import type { Template } from "@/lib/types";

// Same definitions the Power List works from — see lib/segments.ts. The Dial
// Session only offers the callable piles, because you can't power-dial a list
// of Do-Not-Call numbers or records nobody has fixed yet.
const SEGMENTS = segmentsFor("session");

const HOTKEY: Record<string, string> = { na: "1", vm: "2", int: "3", nr: "4", ni: "5", bad: "6", dnc: "7", info: "8" };

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export default function SessionPage() {
  const { leads, who, me, sequences, steps, reload, worked, markWorked, unmarkWorked } = useApp();

  const [seg, setSeg] = useState<string>("all");
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
  const [copied, setCopied] = useState(false);
  const [apptDt, setApptDt] = useState("");
  // What was actually said on this call. Typed while you talk, saved with the
  // disposition, so the timeline reads like a conversation and not a list of
  // outcomes. Cleared when the next lead comes up.
  const [note, setNote] = useState("");
  const [capturing, setCapturing] = useState(false);
  // Consent granted during this session, held locally so the Text button turns
  // on the instant they say yes. The write goes to the database too; this is
  // just so the card doesn't wait on a reload mid-call.
  const [consented, setConsented] = useState<Set<string>>(new Set());
  // Leads texted in this session, so the button reads "Texted" and a second
  // tap is an obvious repeat rather than something you do without noticing.
  const [texted, setTexted] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchTemplates().then(setTemplates).catch(() => {});
  }, []);

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

  const segCtx = useMemo(() => segmentContext(leads), [leads]);
  const held = useMemo(
    () => heldBackCounts(leads.filter((l) => matchesWho(l, who))),
    [leads, who]
  );
  const preview = useMemo(
    () =>
      buildSegment(seg, leads.filter((l) => matchesWho(l, who)), segCtx)
        .filter((l) => !worked.has(l.id))
        .filter((l) => matchesFilter(l, filter, multiUnit.has(householdKey(l)), origin)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leads, who, worked, seg, filter, multiUnit, origin, segCtx]
  );

  // Last-result picks the dial queue is going to swallow. See DIALABLE_RESULTS.
  const parkedPicks = useMemo(
    () => filter.results.filter((r) => !DIALABLE_RESULTS.includes(r as LeadResult)),
    [filter.results]
  );

  const lead = useMemo<ScoredLead | null>(() => {
    if (!started) return null;
    for (let i = idx; i < ids.length; i++) {
      const l = leads.find((x) => x.id === ids[i]);
      if (l) return scoreLead(l);
    }
    return null;
  }, [started, ids, idx, leads]);

  const done = started && !lead;
  // Consent read from the book, or from the yes you just heard on this call.
  const hasConsent = Boolean(lead && (canText(lead) || consented.has(lead.id)));
  const textOk = Boolean(lead) && hasConsent && !lead!.do_not_call;
  const textBlock = lead && !textOk ? textBlockReason(lead) : null;
  // Templates are fetched for the voicemail and nothing else now. The opening
  // script that used to sit on the card is gone: it took up the top third of
  // the screen, it was the same words every time, and the person reading it
  // already knows them. What actually needs to be on screen mid-call is who
  // this is, why they came up, and what happened last time.
  const vmTemplate = templates.find((t) => /voicemail/i.test(t.channel) || /voicemail/i.test(t.name));

  function start() {
    const q = preview;
    setIds(q.map((l) => l.id));
    setIdx(0);
    setStartTime(Date.now());
    setNow(Date.now());
    setCounts({ dials: 0, contacts: 0, appts: 0, sold: 0 });
    setStarted(true);
    setLastUndo(null);
  }

  function advance(id: string) {
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
      // Snapshot BEFORE the write, like every other outcome here. Taking it
      // afterwards only worked because setAppointment doesn't reload, which is
      // the kind of thing that stops being true one refactor later.
      const snap = snapshotLead(lead);
      const id = lead.id;
      await setAppointment(lead, apptDt, me);
      setCounts((c) => ({ ...c, dials: c.dials + 1, contacts: c.contacts + 1, appts: c.appts + 1 }));
      setLastUndo({ snap, name: lead.name || "lead", id });
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

  // Log the number actually dialed, not the primary. Tapping "2nd" used to
  // record the cell you didn't call, which makes the trail lie about which
  // line went unanswered.
  function onDial(dialed: string) {
    if (dialed) logActivity(lead!.id, "Call", "Dial", `Dialed ${dialed}`, me).catch(() => {});
  }

  // One tap, one handset dial.
  //
  // This used to branch three ways through a Telnyx bridge that the team
  // retired: a per-device mode toggle, a persistent line, a one-shot bridge,
  // and a fallback to the handset when none of it was configured. Everyone
  // dials from their own phone, so the fallback was the only path anyone took,
  // and the rest was a decision at the top of every session with one right
  // answer plus a button that rang a number out of a hardcoded list.
  //
  // `alt` dials the second number. Merging duplicates put a lot of real second
  // numbers on the book (same person, two lines from two different lists), and
  // a no-answer on the cell is often a pickup on the landline. Reaching it has
  // to be one tap, not a trip through the drawer.
  //
  // The dial is logged BEFORE the handoff: navigating to a tel: URL can take
  // the tab out from under us, and a call with no row is a call that never
  // happened as far as the book is concerned.
  function placeCall(alt = false) {
    if (!lead) return;
    // bestPhone, not lead.phone. When a lead's primary is a confirmed landline
    // and their second number is a confirmed mobile, the mobile is the one
    // worth ringing: on this book a dialed landline was a dead number 68.8% of
    // the time against 11.8% for a mobile. "alt" still means the other one,
    // whichever the other one now is.
    const best = bestPhone(lead);
    const other = best.swapped ? lead.phone || "" : altPhone(lead) || "";
    const leadPhone = (alt ? other : best.number) || best.number || "";
    if (!leadPhone) return;
    onDial(leadPhone);
    window.location.href = `tel:${leadPhone}`;
  }

  async function dropVoicemail() {
    if (!lead) return;
    const body = vmTemplate
      ? fillTemplate(vmTemplate.body, { first: (lead.name || "").split(" ")[0] || "there", name: lead.name || "", me, city: lead.city || "" })
      : `Hi ${(lead.name || "").split(" ")[0] || "there"}, this is ${me} in Greensboro about your Medicare options for turning 65. Give me a call back when you get a chance. Thanks!`;
    navigator.clipboard.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
    const vm = DISPOSITIONS.find((d) => d.key === "vm");
    if (vm) await doDisposition(vm);
  }

  // The text, handed to the phone's own messaging app with the message already
  // written. Same handoff as the Call button, and logged the same way: before
  // the navigation, because an sms: URL can take the tab with it.
  function sendText(kind: "vm" | "intro") {
    if (!lead) return;
    const to = lead.phone || altPhone(lead) || "";
    const href = smsHref(to, smsBody(kind, lead, me));
    if (!href) return;
    logText(lead, kind, me).catch(() => {});
    setTexted((s) => new Set(s).add(lead.id));
    window.location.href = href;
  }

  // The one-two: voicemail, then the text that follows it, on ONE key.
  //
  // Sequencing is the whole trick here. The disposition has to be written and
  // awaited BEFORE the sms: handoff, because navigating away can kill an
  // in-flight request and a voicemail nobody logged is a voicemail that gets
  // left twice. Only then does the message app open. Coming back to the tab,
  // the session is already sitting on the next lead.
  //
  // Without consent on file this is just the voicemail, which is what V does.
  async function voicemailAndText() {
    if (!lead || busy) return;
    const target = lead;
    const kind: "vm" | "intro" = "vm";
    const href = textOk
      ? smsHref(target.phone || altPhone(target) || "", smsBody(kind, target, me))
      : null;
    await dropVoicemail();
    if (!href) return;
    logText(target, kind, me).catch(() => {});
    setTexted((s) => new Set(s).add(target.id));
    window.location.href = href;
  }

  // "Can I text you the details?" — four seconds on a call that is already
  // happening, and the only thing that makes any of this list textable.
  async function takeConsent() {
    if (!lead || busy) return;
    const id = lead.id;
    setConsented((s) => new Set(s).add(id));
    try {
      await grantSmsConsent(lead, me);
    } catch {
      // Put it back rather than showing a permission the book doesn't hold.
      setConsented((s) => { const n = new Set(s); n.delete(id); return n; });
      setErr("Could not save consent");
    }
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
      else if (k === "c") { e.preventDefault(); placeCall(); }
      else if (k === "v") { e.preventDefault(); dropVoicemail(); }
      else if (k === "t") { e.preventDefault(); void voicemailAndText(); }
      else if (k === "g") { e.preventDefault(); void takeConsent(); }
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
          <p className="mt-2 text-[11px] leading-relaxed text-later">{findSegment(seg).blurb}</p>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-worked">
            Narrow it down
          </label>
          <div className="mt-1">
            <LeadFilters pool={leads} value={filter} onChange={setFilter} />
          </div>
          <p className="mt-1 text-[11px] text-later">
            Towns, ZIPs, list, the month they turn 65, home value, how far out they are, when you
            last worked them and what came of it. Same filters as a door route, so you can build a
            calling session the same way you build a walk.
          </p>
          {/* The dial queue drops closed leads and anything already booked, so a
              pick like "Not interested" would come back as an empty session with
              nothing on screen to say why. Say why. */}
          {parkedPicks.length > 0 && (
            <p role="status" className="mt-1 text-[11px] leading-relaxed text-due">
              {parkedPicks.map((r) => LEAD_RESULT_OPTIONS.find((o) => o.value === r)?.label || r).join(", ")}
              {parkedPicks.length === 1 ? " is not a callable pile" : " are not callable piles"} — the
              dial queue holds those back. Work them from the Leads tab, which reads the whole book.
            </p>
          )}
          {filter.worked === "today" && (
            <p role="status" className="mt-1 text-[11px] leading-relaxed text-due">
              The queue already hides anyone worked today, so this session will come back empty.
            </p>
          )}
          {usingFallback && (
            <p role="status" className="mt-1 text-[11px] text-due">
              Still finding your location — measuring from the office until it lands.
            </p>
          )}

          <p className="mt-4 text-sm text-worked">
            <span className="font-display text-2xl font-semibold text-ink">{preview.length}</span> leads ready in this session.
          </p>
          {(held.worked > 0 || held.later > 0) && (
            <p className="mt-1 text-[11px] leading-relaxed text-later">
              Held back:{" "}
              {held.worked > 0 && <>{held.worked} you already worked today</>}
              {held.worked > 0 && held.later > 0 && " · "}
              {held.later > 0 && <>{held.later} booked for a later day or hour</>}
              . They come back on their own, at the time the callback was set for.
            </p>
          )}
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
          <LeadCardHeader lead={lead} size="lg" />

          <p className="mt-2 text-xs text-later">Why now: {(lead._why || []).join(" · ") || "next in line"}</p>

          {/* Call + voicemail */}
          <div className="mt-4 flex gap-2">
            {(lead.phone || lead.phone2) && (
              <button
                onClick={() => placeCall()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-base font-semibold text-white hover:bg-brand-dark"
              >
                <Phone size={18} /> Call {formatPhone(bestPhone(lead).number)}
                {/* Say when the button is NOT ringing the number on the card.
                    Silently dialing a different line than the one displayed is
                    how you end up unable to explain your own call history. */}
                {bestPhone(lead).swapped && <span className="text-white/70">(cell)</span>}
                <span className="text-white/60">(C)</span>
              </button>
            )}
            {lead.phone && altPhone(lead) && (
              <button
                onClick={() => placeCall(true)}
                title={
                  bestPhone(lead).swapped
                    ? `Their landline: ${formatPhone(lead.phone)}`
                    : `Try their other number: ${formatPhone(altPhone(lead))}`
                }
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
          </div>

          {/* The text. A voicemail on its own asks a 64-year-old to call an
              unknown number back, which is the thing they were already not
              doing. The text is what they can actually answer, and it has to
              go out while the missed call is still on their screen — so it
              lives on the same key as the voicemail, not in another app. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void voicemailAndText()}
              disabled={busy || !textOk}
              title={textBlock || "Log the voicemail, then open a text that follows it"}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-brand/30 bg-brand/5 px-4 py-2.5 text-sm font-semibold text-brand-dark hover:bg-brand hover:text-white disabled:opacity-40"
            >
              <MessageSquare size={16} />
              {texted.has(lead.id) ? "VM + text sent" : "VM + text"} <span className="opacity-60">(T)</span>
            </button>
            {!hasConsent ? (
              <button
                onClick={() => void takeConsent()}
                disabled={busy || Boolean(lead.do_not_call)}
                title="They said yes to a text on this call. Saves a dated, attributed record."
                className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2.5 text-sm font-medium text-worked hover:bg-paper disabled:opacity-40"
              >
                <ShieldCheck size={15} /> Got consent <span className="text-later">(G)</span>
              </button>
            ) : (
              <span className="flex items-center gap-1.5 rounded-xl border border-newlead/40 px-3 py-2.5 text-xs font-medium text-newlead">
                <ShieldCheck size={15} /> OK to text
              </span>
            )}
          </div>
          {textBlock && <p className="mt-1 text-[11px] leading-relaxed text-later">{textBlock}</p>}

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
                {/* Smart Capture is a disposition, so it has to END THE LEAD
                    like one. It used to close its own panel and reload, which
                    left you sitting on the same card: the status had been
                    written, the follow-up scheduled, the activity logged, and
                    the screen looked exactly as it had before you typed. The
                    only way to tell it worked was to move on and come back.
                    advance() is what every other result on this page calls. */}
                <SmartCapture
                  lead={lead}
                  onApplied={() => {
                    setCapturing(false);
                    setCounts((c) => ({ ...c, dials: c.dials + 1 }));
                    advance(lead.id);
                    void reload();
                  }}
                />
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
            Keys: 1-8 result · N note · V voicemail · T VM + text · G got consent · S sold · X skip · U undo. Auto-advances after each.
          </p>
        </div>
      )}
    </div>
  );
}
