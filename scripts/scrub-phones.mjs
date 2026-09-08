#!/usr/bin/env node
// Type every number in the book as cell or landline, for free, so the queue
// dials the mobiles first.
//
//   T65_PASSWORD=... node scripts/scrub-phones.mjs              (dry run)
//   T65_PASSWORD=... node scripts/scrub-phones.mjs --write
//
// Options:
//   --write        save the prefix cache and apply line types to leads
//   --limit N      stop after fetching N new prefixes (default: all of them)
//   --refetch-days N  re-fetch cached prefixes older than N days (default: never)
//
// WHY THIS IS FREE AND THE VENDORS ARE NOT
//
// Paid scrubs bill per NUMBER. But cell-versus-landline is a property of the
// six-digit BLOCK a number was issued from, not of the number, and block
// assignments are public record. This book's 5,952 callable numbers come from
// 1,785 distinct prefixes. So it is 1,785 free lookups, once, and then every
// lead sharing a prefix is typed for nothing, forever, including every future
// import. RealPhoneValidation quoted $0.019 a number, which is $82 for the
// leads turning 65 next year alone, and would be payable again on the next list.
//
// ACCURACY, MEASURED NOT ASSUMED
//
// Checked against 149 numbers that had already been typed by a paid vendor.
// Excluding CLEC blocks it agreed 124 times out of 130, which is 95%. CLEC
// blocks (company-type C) hold both ported cells and ported landlines and
// cannot be told apart from the block alone, so they are stored as "unknown"
// rather than guessed at. They are 13% of the book.
//
// WHAT THIS DOES NOT DO, AND WHY THAT IS FINE
//
// It does not tell you a line is dead. Only a live switch query does that, and
// that is the thing costing $0.019. The arithmetic says skip it. In this book
// dead numbers are 88% landline while the book itself is 38% landline, which
// works out at roughly 63% of landlines being dead against 5% of mobiles.
// Calling the mobiles first drops the wasted-dial rate from 27% to about 5% at
// no cost. The last five points are what the $82 would buy.
//
// NOTHING IS DELETED AND NOTHING IS CLOSED. Line type is a sort key. Landlines
// sink, they do not disappear, and an unknown sorts between the two.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE";
const LOGIN_EMAIL = process.env.T65_EMAIL || "team@bankerst65.com";
const LOGIN_PASSWORD = process.env.T65_PASSWORD || "";

// They 403 an unset user agent, so say who this is.
const UA = "Mozilla/5.0 (compatible; T65CommandCenter/1.0; +bankerst65.com)";
const PREFIX_URL = "https://localcallingguide.com/xmlprefix.php";

/** Mirrors canonicalPhone in src/lib/phone.ts. */
function canonPhone(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).split(/\s*(?:x|ext\.?|extension)\b/i)[0];
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return d;
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  // Carrier names really do contain ampersands ("SOUTHERN BELL TEL &amp; TEL"),
  // and this string is going into the database to be read by a person.
  return m[1]
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
};

/**
 * W is a wireless carrier, I is the incumbent telephone company, C is a
 * competitive carrier. C is left unknown on purpose: those blocks hold ported
 * numbers of both kinds and every one of the misses in the accuracy check was
 * a C being forced into an answer.
 */
function lineTypeOf(companyType) {
  if (companyType === "W") return "mobile";
  if (companyType === "I") return "fixed_line";
  return "unknown";
}

async function fetchPrefix(npa, nxx) {
  const res = await fetch(`${PREFIX_URL}?npa=${npa}&nxx=${nxx}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  // An unassigned prefix comes back as a well-formed document with no
  // prefixdata block. That is an answer, not a failure: nobody owns the block.
  if (!xml.includes("<prefixdata>")) return { company_type: null, company_name: null, line_type: "unknown" };
  const company_type = tag(xml, "company-type") || null;
  return {
    company_type,
    company_name: tag(xml, "company-name") || null,
    line_type: lineTypeOf(company_type),
  };
}

async function main() {
  const write = process.argv.includes("--write");
  const limit = Number(arg("--limit", 0)) || Infinity;
  const refetchDays = Number(arg("--refetch-days", 0));

  if (!LOGIN_PASSWORD) throw new Error("Set T65_PASSWORD in the environment first.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
  });
  if (authErr) throw new Error(`Sign-in failed: ${authErr.message}`);

  // ---- 1. Every prefix the book actually uses ----
  const need = new Map(); // "npanxx" -> count of leads
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("leads")
      .select("phone, phone2, do_not_call, stage_bucket")
      .not("phone", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    for (const l of data) {
      if (l.do_not_call || l.stage_bucket === "Closed") continue;
      for (const p of [l.phone, l.phone2]) {
        const d = canonPhone(p);
        if (d.length === 10) need.set(d.slice(0, 6), (need.get(d.slice(0, 6)) || 0) + 1);
      }
    }
    if (data.length < 1000) break;
  }

  // ---- 2. What's already cached ----
  const cached = new Set();
  const stale = refetchDays > 0 ? new Date(Date.now() - refetchDays * 86400000).toISOString() : null;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("phone_prefixes")
      .select("npa, nxx, fetched_at")
      .order("npa")
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data) {
      if (stale && r.fetched_at < stale) continue;
      cached.add(`${r.npa}${r.nxx}`);
    }
    if (data.length < 1000) break;
  }

  const todo = [...need.keys()].filter((p) => !cached.has(p)).sort();
  console.log(`${need.size} prefixes cover ${[...need.values()].reduce((a, b) => a + b, 0)} numbers`);
  console.log(`${cached.size} already cached, ${todo.length} to fetch${write ? "" : "   [DRY RUN]"}\n`);

  // ---- 3. Fetch the missing ones ----
  const tally = { mobile: 0, fixed_line: 0, unknown: 0 };
  let fetched = 0;
  let failed = 0;
  let consecutiveFails = 0;

  for (const p of todo.slice(0, limit === Infinity ? todo.length : limit)) {
    const npa = p.slice(0, 3);
    const nxx = p.slice(3, 6);
    let r;
    try {
      r = await fetchPrefix(npa, nxx);
      consecutiveFails = 0;
    } catch (e) {
      failed++;
      consecutiveFails++;
      console.log(`  ! ${npa}-${nxx}  ${e.message}`);
      // A free public service that starts refusing is a reason to stop and come
      // back later, not to hammer it 1,700 more times.
      if (consecutiveFails >= 8) {
        console.log(`\n  Eight failures in a row, stopping. Try again later.`);
        break;
      }
      continue;
    }
    tally[r.line_type] = (tally[r.line_type] || 0) + 1;
    fetched++;
    if (write) {
      const { error } = await supabase.from("phone_prefixes").upsert({ npa, nxx, ...r, fetched_at: new Date().toISOString() });
      if (error) console.log(`  ! save ${npa}-${nxx}: ${error.message}`);
    }
    if (fetched % 50 === 0) process.stdout.write(".");
    // Someone else's free service. Roughly three a second.
    await new Promise((s) => setTimeout(s, 350));
  }

  console.log(`\n\n${fetched} prefixes fetched, ${failed} failed`);
  for (const [k, v] of Object.entries(tally)) {
    if (v) console.log(`  ${k.padEnd(12)} ${String(v).padStart(5)}   ${((100 * v) / fetched).toFixed(0)}%`);
  }

  if (!write) {
    console.log(`\n[DRY RUN] nothing saved. Add --write to cache these and type the book.`);
    return;
  }

  // ---- 4. Stamp the leads ----
  //
  // Done here rather than as a database view because phone_type is read on
  // every scoring pass over ~9,000 leads, and a join per pass to answer a
  // question whose answer never changes is a waste. Written once, read forever.
  console.log(`\nApplying line types to leads...`);
  const { data: prefixRows, error: pErr } = await supabase
    .from("phone_prefixes")
    .select("npa, nxx, line_type")
    .neq("line_type", "unknown");
  if (pErr) throw pErr;
  const typeOf = new Map(prefixRows.map((r) => [`${r.npa}${r.nxx}`, r.line_type]));

  let updated = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, phone, phone2, phone_type, phone2_type")
      .not("phone", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    for (const l of data) {
      const patch = {};
      const t1 = typeOf.get(canonPhone(l.phone).slice(0, 6));
      const t2 = typeOf.get(canonPhone(l.phone2 || "").slice(0, 6));
      if (t1 && t1 !== l.phone_type) patch.phone_type = t1;
      if (t2 && t2 !== l.phone2_type) patch.phone2_type = t2;
      if (!Object.keys(patch).length) continue;
      const { error: uErr } = await supabase
        .from("leads")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", l.id);
      if (!uErr) updated++;
    }
    if (data.length < 1000) break;
  }

  console.log(`${updated} leads typed. Mobiles now sort above landlines in every queue.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
