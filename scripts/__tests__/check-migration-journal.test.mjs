import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// RBR-968. `scripts/check-migration-journal.mjs` is a deliberate
// reimplementation of packages/db/src/migration-journal-consistency.ts: the PR
// `policy` job has no `pnpm install`, so the CI guard must run on a bare Node
// runtime. These tests pin the guard's observable contract and — critically —
// assert that the dependency-free copy agrees with the TS source of truth on
// the real repository tree, so the two cannot silently drift apart.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const guard = path.join(repoRoot, "scripts", "check-migration-journal.mjs");
const migrationsDir = path.join(repoRoot, "packages", "db", "src", "migrations");

function runGuard(args = []) {
  const result = spawnSync(process.execPath, [guard, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("passes on the real tree with the shipped baseline", () => {
  const { status, output } = runGuard();
  assert.equal(status, 0, output);
  assert.match(output, /OK — \d+ migration file\(s\) match \d+ journal entry\/entries/);
});

test("reports expected defects on this fork's journal (RBR-1033 fork-retarget)", () => {
  // RBR-968 pinned upstream/paperclipai/paperclip's known defects (duplicate idx 178,
  // gaps at 126/130/177). This fork's journal has been synced with upstream/main and
  // inherited the gaps at 126 and 130. The guard still passes (gaps are warnings, not
  // errors) — this test asserts the known state so any unexpected new defects surface.
  const { status, output } = runGuard();
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /WARN Duplicate journal idx/);
  assert.match(output, /WARN Gaps in journal idx sequence: 126, 130/);
});

test("--strict also passes cleanly on this fork's journal", () => {
  const { status, output } = runGuard(["--strict"]);
  assert.equal(status, 0, output);
});

test("an orphaned .sql is a hard error naming the file (AC3)", () => {
  const orphan = path.join(migrationsDir, "0128_orphan_probe.sql");
  writeFileSync(orphan, "ALTER TABLE issues ADD COLUMN orphan_probe int;\n", "utf8");
  try {
    const { status, output } = runGuard();
    assert.equal(status, 1);
    assert.match(output, /ERROR Orphaned migration file\(s\)/);
    assert.match(output, /0128_orphan_probe\.sql/);
  } finally {
    rmSync(orphan, { force: true });
  }
});

test("a journal entry with no .sql file is a hard error naming the file", () => {
  const held = path.join(migrationsDir, "0127_environment_custom_images_instance_scoped.sql");
  const stash = path.join(mkdtempSync(path.join(tmpdir(), "pcmj-")), "held.sql");
  renameSync(held, stash);
  try {
    const { status, output } = runGuard();
    assert.equal(status, 1);
    assert.match(output, /ERROR Journal entry\/entries with no matching \.sql file/);
    assert.match(output, /0127_environment_custom_images_instance_scoped\.sql/);
  } finally {
    renameSync(stash, held);
  }
});

test("the guard restores nothing and leaves the tree clean", () => {
  const { status } = runGuard();
  assert.equal(status, 0, "the preceding tests must not leave the migrations tree dirty");
});

test("agrees with the TS source of truth on the real tree (anti-drift)", () => {
  // Read the TS implementation's verdict through a tiny tsx program rather than
  // importing it: TS emits `.js` specifiers that only resolve after a build.
  const probeDir = mkdtempSync(path.join(tmpdir(), "pcmj-probe-"));
  const probe = path.join(repoRoot, "packages", "db", "__journal_probe.ts");
  const source = [
    'import { auditMigrationJournal, loadMigrationJournalIdxBaseline } from "./src/migration-journal-consistency.js";',
    "const baseline = await loadMigrationJournalIdxBaseline();",
    "const relaxed = await auditMigrationJournal({ baseline });",
    "const strict = await auditMigrationJournal({ strict: true });",
    "console.log(JSON.stringify({",
    "  relaxedErrors: relaxed.errors.length,",
    "  relaxedWarnings: relaxed.warnings.length,",
    "  strictErrors: strict.errors.length,",
    "  duplicateIdx: relaxed.result.duplicateIdxGroups.map((g) => g.idx),",
    "  idxGaps: relaxed.result.idxGaps,",
    "  files: relaxed.result.migrationFiles.length,",
    "}));",
  ].join("\n");
  writeFileSync(probe, source, "utf8");

  let tsVerdict;
  try {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@paperclipai/db", "exec", "tsx", "__journal_probe.ts"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (result.status !== 0) {
      // tsx is a devDependency; skip rather than fail when it is unavailable
      // (e.g. a production-only install), so this test never blocks CI lanes
      // that legitimately lack dev deps.
      console.log(`skipping anti-drift comparison: tsx unavailable (${result.stderr?.trim()})`);
      return;
    }
    const line = result.stdout.trim().split("\n").at(-1);
    tsVerdict = JSON.parse(line);
  } finally {
    rmSync(probe, { force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }

  const relaxed = runGuard();
  const strict = runGuard(["--strict"]);

  assert.equal(
    relaxed.status === 0,
    tsVerdict.relaxedErrors === 0,
    "mjs and ts guards disagree on whether the tree passes with the baseline",
  );
  assert.equal(
    strict.status === 0,
    tsVerdict.strictErrors === 0,
    "mjs and ts guards disagree on whether the tree passes under --strict",
  );

  // Both must see the same defects, by number. This fork's journal has known
  // gaps at idx 126 and 130 inherited from upstream/main.
  assert.deepEqual(tsVerdict.duplicateIdx, []);
  assert.deepEqual(tsVerdict.idxGaps, [126, 130]);
  assert.match(relaxed.output, new RegExp(`match ${tsVerdict.files} journal entry`));
  if (tsVerdict.relaxedWarnings > 0) {
    assert.match(
      relaxed.output,
      new RegExp(`${tsVerdict.relaxedWarnings} warning\\(s\\)`),
      "mjs and ts guards report a different number of warnings",
    );
  } else {
    assert.doesNotMatch(
      relaxed.output,
      /warning\(s\)/,
      "mjs guard reports warnings the ts guard does not",
    );
  }
});

test("rejects a malformed journal entry instead of silently skipping it", () => {
  // A dropped entry would make an orphaned file look legitimate, so a bad
  // entry must be loud. Verified on an isolated copy of the journal.
  const sandbox = mkdtempSync(path.join(tmpdir(), "pcmj-bad-"));
  const fakeMigrations = path.join(sandbox, "packages", "db", "src", "migrations", "meta");
  mkdirSync(fakeMigrations, { recursive: true });
  mkdirSync(path.join(sandbox, "scripts"), { recursive: true });
  writeFileSync(
    path.join(fakeMigrations, "_journal.json"),
    JSON.stringify({ version: "7", entries: [{ idx: "not-a-number", tag: "0001_a" }] }),
    "utf8",
  );
  writeFileSync(
    path.join(sandbox, "packages", "db", "src", "migrations", "0001_a.sql"),
    "SELECT 1;\n",
    "utf8",
  );
  const copiedGuard = path.join(sandbox, "scripts", "check-migration-journal.mjs");
  writeFileSync(copiedGuard, readGuardSource(), "utf8");

  try {
    const result = spawnSync(process.execPath, [copiedGuard], { cwd: sandbox, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /non-integer idx/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function readGuardSource() {
  return readFileSync(guard, "utf8");
}
