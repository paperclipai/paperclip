import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertMigrationJournalConsistency,
  auditMigrationJournal,
  checkMigrationJournalConsistency,
  findDuplicateJournalIdxGroups,
  findJournalIdxGaps,
  formatMigrationJournalInconsistencies,
  loadMigrationJournalIdxBaseline,
  parseMigrationJournalIdxBaseline,
} from "./migration-journal-consistency.js";

// RBR-927: an orphaned .sql file (present in the migrations folder, absent from
// meta/_journal.json) is invisible to drizzle's journal-driven migrator but is
// reported as permanently pending by folder-enumerating checks. That made
// database bootstrap fail with an unactionable message, and because bootstrap
// runs in `beforeAll`, whole suites reported `skipped` rather than `failed`.
// These tests pin the guard that turns that class of defect into a hard error
// naming the offending filename.

const createdDirs: string[] = [];

function makeFixture(options: {
  readonly files: readonly string[];
  readonly journalTags: readonly string[];
  /** Explicit idx per journal tag. Defaults to the tag's position. */
  readonly journalIdx?: readonly number[];
}): { migrationsDir: string; journalPath: string } {
  const migrationsDir = mkdtempSync(join(tmpdir(), "paperclip-journal-consistency-"));
  createdDirs.push(migrationsDir);
  mkdirSync(join(migrationsDir, "meta"), { recursive: true });

  for (const fileName of options.files) {
    writeFileSync(join(migrationsDir, fileName), "SELECT 1;\n", "utf8");
  }

  const journalPath = join(migrationsDir, "meta", "_journal.json");
  writeFileSync(
    journalPath,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: options.journalTags.map((tag, index) => ({
        idx: options.journalIdx?.[index] ?? index,
        version: "7",
        when: 1_700_000_000_000 + index,
        tag,
        breakpoints: true,
      })),
    }),
    "utf8",
  );

  return { migrationsDir, journalPath };
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkMigrationJournalConsistency", () => {
  it("reports no inconsistencies when every file has a journal entry", async () => {
    const fixture = makeFixture({
      files: ["0001_first.sql", "0002_second.sql"],
      journalTags: ["0001_first", "0002_second"],
    });

    const result = await checkMigrationJournalConsistency(fixture);

    expect(result.inconsistencies).toEqual([]);
    expect(result.migrationFiles).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(result.journalFiles).toEqual(["0001_first.sql", "0002_second.sql"]);
  });

  it("flags an orphaned file whose number collides with a journalled slot", async () => {
    // The exact RBR-927 shape: 0128_force_reassign.sql left behind after the
    // migration was renumbered to 0131, with slot 0128 already taken.
    const fixture = makeFixture({
      files: ["0128_force_reassign.sql", "0128_user_specific_secrets.sql", "0131_force_reassign.sql"],
      journalTags: ["0128_user_specific_secrets", "0131_force_reassign"],
    });

    const result = await checkMigrationJournalConsistency(fixture);

    expect(result.inconsistencies).toEqual([
      { kind: "orphaned-migration-file", fileName: "0128_force_reassign.sql" },
    ]);
  });

  it("flags an orphaned file that occupies an otherwise-unused number", async () => {
    const fixture = makeFixture({
      files: ["0001_first.sql", "0300_orphan_never_journalled.sql"],
      journalTags: ["0001_first"],
    });

    const result = await checkMigrationJournalConsistency(fixture);

    expect(result.inconsistencies).toEqual([
      { kind: "orphaned-migration-file", fileName: "0300_orphan_never_journalled.sql" },
    ]);
  });

  it("flags an orphaned file whose name does not use a 4-digit prefix", async () => {
    // The numbering checks reject this on prefix shape alone; the journal
    // comparison must still identify it as the orphan it is.
    const fixture = makeFixture({
      files: ["0001_first.sql", "0130a_orphan_mid.sql"],
      journalTags: ["0001_first"],
    });

    const result = await checkMigrationJournalConsistency(fixture);

    expect(result.inconsistencies).toEqual([
      { kind: "orphaned-migration-file", fileName: "0130a_orphan_mid.sql" },
    ]);
  });

  it("flags a journal entry with no matching file", async () => {
    const fixture = makeFixture({
      files: ["0001_first.sql"],
      journalTags: ["0001_first", "0002_deleted_by_mistake"],
    });

    const result = await checkMigrationJournalConsistency(fixture);

    expect(result.inconsistencies).toEqual([
      { kind: "missing-migration-file", fileName: "0002_deleted_by_mistake.sql" },
    ]);
  });

  it("reports orphaned and missing files together", async () => {
    const fixture = makeFixture({
      files: ["0001_first.sql", "0009_orphan.sql"],
      journalTags: ["0001_first", "0002_missing"],
    });

    const result = await checkMigrationJournalConsistency(fixture);

    expect(result.inconsistencies).toEqual([
      { kind: "orphaned-migration-file", fileName: "0009_orphan.sql" },
      { kind: "missing-migration-file", fileName: "0002_missing.sql" },
    ]);
  });

  it("ignores non-.sql entries in the migrations folder", async () => {
    const fixture = makeFixture({
      files: ["0001_first.sql"],
      journalTags: ["0001_first"],
    });
    writeFileSync(join(fixture.migrationsDir, "README.md"), "notes\n", "utf8");

    const result = await checkMigrationJournalConsistency(fixture);

    expect(result.inconsistencies).toEqual([]);
  });
});

describe("assertMigrationJournalConsistency", () => {
  it("throws naming the orphaned filename", async () => {
    const fixture = makeFixture({
      files: ["0128_force_reassign.sql", "0128_user_specific_secrets.sql"],
      journalTags: ["0128_user_specific_secrets"],
    });

    await expect(assertMigrationJournalConsistency(fixture)).rejects.toThrow(
      /0128_force_reassign\.sql/,
    );
  });

  it("resolves for the real shipped migrations folder", async () => {
    // Guards the repository itself: packages/db/src/migrations must stay in
    // agreement with meta/_journal.json.
    await expect(assertMigrationJournalConsistency()).resolves.toBeUndefined();
  });
});

describe("formatMigrationJournalInconsistencies", () => {
  it("names the offending file and explains the failure mode", () => {
    const message = formatMigrationJournalInconsistencies([
      { kind: "orphaned-migration-file", fileName: "0128_force_reassign.sql" },
    ]);

    expect(message).toContain("0128_force_reassign.sql");
    expect(message).toContain("meta/_journal.json");
    expect(message).toContain("Orphaned migration file");
  });

  it("names a missing file separately from an orphan", () => {
    const message = formatMigrationJournalInconsistencies([
      { kind: "missing-migration-file", fileName: "0002_missing.sql" },
    ]);

    expect(message).toContain("0002_missing.sql");
    expect(message).not.toContain("Orphaned migration file");
  });
});

// RBR-968: the guard also owns `idx` health. A duplicate `idx` does not stop
// drizzle's migrate(), so it cannot be enforced in the runtime bootstrap path
// without risking production startup — it is enforced here, in the pre-test /
// pre-build audit, with an explicit ratcheting baseline for already-shipped
// defects.

describe("findDuplicateJournalIdxGroups", () => {
  it("returns nothing when every idx is unique", () => {
    expect(
      findDuplicateJournalIdxGroups([
        { idx: 1, tag: "a" },
        { idx: 2, tag: "b" },
      ]),
    ).toEqual([]);
  });

  it("groups the tags sharing an idx, in journal order", () => {
    // The real origin/master shape: idx 178 claimed twice.
    expect(
      findDuplicateJournalIdxGroups([
        { idx: 176, tag: "0176_a" },
        { idx: 178, tag: "0177_activity_log_responsible_user" },
        { idx: 178, tag: "0178_summary_slots" },
      ]),
    ).toEqual([
      { idx: 178, tags: ["0177_activity_log_responsible_user", "0178_summary_slots"] },
    ]);
  });

  it("reports a triple collision as one group with all three tags", () => {
    expect(
      findDuplicateJournalIdxGroups([
        { idx: 5, tag: "a" },
        { idx: 5, tag: "b" },
        { idx: 5, tag: "c" },
      ]),
    ).toEqual([{ idx: 5, tags: ["a", "b", "c"] }]);
  });
});

describe("findJournalIdxGaps", () => {
  it("returns nothing for a contiguous sequence", () => {
    expect(
      findJournalIdxGaps([
        { idx: 0, tag: "a" },
        { idx: 1, tag: "b" },
        { idx: 2, tag: "c" },
      ]),
    ).toEqual([]);
  });

  it("lists every missing idx between the lowest and highest present", () => {
    // The real origin/master shape: 126, 130 and 177 absent.
    expect(
      findJournalIdxGaps([
        { idx: 125, tag: "a" },
        { idx: 127, tag: "b" },
        { idx: 129, tag: "c" },
        { idx: 131, tag: "d" },
      ]),
    ).toEqual([126, 128, 130]);
  });

  it("returns nothing for an empty journal", () => {
    expect(findJournalIdxGaps([])).toEqual([]);
  });
});

describe("auditMigrationJournal", () => {
  it("passes a clean folder/journal pair with no warnings", async () => {
    const fixture = makeFixture({
      files: ["0001_first.sql", "0002_second.sql"],
      journalTags: ["0001_first", "0002_second"],
    });

    const audit = await auditMigrationJournal(fixture);

    expect(audit.errors).toEqual([]);
    expect(audit.warnings).toEqual([]);
  });

  it("hard-errors on an orphaned file, naming it", async () => {
    const fixture = makeFixture({
      files: ["0001_first.sql", "0002_orphan.sql"],
      journalTags: ["0001_first"],
    });

    const audit = await auditMigrationJournal(fixture);

    expect(audit.errors).toHaveLength(1);
    expect(audit.errors[0]).toContain("0002_orphan.sql");
  });

  it("hard-errors on an un-baselined duplicate idx, naming both tags", async () => {
    const fixture = makeFixture({
      files: ["0001_a.sql", "0002_b.sql"],
      journalTags: ["0001_a", "0002_b"],
      journalIdx: [7, 7],
    });

    const audit = await auditMigrationJournal(fixture);

    expect(audit.errors).toHaveLength(1);
    expect(audit.errors[0]).toContain("idx 7");
    expect(audit.errors[0]).toContain("0001_a.sql");
    expect(audit.errors[0]).toContain("0002_b.sql");
  });

  it("downgrades an exactly-baselined duplicate idx to a warning that still names it", async () => {
    const fixture = makeFixture({
      files: ["0001_a.sql", "0002_b.sql"],
      journalTags: ["0001_a", "0002_b"],
      journalIdx: [7, 7],
    });

    const audit = await auditMigrationJournal({
      ...fixture,
      baseline: { duplicateIdx: [{ idx: 7, tags: ["0001_a", "0002_b"] }] },
    });

    expect(audit.errors).toEqual([]);
    expect(audit.warnings).toHaveLength(1);
    expect(audit.warnings[0]).toContain("idx 7");
    expect(audit.warnings[0]).toContain("0001_a.sql");
  });

  it("ignores the baseline under --strict so the defect is an error again", async () => {
    const fixture = makeFixture({
      files: ["0001_a.sql", "0002_b.sql"],
      journalTags: ["0001_a", "0002_b"],
      journalIdx: [7, 7],
    });

    const audit = await auditMigrationJournal({
      ...fixture,
      baseline: { duplicateIdx: [{ idx: 7, tags: ["0001_a", "0002_b"] }] },
      strict: true,
    });

    expect(audit.errors).toHaveLength(1);
    expect(audit.errors[0]).toContain("idx 7");
  });

  it("ratchets: a third entry joining a baselined group is a fresh error", async () => {
    const fixture = makeFixture({
      files: ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
      journalTags: ["0001_a", "0002_b", "0003_c"],
      journalIdx: [7, 7, 7],
    });

    const audit = await auditMigrationJournal({
      ...fixture,
      baseline: { duplicateIdx: [{ idx: 7, tags: ["0001_a", "0002_b"] }] },
    });

    expect(audit.errors).toHaveLength(1);
    expect(audit.errors[0]).toContain("0003_c");
    expect(audit.warnings).toEqual([]);
  });

  it("errors on a stale baseline entry so the file cannot rot into a blanket excuse", async () => {
    const fixture = makeFixture({
      files: ["0001_a.sql", "0002_b.sql"],
      journalTags: ["0001_a", "0002_b"],
    });

    const audit = await auditMigrationJournal({
      ...fixture,
      baseline: { duplicateIdx: [{ idx: 7, tags: ["0001_a", "0002_b"] }] },
    });

    expect(audit.errors).toHaveLength(1);
    expect(audit.errors[0]).toContain("Stale baseline entry");
  });

  it("reports idx gaps as a warning, not an error", async () => {
    const fixture = makeFixture({
      files: ["0001_a.sql", "0002_b.sql"],
      journalTags: ["0001_a", "0002_b"],
      journalIdx: [1, 4],
    });

    const audit = await auditMigrationJournal(fixture);

    expect(audit.errors).toEqual([]);
    expect(audit.warnings).toHaveLength(1);
    expect(audit.warnings[0]).toContain("2, 3");
  });
});

describe("parseMigrationJournalIdxBaseline", () => {
  it("accepts a well-formed baseline", () => {
    const baseline = parseMigrationJournalIdxBaseline(
      JSON.stringify({ duplicateIdx: [{ idx: 178, tags: ["a", "b"], reason: "shipped" }] }),
    );

    expect(baseline.duplicateIdx).toEqual([{ idx: 178, tags: ["a", "b"], reason: "shipped" }]);
  });

  it("treats an absent duplicateIdx as an empty baseline", () => {
    expect(parseMigrationJournalIdxBaseline("{}").duplicateIdx).toEqual([]);
  });

  it("rejects an entry with fewer than two tags", () => {
    expect(() =>
      parseMigrationJournalIdxBaseline(JSON.stringify({ duplicateIdx: [{ idx: 1, tags: ["a"] }] })),
    ).toThrow(/at least two/);
  });

  it("rejects a non-integer idx", () => {
    expect(() =>
      parseMigrationJournalIdxBaseline(
        JSON.stringify({ duplicateIdx: [{ idx: "1", tags: ["a", "b"] }] }),
      ),
    ).toThrow(/non-integer idx/);
  });
});

describe("the shipped repository journal", () => {
  // RBR-1033 fork-retarget note: RBR-968 pinned upstream/paperclipai/paperclip's known
  // defects at the time (duplicate idx 178, gaps at 126/130/177). This fork's journal
  // diverged from upstream before those defects existed on this line of history, so its
  // journal is clean: no duplicates, no gaps, 128 entries with max idx 127. These tests
  // pin that clean state so a regression is caught; if this fork's journal legitimately
  // grows a defect, the fix belongs in the journal, not in loosening this assertion.
  it("has no duplicate idx groups on the fork's journal", async () => {
    const result = await checkMigrationJournalConsistency();
    const baseline = await loadMigrationJournalIdxBaseline();

    expect(result.duplicateIdxGroups).toEqual([]);
    expect(baseline.duplicateIdx).toEqual([]);
  });

  it("has no idx gaps on the fork's journal", async () => {
    const result = await checkMigrationJournalConsistency();

    expect(result.idxGaps).toEqual([]);
  });

  it("audits clean against the (empty) shipped baseline, with no warnings", async () => {
    const audit = await auditMigrationJournal({
      baseline: await loadMigrationJournalIdxBaseline(),
    });

    expect(audit.errors).toEqual([]);
    expect(audit.warnings).toEqual([]);
  });

  it("passes under --strict too, since the fork's journal has no baselined defects", async () => {
    const audit = await auditMigrationJournal({ strict: true });

    expect(audit.errors).toEqual([]);
  });
});
