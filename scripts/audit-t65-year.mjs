#!/usr/bin/env node
// Which T65 season is actually in the book, and where the off-season rows came from.
//
//   T65_PASSWORD=... node scripts/audit-t65-year.mjs [--season 2026]
//
// Read-only. Nothing is written, ever.
//
// The T65 badge is birth year plus 65 and nothing else, so a lead reading
// "T65 Dec 2027" has a birthday of December 1962 on file. This says how many of
// those there are, which lists they arrived on, and — the part that decides
// what to do about them — whether their birth dates are real.
//
// The tell is the DAY. A bought T65 birthday list stamps a placeholder day on
// every row (the May file reads 5/1/1962 all the way down; see
// scripts/t65_birthday_list_to_csv.py). So:
//
//   almost all day 01  → the vendor's file was a 1962 season list. The year is
//                        the vendor's, the data is internally honest, and the
//                        question is whether that list should have been bought.
//   days spread out    → real dates of birth. If they cluster in Sep-Dec, that
//                        is the signature of a birth year derived as
//                        "this year minus their age", which lands a year late
//                        for anyone whose birthday hasn't happened yet.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Same rule as turning65Date() in src/lib/priority.ts. Keep the two in step. */
export function t65Parts(birthday) {
  const m = String(birthday || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!(year >= 1900 && year <= 2010) || month < 1 || month > 12) return null;
  return { t65Year: year + 65, month, day, birthYear: year };
}

/** A row is a tombstone once it's been merged into another lead. */
const isMerged = (l) => String(l.status || "").trim().toLowerCase() === "closed - merged";

function bar(n, max, width = 28) {
  return "#".repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / Math.max(max, 1)) * width)));
}

function tallyList(map, limit = 12) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function main() {
  const seasonArg = process.argv.indexOf("--season");
  const season = seasonArg > -1 ? Number(process.argv[seasonArg + 1]) : 2026;
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
      .select("id, name, birthday, source, tags, city, status, stage_bucket, created_at")
      .range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const live = rows.filter((l) => !isMerged(l));
  console.log(`${live.length} leads in the book (${rows.length - live.length} merged rows ignored)\n`);

  const noBirthday = live.filter((l) => !t65Parts(l.birthday));
  const dated = live.filter((l) => t65Parts(l.birthday));

  // ── which season is in the book ──────────────────────────────────────────
  const byYear = new Map();
  for (const l of dated) {
    const y = t65Parts(l.birthday).t65Year;
    byYear.set(y, (byYear.get(y) || 0) + 1);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const max = Math.max(...byYear.values());
  console.log("Turns 65 in:");
  for (const y of years) {
    const n = byYear.get(y);
    const pct = ((n / dated.length) * 100).toFixed(1);
    console.log(`  ${y}  ${String(n).padStart(5)}  ${pct.padStart(5)}%  ${bar(n, max)}`);
  }
  if (noBirthday.length) console.log(`  none ${String(noBirthday.length).padStart(5)}         no birthday on file`);

  // ── the off-season rows ──────────────────────────────────────────────────
  const off = dated.filter((l) => t65Parts(l.birthday).t65Year !== season);
  console.log(`\n${off.length} leads are not the ${season} season.`);
  if (off.length === 0) return;

  const laterOnly = off.filter((l) => t65Parts(l.birthday).t65Year > season);
  const earlierOnly = off.filter((l) => t65Parts(l.birthday).t65Year < season);
  console.log(`  ${laterOnly.length} turn 65 after ${season} (too early to enroll)`);
  console.log(`  ${earlierOnly.length} turned 65 before ${season} (window already closed)`);

  const bySource = new Map();
  const byMonth = new Map();
  const byDay = new Map();
  const openOff = [];
  for (const l of off) {
    const p = t65Parts(l.birthday);
    const src = l.source || "(no source)";
    bySource.set(src, (bySource.get(src) || 0) + 1);
    const key = `${MONTHS[p.month - 1]} ${p.t65Year}`;
    byMonth.set(key, (byMonth.get(key) || 0) + 1);
    byDay.set(p.day, (byDay.get(p.day) || 0) + 1);
    const closed = l.stage_bucket === "Closed" || String(l.status || "").toLowerCase().startsWith("closed");
    if (!closed) openOff.push(l);
  }

  console.log("\nWhich lists they came in on:");
  for (const [src, n] of tallyList(bySource)) {
    console.log(`  ${String(n).padStart(5)}  ${src}`);
  }

  console.log("\nWhen they turn 65:");
  for (const [k, n] of tallyList(byMonth, 16)) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }

  // The day-of-month tell: placeholder list, or real dates of birth.
  const onFirst = byDay.get(1) || 0;
  const share = ((onFirst / off.length) * 100).toFixed(0);
  console.log(`\nBirth day-of-month: ${onFirst} of ${off.length} (${share}%) fall on the 1st.`);
  if (onFirst / off.length > 0.8) {
    console.log("  → placeholder days. These came off a bought birthday list whose file");
    console.log("    was for that season. The year is the vendor's, not an import bug.");
  } else {
    const lateMonths = off.filter((l) => t65Parts(l.birthday).month >= 9).length;
    console.log("  → real dates of birth, so the year came from the source data.");
    console.log(`    ${lateMonths} of ${off.length} were born Sep-Dec. If that's most of them,`);
    console.log("    the birth year was likely derived from an age and is one year late.");
  }

  console.log(`\n${openOff.length} of the off-season leads are still open (not closed out),`);
  console.log("so they are sitting in the working queues today.");

  console.log("\nA sample:");
  for (const l of off.slice(0, 12)) {
    const p = t65Parts(l.birthday);
    console.log(
      `  ${String(l.name || "unnamed").slice(0, 22).padEnd(22)}  born ${l.birthday}  ` +
        `T65 ${MONTHS[p.month - 1]} ${p.t65Year}  ${String(l.source || "").slice(0, 24)}`
    );
  }
}

// Only when run directly, so t65Parts() can be imported and checked on its own.
if (process.argv[1] && process.argv[1].endsWith("audit-t65-year.mjs")) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
