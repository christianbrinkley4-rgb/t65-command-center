#!/usr/bin/env node
// Did every row of a bought list actually land, and land labeled?
//
//   T65_PASSWORD=... node scripts/verify-list-import.mjs "T65 2092 April 1962 NC Birthdays.xlsx"
//   T65_PASSWORD=... node scripts/verify-list-import.mjs clean.csv --list "T65 April"
//
// Read-only. Nothing is written, ever.
//
// An import that half worked looks exactly like one that worked: the console
// said "1699 leads", the book got bigger, and nobody counts 1699 rows by hand.
// This counts them.
//
// It reproduces import-oscr-csv.mjs's matching rules on purpose — phone plus a
// name check, then name-and-street — because a verifier with its own idea of
// identity reports failures that aren't there. Keep the two in step.
//
// Three separate questions, because they have three different answers:
//
//   IS IT HERE      matched to a lead in the book at all
//   IS IT LABELED   carries the list, either as `source` or as a `list:` tag.
//                   Both count. A lead already in the book keeps whatever
//                   source it had and gets the tag added, so checking `source`
//                   alone reports people as unlabeled who are filed correctly.
//   BOTH NUMBERS    a row with two lines put both on the lead, not just one.
//                   The importer only fills phone2 when it's blank AND the
//                   number differs from phone, so a lead that arrived earlier
//                   with one number can quietly stay on one number.

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

// ── the importer's rules, copied verbatim ────────────────────────────────────

export function canonPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : "";
}

const nameParts = (v) => {
  const w = String(v || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  return { first: w[0] || "", last: w.length > 1 ? w[w.length - 1] : "" };
};

export function samePerson(existingName, incomingName) {
  const a = nameParts(existingName);
  const b = nameParts(incomingName);
  if (!a.first && !a.last) return true;
  if (a.last && b.last && a.last !== b.last) return false;
  if (!a.first || !b.first) return true;
  if (a.first === b.first) return true;
  const [s, l] = a.first.length <= b.first.length ? [a.first, b.first] : [b.first, a.first];
  return s.length >= 3 && l.startsWith(s);
}

export const streetKey = (addr) => {
  const first = String(addr || "").split(",")[0].trim().toLowerCase();
  return first
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(street|st|road|rd|drive|dr|lane|ln|court|ct|circle|cir|avenue|ave|place|pl|boulevard|blvd|trail|trl|way|terrace|ter|parkway|pkwy|loop|run|point|pt|ridge|rdg|cove|cv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

export const personKeyOf = (name, addr) => {
  const n = nameParts(name);
  return `${n.first}|${n.last}|${streetKey(addr)}`;
};

export function listTagFor(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `list:${slug}` : "";
}

export function parseCsv(text) {
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

/** An .xlsx goes through the same converter the import used. */
export function toCsv(path) {
  if (path.toLowerCase().endsWith(".csv")) return readFileSync(path, "utf8");
  const out = join(mkdtempSync(join(tmpdir(), "t65-verify-")), "list.csv");
  const py = spawnSync("python", ["scripts/t65_birthday_list_to_csv.py", out, path], {
    encoding: "utf8",
  });
  if (py.status !== 0 || !existsSync(out)) {
    throw new Error(
      `Couldn't convert that workbook.\n${py.stderr || py.stdout || "python not found"}`
    );
  }
  process.stdout.write(py.stdout);
  return readFileSync(out, "utf8");
}

const sample = (arr, n = 8) => arr.slice(0, n);
const pct = (n, of) => (of === 0 ? "0" : ((n / of) * 100).toFixed(1));

async function main() {
  const listArg = process.argv.indexOf("--list");
  // Every argument that isn't a flag is a file. Several months in one run reads
  // the book once instead of once per list, and prints one summary at the end.
  const files = process.argv.slice(2).filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (listArg > -1 && i + 2 === listArg + 1) return false;
    return true;
  });
  if (files.length === 0) {
    throw new Error('Usage: node scripts/verify-list-import.mjs <list.xlsx|clean.csv> [more…] [--list "T65 April"]');
  }
  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  let existing = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, name, phone, phone2, address, city, source, tags, birthday, do_not_call, status")
      .range(from, from + 999);
    if (error) throw error;
    existing = existing.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const live = existing.filter((l) => String(l.status || "").trim().toLowerCase() !== "closed - merged");
  console.log(`${live.length} leads in the book\n`);

  const byPhone = new Map();
  const byNameAddr = new Map();
  for (const l of live) {
    for (const p of [canonPhone(l.phone), canonPhone(l.phone2)]) {
      if (p && !byPhone.has(p)) byPhone.set(p, l);
    }
    if (l.name && l.address) {
      const k = personKeyOf(l.name, l.address);
      if (!byNameAddr.has(k)) byNameAddr.set(k, l);
    }
  }

  const totals = { rows: 0, landed: 0, missing: 0, unlabeled: 0, oneNumberOnly: 0, two: 0 };

  /** One list against the book. `claimed` is per file, exactly as the import ran. */
  function checkOne(file) {
  const incoming = parseCsv(toCsv(file));
  if (incoming.length === 0) {
    console.log(`\n${file}: no rows. Skipped.`);
    return;
  }
  // The converter stamps the list on every row, so the file names itself.
  const listName = listArg > -1 ? process.argv[listArg + 1] : incoming[0]["Lead source"] || "";
  const tag = listTagFor(listName);
  console.log(`\n${"=".repeat(72)}\n${incoming.length} rows, list "${listName}" (tag ${tag})`);

  const claimed = new Set();
  const missing = [];
  const unlabeled = [];
  const oneNumberOnly = [];
  const unimportable = [];
  const fileDupes = [];
  const seenInFile = new Set();
  const matchedIds = new Set();
  let twoNumberRows = 0;
  let dncRows = 0;
  let dncMissingFlag = 0;

  for (const r of incoming) {
    const phone = canonPhone(r["Primary phone"]);
    const alt = canonPhone(r["Secondary phone"]);
    const hasTwo = Boolean(phone && alt && alt !== phone);
    if (hasTwo) twoNumberRows++;
    const isDnc = (r["Phone status"] || "").toUpperCase() === "DNC";
    if (isDnc) dncRows++;

    // The importer skips these outright, so they were never going to land.
    if (!phone && !r["Street"]) { unimportable.push(r); continue; }

    const dupeKey = phone
      ? `${phone}|${nameParts(r["Name"]).first}|${nameParts(r["Name"]).last}`
      : personKeyOf(r["Name"], r["Street"]);
    if (seenInFile.has(dupeKey)) { fileDupes.push(r); continue; }
    seenInFile.add(dupeKey);

    const phoneMatch = phone ? byPhone.get(phone) : null;
    const candidate =
      (phoneMatch && samePerson(phoneMatch.name, r["Name"]) ? phoneMatch : null) ||
      byNameAddr.get(personKeyOf(r["Name"], r["Street"])) ||
      null;
    const match = candidate && !claimed.has(candidate.id) ? candidate : null;
    if (!match) { missing.push(r); continue; }
    claimed.add(match.id);
    matchedIds.add(match.id);

    const labeled =
      String(match.source || "").trim().toLowerCase() === listName.trim().toLowerCase() ||
      (match.tags || []).some((t) => String(t).toLowerCase() === tag);
    if (!labeled) unlabeled.push({ r, match });

    if (hasTwo) {
      const on = new Set([canonPhone(match.phone), canonPhone(match.phone2)].filter(Boolean));
      if (!on.has(phone) || !on.has(alt)) oneNumberOnly.push({ r, match });
    }
    if (isDnc && !match.do_not_call) dncMissingFlag++;
  }

  const landed = incoming.length - missing.length - unimportable.length - fileDupes.length;

  console.log("Did it land");
  console.log(`  in the book                 ${landed} of ${incoming.length} (${pct(landed, incoming.length)}%)`);
  console.log(`  NOT FOUND                   ${missing.length}`);
  console.log(`  same person twice in file   ${fileDupes.length}  (collapsed on purpose)`);
  console.log(`  no phone and no address     ${unimportable.length}  (the importer skips these)`);

  console.log("\nIs it labeled");
  console.log(`  carries "${listName}"        ${landed - unlabeled.length} of ${landed}`);
  console.log(`  MISSING THE LABEL           ${unlabeled.length}`);

  console.log("\nBoth numbers");
  console.log(`  rows with two lines         ${twoNumberRows}`);
  console.log(`  MISSING THE SECOND          ${oneNumberOnly.length}`);

  console.log("\nCompliance");
  console.log(`  DNC rows in the file        ${dncRows}`);
  console.log(`  matched but not flagged     ${dncMissingFlag}`);

  // The other direction: leads wearing this list that the file doesn't contain.
  const wearingLabel = live.filter(
    (l) =>
      String(l.source || "").trim().toLowerCase() === listName.trim().toLowerCase() ||
      (l.tags || []).some((t) => String(t).toLowerCase() === tag)
  );
  const extra = wearingLabel.filter((l) => !matchedIds.has(l.id));
  console.log(`\n${wearingLabel.length} leads in the book wear this list; ${extra.length} of them are not in this file.`);

  const show = (title, rows, fmt) => {
    if (rows.length === 0) return;
    console.log(`\n${title} (first ${Math.min(8, rows.length)} of ${rows.length}):`);
    for (const x of sample(rows)) console.log("  " + fmt(x));
  };
  show("Not found in the book", missing, (r) =>
    `${String(r["Name"]).padEnd(24)} ${String(r["Primary phone"] || "no phone").padEnd(12)} ${r["Street"] || ""}, ${r["City"] || ""}`
  );
  show("In the book but not labeled", unlabeled, ({ r, match }) =>
    `${String(r["Name"]).padEnd(24)} source="${match.source || ""}" tags=[${(match.tags || []).join(", ")}]`
  );
  show("Only one of their two numbers", oneNumberOnly, ({ r, match }) =>
    `${String(r["Name"]).padEnd(24)} file ${r["Primary phone"]}/${r["Secondary phone"]}  book ${match.phone || "-"}/${match.phone2 || "-"}`
  );
  show("Skipped: no phone and no address", unimportable, (r) => `${r["Name"]} (${r["City"] || "no city"})`);
  show("Wearing the label but not in this file", extra, (l) =>
    `${String(l.name).padEnd(24)} ${l.phone || "no phone"}  ${l.address || ""}`
  );

  totals.rows += incoming.length;
  totals.landed += landed;
  totals.missing += missing.length;
  totals.unlabeled += unlabeled.length;
  totals.oneNumberOnly += oneNumberOnly.length;
  totals.two += twoNumberRows;
  }

  for (const f of files) checkOne(f);

  if (files.length > 1) {
    console.log(`\n${"=".repeat(72)}\nAll ${files.length} lists`);
    console.log(`  rows                        ${totals.rows}`);
    console.log(`  in the book                 ${totals.landed}`);
    console.log(`  NOT FOUND                   ${totals.missing}`);
    console.log(`  MISSING THE LABEL           ${totals.unlabeled}`);
    console.log(`  rows with two lines         ${totals.two}`);
    console.log(`  MISSING THE SECOND          ${totals.oneNumberOnly}`);
  }

  const clean = totals.missing === 0 && totals.unlabeled === 0 && totals.oneNumberOnly === 0;
  console.log(
    clean
      ? "\nEvery importable row is in the book, labeled, with both numbers where the file had two."
      : "\nRe-running the import fixes the gaps: it fills blanks and adds tags, and never overwrites work."
  );
}

// Only when run directly, so the matching rules can be imported and checked.
if (process.argv[1] && process.argv[1].endsWith("verify-list-import.mjs")) {
  main().catch((e) => {
    console.error("\n" + (e.message || e));
    process.exit(1);
  });
}
