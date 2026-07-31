// The deploy build. Use this, never a bare `next build`.
//
// The app is served from https://ncwealthprotection.me/t65/, so every asset URL
// has to carry the /t65 prefix. That prefix comes from an environment variable
// read by next.config.js, which means a plain `next build` produces a build
// that looks completely fine — it compiles, the pages generate, the file sizes
// are right — and then hangs on "Loading…" the moment it's live, because every
// script tag points at /_next instead of /t65/_next.
//
// That already shipped once. Setting the variable by hand is not a process, so
// it lives here instead, along with a check that the output actually came out
// with the prefix before anyone pushes it.
//
// Passing the variable inline is also platform-dependent in a way that bites on
// this machine: cmd.exe has no `VAR=x cmd` syntax at all, and Git Bash's MSYS
// path conversion silently rewrites "/t65" into "C:/Program Files/Git/t65".
// Spawning from Node sidesteps both.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_PATH = "/t65";
const root = process.cwd();

// Run Next's own entry point directly. Going through `npx` would need a shell,
// and a shell is what mangles the path on this machine in the first place.
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const res = spawnSync(process.execPath, [nextBin, "build"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_BASE_PATH: BASE_PATH },
});

if (res.status !== 0) process.exit(res.status ?? 1);

// Verify rather than trust. A build with the wrong prefix is indistinguishable
// from a good one until it's in front of an agent mid-dial.
const page = join(root, "out", "index.html");
if (!existsSync(page)) {
  console.error("\nBuild finished but out/index.html is missing. Nothing to deploy.");
  process.exit(1);
}
const html = readFileSync(page, "utf8");
const prefixed = (html.match(/"\/t65\/_next\//g) || []).length;
const bare = (html.match(/"\/_next\//g) || []).length;

if (prefixed === 0 || bare > 0) {
  console.error(
    `\nWrong asset prefix: ${prefixed} tags on ${BASE_PATH}/_next, ${bare} on bare /_next.` +
      `\nThis build would hang on "Loading…" in production. Not safe to deploy.`
  );
  process.exit(1);
}

console.log(`\nBuild OK for ${BASE_PATH} — ${prefixed} asset refs prefixed, 0 bare.`);
