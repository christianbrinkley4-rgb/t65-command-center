#!/usr/bin/env node
// Convert, import and verify a batch of "T65 <N> NC <Month> <Year> Birthdays"
// workbooks in one pass.
//
//   T65_PASSWORD=... node scripts/import-t65-birthday-lists.mjs "a.xlsx" "b.xlsx" ...
//   T65_PASSWORD=... node scripts/import-t65-birthday-lists.mjs --dry-run "a.xlsx"
//
// Three steps per file, the same three anyone would run by hand:
//
//   1. python scripts/t65_birthday_list_to_csv.py OUT.csv FILE.xlsx
//   2. node   scripts/import-oscr-csv.mjs OUT.csv
//   3. node   scripts/verify-list-import.mjs FILE.xlsx
//
// Step 3 is the point. An import that half worked looks exactly like one that
// worked — the console says a number, the book gets bigger, and nobody counts
// two thousand rows by hand. This stops on the first failure rather than
// carrying on and reporting a total that includes a file that never landed.
//
// The password is read from the environment and never passed as an argument,
// so it stays out of the shell history and out of the process list.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const files = args.filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error(
    'Usage: T65_PASSWORD=... node scripts/import-t65-birthday-lists.mjs "list.xlsx" ["another.xlsx" ...]'
  );
  process.exit(1);
}
if (!process.env.T65_PASSWORD) {
  console.error("T65_PASSWORD is not set. Nothing was read or written.");
  process.exit(1);
}

const missing = files.filter((f) => !existsSync(f));
if (missing.length) {
  console.error("These files don't exist:\n  " + missing.join("\n  "));
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "t65-import-"));
const python = process.env.PYTHON || "python";

/** Run a step, echoing it, and stop the whole batch if it fails. */
function step(label, cmd, cmdArgs) {
  console.log(`\n  ${label}`);
  const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    console.error(`\nFAILED: ${label}`);
    console.error("Stopping here so the rest of the batch isn't reported as done.");
    process.exit(res.status ?? 1);
  }
}

console.log(`${files.length} list${files.length === 1 ? "" : "s"} to load${dryRun ? "  (dry run)" : ""}`);

for (const file of files) {
  const name = basename(file);
  console.log(`\n${"=".repeat(70)}\n${name}\n${"=".repeat(70)}`);

  const csv = join(work, name.replace(/\.xlsx$/i, "") + ".csv");
  step("convert", python, ["scripts/t65_birthday_list_to_csv.py", csv, file]);

  const importArgs = ["scripts/import-oscr-csv.mjs", csv];
  if (dryRun) importArgs.push("--dry-run");
  step(dryRun ? "import (dry run)" : "import", process.execPath, importArgs);

  if (dryRun) {
    console.log("\n  verify skipped on a dry run — nothing was written to check.");
    continue;
  }
  step("verify", process.execPath, ["scripts/verify-list-import.mjs", file]);
}

console.log(
  `\n${"=".repeat(70)}\nAll ${files.length} list${files.length === 1 ? "" : "s"} converted, imported and verified.\n` +
    "Anything reported above as NOT HERE is a row that did not land — re-run that file.\n"
);
