"use client";

// Assistant: dump leads in ANY format — a Word route table, a Nextdoor thread,
// a scribbled list — and get a clean preview to import. AI-parsed when an API
// key is configured (Claude first), heuristic parser otherwise, and every
// import runs through the same dedupe/DNC checks as the Import tab.

import { useEffect, useMemo, useState } from "react";
import { Sparkles, LoaderCircle, ShieldCheck } from "lucide-react";
import { useApp } from "@/lib/context";
import { supabase } from "@/lib/supabaseClient";
import { parseLeadText, dedupeKey, type ParsedLead, type ParseResult } from "@/lib/aiImport";
import { canonicalPhone, formatPhone } from "@/lib/phone";
import { enrichUncheckedLeads } from "@/lib/homeValue";
import { geocodeUncheckedLeads } from "@/lib/geocode";
import CoachPanel from "@/components/CoachPanel";
import type { Activity } from "@/lib/types";

type RowState = ParsedLead & { include: boolean; flag: "new" | "existing-phone" | "dnc-phone" };

export default function AssistantPage() {
  const { leads, reload } = useApp();

  // The coach recomputes its hour table from this on every ask, so it has to be
  // the real log rather than a summary. The whole thing is about 3,000 rows.
  const [activity, setActivity] = useState<Activity[]>([]);
  useEffect(() => {
    const since = new Date();
    since.setDate(since.getDate() - 180);
    supabase
      .from("activity_log")
      .select("activity_type,outcome,activity_date,lead_id,logged_by")
      .gte("activity_date", since.toISOString())
      .limit(20000)
      .then(({ data }) => setActivity((data || []) as Activity[]));
  }, []);
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [parsing, setParsing] = useState(false);
  const [provider, setProvider] = useState<ParseResult["provider"] | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [importing, setImporting] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const existingPhones = useMemo(
    () => new Set(leads.map((l) => canonicalPhone(l.phone)).filter(Boolean)),
    [leads]
  );
  const dncPhones = useMemo(
    () =>
      new Set(
        leads
          .filter((l) => l.do_not_call)
          .flatMap((l) => [canonicalPhone(l.phone), canonicalPhone(l.phone2)])
          .filter(Boolean)
      ),
    [leads]
  );

  async function parse() {
    if (!text.trim() || parsing) return;
    setParsing(true);
    setResultMsg(null);
    setRows([]);
    try {
      const res = await parseLeadText(text);
      setProvider(res.provider);
      const seen = new Set<string>();
      const next: RowState[] = [];
      for (const l of res.leads) {
        const key = dedupeKey(l);
        if (seen.has(key)) continue;
        seen.add(key);
        const p = canonicalPhone(l.phone);
        const flag: RowState["flag"] = p && dncPhones.has(p) ? "dnc-phone" : p && existingPhones.has(p) ? "existing-phone" : "new";
        next.push({ ...l, include: flag === "new", flag });
      }
      setRows(next);
    } finally {
      setParsing(false);
    }
  }

  async function runImport() {
    const chosen = rows.filter((r) => r.include);
    if (!chosen.length || importing) return;
    setImporting(true);
    setResultMsg(null);
    try {
      const src = source.trim() || "Assistant";
      const inserts = chosen.map((r) => ({
        source: src,
        assigned_to: "Both",
        name: r.name,
        phone: r.phone,
        phone2: r.phone2,
        email: r.email,
        address: r.address,
        city: r.city,
        county: r.county,
        zip: r.zip,
        state: "NC",
        birthday: r.birthday,
        status: "New",
        stage_bucket: "New Prospecting",
        raw_notes: r.notes,
        do_not_call: r.dnc_mentioned,
      }));
      const { error } = await supabase.from("leads").insert(inserts);
      if (error) throw error;
      setResultMsg(`Imported ${inserts.length} leads as “${src}”. Looking up home values and map coordinates…`);
      setRows([]);
      setText("");
      await reload();
      // Same automatic enrichment as the Import tab
      await enrichUncheckedLeads().catch(() => {});
      await geocodeUncheckedLeads().catch(() => {});
      await reload();
      setResultMsg(`Imported ${inserts.length} leads as “${src}”. Home values and coordinates are in.`);
    } catch (e) {
      setResultMsg(e instanceof Error ? `Import failed: ${e.message}` : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  const includeCount = rows.filter((r) => r.include).length;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4">
        <h1 className="font-display text-2xl font-semibold text-ink">Assistant</h1>
        <p className="mt-1 text-sm text-worked">
          Ask it who to call and it answers from your own call history and the hour it is now.
          Or paste leads in any shape and it turns them into clean rows you approve before
          anything is saved.
        </p>
      </div>

      {/* Asking comes first. It is the thing you open this tab for most days;
          importing is the thing you do when a new list arrives. */}
      <div className="mb-6">
        <CoachPanel activity={activity} />
      </div>

      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-worked">Import leads from pasted text</p>

      <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          aria-label="Paste lead text"
          placeholder={"Paste anything…\n\nRelada Hayes\n1322 Broholmer Ln\nGreensboro, NC 27405\nDec 1961\n301-429-0250 (Do not call)"}
          className="w-full rounded-xl border border-line px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={parse}
            disabled={parsing || !text.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {parsing ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <Sparkles size={15} aria-hidden />}
            {parsing ? "Reading…" : "Find the leads"}
          </button>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Source label for these leads"
            placeholder="Source (e.g. Nextdoor Lake Jeanette)"
            className="min-w-[14rem] flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        {provider && rows.length > 0 && (
          <p className="mt-2 text-xs text-later">
            {provider === "local"
              ? "Parsed with the built-in parser. For messier text, add an ANTHROPIC_API_KEY secret in Supabase Edge Functions to turn on Claude."
              : `Parsed by ${provider === "claude" ? "Claude" : "Gemini"}.`}
          </p>
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-4 rounded-2xl border border-line bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-semibold text-ink">
              {rows.length} found · {includeCount} selected
            </p>
            <button
              onClick={runImport}
              disabled={importing || includeCount === 0}
              className="flex items-center gap-1.5 rounded-lg bg-newlead px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {importing ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <ShieldCheck size={15} aria-hidden />}
              Import {includeCount}
            </button>
          </div>
          <div className="divide-y divide-line">
            {rows.map((r, i) => (
              <label key={i} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-paper/50">
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={(e) => setRows((all) => all.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-semibold text-ink">{r.name || "No name"}</span>
                    <span className="text-worked">{formatPhone(r.phone) || "no phone"}</span>
                    {r.flag === "existing-phone" && (
                      <span className="rounded bg-week/10 px-1.5 py-0.5 text-[11px] font-medium text-week">
                        phone already in CRM
                      </span>
                    )}
                    {r.flag === "dnc-phone" && (
                      <span className="rounded bg-overdue-50 px-1.5 py-0.5 text-[11px] font-medium text-overdue">
                        phone on DNC list
                      </span>
                    )}
                    {r.dnc_mentioned && (
                      <span className="rounded bg-due-50 px-1.5 py-0.5 text-[11px] font-medium text-due">
                        marked do-not-call in text
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-later">
                    {[r.address, r.city, r.zip].filter(Boolean).join(", ") || "no address"}
                    {r.birthday ? ` · b. ${r.birthday}` : ""}
                    {r.notes ? ` · ${r.notes}` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {resultMsg && (
        <p role="status" className="mt-4 rounded-xl bg-newlead-50 px-4 py-3 text-sm text-newlead">
          {resultMsg}
        </p>
      )}
    </div>
  );
}
