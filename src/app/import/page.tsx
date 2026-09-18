"use client";

import { useMemo, useState } from "react";
import { FileUp, LoaderCircle, ShieldCheck } from "lucide-react";
import { useApp } from "@/lib/context";
import { supabase } from "@/lib/supabaseClient";
import {
  detectMappings,
  exactLeadKey,
  IMPORT_FIELDS,
  makeImportRows,
  normalizedPhone,
  parseLeadFile,
  type ImportField,
  type ImportRow,
  type ParsedFile,
} from "@/lib/leadImport";
import { buildOscrMapping, canonize, isOscrExport, oscrToLead } from "@/lib/oscrMap";
import { listTag } from "@/lib/categories";
import { enrichUncheckedLeads, type EnrichProgress } from "@/lib/homeValue";
import { geocodeUncheckedLeads } from "@/lib/geocode";

const BATCH_SIZE = 250;

type ImportResult =
  | { kind: "success"; imported: number; skipped: number }
  | { kind: "error"; imported: number; message: string };

export default function ImportPage() {
  const { leads, reload } = useApp();
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState("");
  const [mappings, setMappings] = useState<Partial<Record<ImportField, string>>>({});
  const [skipExactDuplicates, setSkipExactDuplicates] = useState(true);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [enriching, setEnriching] = useState<EnrichProgress | null>(null);
  const [enrichDone, setEnrichDone] = useState<EnrichProgress | null>(null);

  // After any import, look up home values (NC OneMap parcel data) for leads
  // that came in without one — the $250k+ filter only works if this runs.
  async function enrichNewLeads() {
    setEnrichDone(null);
    setEnriching({ checked: 0, matched: 0, total: 0 });
    try {
      const final = await enrichUncheckedLeads((p) => setEnriching(p));
      setEnrichDone(final);
      // Geocode for door-knock routing in the same pass (silent; misses are
      // recorded and simply can't be routed).
      await geocodeUncheckedLeads().catch(() => {});
      if (final.matched > 0) await reload();
    } catch {
      // parcel service unreachable — leads stay unchecked and the
      // "Needs home value" segment (or npm run enrich:home-value) catches them
    } finally {
      setEnriching(null);
    }
  }

  const rawRows = useMemo(
    () => (parsed ? makeImportRows(parsed.rows, mappings, source) : []),
    [parsed, mappings, source]
  );

  // --- OSCR path -------------------------------------------------------------
  // OSCR is the system of record. If the export carries an OSCR lead id we key
  // on it and upsert, so re-exporting the same county slice updates rather than
  // duplicating, and compliance (DNC / consent) comes from OSCR, not guesswork.
  const oscrMode = parsed ? isOscrExport(parsed.headers) : false;

  const oscrRows = useMemo(() => {
    if (!parsed || !oscrMode) return [] as Record<string, unknown>[];
    const { mapping } = buildOscrMapping(parsed.headers);
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    for (const row of parsed.rows) {
      const lead = oscrToLead(canonize(row, mapping)) as Record<string, unknown>;
      const id = lead.oscr_lead_id as string | null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Never let an empty OSCR value wipe CRM work. Only propagate the
      // conservative direction: set DNC, never clear it.
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(lead)) {
        if (v === null || v === undefined || v === "") continue;
        if (k === "do_not_call" && v !== true) continue;
        clean[k] = v;
      }
      clean.sms_consent = lead.sms_consent === true;
      clean.email_consent = lead.email_consent === true;
      out.push(clean);
    }
    return out;
  }, [parsed, oscrMode]);

  const oscrStats = useMemo(() => {
    const existing = new Set(leads.map((l) => (l as any).oscr_lead_id).filter(Boolean));
    let updates = 0;
    let dnc = 0;
    let consent = 0;
    for (const r of oscrRows) {
      if (existing.has(r.oscr_lead_id)) updates += 1;
      if (r.do_not_call === true) dnc += 1;
      if (r.sms_consent === true || r.email_consent === true) consent += 1;
    }
    return { total: oscrRows.length, updates, added: oscrRows.length - updates, dnc, consent };
  }, [oscrRows, leads]);

  async function runOscrSync() {
    if (importing || oscrRows.length === 0) return;
    setImporting(true);
    setResult(null);
    let done = 0;
    try {
      for (let i = 0; i < oscrRows.length; i += BATCH_SIZE) {
        const batch = oscrRows.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from("leads").upsert(batch, { onConflict: "oscr_lead_id" });
        if (error) throw error;
        done += batch.length;
      }
      await reload();
      setResult({ kind: "success", imported: done, skipped: 0 });
      void enrichNewLeads();
    } catch (error) {
      await reload().catch(() => {});
      setResult({
        kind: "error",
        imported: done,
        message: error instanceof Error ? error.message : "The sync stopped before it finished.",
      });
    } finally {
      setImporting(false);
    }
  }

  const importPlan = useMemo(() => {
    const existing = new Set(leads.map(exactLeadKey).filter((key): key is string => !!key));
    const seen = new Set<string>();
    const existingPhones = new Set(leads.map((lead) => normalizedPhone(lead.phone)).filter(Boolean));
    let empty = 0;
    let skipped = 0;
    let matchingPhone = 0;

    const rows: ImportRow[] = [];

    for (const row of rawRows) {
      const hasUsefulData = Boolean(row.name || row.phone || row.phone2 || row.email || row.address);
      if (!hasUsefulData) {
        empty += 1;
        continue;
      }
      const ph = normalizedPhone(row.phone);
      const key = exactLeadKey(row);
      if (skipExactDuplicates && key && (existing.has(key) || seen.has(key))) {
        skipped += 1;
        continue;
      }
      if (key) seen.add(key);
      if (ph && existingPhones.has(ph)) matchingPhone += 1;
      rows.push(row);
    }
    return { rows, empty, skipped, matchingPhone };
  }, [leads, rawRows, skipExactDuplicates]);

  async function selectFile(file: File | undefined) {
    if (!file) return;
    setReadingError(null);
    setResult(null);
    try {
      const nextParsed = parseLeadFile(await file.text());
      if (!nextParsed.headers.length || !nextParsed.rows.length) {
        setParsed(null);
        setReadingError("That file has no header row and lead rows to import.");
        return;
      }
      setParsed(nextParsed);
      setMappings(detectMappings(nextParsed.headers));
      setFileName(file.name);
      if (!source.trim()) setSource(file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
    } catch {
      setParsed(null);
      setReadingError("We could not read that file. Please use a CSV or tab-delimited file.");
    }
  }

  async function runImport() {
    if (!parsed || importing || importPlan.rows.length === 0) return;
    setImporting(true);
    setResult(null);
    let imported = 0;
    try {
      // Stamp the list this file came from as a tag as well as the source.
      // Source holds one answer; tags let the same lead sit in every list it
      // has ever appeared on, next to its birth month and anything else.
      const tag = listTag(source);
      for (let i = 0; i < importPlan.rows.length; i += BATCH_SIZE) {
        const batch = importPlan.rows
          .slice(i, i + BATCH_SIZE)
          .map((r) => (tag ? { ...r, tags: [tag] } : r));
        const { error } = await supabase.from("leads").insert(batch);
        if (error) throw error;
        imported += batch.length;
      }
      await reload();
      setResult({ kind: "success", imported, skipped: importPlan.skipped + importPlan.empty });
      void enrichNewLeads();
    } catch (error) {
      setResult({
        kind: "error",
        imported,
        message: error instanceof Error ? error.message : "The import stopped before it finished.",
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-ink">Import leads</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload a CSV or tab-delimited export — OSCR slices, T65 trackers, Nextdoor research lists, or
          door-knock routes. Name + address with no phone is enough for a door-knock lead; set the source
          (e.g. Nextdoor) so channel ROI stays honest. New leads enter New Prospecting unless the file
          supplies a follow-up date or stage.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-white p-5 shadow-card">
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand/30 bg-brand-light/30 px-5 py-8 text-center text-sm font-medium text-brand-dark hover:bg-brand-light/50">
          <FileUp size={18} />
          <span>{fileName ? `Replace ${fileName}` : "Choose a lead file"}</span>
          <input
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            className="sr-only"
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
        </label>
        {readingError && <p className="mt-3 text-sm text-overdue">{readingError}</p>}

        {parsed && oscrMode && (
          <div className="mt-5">
            <div className="rounded-xl border border-newlead/40 bg-newlead/5 p-4">
              <p className="text-sm font-semibold text-newlead">OSCR export detected</p>
              <p className="mt-1 text-xs text-worked">
                Syncing on OSCR lead ID — re-exporting the same slice updates those leads instead of
                duplicating them. Compliance (do-not-call, SMS/email consent) is taken from OSCR,
                and your CRM statuses, notes, tags, and follow-ups are left untouched.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div><p className="font-display text-2xl font-semibold text-ink">{oscrStats.total.toLocaleString()}</p><p className="text-xs text-worked">in file</p></div>
                <div><p className="font-display text-2xl font-semibold text-ink">{oscrStats.added.toLocaleString()}</p><p className="text-xs text-worked">new</p></div>
                <div><p className="font-display text-2xl font-semibold text-ink">{oscrStats.updates.toLocaleString()}</p><p className="text-xs text-worked">updated</p></div>
                <div><p className="font-display text-2xl font-semibold text-overdue">{oscrStats.dnc.toLocaleString()}</p><p className="text-xs text-worked">DNC from OSCR</p></div>
                <div><p className="font-display text-2xl font-semibold text-newlead">{oscrStats.consent.toLocaleString()}</p><p className="text-xs text-worked">with consent</p></div>
              </div>
              <button
                onClick={runOscrSync}
                disabled={importing || oscrRows.length === 0}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-newlead py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {importing ? <LoaderCircle size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                {importing ? "Syncing from OSCR…" : `Sync ${oscrStats.total.toLocaleString()} leads from OSCR`}
              </button>
            </div>
          </div>
        )}

        {parsed && !oscrMode && (
          <>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-600">Source for these leads</label>
                <input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="e.g. SmartAsset, Door Knock, Mailer"
                  className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
                <p className="mt-1 text-xs text-slate-400">
                  A Source column in the file overrides this for that specific row.
                </p>
              </div>
              <div className="rounded-lg bg-paper px-4 py-3 text-sm text-slate-600">
                <p>
                  <span className="font-semibold text-ink">{parsed.rows.length.toLocaleString()}</span> rows found
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {Object.keys(mappings).length} fields matched automatically from {parsed.headers.length} columns.
                </p>
              </div>
            </div>

            <details className="mt-5 rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">Review field matching</summary>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {IMPORT_FIELDS.map((field) => (
                  <label key={field.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3 text-xs">
                    <span className="text-slate-600">{field.label}</span>
                    <select
                      value={mappings[field.key] || ""}
                      onChange={(event) =>
                        setMappings((current) => ({
                          ...current,
                          [field.key]: event.target.value || undefined,
                        }))
                      }
                      className="min-w-0 rounded-md border border-line px-2 py-1.5 text-xs"
                    >
                      <option value="">Do not import</option>
                      {parsed.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>

            <label className="mt-5 flex items-start gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={skipExactDuplicates}
                onChange={(event) => setSkipExactDuplicates(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Skip exact duplicates (same primary phone and source). The same phone from a different source stays
                importable and will be flagged in the CRM.
              </span>
            </label>

            <div className="mt-5 grid gap-3 rounded-xl bg-paper p-4 text-sm sm:grid-cols-5">
              <p><span className="block text-xl font-semibold text-ink">{importPlan.rows.length.toLocaleString()}</span>ready to add</p>
              <p><span className="block text-xl font-semibold text-ink">{importPlan.skipped.toLocaleString()}</span>exact duplicates</p>
              <p><span className="block text-xl font-semibold text-ink">{importPlan.matchingPhone.toLocaleString()}</span>same phone, another source</p>
              <p>DNC numbers are included.</p>
              <p><span className="block text-xl font-semibold text-ink">{importPlan.empty.toLocaleString()}</span>blank rows skipped</p>
            </div>

            <div className="mt-5 overflow-hidden rounded-lg border border-line">
              <div className="grid grid-cols-3 gap-3 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500">
                <span>Preview</span><span>Phone</span><span>Source</span>
              </div>
              {importPlan.rows.slice(0, 5).map((row, index) => (
                <div key={`${row.source_row}-${index}`} className="grid grid-cols-3 gap-3 border-t border-line px-4 py-2 text-sm text-slate-600">
                  <span className="truncate">{String(row.name || "Unnamed lead")}</span>
                  <span className="truncate">{String(row.phone || row.phone2 || "—")}</span>
                  <span className="truncate">{String(row.source)}</span>
                </div>
              ))}
            </div>

            <button
              onClick={runImport}
              disabled={importing || importPlan.rows.length === 0}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {importing ? <LoaderCircle size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
              {importing ? "Importing leads…" : `Import ${importPlan.rows.length.toLocaleString()} leads`}
            </button>
          </>
        )}

        {result?.kind === "success" && (
          <p className="mt-4 rounded-lg bg-newlead-50 px-4 py-3 text-sm text-newlead">
            Imported {result.imported.toLocaleString()} leads. {result.skipped ? `${result.skipped.toLocaleString()} rows were skipped.` : ""}
          </p>
        )}
        {result?.kind === "error" && (
          <p className="mt-4 rounded-lg bg-overdue-50 px-4 py-3 text-sm text-overdue">
            Imported {result.imported.toLocaleString()} before the import stopped. {result.message}
          </p>
        )}
        {enriching && (
          <p role="status" className="mt-2 flex items-center gap-2 rounded-lg bg-paper px-4 py-3 text-sm text-worked">
            <LoaderCircle size={14} aria-hidden className="animate-spin" />
            Looking up home values (NC parcel data)… {enriching.checked}/{enriching.total} checked,{" "}
            {enriching.matched} matched. Safe to leave this page open in the background.
          </p>
        )}
        {enrichDone && enrichDone.total > 0 && (
          <p className="mt-2 rounded-lg bg-paper px-4 py-3 text-sm text-worked">
            Home values: matched {enrichDone.matched.toLocaleString()} of {enrichDone.total.toLocaleString()}{" "}
            new leads against county parcel data. Unmatched leads show under “Needs home value” on the Power List.
          </p>
        )}
      </div>
    </div>
  );
}
