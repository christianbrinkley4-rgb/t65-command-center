#!/usr/bin/env node
// Import a cleaned OSCR CSV (from oscr_xlsx_to_csv.py) into the CRM.
//
//   T65_PASSWORD=... node scripts/import-oscr-csv.mjs path/to/clean.csv [--dry-run]
//
// Three ways a row can land, checked in this order:
//   1. Same OSCR lead ID already here  -> refresh the OSCR fields on it.
//   2. Same phone as an existing lead  -> that's the same person from a tracker
//      import. Attach the OSCR ID and fill only BLANK fields. Never a new row.
//   3. Otherwise                       -> insert.
//
// What is never touched on an existing lead: status, stage, notes, follow-ups,
// appointments. Tags are only ever ADDED to (the import stamps a `list:` tag so
// a lead on two lists belongs to both). OSCR is the system of record for
// compliance; the CRM is the system of record for the work. do_not_call is SET,
// never cleared — a DNC lead stays labeled and dialable-with-warning, and stays
// out of the automatic queue.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

function canonPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : "";
}

// How a number is written down. Bought lists arrive as bare ten-digit strings
// and a column of 3369405598 is unreadable at the speed you dial. Mirrors
// formatPhone in src/lib/phone.ts — keep the two in step. Anything that isn't
// exactly ten digits, or carries an extension, is left exactly as it came.
function fmtPhone(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  if (/\b(?:x|ext\.?|extension)\b/i.test(raw)) return raw;
  const d = canonPhone(raw);
  if (d.length !== 10) return raw;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

const nameParts = (v) => {
  const w = String(v || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  return { first: w[0] || "", last: w.length > 1 ? w[w.length - 1] : "" };
};

/**
 * Is this the same person, or just the same household?
 * Couples share a landline, so a phone match alone is not identity — merging on
 * it silently drops the spouse. Require the names to agree too (a blank name on
 * the existing record, or matching last name with a first name that matches or
 * abbreviates: Kathy/Katherine).
 */
function samePerson(existingName, incomingName) {
  const a = nameParts(existingName);
  const b = nameParts(incomingName);
  if (!a.first && !a.last) return true; // nothing to contradict
  if (a.last && b.last && a.last !== b.last) return false;
  if (!a.first || !b.first) return true;
  if (a.first === b.first) return true;
  const [s, l] = a.first.length <= b.first.length ? [a.first, b.first] : [b.first, a.first];
  return s.length >= 3 && l.startsWith(s);
}

// "OSCR:Turning 65" is not a category — the whole book is turning 65, so it
// made a filter entry that could never narrow anything. Those leads are filed
// by the MONTH they turn 65 (derived from the birthday by the converter), and
// the source stays the plain channel. Other OSCR pulls keep their label.
// Mirrors normalizeSource in src/lib/categories.ts.
function normalizeSource(source) {
  const v = String(source || "").trim();
  if (/^oscr\s*:?\s*turning\s*65$/i.test(v)) return "OSCR";
  return v || "Unknown";
}

/** A list tag is only worth adding when it names something. "Turning 65" doesn't. */
function listLabel(leadSource) {
  const v = String(leadSource || "").trim();
  return /^turning\s*65$/i.test(v) ? "" : v;
}


function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (q && s[i + 1] === '"') { cell += '"'; i++; }
      else if (q) q = false;
      else if (cell === "") q = true;
      else cell += '"';
    } else if (!q && c === ",") { row.push(cell); cell = ""; }
    else if (!q && (c === "\n" || c === "\r")) {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  const headers = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] || "").trim()])));
}

async function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!file) throw new Error("Usage: node scripts/import-oscr-csv.mjs <clean.csv> [--dry-run]");
  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL, password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  const incoming = parseCsv(readFileSync(file, "utf8"));
  console.log(`${incoming.length} leads in ${file}`);

  // Whole book, paged (the client caps a page at 1000).
  let existing = [], from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, name, phone, phone2, oscr_lead_id, do_not_call, address, city, county, zip, birthday, tags")
      .range(from, from + 999);
    if (error) throw error;
    existing = existing.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`${existing.length} leads already in the CRM`);

  // A street key that survives formatting differences between sources:
  // "1631 BANTAM RD" / "1631 Bantam Road, Pleasant Garden, NC" -> "1631 bantam".
  const streetKey = (v) => {
    const first = String(v || "").split(",")[0].toLowerCase();
    return first
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\b(street|st|road|rd|drive|dr|lane|ln|court|ct|circle|cir|avenue|ave|place|pl|boulevard|blvd|trail|trl|way|terrace|ter|parkway|pkwy|loop|run|point|pt|ridge|rdg|cove|cv)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  const personKeyOf = (name, addr) => {
    const n = nameParts(name);
    return `${n.first}|${n.last}|${streetKey(addr)}`;
  };

  const byOscr = new Map();
  const byPhone = new Map();
  const byNameAddr = new Map();
  for (const l of existing) {
    if (l.oscr_lead_id) byOscr.set(l.oscr_lead_id, l);
    for (const p of [canonPhone(l.phone), canonPhone(l.phone2)]) {
      if (p && !byPhone.has(p)) byPhone.set(p, l);
    }
    // Address-only lists (neighborhood reports) have no phone to dedupe on.
    if (l.name && l.address) {
      const k = personKeyOf(l.name, l.address);
      if (!byNameAddr.has(k)) byNameAddr.set(k, l);
    }
  }

  const now = new Date().toISOString();
  const inserts = [];
  const updates = [];
  const stats = { insert: 0, refreshOscr: 0, mergePhone: 0, dncSet: 0, skippedNoPhone: 0, sameFileDupe: 0 };
  // One existing lead can absorb only one incoming row — otherwise a second
  // match overwrites the first one's OSCR id and that lead vanishes.
  const claimed = new Set();
  // Same person listed twice in the file (OSCR sometimes carries two IDs for
  // one person) collapses; a spouse on the same line does not.
  const insertedPeople = new Set();

  for (const r of incoming) {
    const oscrId = r["OSCR lead ID"];
    const phone = canonPhone(r["Primary phone"]);
    const isDnc = (r["Phone status"] || "").toUpperCase() === "DNC";

    // Compliance fields, safe to refresh on every sync. The oscr_* linkage only
    // applies to real OSCR exports; neighborhood lists carry no lead ID.
    const oscrFields = {
      callable: !isDnc,
      sms_consent: false,
      email_consent: false,
      updated_at: now,
    };
    if (oscrId) {
      oscrFields.oscr_lead_id = oscrId;
      oscrFields.oscr_lead_source = r["Lead source"] || null;
      oscrFields.oscr_latest_disp = r["Latest disp."] || null;
      oscrFields.oscr_last_disp_date = r["Last disp. date"] || null;
      oscrFields.oscr_synced_at = now;
    }
    if (isDnc) oscrFields.do_not_call = true; // only ever set, never cleared

    const phoneMatch = phone ? byPhone.get(phone) : null;
    const candidate =
      (oscrId && byOscr.get(oscrId)) ||
      (phoneMatch && samePerson(phoneMatch.name, r["Name"]) ? phoneMatch : null) ||
      byNameAddr.get(personKeyOf(r["Name"], r["Street"])) ||
      null;
    const match = candidate && !claimed.has(candidate.id) ? candidate : null;
    if (match) claimed.add(match.id);

    // The same person can appear twice in one file — same name, same number,
    // two addresses (a house and a PO box, or a second property). One of the
    // two claims the lead; the other has to be recognised as the same person or
    // it becomes a duplicate row.
    //
    // This key used to be registered only when a row was INSERTED, which made
    // the importer safe to run once and unsafe to run twice. On a re-run the
    // first twin MERGES rather than inserts, so the key was never registered,
    // the second twin couldn't claim the already-claimed lead, and it inserted.
    // Re-running June created 5 duplicates that way — and every instruction in
    // this repo, the verifier's own advice included, says to re-run an import
    // to fill gaps. Registering the key on a merge too makes a second run a
    // no-op, which is what re-runnable was always supposed to mean.
    const dupeKey =
      phone || r["Street"]
        ? phone
          ? `${phone}|${nameParts(r["Name"]).first}|${nameParts(r["Name"]).last}`
          : personKeyOf(r["Name"], r["Street"])
        : "";
    if (dupeKey && !match && insertedPeople.has(dupeKey)) { stats.sameFileDupe++; continue; }
    if (dupeKey) insertedPeople.add(dupeKey);

    if (match) {
      const patch = { ...oscrFields };
      // No list: tag. The app stopped reading them on 2026-08-28 — the only
      // list it has is a mailer drop, and the birth-month filter covers what
      // "T65 December" used to say. `source` still records which file a lead
      // came off. Tags on an existing lead are left exactly as they are.
      // Fill only what's blank on the existing record; never overwrite work.
      if (!match.address && r["Street"]) patch.address = r["Street"];
      if (!match.city && r["City"]) patch.city = r["City"];
      if (!match.county && r["County"]) patch.county = r["County"];
      if (!match.zip && r["Zip code"]) patch.zip = r["Zip code"];
      if (!match.birthday && r["Birthday"]) patch.birthday = r["Birthday"];
      // A second real line on the same person, only when it's actually
      // different from the one already on file (the same number arrives in two
      // formats constantly, and a "2nd" button that redials the first is worse
      // than no button at all).
      //
      // BOTH of the file's numbers are candidates, not just the secondary one.
      // A lead is often matched BY the file's secondary — that's the number the
      // tracker had — and looking only at "Secondary phone" then finds it
      // already on file and stops, quietly throwing the file's primary away.
      // That left 123 people across the seven 2026/27 lists holding one line
      // when the list carried two.
      //
      // Fill a blank PRIMARY before touching the second slot. There was no rule
      // for `phone` at all, only for `phone2`, so a lead already in the book
      // with no number got the file's line written into `phone2` and kept an
      // empty `phone`. 121 people book-wide ended up that way: the list row
      // reads "no phone", the CSV export goes out blank, and their only working
      // number sits in the "2nd" slot. Blanks only — a number already on file
      // is still never replaced.
      if (!match.phone) {
        const first = [r["Primary phone"], r["Secondary phone"]].find((v) => {
          const d = canonPhone(v);
          return d && d !== canonPhone(match.phone2);
        });
        if (first) patch.phone = fmtPhone(first);
      }
      if (!match.phone2) {
        // patch.phone counts as on file — otherwise the number just placed in
        // the primary slot is a candidate to be copied into the second one.
        const onFile = new Set(
          [canonPhone(match.phone), canonPhone(patch.phone), canonPhone(match.phone2)].filter(Boolean)
        );
        const spare = [r["Secondary phone"], r["Primary phone"]].find((v) => {
          const d = canonPhone(v);
          return d && !onFile.has(d);
        });
        if (spare) patch.phone2 = fmtPhone(spare);
      }
      if (isDnc && !match.do_not_call) stats.dncSet++;
      updates.push({ id: match.id, patch });
      if (byOscr.has(oscrId)) stats.refreshOscr++;
      else stats.mergePhone++;
      continue;
    }

    if (!phone && !r["Street"]) { stats.skippedNoPhone++; continue; }
    inserts.push({
      source: oscrId ? normalizeSource(`OSCR:${r["Lead source"] || "Unknown"}`) : r["Lead source"] || "Imported list",
      assigned_to: "Both",
      name: r["Name"] || null,
      phone: fmtPhone(r["Primary phone"]),
      phone2:
        r["Secondary phone"] &&
        canonPhone(r["Secondary phone"]) &&
        canonPhone(r["Secondary phone"]) !== canonPhone(r["Primary phone"])
          ? fmtPhone(r["Secondary phone"])
          : null,
      address: r["Street"] || null,
      city: r["City"] || null,
      county: r["County"] || null,
      zip: r["Zip code"] || null,
      state: r["State"] || "NC",
      birthday: r["Birthday"] || null,
      status: "New",
      stage_bucket: "New Prospecting",
      // No list tag (see the note on the update path above), but an EMPTY
      // ARRAY, not null: leads.tags is a NOT NULL text[]. Writing null used to
      // work and now takes down the whole insert batch — 2,019 June leads
      // failed on the first chunk of 200 with "null value in column tags
      // violates not-null constraint", and the plan printed above it looked
      // exactly like a successful run.
      tags: [],
      raw_notes: r["Notes"] || null,
      ...oscrFields,
      do_not_call: isDnc,
    });
    stats.insert++;
    if (isDnc) stats.dncSet++;
  }

  console.log("\nPlan");
  console.log(`  new leads to insert            ${stats.insert}`);
  console.log(`  existing OSCR leads refreshed  ${stats.refreshOscr}`);
  console.log(`  merged onto existing by phone  ${stats.mergePhone}  (no duplicate row created)`);
  console.log(`  newly flagged do-not-call      ${stats.dncSet}`);
  console.log(`  same person twice in the file  ${stats.sameFileDupe} (collapsed)`);
  console.log(`  skipped (no phone, no address) ${stats.skippedNoPhone}`);
  if (dryRun) { console.log("\n[DRY RUN] nothing written."); return; }

  for (let i = 0; i < inserts.length; i += 200) {
    const { error } = await supabase.from("leads").insert(inserts.slice(i, i + 200));
    if (error) throw error;
  }
  for (const u of updates) {
    const { error } = await supabase.from("leads").update(u.patch).eq("id", u.id);
    if (error) console.warn(`update ${u.id} failed: ${error.message}`);
  }
  console.log(`\nWrote ${inserts.length} new leads and updated ${updates.length}.`);
  console.log("Next: node scripts/enrich-home-value.mjs && node scripts/geocode-leads.mjs");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
