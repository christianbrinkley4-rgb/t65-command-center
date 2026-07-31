#!/usr/bin/env node
// Sync the SmartAsset "Leads received" export into the CRM.
//
//   T65_PASSWORD=... node scripts/import-smartasset.mjs smartasset.csv [--dry-run]
//
// Input is the CSV from scripts/smartasset_xlsx_to_csv.py.
//
// The point of this one is the NOTES column. It's a hand-typed running history
// — "left vm(10/16), sent 3week followup email(9/23), left vm email Christian
// (7/9)" — and it's the thing you want on screen before the phone connects. It
// goes to raw_notes, prepended and marked, never replacing what's already
// there. The survey answers become lead_profile, a separate field, because a
// static fact about someone is not a call history and they shouldn't share a
// box.
//
// DIALS/TXTs and LAST CALLED are attempt history the CRM never had for these
// leads. dials_count only ever goes UP, and a date is only written when it's
// newer than what the CRM already believes.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

const HISTORY_TYPE = "History";

const canonPhone = (v) => {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : "";
};
const words = (v) => String(v || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
const nameKey = (v) => {
  const w = words(v);
  return w.length > 1 ? `${w[0]}|${w[w.length - 1]}` : (w[0] || "");
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
  const h = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] || "").trim()])));
}

async function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!file) throw new Error("Usage: import-smartasset.mjs <smartasset.csv> [--dry-run]");
  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL, password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  const incoming = parseCsv(readFileSync(file, "utf8"));
  console.log(`${incoming.length} SmartAsset leads in ${file}`);

  let book = [], from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, name, phone, phone2, email, zip, source, tags, raw_notes, lead_profile, dials_count, last_contact_date, status")
      .range(from, from + 999);
    if (error) throw error;
    book = book.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`${book.length} leads in the CRM`);

  const { data: existingLog } = await supabase
    .from("activity_log").select("lead_id").eq("activity_type", HISTORY_TYPE);
  const alreadyLogged = new Set((existingLog || []).map((r) => r.lead_id));

  const byPhone = new Map(), byEmail = new Map(), byName = new Map();
  for (const l of book) {
    for (const p of [canonPhone(l.phone), canonPhone(l.phone2)]) {
      if (p && !byPhone.has(p)) byPhone.set(p, l);
    }
    const e = String(l.email || "").trim().toLowerCase();
    if (e && !byEmail.has(e)) byEmail.set(e, l);
    const k = nameKey(l.name);
    if (k) byName.set(k, [...(byName.get(k) || []), l]);
  }

  const patches = [], inserts = [], logs = [];
  const st = { phone: 0, email: 0, name: 0, neu: 0, notes: 0, profiles: 0,
               dials: 0, dates: 0, emails: 0, timeline: 0 };

  for (const r of incoming) {
    const ph = canonPhone(r.Phone);
    const em = String(r.Email || "").trim().toLowerCase();
    let lead = ph ? byPhone.get(ph) : null;
    if (lead) st.phone++;
    if (!lead && em) { lead = byEmail.get(em); if (lead) st.email++; }
    if (!lead) {
      const hits = byName.get(nameKey(r.Name)) || [];
      if (hits.length === 1) { lead = hits[0]; st.name++; }
    }

    if (!lead) {
      st.neu++;
      inserts.push({
        name: r.Name,
        phone: r.Phone || null,
        email: r.Email || null,
        zip: r.Zip || null,
        state: "NC",
        source: "SmartAsset",
        assigned_to: "Both",
        status: "New",
        stage_bucket: "New Prospecting",
        dials_count: Number(r.Dials || 0) || null,
        last_contact_date: r["Last called"] || null,
        raw_notes: r.Notes ? `[SmartAsset] ${r.Notes}` : null,
        lead_profile: r.Profile || null,
        tags: ["smartasset"],
      });
      continue;
    }

    const patch = {};
    // The running call history. Marked and prepended so it can't be mistaken
    // for something typed here, and so a later note doesn't bury it silently.
    if (r.Notes && !String(lead.raw_notes || "").includes(r.Notes)) {
      patch.raw_notes = `[SmartAsset] ${r.Notes}${lead.raw_notes ? "\n" + lead.raw_notes : ""}`;
      st.notes++;
    }
    if (r.Profile && r.Profile !== lead.lead_profile) { patch.lead_profile = r.Profile; st.profiles++; }
    if (r.Email && !lead.email) { patch.email = r.Email; st.emails++; }
    if (r.Zip && !lead.zip) patch.zip = r.Zip;
    const dials = Number(r.Dials || 0);
    if (dials > (lead.dials_count || 0)) { patch.dials_count = dials; st.dials++; }
    const last = r["Last called"];
    if (last && (!lead.last_contact_date || last > String(lead.last_contact_date).slice(0, 10))) {
      patch.last_contact_date = last;
      st.dates++;
    }
    const tags = lead.tags || [];
    if (!tags.includes("smartasset")) patch.tags = [...tags, "smartasset"];

    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      patches.push({ id: lead.id, patch });
    }

    // One timeline entry so the drawer isn't blank for these. Typed "History",
    // not "Call", because it's a summary of many touches and must not inflate
    // this week's dial numbers on Stats.
    if (r.Notes && !alreadyLogged.has(lead.id)) {
      logs.push({
        lead_id: lead.id,
        activity_type: HISTORY_TYPE,
        activity_date: last ? `${last}T12:00:00Z` : new Date().toISOString(),
        outcome: `SmartAsset: ${dials || 0} dials, ${r.Emails || 0} emails`,
        notes: r.Notes.slice(0, 1000),
        logged_by: "SmartAsset",
      });
      st.timeline++;
    }
  }

  console.log("\nPlan");
  console.log(`  matched   ${st.phone} by phone, ${st.email} by email, ${st.name} by name`);
  console.log(`  new leads to insert            ${st.neu}`);
  console.log(`  lead rows to update            ${patches.length}`);
  console.log(`    call histories added         ${st.notes}`);
  console.log(`    survey profiles              ${st.profiles}`);
  console.log(`    dial counts raised           ${st.dials}`);
  console.log(`    last-called dates            ${st.dates}`);
  console.log(`    emails filled in             ${st.emails}`);
  console.log(`  timeline rows                  ${st.timeline}`);

  if (dryRun) { console.log("\n[DRY RUN] nothing written."); return; }

  let n = 0;
  for (const { id, patch } of patches) {
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (error) throw error;
    if (++n % 50 === 0) console.log(`  leads ${n}/${patches.length}`);
  }
  for (let i = 0; i < inserts.length; i += 200) {
    const { error } = await supabase.from("leads").insert(inserts.slice(i, i + 200));
    if (error) throw error;
  }
  for (let i = 0; i < logs.length; i += 200) {
    const { error } = await supabase.from("activity_log").insert(logs.slice(i, i + 200));
    if (error) throw error;
  }
  console.log(`\nDone. ${patches.length} updated, ${inserts.length} new, ${logs.length} timeline rows.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
