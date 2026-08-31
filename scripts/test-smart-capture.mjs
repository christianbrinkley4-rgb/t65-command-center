#!/usr/bin/env node
// Who does a captured note belong to?
//
// This exists because the answer was wrong for months in a way nobody could
// see. "Will" is a teammate's name and the most common auxiliary verb in a
// follow-up note, and the old pattern matched `will call` / `will follow` /
// `will take`, so "i will call her tuesday" handed the task to Will. So did
// "she said she will call back", which is the prospect talking. The note looked
// right, the task went to the wrong queue, and the person who made the promise
// never got the reminder.
//
// The patterns are READ OUT OF THE SOURCE FILE rather than copied here. A test
// that keeps its own copy of a regex passes forever while the shipped one
// rots, which for this particular bug is worse than having no test at all.
//
// Run: npm test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "lib", "smartCapture.ts"), "utf8");
const types = readFileSync(join(root, "src", "lib", "types.ts"), "utf8");

/** Pull `const NAME = /regex/;` out of the source and rebuild it here. */
function regexFromSource(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*(/.*/[gimsuy]*);`));
  if (!m) {
    console.error(`Could not find ${name} in src/lib/smartCapture.ts.`);
    console.error("If it was renamed or reshaped, update this test to match — do not delete it.");
    process.exit(1);
  }
  const body = m[1].slice(1, m[1].lastIndexOf("/"));
  const flags = m[1].slice(m[1].lastIndexOf("/") + 1);
  return new RegExp(body, flags);
}

const WILL_AS_VERB = regexFromSource("WILL_AS_VERB");
const WILL_AS_NAME = regexFromSource("WILL_AS_NAME");
const SPEAKER = regexFromSource("SPEAKER");

const assigneeMatch = types.match(/ACTION_ASSIGNEES\s*=\s*\[([^\]]+)\]/);
const ACTION_ASSIGNEES = assigneeMatch
  ? assigneeMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  : [];

// Mirrors parseAssignee() in src/lib/smartCapture.ts. Only the control flow is
// duplicated; every pattern above came from the source.
function parseAssignee(text, me) {
  const t = text.toLowerCase();
  const speaker = ACTION_ASSIGNEES.includes(me) ? me : "Either";
  const withoutAuxiliary = t.replace(WILL_AS_VERB, " ");
  if (WILL_AS_NAME.test(withoutAuxiliary)) return "Will";
  if (/\bchristian\b/.test(t)) return "Christian";
  if (SPEAKER.test(t)) return speaker;
  return "Either";
}

// [note, who is signed in, expected owner]
const cases = [
  // The regression. Future tense is a verb, never the name.
  ["i will call her tuesday", "Christian", "Christian"],
  ["i will follow up friday", "Christian", "Christian"],
  ["i will take this one", "Christian", "Christian"],
  ["i will reach out after his birthday", "Christian", "Christian"],
  ["she said she will call back", "Christian", "Either"],
  ["he will be home after 6", "Christian", "Either"],
  ["they will think about it", "Christian", "Either"],
  ["the husband will decide", "Christian", "Either"],

  // The same words typed by Will belong to Will, not to a hardcoded name.
  ["i will call her tuesday", "Will", "Will"],
  ["i'll swing by thursday", "Will", "Will"],

  // Real handoffs still reach him.
  ["give it to will", "Christian", "Will"],
  ["for will to handle", "Christian", "Will"],
  ["ask will to call him", "Christian", "Will"],
  ["tell will she is interested", "Christian", "Will"],
  ["will's client, he should take it", "Christian", "Will"],
  ["will can handle this one", "Christian", "Will"],
  ["will needs to run the quote", "Christian", "Will"],
  ["send will the details", "Christian", "Will"],
  ["have will follow up", "Christian", "Will"],

  ["christian should take this", "Will", "Christian"],

  // Self-reference resolves to whoever is signed in.
  ["call me back monday", "Will", "Will"],
  ["my lead, i got it", "Christian", "Christian"],

  // An agent the app does not know yet gets a SHARED task. A wrong name is
  // invisible; a shared task is visible to everyone including them.
  ["i will call her tuesday", "Dana", "Either"],
  ["i'll handle it", "Dana", "Either"],
  ["give it to will", "Dana", "Will"],

  // Nobody named, nobody assigned.
  ["not home, try again next week", "Christian", "Either"],
  ["left a door hanger", "Christian", "Either"],
];

let pass = 0;
const failures = [];
for (const [note, me, expected] of cases) {
  const got = parseAssignee(note, me);
  if (got === expected) pass += 1;
  else failures.push(`  signed in as ${me}: ${JSON.stringify(note)}\n    expected ${expected}, got ${got}`);
}

if (failures.length) {
  console.error(`\nSmart Capture assignee: ${failures.length} of ${cases.length} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Smart Capture assignee: ${pass}/${cases.length} passed.`);
