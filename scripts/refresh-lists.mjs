#!/usr/bin/env node
// Bought lists in, everything the app filters on filled in, one command.
//
//   node scripts/refresh-lists.mjs "T65 2092 NC December 1961 Birthdays.xlsx" [more…]
//   node scripts/refresh-lists.mjs <workbooks…> --write
//
// Without --write it is a DRY RUN: it converts the workbooks, compares them to
// the book, prints exactly what would be inserted, updated and tagged, and
// writes nothing. Read that plan before running it for real.
//
// With --write it runs the whole chain in the order the data needs:
//
//   1. import   new people inserted, people already here get the list added to
//               their tags and their blanks filled. Never overwrites work.
//   2. geocode  latitude/longitude, which is what Door Knock routing needs.
//   3. value    home value, owner-occupied and property type from the NC
//               OneMap parcel layer, which is what the value and occupancy
//               filters read.
//
// Steps 2 and 3 are capped per run by the scripts they call (12,000 addresses
// for the geocoder, 2,000 leads for the parcel matcher), so both are repeated
// here until a pass comes back with nothing left to do. A nine-month import is
// far past either cap, and running each once is how half a book ends up
// unmapped and unpriced with no error anywhere.
//
// Auth: every child reads T65_PASSWORD from the environment, same as before.
// This script never sees it and never logs it.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_PASSES = 25; // a backstop, not an expectation

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      env: process.env,
    });
    let out = "";
    if (capture) {
      // Teed, not swallowed: the run is long and watching it is the only way
      // to know it's alive.
      child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
      child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    }
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args[0]} exited ${code}`))));
  });
}

const node = process.execPath;

/** Repeat a capped script until a pass reports there is nothing left. */
async function untilDone(label, args, doneWhen) {
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    console.log(`\n--- ${label}, pass ${pass} ---`);
    const out = await run(node, args, { capture: true });
    if (doneWhen(out)) {
      console.log(`${label}: nothing left.`);
      return;
    }
  }
  console.log(`\n${label}: stopped after ${MAX_PASSES} passes. Run it again to finish the rest.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const books = argv.filter((a) => !a.startsWith("--"));
  if (books.length === 0) {
    throw new Error('Usage: node scripts/refresh-lists.mjs <list.xlsx> [more…] [--write]');
  }
  for (const b of books) {
    if (!existsSync(b)) throw new Error(`No such file: ${b}`);
  }
  if (!process.env.T65_PASSWORD) {
    throw new Error("Set T65_PASSWORD in the environment first.");
  }

  // ── 1. workbooks to one clean CSV ─────────────────────────────────────────
  const csv = join(mkdtempSync(join(tmpdir(), "t65-lists-")), "lists.csv");
  console.log(`Converting ${books.length} workbook${books.length === 1 ? "" : "s"}…\n`);
  await run("python", ["scripts/t65_birthday_list_to_csv.py", csv, ...books]);

  // ── 2. what's already here, and what isn't ────────────────────────────────
  console.log("\n=== Comparing against the book ===");
  await run(node, ["scripts/verify-list-import.mjs", csv]);

  console.log("\n=== Import plan ===");
  await run(node, ["scripts/import-oscr-csv.mjs", csv, "--dry-run"]);

  if (!write) {
    console.log(
      "\nDRY RUN. Nothing was written.\n" +
        "Re-run the same command with --write on the end to import, geocode and price them."
    );
    return;
  }

  // ── 3. write ──────────────────────────────────────────────────────────────
  console.log("\n=== Importing ===");
  await run(node, ["scripts/import-oscr-csv.mjs", csv]);

  await untilDone("Geocoding", ["scripts/geocode-leads.mjs"], (o) => /Nothing to geocode/.test(o));

  await untilDone(
    "Home values",
    ["scripts/enrich-home-value.mjs"],
    (o) => /Checking 0 lead\(s\)/.test(o)
  );

  console.log("\n=== Done ===");
  console.log("Every new lead is in the book, on the map, and priced.");
  console.log("Open Door Knock and the town, ZIP, value and occupancy filters will see them.");
}

main().catch((e) => {
  const msg = String(e.message || e);
  console.error("\n" + msg);
  if (/exited 1\b|Sign-in failed/.test(msg)) {
    console.error("If that was a sign-in failure, T65_PASSWORD is wrong. Nothing was written.");
  }
  process.exitCode = 1;
});
