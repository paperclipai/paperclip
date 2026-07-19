import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { extractLatestTip } from "./upstream-delta-base.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MJS = join(HERE, "upstream-delta-base.mjs");

// A minimal ledger fixture shaped exactly like doc/upstream-fork-delta-ledger.md's table, including
// the squash-merged 2026-07-18 row whose "cortex-beta commit" is bold — the case that broke tracking.
const LEDGER = `# Upstream ↔ Fork Delta Ledger

## Integrated points

| Date | Upstream tip integrated | cortex-beta commit | Commits | Notes |
|------|------------------------|--------------------|---------|-------|
| 2026-07-11 | \`e4e12bfb8\` | \`bb9ae53c4\` | 391 | Initial catch-up merge. |
| 2026-07-13 | \`b49d178c4\` | \`63d31f41e\` | 10 | First weekly cadence run. |
| 2026-07-18 | \`f12bb27bc\` | **\`869183e77\`** (master, PR #42 squash-merged) | 96 | Big batch, squash-merged. |

> ⚠️ **Next-run guard.** prose row with a \`deadbeef\` sha that must be ignored.
`;

function run(args, ledgerPath) {
  return spawnSync("node", [MJS, "--ledger", ledgerPath, ...args], { encoding: "utf8" });
}

function withLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), "udb-"));
  const p = join(dir, "ledger.md");
  try {
    writeFileSync(p, LEDGER);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("extractLatestTip picks the LAST dated row's tip, not merge-base and not a prose SHA", () => {
  const latest = extractLatestTip(LEDGER);
  assert.equal(latest.tip, "f12bb27bc");
  assert.equal(latest.date, "2026-07-18");
});

test("extractLatestTip ignores the header/separator and the prose next-run-guard row", () => {
  // 'deadbeef' lives in a non-dated blockquote line and must never be selected.
  const latest = extractLatestTip(LEDGER);
  assert.notEqual(latest.tip, "deadbeef");
});

test("extractLatestTip returns null for a table with no dated rows", () => {
  assert.equal(extractLatestTip("# empty\n\n| Date | Tip |\n|---|---|\n"), null);
});

test("default mode prints only the canonical base SHA (the ledger tip)", () => {
  withLedger((p) => {
    const r = run([], p);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "f12bb27bc");
  });
});

test("--range prints '<ledger-tip>..upstream/master' — the exact command range the routine must diff", () => {
  withLedger((p) => {
    const r = run(["--range"], p);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "f12bb27bc..upstream/master");
  });
});

test("--range --ref honors a custom ref", () => {
  withLedger((p) => {
    const r = run(["--range", "--ref", "upstream/next"], p);
    assert.equal(r.stdout.trim(), "f12bb27bc..upstream/next");
  });
});

test("--check surfaces the ledger tip as the delta base on stderr (squash-safe guard)", () => {
  withLedger((p) => {
    const r = run(["--check"], p);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /last integrated tip:\s+f12bb27bc/);
    assert.match(r.stderr, /git log f12bb27bc\.\.upstream\/master/);
  });
});

test("malformed ledger (no dated rows) exits 2 — a real failure the routine can gate on", () => {
  const dir = mkdtempSync(join(tmpdir(), "udb-"));
  const p = join(dir, "ledger.md");
  try {
    writeFileSync(p, "# no table here\n");
    const r = run([], p);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /could not find any "Upstream tip integrated" SHA/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
