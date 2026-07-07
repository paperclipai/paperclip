import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

type JournalFile = {
  version?: string;
  dialect?: string;
  entries?: Array<{ idx?: number; tag?: string; when?: number; breakpoints?: boolean }>;
};

async function listMigrationSqlFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

async function readJournal(): Promise<Required<Pick<JournalFile, "entries">> & JournalFile> {
  const raw = await readFile(journalPath, "utf8");
  const parsed = JSON.parse(raw) as JournalFile;
  return { ...parsed, entries: parsed.entries ?? [] };
}

describe("migration file invariants", () => {
  it("names every migration file with a snake_case tag behind a 4-digit number", async () => {
    const files = await listMigrationSqlFiles();
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it("numbers migration files in strictly increasing order with no duplicates", async () => {
    // Gaps are allowed: removed migrations leave their number retired
    // (e.g. 0126 was relocated to 0132 and 0130 was reverted).
    const files = await listMigrationSqlFiles();
    const numbers = files.map((file) => Number(file.slice(0, 4)));
    expect(numbers[0]).toBe(0);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i], `migration ${files[i]} must be numbered after ${files[i - 1]}`)
        .toBeGreaterThan(numbers[i - 1]!);
    }
  });

  it("contains at least one non-empty statement per migration file", async () => {
    const files = await listMigrationSqlFiles();
    for (const file of files) {
      const content = await readFile(`${migrationsDir}/${file}`, "utf8");
      const statements = content
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
      expect(statements.length, `migration ${file} has no statements`).toBeGreaterThan(0);
    }
  });
});

describe("migration journal invariants", () => {
  it("declares the expected drizzle journal shape", async () => {
    const journal = await readJournal();
    expect(journal.version).toBe("7");
    expect(journal.dialect).toBe("postgresql");
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("keeps journal idx values strictly increasing and matching each tag prefix", async () => {
    const journal = await readJournal();
    journal.entries.forEach((entry, position) => {
      expect(typeof entry.tag, `journal entry ${position}`).toBe("string");
      expect(entry.idx, `journal tag ${entry.tag}`).toBe(Number(entry.tag!.slice(0, 4)));
      expect(typeof entry.when, `journal entry ${position} is missing "when"`).toBe("number");
      if (position > 0) {
        expect(entry.idx, `journal entry ${entry.tag} must come after its predecessor`)
          .toBeGreaterThan(journal.entries[position - 1]!.idx!);
      }
    });
  });

  it("matches journal tags one-to-one, in order, with migration files on disk", async () => {
    const files = await listMigrationSqlFiles();
    const journal = await readJournal();
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files);
  });
});

describe("check-migration-numbering script", () => {
  it("passes against the current migrations directory", async () => {
    // The script performs its checks at import time and throws on violations.
    await expect(import("./check-migration-numbering.js")).resolves.toBeDefined();
  });
});
