#!/usr/bin/env node
// Retire the "OSCR:Turning 65" source.
//
//   T65_PASSWORD=... node scripts/normalize-oscr-source.mjs [--dry-run]
//
// It was never a category. Every lead in this book is turning 65, so it made a
// filter entry that could not narrow anything, while hiding the split that
// actually matters: WHICH MONTH they turn 65. That comes from the birthday and
// is derived on the fly, so it needs no column and never goes stale.
//
// This rewrites those rows to the plain channel "OSCR" and drops the matching
// `list:oscr-turning-65` tag. Other OSCR pulls are left alone — "OSCR:GLIA EBD
// Annuity" is a genuinely different kind of lead.
//
// Nothing else on the lead is touched. Imports already write the new value, so
// this is a one-time cleanup of rows that came in before that change.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

const RETIRED_TAG = "list:oscr-turning-65";

function isTurning65Source(source) {
  return /^oscr\s*:?\s*turning\s*65$/i.test(String(source || "").trim());
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
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
      .select("id, source, tags, birthday")
      .range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`${rows.length} leads in the book`);

  const targets = rows.filter(
    (l) => isTurning65Source(l.source) || (l.tags || []).includes(RETIRED_TAG)
  );
  console.log(`${targets.length} carry the retired "OSCR:Turning 65" category`);
  if (targets.length === 0) return;

  // Where they land instead. A lead with no birthday can't be filed by month,
  // and that's worth knowing: it's findable under "No birth month on file".
  const byMonth = new Map();
  let noMonth = 0;
  for (const l of targets) {
    const m = String(l.birthday || "").match(/^\d{4}-(\d{2})/);
    if (!m) {
      noMonth += 1;
      continue;
    }
    const label = MONTHS[Number(m[1]) - 1];
    byMonth.set(label, (byMonth.get(label) || 0) + 1);
  }
  console.log("\nThey file by the month they turn 65:");
  for (const label of MONTHS) {
    if (byMonth.get(label)) console.log(`  ${label.padEnd(10)} ${byMonth.get(label)}`);
  }
  if (noMonth) {
    console.log(`  ${"(no date)".padEnd(10)} ${noMonth}  <- filter "No birth month on file" to fix these`);
  }

  if (dryRun) {
    console.log("\n[DRY RUN] nothing written.");
    return;
  }

  let done = 0;
  for (const l of targets) {
    const patch = { updated_at: new Date().toISOString() };
    if (isTurning65Source(l.source)) patch.source = "OSCR";
    const tags = (l.tags || []).filter((t) => t !== RETIRED_TAG);
    if (tags.length !== (l.tags || []).length) patch.tags = tags;
    const { error } = await supabase.from("leads").update(patch).eq("id", l.id);
    if (error) throw error;
    done += 1;
    if (done % 100 === 0) console.log(`  ${done}/${targets.length}`);
  }
  console.log(`\nDone. ${done} leads moved to source "OSCR"; they now sort by T65 month.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
