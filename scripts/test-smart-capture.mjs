#!/usr/bin/env node
// Smart Capture reads a plain-English note and decides three things: who the
// task belongs to, when to bring the lead back, and what happened. All three
// were wrong in ways nobody could see from the screen.
//
//   "i will call her tuesday"        → the task went to Will
//   "he's 64 years old"              → the callback was scheduled for 2090
//   "already signed up with humana"  → the lead was closed as SOLD
//
// Every one of those looked fine in the review panel. The patterns below are
// READ OUT OF THE SOURCE FILE rather than copied here, because a test that
// keeps its own copy of a regex passes forever while the shipped one rots,
// which for these bugs is worse than having no test at all.
//
// Run: npm test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "lib", "smartCapture.ts"), "utf8");
const types = readFileSync(join(root, "src", "lib", "types.ts"), "utf8");

/** Pull `const NAME = /regex/;` (possibly wrapped onto the next line) out of the source. */
function regexFromSource(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*(/.*/[gimsuy]*);`));
  if (!m) {
    console.error(`\nCould not find ${name} in src/lib/smartCapture.ts.`);
    console.error("If it was renamed or reshaped, update this test to match — do not delete it.");
    process.exit(1);
  }
  const lastSlash = m[1].lastIndexOf("/");
  return new RegExp(m[1].slice(1, lastSlash), m[1].slice(lastSlash + 1));
}

let pass = 0;
let total = 0;
const failures = [];

function check(label, got, expected) {
  total += 1;
  if (got === expected) pass += 1;
  else failures.push(`  ${label}\n    expected ${expected}, got ${got}`);
}

// ── who does it belong to ────────────────────────────────────────────────────

const WILL_AS_VERB = regexFromSource("WILL_AS_VERB");
const WILL_AS_NAME = regexFromSource("WILL_AS_NAME");
const SPEAKER = regexFromSource("SPEAKER");

const assigneeMatch = types.match(/ACTION_ASSIGNEES\s*=\s*\[([^\]]+)\]/);
const ACTION_ASSIGNEES = assigneeMatch
  ? assigneeMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  : [];

// Mirrors parseAssignee(). Only the control flow is duplicated; every pattern
// came from the source above.
function parseAssignee(text, me) {
  const t = text.toLowerCase();
  const speaker = ACTION_ASSIGNEES.includes(me) ? me : "Either";
  if (WILL_AS_NAME.test(t.replace(WILL_AS_VERB, " "))) return "Will";
  if (/\bchristian\b/.test(t)) return "Christian";
  if (SPEAKER.test(t)) return speaker;
  return "Either";
}

for (const [note, me, expected] of [
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
  // invisible; a shared task is visible to everyone, including them.
  ["i will call her tuesday", "Dana", "Either"],
  ["i'll handle it", "Dana", "Either"],
  ["give it to will", "Dana", "Will"],

  // Nobody named, nobody assigned.
  ["not home, try again next week", "Christian", "Either"],
  ["left a door hanger", "Christian", "Either"],
]) {
  check(`assignee, signed in as ${me}: ${JSON.stringify(note)}`, parseAssignee(note, me), expected);
}

// ── what happened ────────────────────────────────────────────────────────────

const ALREADY_COVERED = regexFromSource("ALREADY_COVERED");
const IS_A_SALE = regexFromSource("IS_A_SALE");

function outcome(note) {
  const t = note.toLowerCase();
  if (ALREADY_COVERED.test(t)) return "covered";
  if (IS_A_SALE.test(t)) return "sale";
  return "neither";
}

for (const [note, expected] of [
  // Somebody else got there first. A lost lead, never revenue.
  ["already signed up with humana", "covered"],
  ["signed up with aetna in january", "covered"],
  ["she signed with another agent", "covered"],
  ["signed up for a group plan at work", "covered"],
  ["already enrolled, call at aep", "covered"],
  ["has an advisor he likes", "covered"],

  // Somebody's life story, not a transaction.
  ["he sold his house last year", "neither"],
  ["sold cars for 30 years, nice guy", "neither"],
  ["signed the visitor book at church", "neither"],

  // Real sales.
  ["wrote him up for plan g", "sale"],
  ["got the sale, plan n", "sale"],
  ["closed the deal today", "sale"],
  ["sold her a plan g", "sale"],
  ["took the app, application submitted", "sale"],
  ["she bought plan g", "sale"],
]) {
  check(`outcome ${JSON.stringify(note)}`, outcome(note), expected);
}

// ── when to bring it back ────────────────────────────────────────────────────

const AGE_TRAILING = regexFromSource("AGE_TRAILING");
const AGE_LEADING = regexFromSource("AGE_LEADING");

/** Mirrors the number-and-unit branch of parseTimeframe, age guard included. */
function durationDays(note) {
  const t = note.toLowerCase();
  const m = t.match(/(\d+)\s*(day|week|month|year)s?/);
  if (!m) return null;
  const at = m.index ?? 0;
  const before = t.slice(Math.max(0, at - 14), at);
  const after = t.slice(at + m[0].length, at + m[0].length + 6);
  if (AGE_TRAILING.test(after) || AGE_LEADING.test(before)) return null;
  const n = Number(m[1]);
  const unit = m[2];
  return unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
}

for (const [note, expected] of [
  // An age is not a timeframe. These used to land in 2089 and 2090.
  ["he's 64 years old, turning 65 in november", null],
  ["wife is 63 years old", null],
  ["she is 64 years", null],
  ["turning 65 years old in march", null],

  // Real durations still parse.
  ["call back in 3 days", 3],
  ["follow up in 2 weeks", 14],
  ["check back in 6 months", 180],
  ["retiring in 1 year", 365],
]) {
  check(`duration ${JSON.stringify(note)}`, durationDays(note), expected);
}

/** Mirrors the weekday branch: next occurrence, 1 to 7 days out. */
const WEEKDAYS = [
  [/\bsunday\b/, 0],
  [/\bmonday\b/, 1],
  [/\btues(day)?\b/, 2],
  [/\bwed(nes)?(day)?\b/, 3],
  [/\bthurs(day)?\b/, 4],
  [/\bfriday\b/, 5],
  [/\bsaturday\b/, 6],
];

function weekdayDelta(note, todayDow) {
  const t = note.toLowerCase();
  for (const [re, target] of WEEKDAYS) {
    if (!re.test(t)) continue;
    let delta = (target - todayDow + 7) % 7;
    if (delta === 0) delta = 7;
    if (/\bnext\s+\w*(sun|mon|tues|wed|thurs|fri|satur)/.test(t) && delta <= 3) delta += 7;
    return delta;
  }
  return null;
}

// Today is Monday (dow 1) for every case below.
for (const [note, expected] of [
  ["come back tuesday", 1],
  ["call her wednesday morning", 2],
  ["she said thursday after 6", 3],
  ["try again friday", 4],
  ["saturday if he's around", 5],
  ["sunday after church", 6],
  // Saying Monday on a Monday means the next one, not today.
  ["monday works for him", 7],
  // "Next Tuesday" when Tuesday is tomorrow means the one after.
  ["next tuesday", 8],
  // No weekday named.
  ["not home", null],
  // Must not fire on words that merely contain a day.
  ["sat down with them in the sunroom", null],
]) {
  check(`weekday ${JSON.stringify(note)}`, weekdayDelta(note, 1), expected);
}

if (failures.length) {
  console.error(`\nSmart Capture: ${failures.length} of ${total} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Smart Capture: ${pass}/${total} passed (assignee, outcome, timeframe).`);
