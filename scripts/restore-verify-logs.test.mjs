import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Behavioural tests for scripts/restore-verify-logs.sh: build a restored
// run-log tree in a temp dir, feed it the rows a restored `heartbeat_runs`
// would produce, and assert on exit status and summary.
//
// The point of the digest check: a data-directory tar taken while a run is
// writing its transcript captures the file mid-line. The file exists, so a
// presence check passes; only comparing the restored bytes with what the
// database recorded at finalize (`log_bytes`, `log_sha256`) catches it.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "restore-verify-logs.sh");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (s) => Buffer.byteLength(s, "utf8");

const LINE1 = '{"ts":"2026-09-25T08:00:00.000Z","stream":"stdout","chunk":"hello\\n","seq":1}\n';
const LINE2 = '{"ts":"2026-09-25T08:00:01.000Z","stream":"stdout","chunk":"world\\n","seq":2}\n';
const FULL = LINE1 + LINE2;
const TORN = LINE1 + LINE2.slice(0, 30); // captured mid-JSON-line

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "restore-verify-logs-"));
  const base = join(root, "instances", "default", "data", "run-logs");
  for (const [ref, content] of Object.entries(files)) {
    const abs = join(base, ref);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, base };
}

// rows: [ref, createdAt, logBytes|null, sha|null]
function run(root, rows, args = []) {
  const stdin = rows
    .map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))).join("\t"))
    .join("\n");
  const res = spawnSync("bash", [scriptPath, root, ...args], {
    input: stdin + "\n",
    encoding: "utf8",
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

const finalized = (ref, content, createdAt = "2026-09-25 08:00:00") => [
  ref,
  createdAt,
  bytes(content),
  sha256(content),
];
const inflight = (ref, createdAt = "2026-09-25 08:00:00") => [ref, createdAt, null, null];

test("intact tree with digests passes and reports every ref as verified", () => {
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/r2.ndjson": LINE1,
    "c/a/r3.ndjson": "",
  });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      finalized("c/a/r2.ndjson", LINE1),
      finalized("c/a/r3.ndjson", ""),
    ]);
    assert.equal(status, 0, out);
    assert.match(out, /run-log check PASSED/);
    assert.match(out, /3 ref\(s\) checked/);
    assert.match(out, /3 verified against the database digest/);
    assert.match(out, /1 zero-byte/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transcript captured mid-line fails when the database holds its digest", () => {
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/torn.ndjson": TORN,
  });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      finalized("c/a/torn.ndjson", FULL, "2026-09-25 08:59:00"),
    ]);
    assert.equal(status, 1, out);
    assert.match(out, /FAIL/);
    assert.match(out, /1 content mismatch/);
    assert.match(out, /mismatch: c\/a\/torn\.ndjson/);
    assert.match(out, /run created 2026-09-25 08:59:00/);
    assert.doesNotMatch(out, /run-log check PASSED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a right-sized file with different bytes still fails: the digest is compared, not just the size", () => {
  const swapped = LINE2 + LINE1; // same length, different content
  const { root } = makeTree({ "c/a/r1.ndjson": swapped });
  try {
    const { status, out } = run(root, [finalized("c/a/r1.ndjson", FULL)]);
    assert.equal(status, 1, out);
    assert.match(out, /1 content mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run the database never finalized is reported as unverifiable, not failed", () => {
  // No log_bytes/log_sha256 on the row: the run was in flight (or died before
  // finalize) when the dump was taken, so there is nothing to compare against.
  // The source can hold torn files for exactly these runs; a faithful restore
  // brings them back torn, and failing on them would fail every live backup.
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/live.ndjson": TORN,
  });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      inflight("c/a/live.ndjson"),
    ]);
    assert.equal(status, 0, out);
    assert.match(out, /run-log check PASSED/);
    assert.match(out, /1 verified against the database digest/);
    assert.match(out, /1 unverifiable \(no digest in the database: run never finalized\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing files still fail, with the run's creation time", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      finalized("c/a/gone.ndjson", FULL, "2026-08-23 06:08:00"),
    ]);
    assert.equal(status, 1, out);
    assert.match(out, /missing: c\/a\/gone\.ndjson\s+\(run created 2026-08-23 06:08:00\)/);
    assert.match(out, /1 missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--max-missing tolerates the source's known dangling refs but never a content mismatch", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL, "c/a/torn.ndjson": TORN });
  try {
    const ok = run(
      root,
      [finalized("c/a/r1.ndjson", FULL), finalized("c/a/gone.ndjson", FULL)],
      ["--max-missing", "1"],
    );
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /1 missing \(within tolerance 1\)/);

    const torn = run(
      root,
      [finalized("c/a/r1.ndjson", FULL), finalized("c/a/torn.ndjson", FULL)],
      ["--max-missing", "5"],
    );
    assert.equal(torn.status, 1, torn.out);
    assert.match(torn.out, /1 content mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rows without any digest column cannot pass silently", () => {
  // The two-column query (ref, created_at) proves presence only. Refuse to
  // print PASSED for it unless the operator says so explicitly.
  const { root } = makeTree({ "c/a/r1.ndjson": FULL });
  try {
    const bare = run(root, [["c/a/r1.ndjson", "2026-09-25 08:00:00"]]);
    assert.equal(bare.status, 1, bare.out);
    assert.match(bare.out, /FAIL: no ref carried a digest/);
    assert.match(bare.out, /log_bytes/);

    const allowed = run(root, [["c/a/r1.ndjson", "2026-09-25 08:00:00"]], ["--allow-unverified"]);
    assert.equal(allowed.status, 0, allowed.out);
    assert.match(allowed.out, /run-log check PASSED/);
    assert.match(allowed.out, /content NOT verified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("psql's default '|' separator is accepted when no tab is present", () => {
  // `psql -At` without -F separates columns with '|'. Nothing in a row can
  // contain one, so a forgotten -F must not turn into "every ref is missing".
  const { root } = makeTree({ "c/a/r1.ndjson": FULL, "c/a/torn.ndjson": TORN });
  try {
    const rows = [
      ["c/a/r1.ndjson", "2026-09-25 08:00:00", bytes(FULL), sha256(FULL)].join("|"),
      ["c/a/torn.ndjson", "2026-09-25 08:59:00", bytes(FULL), sha256(FULL)].join("|"),
    ].join("\n");
    const res = spawnSync("bash", [scriptPath, root], { input: rows + "\n", encoding: "utf8" });
    const out = res.stdout + res.stderr;
    assert.equal(res.status, 1, out);
    assert.match(out, /2 ref\(s\) checked, 1 content mismatch/);
    assert.match(out, /mismatch: c\/a\/torn\.ndjson/);
    assert.doesNotMatch(out, /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a digest row whose log_bytes disagrees with its own file size is a mismatch even before hashing", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL });
  try {
    const { status, out } = run(root, [["c/a/r1.ndjson", "2026-09-25 08:00:00", bytes(FULL) + 7, sha256(FULL)]]);
    assert.equal(status, 1, out);
    assert.match(out, /mismatch: c\/a\/r1\.ndjson/);
    assert.match(out, new RegExp(`size ${bytes(FULL)}, database recorded ${bytes(FULL) + 7}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--expect fails a ref list shorter than the database's count, and passes the full one", () => {
  // `docker exec ... | <slow reader>` has been measured dropping output with
  // exit 0 and nothing on stderr: 5942 of 6457 rows reached the reader. A
  // checker fed a short list checks fewer refs and passes, so the caller
  // states the count the database reported and the checker holds it to it.
  const { root } = makeTree({ "c/a/r1.ndjson": FULL, "c/a/r2.ndjson": LINE1 });
  try {
    const short = run(root, [finalized("c/a/r1.ndjson", FULL)], ["--expect", "2"]);
    assert.notEqual(short.status, 0, short.out);
    assert.match(short.out, /1 row\(s\) arrived, the database reported 2/);

    const full = run(
      root,
      [finalized("c/a/r1.ndjson", FULL), finalized("c/a/r2.ndjson", LINE1)],
      ["--expect", "2"],
    );
    assert.equal(full.status, 0, full.out);
    assert.match(full.out, /2 ref\(s\) checked/);

    const bad = run(root, [finalized("c/a/r1.ndjson", FULL)], ["--expect", "two"]);
    assert.equal(bad.status, 2, bad.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
