#!/usr/bin/env node
// Teach the CRM what was already done to these leads.
//
//   T65_PASSWORD=... node scripts/backfill-prior-work.mjs [--dry-run]
//
// The book carries the LAST OUTCOME for ~1,400 leads (from the tracker years
// and from OSCR) but not when it happened, not how many attempts it took, and
// no history at all — activity_log holds 90 rows for 4,853 leads. The result:
// the queue can't tell a lead called last week from one called in November,
// and a lead someone dialed nine times looked brand new.
//
// Three things happen here, and one thing deliberately does NOT:
//
//   1. last_contact_date is filled from OSCR's last disposition date, where
//      OSCR actually has one.
//   2. dials_count is filled from the "dispositioned Nx" note the OSCR
//      converter writes.
//   3. Every lead with prior work gets ONE activity_log row of type "History"
//      so the drawer timeline stops being blank.
//   4. NO DATE IS INVENTED. A lead worked at an unknown time gets dials_count
//      1 (enough to stop it reading as never-dialed) and keeps a null date. A
//      made-up date would sort the queue wrongly and lie in the stats forever.
//
// "History" rows are typed that way on purpose: the Stats page counts Call /
// Door Knock activity, so backfilled history can't inflate this week's numbers.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

const HISTORY_TYPE = "History";

function dispCountFromNotes(notes) {
  const m = String(notes || "").match(/dispositioned\s+(\d+)\s*x/i);
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function priorOutcome(l) {
  const disp = String(l.oscr_latest_disp || "").trim();
  const status = String(l.status || "").trim();
  if (status && status.toLowerCase() !== "new") return status;
  if (disp && disp.toLowerCase() !== "no_disposition") return `OSCR: ${disp}`;
  return null;
}

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
      .select(
        "id, name, source, status, dials_count, last_contact_date, raw_notes, oscr_latest_disp, oscr_last_disp_date, created_at"
      )
      .range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`${rows.length} leads in the book`);

  const { data: existingLog } = await supabase
    .from("activity_log")
    .select("lead_id")
    .eq("activity_type", HISTORY_TYPE);
  const alreadyLogged = new Set((existingLog || []).map((r) => r.lead_id));

  const patches = [];
  const logs = [];
  const stats = { dated: 0, counted: 0, markedWorked: 0, timeline: 0, skipped: 0 };

  for (const l of rows) {
    const outcome = priorOutcome(l);
    if (!outcome && !l.oscr_last_disp_date) continue; // genuinely untouched

    const patch = {};
    if (!l.last_contact_date && l.oscr_last_disp_date) {
      patch.last_contact_date = String(l.oscr_last_disp_date).slice(0, 10);
      stats.dated += 1;
    }
    const counted = dispCountFromNotes(l.raw_notes);
    if (!(Number(l.dials_count) > 0)) {
      if (counted > 0) {
        patch.dials_count = counted;
        stats.counted += 1;
      } else {
        // Worked, timing unknown. One attempt is the floor, and it's enough to
        // stop the speed-to-lead bonus firing on somebody else's work.
        patch.dials_count = 1;
        stats.markedWorked += 1;
      }
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      patches.push({ id: l.id, patch });
    } else {
      stats.skipped += 1;
    }

    if (!alreadyLogged.has(l.id)) {
      logs.push({
        lead_id: l.id,
        activity_type: HISTORY_TYPE,
        // Real date when one exists; otherwise the import date, so the row
        // sorts sanely without claiming the call happened then.
        activity_date: l.last_contact_date || l.oscr_last_disp_date || l.created_at,
        outcome: outcome || "Worked before this CRM",
        notes: [
          l.source ? `source ${l.source}` : null,
          counted ? `dispositioned ${counted}x in OSCR` : null,
          !l.last_contact_date && !l.oscr_last_disp_date ? "date unknown" : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
        logged_by: "Import",
      });
      stats.timeline += 1;
    }
  }

  console.log("\nPlan");
  console.log(`  real last-contact dates recovered from OSCR   ${stats.dated}`);
  console.log(`  dial counts recovered from the OSCR notes     ${stats.counted}`);
  console.log(`  worked-but-undated, marked as 1 dial          ${stats.markedWorked}`);
  console.log(`  timeline rows to write                        ${stats.timeline}`);
  console.log(`  already correct, left alone                   ${stats.skipped}`);
  console.log(`  NOT touched: leads with no prior work anywhere ${rows.length - patches.length - stats.skipped}`);

  if (dryRun) {
    console.log("\n[DRY RUN] nothing written.");
    return;
  }

  let n = 0;
  for (const { id, patch } of patches) {
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (error) throw error;
    if (++n % 200 === 0) console.log(`  leads ${n}/${patches.length}`);
  }
  for (let i = 0; i < logs.length; i += 200) {
    const { error } = await supabase.from("activity_log").insert(logs.slice(i, i + 200));
    if (error) throw error;
    console.log(`  timeline ${Math.min(i + 200, logs.length)}/${logs.length}`);
  }
  console.log(`\nDone. ${patches.length} leads updated, ${logs.length} history rows written.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
