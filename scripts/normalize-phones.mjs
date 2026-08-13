#!/usr/bin/env node
// Write every phone number in the book the same way: 336-273-7565.
//
//   T65_PASSWORD=... node scripts/normalize-phones.mjs            (dry run)
//   T65_PASSWORD=... node scripts/normalize-phones.mjs --write
//
// The book grew from four sources with four habits. Bought T65 lists arrive as
// bare ten-digit strings, the trackers carried "(336) 421-9302", OSCR used
// dots, and anything typed by hand looks like whatever the typist felt like. A
// column mixing 3369405598 and (336) 421-9302 is slow to read and easy to
// misdial, and reading a number off the screen onto a keypad happens dozens of
// times a day.
//
// This only ever rewrites the FORMAT. canonicalPhone() sees no difference
// before and after, so nothing that depends on a number — duplicate detection,
// DNC suppression by phone, the dialer, call history — can shift underneath it.
// The check below proves that per row rather than trusting it.
//
// Anything that isn't exactly ten digits is left alone: extensions, short
// numbers, international numbers, and the handful of rows where somebody typed
// a note into the phone field. Those are all real information, and a formatter
// that guessed would destroy them.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

/** Mirrors canonicalPhone in src/lib/phone.ts. */
export function canonPhone(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).split(/\s*(?:x|ext\.?|extension)\b/i)[0];
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return d;
}

/** Mirrors formatPhone in src/lib/phone.ts. Keep the two in step. */
export function fmtPhone(v) {
  if (v === null || v === undefined) return "";
  const raw = String(v).trim();
  if (!raw) return "";
  if (/\b(?:x|ext\.?|extension)\b/i.test(raw)) return raw;
  const d = canonPhone(raw);
  if (d.length !== 10) return raw;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** The rewrite for one lead, or null when nothing needs to change. */
export function repatch(lead) {
  const patch = {};
  for (const field of ["phone", "phone2"]) {
    const before = lead[field];
    if (before === null || before === undefined || String(before).trim() === "") continue;
    const after = fmtPhone(before);
    if (after === String(before)) continue;
    // The safety property, checked per row: the number itself must not move.
    if (canonPhone(after) !== canonPhone(before)) {
      throw new Error(`Refusing to rewrite ${lead.id} ${field}: "${before}" -> "${after}" changes the number`);
    }
    patch[field] = after;
  }
  return Object.keys(patch).length ? patch : null;
}

async function main() {
  const write = process.argv.includes("--write");
  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  let rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, name, phone, phone2")
      .range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`${rows.length} leads in the book`);

  const work = [];
  const leftAlone = [];
  for (const l of rows) {
    const patch = repatch(l);
    if (patch) work.push({ l, patch });
    else {
      for (const f of ["phone", "phone2"]) {
        const v = String(l[f] ?? "").trim();
        if (v && canonPhone(v).length !== 10) leftAlone.push(`${l.name || l.id} ${f}="${v}"`);
      }
    }
  }
  console.log(`${work.length} leads need reformatting`);
  console.log(`${leftAlone.length} numbers left alone (not ten digits, or carry an extension)`);

  console.log("\nA sample of what changes:");
  for (const { l, patch } of work.slice(0, 10)) {
    const bits = Object.entries(patch).map(([f, v]) => `${l[f]} -> ${v}`);
    console.log(`  ${String(l.name || "unnamed").slice(0, 22).padEnd(22)} ${bits.join("  |  ")}`);
  }
  if (leftAlone.length) {
    console.log("\nLeft alone:");
    for (const s of leftAlone.slice(0, 10)) console.log("  " + s);
  }

  if (!write) {
    console.log("\n[DRY RUN] nothing written. Add --write to apply.");
    return;
  }
  if (work.length === 0) return;

  let done = 0;
  for (const { l, patch } of work) {
    const { error } = await supabase
      .from("leads")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", l.id);
    if (error) throw error;
    done += 1;
    if (done % 250 === 0) console.log(`  ${done}/${work.length}`);
  }
  console.log(`\nDone. ${done} leads now read the same way.`);
}

// Only when run directly, so the rules can be imported and checked on their own.
if (process.argv[1] && process.argv[1].endsWith("normalize-phones.mjs")) {
  main().catch((e) => {
    console.error("\n" + (e.message || e));
    process.exitCode = 1;
  });
}
