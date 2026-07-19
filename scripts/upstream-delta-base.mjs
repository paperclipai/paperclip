#!/usr/bin/env node
// upstream-delta-base.mjs — canonical "where does the next upstream delta start?" resolver.
//
// WHY THIS EXISTS (NEO-565): the weekly upstream-review routine used to compute the delta as
// `git merge-base <fork-line> upstream/master` … `upstream/master`. That is WRONG whenever the
// previous integration PR was **squash-merged** (our default merge mode): a squash merge produces
// a single-parent commit on master, so `upstream/master`'s history is NOT an ancestor of master and
// `git merge-base` keeps resolving to the *previous* upstream tip. The next run would then re-detect
// every already-integrated commit as a phantom conflict.
//
// The robust fix (option 2 in NEO-565) is to drive the delta from the **ledger**, not from git
// ancestry: `doc/upstream-fork-delta-ledger.md` records the exact "Upstream tip integrated" SHA for
// every run. The next delta is always `git log <last-recorded-tip>..upstream/master`, which is
// correct by construction regardless of squash vs. merge-commit history.
//
// This is preferred over recording ancestry via `git merge -s ours upstream/master` (option 1) or
// switching to `--no-ff` true merges (option 3) because BOTH of those inject upstream's full
// ancestry into the master line, which inflates the NEO-522 weekly deploy train's cut enumeration
// (`git rev-list/log <LKG>..<candidate>` in scripts/cortex-release-handoff.sh / cortex-deploy.sh).
// Keeping squash merges keeps the deploy-train changelog clean; the ledger keeps upstream tracking correct.
//
// Usage:
//   node scripts/upstream-delta-base.mjs                 # print the canonical base SHA (last ledger tip)
//   node scripts/upstream-delta-base.mjs --range         # print "<base>..upstream/master"
//   node scripts/upstream-delta-base.mjs --range --ref origin/some-ref
//   node scripts/upstream-delta-base.mjs --check         # + compare vs git merge-base; warn on squash drift
//   node scripts/upstream-delta-base.mjs --ledger <path> # override ledger path (default: doc/upstream-fork-delta-ledger.md)
//
// Exit codes: 0 = base resolved (drift is reported, NOT an error — it is the expected squash condition).
//             2 = could not resolve a tip from the ledger (malformed/empty table) — real failure.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_LEDGER = resolve(REPO_ROOT, "doc/upstream-fork-delta-ledger.md");
const DEFAULT_REF = "upstream/master";

function parseArgs(argv) {
  const args = { range: false, check: false, ref: DEFAULT_REF, ledger: DEFAULT_LEDGER };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--range") args.range = true;
    else if (a === "--check") args.check = true;
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--ledger") args.ledger = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// Extract the "Upstream tip integrated" SHA from the LAST data row of the "## Integrated points"
// table. Data rows start with `|` and have a YYYY-MM-DD date in the first cell; the tip is the first
// backtick-wrapped hex SHA (7–40 chars) in the second cell (bold `**...**` wrapping tolerated).
export function extractLatestTip(markdown) {
  const rows = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[0])) continue; // skip header / separator / prose rows
    const m = cells[1].match(/`([0-9a-f]{7,40})`/i);
    if (!m) continue;
    rows.push({ date: cells[0], tip: m[1] });
  }
  if (rows.length === 0) return null;
  return rows[rows.length - 1]; // ledger is append-only chronological; last row = latest run
}

function git(args) {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 27).join("\n").replace(/^\/\/ ?/gm, ""));
    return 0;
  }

  const markdown = readFileSync(args.ledger, "utf8");
  const latest = extractLatestTip(markdown);
  if (!latest) {
    console.error(
      `upstream-delta-base: could not find any "Upstream tip integrated" SHA in ${args.ledger}.\n` +
        `The Integrated points table must have at least one dated row with a backtick-wrapped SHA.`,
    );
    return 2;
  }

  if (!args.range && !args.check) {
    console.log(latest.tip);
    return 0;
  }

  if (args.range) {
    console.log(`${latest.tip}..${args.ref}`);
  }

  if (args.check) {
    // The squash-drift guard: if git merge-base disagrees with the ledger tip, a prior integration
    // was squash-merged and merge-base is STALE. This is expected and handled — surface it loudly so
    // no future run silently reverts to merge-base and re-detects phantom conflicts.
    console.error(`# upstream-delta-base (NEO-565 squash-safe delta guard)`);
    console.error(`ledger:                 ${args.ledger}`);
    console.error(`last integrated tip:    ${latest.tip}  (${latest.date})  ← use THIS as the delta base`);
    console.error(`canonical delta range:  git log ${latest.tip}..${args.ref}`);

    const mb = git(["merge-base", "HEAD", args.ref]);
    if (!mb.ok) {
      console.error(`git merge-base HEAD ${args.ref}: unavailable (${mb.err || "no ref"}) — ledger tip is authoritative.`);
    } else if (mb.out.startsWith(latest.tip) || latest.tip.startsWith(mb.out)) {
      console.error(`git merge-base:         ${mb.out}  ✅ matches ledger tip (true-merge ancestry intact).`);
    } else {
      console.error(`git merge-base:         ${mb.out}  ⚠️  DIFFERS from ledger tip.`);
      console.error(
        `⚠️  SQUASH DRIFT DETECTED: a prior integration was squash-merged, so \`git merge-base\` is STALE.\n` +
          `    Do NOT compute the delta from merge-base — it would re-surface already-integrated commits as\n` +
          `    phantom conflicts. Use the ledger tip: \`git log ${latest.tip}..${args.ref}\`. (NEO-565)`,
      );
    }
  }
  return 0;
}

// Only run the CLI when executed directly — importing (e.g. from the test) must NOT exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
