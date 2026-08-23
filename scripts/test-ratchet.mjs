#!/usr/bin/env node
// Test ratchet: the set of failing tests may SHRINK freely, but may only GROW
// through a deliberate, reviewed edit of test-baseline.json.
//
// Why this exists: `candidate_tests` in pinned-deploy-promote.sh is an
// ALLOWLIST of hand-picked suite files. It can only ever protect what someone
// remembered to add, so red accumulates everywhere else unnoticed — which is
// how the 2026-08-22 shared-extractor refactor shipped with
// antigravity-local/parse.test.ts already failing, and how a large red set
// accrued on the serving branch without anyone seeing it.
//
// Usage:
//   node scripts/test-ratchet.mjs check   --results <vitest.json> [--baseline <path>]
//   node scripts/test-ratchet.mjs seed    --results <vitest.json> [--baseline <path>]
//
// `check` exits non-zero when a failing test is NOT in the baseline.
// `seed` writes a fresh baseline from a results file (a deliberate act).

import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASELINE = "test-baseline.json";

function usage(msg) {
  if (msg) console.error(`test-ratchet: ${msg}`);
  console.error(`
Usage:
  node scripts/test-ratchet.mjs check --results <vitest-json> [--baseline <path>] [--update-on-shrink]
  node scripts/test-ratchet.mjs seed  --results <vitest-json> [--baseline <path>] [--reason <text>] [--owner <name>]

Produce <vitest-json> with:  npx vitest run --reporter=json --outputFile=<path>
`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

// A test's identity is file + full name. Vitest's JSON reporter emits both, and
// neither depends on run order or on how the suites were sharded, so the same
// test yields the same id whether it ran alone or in a full-repo run.
function testId(fileName, fullName) {
  const rel = path.relative(process.cwd(), fileName).replaceAll(path.sep, "/");
  return `${rel} :: ${fullName}`;
}

function readResults(file) {
  if (!file || file === true) usage("--results <vitest-json> is required");
  if (!fs.existsSync(file)) usage(`results file not found: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    usage(`results file is not valid JSON (${err.message})`);
  }
  const suites = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  const failing = [];
  let total = 0;
  for (const suite of suites) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    // A suite that fails to load reports status "failed" with no assertions —
    // an import error or a syntax error. That must not read as "nothing failed".
    if (assertions.length === 0 && suite.status === "failed") {
      failing.push(testId(suite.name, "<suite failed to run>"));
      total += 1;
      continue;
    }
    for (const a of assertions) {
      total += 1;
      if (a.status === "failed") failing.push(testId(suite.name, a.fullName));
    }
  }
  return { failing: [...new Set(failing)].sort(), total, suiteCount: suites.length };
}

function readBaseline(file) {
  if (!fs.existsSync(file)) return { known: [], missing: true };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const known = Array.isArray(parsed.known) ? parsed.known : [];
  // Every entry needs a reason and an owner. Enforcing it here is what stops
  // the baseline quietly becoming a dumping ground: adding one is a visible,
  // reviewable diff rather than a silent append.
  const malformed = known.filter((e) => !e || !e.id || !e.reason || !e.owner);
  return { known, malformed, raw: parsed };
}

function cmdCheck(args) {
  const baselinePath = typeof args.baseline === "string" ? args.baseline : DEFAULT_BASELINE;
  const { failing, total, suiteCount } = readResults(args.results);
  const { known, malformed, missing } = readBaseline(baselinePath);

  if (missing) {
    console.error(`test-ratchet: no baseline at ${baselinePath}. Seed one with:  node scripts/test-ratchet.mjs seed --results <vitest-json>`);
    process.exit(1);
  }
  if (malformed.length > 0) {
    console.error(`test-ratchet: ${malformed.length} baseline entr${malformed.length === 1 ? "y" : "ies"} missing id/reason/owner:`);
    for (const e of malformed.slice(0, 10)) console.error(`  - ${JSON.stringify(e)}`);
    process.exit(1);
  }

  const knownIds = new Set(known.map((e) => e.id));
  const regressions = failing.filter((id) => !knownIds.has(id));
  const fixed = [...knownIds].filter((id) => !failing.includes(id)).sort();

  console.log(`test-ratchet: ${total} tests across ${suiteCount} suites; ${failing.length} failing; baseline holds ${knownIds.size}`);

  if (fixed.length > 0) {
    console.log(`test-ratchet: ${fixed.length} baselined test${fixed.length === 1 ? "" : "s"} now GREEN — remove from ${baselinePath}:`);
    for (const id of fixed.slice(0, 25)) console.log(`  + ${id}`);
    if (fixed.length > 25) console.log(`  … and ${fixed.length - 25} more`);
  }

  if (regressions.length > 0) {
    console.error(`test-ratchet: FAIL — ${regressions.length} failing test${regressions.length === 1 ? "" : "s"} not in the baseline:`);
    for (const id of regressions.slice(0, 40)) console.error(`  - ${id}`);
    if (regressions.length > 40) console.error(`  … and ${regressions.length - 40} more`);
    process.exit(1);
  }

  if (args["update-on-shrink"] && fixed.length > 0) {
    const { raw } = readBaseline(baselinePath);
    raw.known = known.filter((e) => failing.includes(e.id));
    raw.updatedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(baselinePath, `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`test-ratchet: tightened ${baselinePath} to ${raw.known.length} entries`);
  }

  console.log("test-ratchet: PASS — no new failures");
}

function cmdSeed(args) {
  const baselinePath = typeof args.baseline === "string" ? args.baseline : DEFAULT_BASELINE;
  const { failing, total, suiteCount } = readResults(args.results);
  const reason = typeof args.reason === "string" ? args.reason : "pre-existing failure captured at baseline seed; not yet triaged";
  const owner = typeof args.owner === "string" ? args.owner : "unassigned";
  const today = new Date().toISOString().slice(0, 10);
  const doc = {
    $comment:
      "Known-failing tests. The ratchet gate fails on any failing test NOT listed here. "
      + "Entries may be removed freely (and should be, as they get fixed). Adding one is a "
      + "deliberate act: it needs a reason and an owner, and it shows up in review.",
    updatedAt: today,
    seededFrom: { total, suiteCount, failing: failing.length },
    known: failing.map((id) => ({ id, reason, owner, since: today })),
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`test-ratchet: seeded ${baselinePath} with ${failing.length} known-failing tests (of ${total} across ${suiteCount} suites)`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === "check") cmdCheck(args);
else if (cmd === "seed") cmdSeed(args);
else usage(cmd ? `unknown command "${cmd}"` : null);
