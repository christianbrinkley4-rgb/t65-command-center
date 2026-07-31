#!/usr/bin/env node
// Push the monthly trackers' call history into the CRM.
//
//   T65_PASSWORD=... node scripts/import-tracker-history.mjs history.csv [--dry-run]
//
// Input is the CSV from scripts/tracker_xlsx_to_csv.py. Every row is a lead
// somebody actually worked: when they were dialed, how many times, what was
// said, and what it turned into.
//
// WHAT THIS WRITES
//   dials_count          the real number of attempts
//   last_contact_date    the day of the last dial
//   status / stage       mapped from Outcome, falling back to Call Result
//   next_follow_up_date  a parsed callback date
//   appointment_datetime a parsed appointment
//   do_not_call          only ever SET, when the tracker says DNC
//   raw_notes            the tracker note, prepended and dated
//   activity_log         ONE ROW PER DIAL, at the real timestamp — this is the
//                        timeline the app has never had
//
// WHAT IT REFUSES TO DO
//   Overwrite newer CRM work. If the lead has been contacted since the last
//   tracker call, the status and dates are left alone and only the history
//   rows are added. History is additive and always true; a status is a claim
//   about right now, and the CRM's is more recent.
//
//   Create leads. Every tracker row should already be in the book (a 120-lead
//   sample matched 120). Unmatched rows are reported, never inserted, because
//   a tracker row with no match usually means a typo'd phone, not a new person.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

// Tracker vocabulary -> CRM vocabulary. Outcome wins over Call Result: it's
// what the conversation produced, not merely whether the phone was answered.
const OUTCOME_MAP = {
  "appointment set": { status: "Appointment Set", stage: "Appointment Upcoming" },
  "not interested": { status: "Closed - Not Interested", stage: "Closed" },
  "already enrolled / covered": { status: "Closed - Already Enrolled", stage: "Closed" },
  "already enrolled": { status: "Closed - Already Enrolled", stage: "Closed" },
  "sent info / follow up": { status: "Talked - Interested", stage: "Worked - Follow Up" },
  callback: { status: "Talked - Not Ready", stage: "Worked - Follow Up" },
  dnc: { status: "Closed - DNC", stage: "Closed", dnc: true },
  "bad number": { status: "Closed - Bad Number", stage: "Closed" },
};

const RESULT_MAP = {
  "no answer": { status: "No Answer", stage: "Worked - Follow Up" },
  busy: { status: "Busy - Retry", stage: "Worked - Follow Up" },
  "voicemail left": { status: "Voicemail Left", stage: "Worked - Follow Up" },
  "disconnected / bad number": { status: "Closed - Bad Number", stage: "Closed" },
  "answered - spoke to prospect": { status: "Contacted", stage: "Worked - Follow Up" },
  "answered - spoke to spouse": { status: "Contacted", stage: "Worked - Follow Up" },
  "wrn#": { status: "Closed - Bad Number", stage: "Closed" },
  "dsc#": { status: "Closed - Bad Number", stage: "Closed" },
  "talked to prospect": { status: "Contacted", stage: "Worked - Follow Up" },
  // The person who answered isn't the lead. That's a broken record, not a
  // rejection — it lands on the same bench as the app's "Wrong Info".
  "answered - wrong person": { status: "Needs Info - Verify", stage: "Needs Info" },
  "do not call - requested": { status: "Closed - DNC", stage: "Closed", dnc: true },
  ni: { status: "Closed - Not Interested", stage: "Closed" },
  // Shorthand typed straight into the April tracker mid-session. These are the
  // same outcomes as the dropdown values above, just written the fast way, and
  // without them 20-odd real calls import as "worked, result unknown".
  vm: { status: "Voicemail Left", stage: "Worked - Follow Up" },
  "no vm": { status: "No Answer", stage: "Worked - Follow Up" },
  na: { status: "No Answer", stage: "Worked - Follow Up" },
  "talked to spouse": { status: "Contacted", stage: "Worked - Follow Up" },
  "has advisors": { status: "Closed - Has Advisor", stage: "Closed" },
  "has advisor": { status: "Closed - Has Advisor", stage: "Closed" },
};

function mapStatus(row) {
  const o = String(row.Outcome || "").trim().toLowerCase();
  if (o && OUTCOME_MAP[o]) return OUTCOME_MAP[o];
  // "Voicemail Left , No Answer" — take the first thing that maps.
  const r = String(row["Call result"] || "").trim().toLowerCase();
  if (r && RESULT_MAP[r]) return RESULT_MAP[r];
  for (const part of r.split(/\s*,\s*/)) {
    if (RESULT_MAP[part]) return RESULT_MAP[part];
  }
  return null;
}

function canonPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : "";
}

const nameParts = (v) => {
  const w = String(v || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  return { first: w[0] || "", last: w.length > 1 ? w[w.length - 1] : "" };
};

// Couples share a landline, so a phone match alone is not identity.
function samePerson(a, b) {
  const x = nameParts(a);
  const y = nameParts(b);
  if (!x.first && !x.last) return true;
  if (x.last && y.last && x.last !== y.last) return false;
  if (!x.first || !y.first) return true;
  if (x.first === y.first) return true;
  const [s, l] = x.first.length <= y.first.length ? [x.first, y.first] : [y.first, x.first];
  return s.length >= 3 && l.startsWith(s);
}

const streetKey = (v) =>
  String(v || "").split(",")[0].toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(street|st|road|rd|drive|dr|lane|ln|court|ct|circle|cir|avenue|ave|place|pl|boulevard|blvd|trail|trl|way|terrace|ter|parkway|pkwy|loop|run|point|pt|ridge|rdg|cove|cv)\b/g, "")
    .replace(/\s+/g, " ").trim();

const personKey = (name, addr) => {
  const n = nameParts(name);
  return `${n.first}|${n.last}|${streetKey(addr)}`;
};

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (q && s[i + 1] === '"') { cell += '"'; i++; }
      else q = !q;
    } else if (!q && c === ",") { row.push(cell); cell = ""; }
    else if (!q && (c === "\n" || c === "\r")) {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); if (row.some((x) => x !== "")) rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== "")) rows.push(row);
  const headers = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] || "").trim()])));
}

const ymd = (s) => String(s || "").slice(0, 10);

async function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!file) throw new Error("Usage: import-tracker-history.mjs <history.csv> [--dry-run]");
  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL, password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  const incoming = parseCsv(readFileSync(file, "utf8"));
  console.log(`${incoming.length} worked leads in ${file}`);

  let book = [], from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, name, phone, phone2, address, city, status, stage_bucket, dials_count, last_contact_date, next_follow_up_date, appointment_datetime, raw_notes, do_not_call")
      .range(from, from + 999);
    if (error) throw error;
    book = book.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`${book.length} leads in the CRM`);

  // Re-running must not duplicate history, so remember what's already logged.
  let logged = new Map(), lfrom = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("activity_log")
      .select("id, lead_id, activity_date, outcome")
      .eq("activity_type", "Call")
      .range(lfrom, lfrom + 999);
    if (error) throw error;
    for (const a of data) logged.set(`${a.lead_id}|${String(a.activity_date).slice(0, 16)}`, a);
    if (data.length < 1000) break;
    lfrom += 1000;
  }

  const byPhone = new Map();
  const byPerson = new Map();
  for (const l of book) {
    for (const p of [canonPhone(l.phone), canonPhone(l.phone2)]) {
      if (p && !byPhone.has(p)) byPhone.set(p, l);
    }
    if (l.name && l.address) {
      const k = personKey(l.name, l.address);
      if (!byPerson.has(k)) byPerson.set(k, l);
    }
  }

  const patches = [];
  const logs = [];
  const corrections = [];
  const unmatched = [];
  const stats = { matched: 0, byPhone: 0, byName: 0, statusSet: 0, dialsSet: 0, datesSet: 0,
                  appts: 0, callbacks: 0, dncSet: 0, skippedNewer: 0, historyRows: 0 };

  for (const r of incoming) {
    // Match on either number: March's leads carry a second phone.
    let lead = null, how = "";
    for (const p of [canonPhone(r.Phone), canonPhone(r["Phone 2"])]) {
      const hit = p ? byPhone.get(p) : null;
      if (hit && samePerson(hit.name, r.Name)) { lead = hit; how = "phone"; break; }
    }
    if (!lead) {
      const hit = byPerson.get(personKey(r.Name, r.Address));
      if (hit) { lead = hit; how = "name+address"; }
    }
    if (!lead) { unmatched.push(r); continue; }
    stats.matched++;
    how === "phone" ? stats.byPhone++ : stats.byName++;

    // Every dial becomes a history row at its real timestamp.
    const calls = String(r["All calls"] || "").split("|").map((s) => s.trim()).filter(Boolean);
    for (const c of calls) {
      const iso = new Date(c.replace(" ", "T")).toISOString();
      const key = `${lead.id}|${iso.slice(0, 16)}`;
      const already = logged.get(key);
      if (already) {
        // The call is already on the timeline but was logged with no result,
        // because the sheet had none at the time. If a result has since been
        // recovered from an older copy, correct that row rather than adding a
        // second one for the same dial.
        const better = r["Call result"] || r.Outcome;
        if (already.outcome === "Dialed" && better && better !== "Dialed") {
          corrections.push({ id: already.id, outcome: better });
        }
        continue;
      }
      logged.set(key, { outcome: r["Call result"] || r.Outcome || "Dialed" });
      logs.push({
        lead_id: lead.id,
        activity_type: "Call",
        activity_date: iso,
        outcome: r["Call result"] || r.Outcome || "Dialed",
        notes: [r.Tracker, r.Notes].filter(Boolean).join(" · ") || null,
        logged_by: r.Agent || "Import",
      });
      stats.historyRows++;
    }

    // The lead row only moves if the tracker knows something newer.
    const lastCall = ymd(r["Last call"]);
    const crmDate = ymd(lead.last_contact_date);
    const crmIsNewer = crmDate && lastCall && crmDate > lastCall;
    if (crmIsNewer) { stats.skippedNewer++; continue; }

    const patch = {};
    const dials = Number(r.Dials || 0);
    if (dials > (lead.dials_count || 0)) { patch.dials_count = dials; stats.dialsSet++; }
    if (lastCall && lastCall !== crmDate) { patch.last_contact_date = lastCall; stats.datesSet++; }

    const mapped = mapStatus(r);
    if (mapped) {
      if ((lead.status || "New") !== mapped.status) {
        patch.status = mapped.status;
        patch.stage_bucket = mapped.stage;
        stats.statusSet++;
      }
      if (mapped.dnc && !lead.do_not_call) { patch.do_not_call = true; stats.dncSet++; }
    }
    if (r.Appointment && !lead.appointment_datetime) {
      patch.appointment_datetime = new Date(r.Appointment.replace(" ", "T")).toISOString();
      patch.status = "Appointment Set";
      patch.stage_bucket = "Appointment Upcoming";
      stats.appts++;
    }
    if (r.Callback && !lead.next_follow_up_date) {
      patch.next_follow_up_date = r.Callback;
      stats.callbacks++;
    }
    if (r.Notes) {
      const entry = `[${lastCall || "tracker"} · ${r.Agent || "tracker"}] ${r.Notes}`;
      const prior = String(lead.raw_notes || "");
      if (!prior.includes(r.Notes)) patch.raw_notes = prior ? `${entry}\n${prior}` : entry;
    }

    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      patches.push({ id: lead.id, name: lead.name, patch });
    }
  }

  console.log("\nPlan");
  console.log(`  matched to a lead              ${stats.matched}  (${stats.byPhone} by phone, ${stats.byName} by name+address)`);
  console.log(`  no match, left alone           ${unmatched.length}`);
  console.log(`  lead rows to update            ${patches.length}`);
  console.log(`    dial counts                  ${stats.dialsSet}`);
  console.log(`    last-contact dates           ${stats.datesSet}`);
  console.log(`    statuses                     ${stats.statusSet}`);
  console.log(`    appointments                 ${stats.appts}`);
  console.log(`    callbacks                    ${stats.callbacks}`);
  console.log(`    newly do-not-call            ${stats.dncSet}`);
  console.log(`  skipped, CRM has newer work    ${stats.skippedNewer}`);
  console.log(`  history rows to write          ${stats.historyRows}`);
  console.log(`  history rows to CORRECT        ${corrections.length}  (logged as "Dialed", result now recovered)`);

  if (unmatched.length) {
    console.log("\nUnmatched (check the phone in the tracker):");
    for (const u of unmatched.slice(0, 12)) console.log(`  ${u.Name} · ${u.Phone} · ${u.Tracker}`);
    if (unmatched.length > 12) console.log(`  …and ${unmatched.length - 12} more`);
  }

  if (dryRun) { console.log("\n[DRY RUN] nothing written."); return; }

  let n = 0;
  for (const { id, patch } of patches) {
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (error) throw error;
    if (++n % 100 === 0) console.log(`  leads ${n}/${patches.length}`);
  }
  // activity_log is APPEND-ONLY: it has INSERT and SELECT policies and no
  // UPDATE policy. PostgREST answers an update with 200 and zero rows changed,
  // so a naive loop here reports success while nothing happens. Verify, and if
  // the rows didn't move, say so and hand back SQL an admin can run.
  if (corrections.length) {
    for (const c of corrections) {
      await supabase.from("activity_log").update({ outcome: c.outcome }).eq("id", c.id);
    }
    const ids = corrections.map((c) => c.id);
    let stillDialed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase
        .from("activity_log").select("id").in("id", ids.slice(i, i + 200)).eq("outcome", "Dialed");
      stillDialed += (data || []).length;
    }
    if (stillDialed === 0) {
      console.log(`  corrected ${corrections.length} history rows`);
    } else {
      console.log(`  COULD NOT correct ${stillDialed} of ${corrections.length} history rows.`);
      console.log(`  activity_log is append-only for the app role, so these need an admin. Run:`);
      const vals = corrections.map((c) => `('${c.id}','${String(c.outcome).replace(/'/g, "''")}')`).join(",");
      console.log(`  update activity_log a set outcome=v.res from (values ${vals}) v(id,res) where a.id=v.id::uuid;`);
    }
  }
  for (let i = 0; i < logs.length; i += 200) {
    const { error } = await supabase.from("activity_log").insert(logs.slice(i, i + 200));
    if (error) throw error;
    console.log(`  history ${Math.min(i + 200, logs.length)}/${logs.length}`);
  }
  console.log(`\nDone. ${patches.length} leads updated, ${logs.length} calls added to the timeline.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
