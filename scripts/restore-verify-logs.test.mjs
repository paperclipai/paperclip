import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "restore-verify-logs.sh");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (s) => Buffer.byteLength(s, "utf8");

const LINE1 = '{"ts":"2026-09-25T08:00:00.000Z","stream":"stdout","chunk":"hello\\n","seq":1}\n';
const LINE2 = '{"ts":"2026-09-25T08:00:01.000Z","stream":"stdout","chunk":"world\\n","seq":2}\n';
const FULL = LINE1 + LINE2;
const TORN = LINE1 + LINE2.slice(0, 30);

const DUMP_SHA = sha256("db-20260925T0800.sql.gz contents");
const OLDER_DUMP_SHA = sha256("db-20260925T0700.sql.gz contents");
const bound = (root) => ["--dump-sha256", DUMP_SHA, "--archive", archiveOf(root)];
const archiveOf = (root) => join(dirname(root), "paperclip.tar.gz");
const cleanup = (root) => rmSync(dirname(root), { recursive: true, force: true });

function makeTree(files, { generation = DUMP_SHA, tarredMarker = generation, markerFirst = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "restore-verify-logs-"));
  const root = join(parent, "paperclip");
  const marker = join(root, ".backup-generation");
  const base = join(root, "instances", "default", "data", "run-logs");
  mkdirSync(base, { recursive: true });
  for (const [ref, content] of Object.entries(files)) {
    const abs = join(base, ref);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const markerLine = (sha) => `${sha}  db-<ts>.sql.gz\n`;
  const tarball = join(parent, "paperclip.tar");
  if (generation !== null && markerFirst) {
    writeFileSync(marker, markerLine(tarredMarker));
    execFileSync("tar", ["-cf", tarball, "-C", parent, "paperclip/.backup-generation"]);
    writeFileSync(marker, markerLine(generation));
    execFileSync("tar", ["-rf", tarball, "-C", parent, "paperclip"]);
  } else {
    if (generation !== null) writeFileSync(marker, markerLine(generation));
    execFileSync("tar", ["-cf", tarball, "-C", parent, "paperclip"]);
  }
  execFileSync("gzip", ["-f", tarball]);
  return { root, base };
}

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
  bytes(content),
];
const inflight = (ref, createdAt = "2026-09-25 08:00:00", lastOutputBytes = null) => [
  ref,
  createdAt,
  null,
  null,
  lastOutputBytes,
];

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
    cleanup(root);
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
    cleanup(root);
  }
});

test("a right-sized file with different bytes still fails: the digest is compared, not just the size", () => {
  const swapped = LINE2 + LINE1;
  const { root } = makeTree({ "c/a/r1.ndjson": swapped });
  try {
    const { status, out } = run(root, [finalized("c/a/r1.ndjson", FULL)]);
    assert.equal(status, 1, out);
    assert.match(out, /1 content mismatch/);
  } finally {
    cleanup(root);
  }
});

test("an unfinalized transcript ending on a line boundary passes as a clean prefix", () => {
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/live.ndjson": LINE1,
    "c/a/empty.ndjson": "",
  });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      inflight("c/a/live.ndjson"),
      inflight("c/a/empty.ndjson"),
    ], bound(root));
    assert.equal(status, 0, out);
    assert.match(out, /run-log check PASSED/);
    assert.match(out, /1 verified against the database digest/);
    assert.match(out, /2 unfinalized ending on a line boundary/);
    assert.doesNotMatch(out, /torn/);
  } finally {
    cleanup(root);
  }
});

test("an unfinalized transcript cut off mid-line fails, even beside a verified one", () => {
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/live.ndjson": TORN,
  });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      inflight("c/a/live.ndjson", "2026-09-25 08:59:00"),
    ]);
    assert.equal(status, 1, out);
    assert.match(out, /torn: c\/a\/live\.ndjson\s+unfinalized, ends mid-line\s+\(run created 2026-09-25 08:59:00\)/);
    assert.match(out, /1 unfinalized transcript\(s\) end mid-line \(tolerance 0\)/);
    assert.doesNotMatch(out, /run-log check PASSED/);
  } finally {
    cleanup(root);
  }
});

test("an unfinalized transcript cut on a line boundary short of the database's recorded length fails", () => {
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/live.ndjson": LINE1,
    "c/a/gone.ndjson": "",
  });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      inflight("c/a/live.ndjson", "2026-09-25 08:59:00", bytes(FULL)),
      inflight("c/a/gone.ndjson", "2026-09-25 08:59:30", bytes(LINE1)),
    ]);
    assert.equal(status, 1, out);
    assert.match(
      out,
      new RegExp(
        `short: c/a/live\\.ndjson\\s+${bytes(LINE1)} bytes, database recorded at least ${bytes(FULL)}\\s+\\(run created 2026-09-25 08:59:00\\)`,
      ),
    );
    assert.match(out, new RegExp(`short: c/a/gone\\.ndjson\\s+0 bytes, database recorded at least ${bytes(LINE1)}`));
    assert.match(out, /2 unfinalized transcript\(s\) shorter than the output the database recorded/);
    assert.doesNotMatch(out, /run-log check PASSED/);
  } finally {
    cleanup(root);
  }
});

test("an unfinalized transcript at or past the database's recorded length passes", () => {
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/even.ndjson": FULL,
    "c/a/ahead.ndjson": FULL,
    "c/a/nobound.ndjson": LINE1,
  });
  try {
    const { status, out } = run(root, [
      finalized("c/a/r1.ndjson", FULL),
      inflight("c/a/even.ndjson", "2026-09-25 08:00:00", bytes(FULL)),
      inflight("c/a/ahead.ndjson", "2026-09-25 08:00:00", bytes(LINE1)),
      inflight("c/a/nobound.ndjson"),
    ], bound(root));
    assert.equal(status, 0, out);
    assert.match(out, /2 unfinalized at or past the length the database recorded/);
    assert.match(out, /1 unfinalized ending on a line boundary with no recorded length/);
  } finally {
    cleanup(root);
  }
});

test("unfinalized rows from the four-column query cannot pass silently", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL, "c/a/live.ndjson": LINE1 });
  try {
    const rows = [finalized("c/a/r1.ndjson", FULL).slice(0, 4), inflight("c/a/live.ndjson").slice(0, 4)];
    const bare = run(root, rows);
    assert.equal(bare.status, 1, bare.out);
    assert.match(bare.out, /FAIL: 1 unfinalized ref\(s\) arrived without a last_output_bytes column/);

    const allowed = run(root, rows, ["--allow-unverified", ...bound(root)]);
    assert.equal(allowed.status, 0, allowed.out);
    assert.match(allowed.out, /run-log check PASSED/);
  } finally {
    cleanup(root);
  }
});

test("--max-torn tolerates the source's known torn transcripts and not one more", () => {
  const { root } = makeTree({
    "c/a/r1.ndjson": FULL,
    "c/a/old.ndjson": TORN,
    "c/a/live.ndjson": TORN,
  });
  try {
    const rows = [finalized("c/a/r1.ndjson", FULL), inflight("c/a/old.ndjson"), inflight("c/a/live.ndjson")];
    const within = run(root, rows, ["--max-torn", "2", ...bound(root)]);
    assert.equal(within.status, 0, within.out);
    assert.match(within.out, /2 unfinalized torn mid-line \(within tolerance 2\)/);

    const over = run(root, rows, ["--max-torn", "1", ...bound(root)]);
    assert.equal(over.status, 1, over.out);
    assert.match(over.out, /2 unfinalized transcript\(s\) end mid-line \(tolerance 1\)/);

    const bad = run(root, rows, ["--max-torn", "some"]);
    assert.equal(bad.status, 2, bad.out);
  } finally {
    cleanup(root);
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
    cleanup(root);
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
    cleanup(root);
  }
});

test("rows without any digest column cannot pass silently", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL });
  try {
    const bare = run(root, [["c/a/r1.ndjson", "2026-09-25 08:00:00"]], bound(root));
    assert.equal(bare.status, 1, bare.out);
    assert.match(bare.out, /FAIL: no ref carried a digest/);
    assert.match(bare.out, /log_bytes/);

    const unmarked = run(root, [["c/a/r1.ndjson", "2026-09-25 08:00:00"]], ["--allow-unverified"]);
    assert.equal(unmarked.status, 1, unmarked.out);
    assert.match(unmarked.out, /FAIL: 1 unfinalized transcript\(s\) cannot be bounded/);
    assert.doesNotMatch(unmarked.out, /run-log check PASSED/);

    const allowed = run(root, [["c/a/r1.ndjson", "2026-09-25 08:00:00"]], ["--allow-unverified", ...bound(root)]);
    assert.equal(allowed.status, 0, allowed.out);
    assert.match(allowed.out, /run-log check PASSED/);
    assert.match(allowed.out, /content NOT verified/);
  } finally {
    cleanup(root);
  }
});

test("psql's default '|' separator is accepted when no tab is present", () => {
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
    cleanup(root);
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
    cleanup(root);
  }
});

test("--expect fails a ref list shorter than the database's count, and passes the full one", () => {
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
    cleanup(root);
  }
});

test("an unfinalized transcript cannot pass unless the tar is proven to follow this dump", () => {
  const { root } = makeTree(
    { "c/a/r1.ndjson": FULL, "c/a/live.ndjson": LINE1 },
    { generation: OLDER_DUMP_SHA },
  );
  const rows = [
    finalized("c/a/r1.ndjson", FULL),
    inflight("c/a/live.ndjson", "2026-09-25 06:00:00", bytes(LINE1)),
  ];
  try {
    const older = run(root, rows, bound(root));
    assert.equal(older.status, 1, older.out);
    assert.match(older.out, /FAIL: the data directory was not taken after this dump/);
    assert.match(older.out, new RegExp(`marker names ${OLDER_DUMP_SHA}`));
    assert.doesNotMatch(older.out, /run-log check PASSED/);

    const unstated = run(root, rows);
    assert.equal(unstated.status, 1, unstated.out);
    assert.match(unstated.out, /FAIL: 1 unfinalized transcript\(s\) cannot be bounded/);
    assert.match(unstated.out, /--dump-sha256/);
    assert.doesNotMatch(unstated.out, /run-log check PASSED/);

    const accepted = run(root, rows, ["--allow-unbound"]);
    assert.equal(accepted.status, 0, accepted.out);
    assert.match(accepted.out, /1 unfinalized NOT bounded/);
  } finally {
    cleanup(root);
  }
});

test("a stated dump the tree carries no marker for fails before any ref is checked", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL }, { generation: null });
  try {
    const { status, out } = run(root, [finalized("c/a/r1.ndjson", FULL)], bound(root));
    assert.equal(status, 1, out);
    assert.match(out, /FAIL: no \.backup-generation marker/);
    assert.doesNotMatch(out, /run-log check PASSED/);

    const malformed = run(root, [finalized("c/a/r1.ndjson", FULL)], ["--dump-sha256", "not-a-digest"]);
    assert.equal(malformed.status, 2, malformed.out);
  } finally {
    cleanup(root);
  }
});

test("finalized runs need no marker: their digests already pin the generation", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL }, { generation: null });
  try {
    const { status, out } = run(root, [finalized("c/a/r1.ndjson", FULL)]);
    assert.equal(status, 0, out);
    assert.match(out, /run-log check PASSED/);
    assert.doesNotMatch(out, /NOT bounded/);
  } finally {
    cleanup(root);
  }
});

test("a matching marker is reported, so PASSED says the pair was proven", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL, "c/a/live.ndjson": LINE1 });
  try {
    const { status, out } = run(
      root,
      [finalized("c/a/r1.ndjson", FULL), inflight("c/a/live.ndjson", "2026-09-25 08:00:00", bytes(LINE1))],
      ["--dump-sha256", DUMP_SHA.toUpperCase(), "--archive", archiveOf(root)],
    );
    assert.equal(status, 0, out);
    assert.match(out, /data directory taken after dump [0-9a-f]{12}/);
  } finally {
    cleanup(root);
  }
});

test("a tar that read the marker after another run rewrote it fails: the marker must be read first", () => {
  const { root } = makeTree(
    { "c/a/r1.ndjson": FULL, "c/a/live.ndjson": LINE1 },
    { generation: DUMP_SHA, tarredMarker: OLDER_DUMP_SHA },
  );
  try {
    const { status, out } = run(
      root,
      [finalized("c/a/r1.ndjson", FULL), inflight("c/a/live.ndjson", "2026-09-25 06:00:00", bytes(LINE1))],
      bound(root),
    );
    assert.equal(status, 1, out);
    assert.match(out, /FAIL: the data-directory tar was not started after this dump/);
    assert.match(out, new RegExp(`first member names ${OLDER_DUMP_SHA}`));
    assert.doesNotMatch(out, /run-log check PASSED/);
  } finally {
    cleanup(root);
  }
});

test("a tar whose first member is not the marker cannot be paired, even when the marker matches", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL, "c/a/live.ndjson": LINE1 }, { markerFirst: false });
  try {
    const { status, out } = run(
      root,
      [finalized("c/a/r1.ndjson", FULL), inflight("c/a/live.ndjson", "2026-09-25 08:00:00", bytes(LINE1))],
      bound(root),
    );
    assert.equal(status, 1, out);
    assert.match(out, /FAIL: \.backup-generation is not the first member of/);
    assert.doesNotMatch(out, /run-log check PASSED/);
  } finally {
    cleanup(root);
  }
});

test("--dump-sha256 needs the archive: the extracted tree alone cannot show when the marker was read", () => {
  const { root } = makeTree({ "c/a/r1.ndjson": FULL });
  try {
    const { status, out } = run(root, [finalized("c/a/r1.ndjson", FULL)], ["--dump-sha256", DUMP_SHA]);
    assert.equal(status, 2, out);
    assert.match(out, /--dump-sha256 needs --archive/);

    const gone = run(root, [finalized("c/a/r1.ndjson", FULL)], ["--dump-sha256", DUMP_SHA, "--archive", `${archiveOf(root)}.nope`]);
    assert.equal(gone.status, 1, gone.out);
    assert.match(gone.out, /FAIL: archive not found/);
  } finally {
    cleanup(root);
  }
});

test("--help prints the help on stdout and exits 0; an unknown option prints it on stderr and exits 2", () => {
  const help = spawnSync("bash", [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const opt of ["--run-logs-dir", "--max-missing", "--max-torn", "--expect", "--allow-empty", "--allow-unverified", "--dump-sha256", "--archive", "--allow-unbound"]) {
    assert.match(help.stdout, new RegExp(`^\\s*${opt}\\b`, "m"), `help should list ${opt}`);
  }
  const bad = spawnSync("bash", [scriptPath, "--bogus"], { encoding: "utf8" });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /unknown option: --bogus/);
  assert.match(bad.stderr, /^Usage:/m);
});
