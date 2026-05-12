import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const migrationsMetaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
  }>;
};

function ensureUniqueValues(values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} entry: ${value}`);
    }
    seen.add(value);
  }
}

function ensureNumberedTags(values: string[], label: string) {
  for (const value of values) {
    if (!/^\d{4}_.+/.test(value)) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
  }
}

function ensureSequentialJournalIndexes(journal: JournalFile) {
  (journal.entries ?? []).forEach((entry, index) => {
    if (entry.idx !== index) {
      throw new Error(`Migration journal entry ${index} has idx ${entry.idx ?? "missing"}`);
    }
  });
}

function migrationPrefix(tag: string): number {
  const match = tag.match(/^(\d{4})_/);
  if (!match) {
    throw new Error(`Migration journal entry does not start with a 4-digit migration number: ${tag}`);
  }
  return Number(match[1]);
}

export function ensureJournalPrefixOrder(journalTags: string[]) {
  let previous = -1;
  for (const tag of journalTags) {
    const current = migrationPrefix(tag);
    if (current <= previous) {
      throw new Error(`Migration journal numeric order did not increase at ${tag}`);
    }
    previous = current;
  }
}

function ensureJournalReferencesFiles(migrationFiles: string[], journalTags: string[]) {
  const migrationFileSet = new Set(migrationFiles);
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);
  const journalFileSet = new Set(journalFiles);

  if (journalFileSet.size !== journalFiles.length) {
    throw new Error("Migration journal contains duplicate file entries");
  }

  if (migrationFileSet.size !== migrationFiles.length) {
    throw new Error("Migration files contain duplicate entries");
  }

  if (journalFileSet.size !== migrationFileSet.size) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFileSet.size}, files have ${migrationFileSet.size}`,
    );
  }

  for (const journalFile of journalFileSet) {
    if (!migrationFileSet.has(journalFile)) {
      throw new Error(`Migration journal references missing file: ${journalFile}`);
    }
  }

  for (const migrationFile of migrationFileSet) {
    if (!journalFileSet.has(migrationFile)) {
      throw new Error(`Migration file is missing from journal: ${migrationFile}`);
    }
  }
}

function ensureNamedSnapshotsMatchJournal(snapshotFiles: string[], journalTags: string[]) {
  const journalTagSet = new Set(journalTags);

  for (const snapshotFile of snapshotFiles) {
    const match = snapshotFile.match(/^(\d{4}_.+)_snapshot\.json$/);
    if (!match) continue;
    const tag = match[1];
    if (!journalTagSet.has(tag)) {
      throw new Error(
        `Named migration snapshot ${snapshotFile} does not match any journal tag`,
      );
    }
  }
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const snapshotFiles = (await readdir(migrationsMetaDir))
    .filter((entry) => entry.endsWith("_snapshot.json"))
    .sort();

  ensureUniqueValues(migrationFiles, "migration file");
  ensureNumberedTags(migrationFiles, "migration file");

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalTags = (journal.entries ?? [])
    .map((entry, index) => {
      if (typeof entry.tag !== "string" || entry.tag.length === 0) {
        throw new Error(`Migration journal entry ${index} is missing a tag`);
      }
      return entry.tag;
    });

  ensureUniqueValues(journalTags, "migration journal");
  ensureNumberedTags(journalTags, "migration journal");
  ensureSequentialJournalIndexes(journal);
  ensureJournalPrefixOrder(journalTags);
  ensureJournalReferencesFiles(migrationFiles, journalTags);
  ensureNamedSnapshotsMatchJournal(snapshotFiles, journalTags);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
