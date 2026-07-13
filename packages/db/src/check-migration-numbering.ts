import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const metaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
  }>;
};

// Fork migrations are reserved at 10000+ (5 digits) to stay clear of the
// upstream 4-digit sequence permanently (NEO-419/NEO-422). Accept 4-OR-MORE
// digit prefixes so both the upstream (0000-9999) and fork (10000+) ranges pass.
function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4,})_/);
  return match ? match[1] : null;
}

function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

type Snapshot = {
  id?: unknown;
  prevId?: unknown;
};

// drizzle-kit aborts `generate` when two snapshots in meta/ share the same
// `prevId` ("collision") — it can no longer tell which snapshot is the latest.
// Hand-authored migrations (.sql + _journal.json with no snapshot) are fine and
// common in this repo, so we do NOT require a snapshot per migration; we only
// guard the invariant drizzle-kit actually relies on: among the snapshot files
// that DO exist, every `prevId` is unique and every `id` is unique.
async function ensureSnapshotChainIntegrity() {
  const snapshotFiles = (await readdir(metaDir))
    .filter((entry) => entry.endsWith("_snapshot.json"))
    .sort();

  const prevIdOwners = new Map<string, string>();
  const idOwners = new Map<string, string>();

  for (const file of snapshotFiles) {
    const raw = await readFile(`${metaDir}/${file}`, "utf8");
    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(raw) as Snapshot;
    } catch (error) {
      throw new Error(`Migration snapshot ${file} is not valid JSON: ${String(error)}`);
    }

    if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
      throw new Error(`Migration snapshot ${file} is missing an "id"`);
    }
    if (typeof snapshot.prevId !== "string") {
      throw new Error(`Migration snapshot ${file} is missing a "prevId"`);
    }

    const idOwner = idOwners.get(snapshot.id);
    if (idOwner) {
      throw new Error(`Duplicate snapshot id ${snapshot.id} in ${idOwner}, ${file}`);
    }
    idOwners.set(snapshot.id, file);

    const prevOwner = prevIdOwners.get(snapshot.prevId);
    if (prevOwner) {
      throw new Error(
        `Snapshot chain collision: ${prevOwner} and ${file} both point to parent snapshot ` +
          `${snapshot.prevId}. This breaks "drizzle-kit generate". Repoint the newer ` +
          `snapshot's "prevId" to the previous snapshot's "id", or regenerate the chain.`,
      );
    }
    prevIdOwners.set(snapshot.prevId, file);
  }
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalTags = (journal.entries ?? [])
    .map((entry, index) => {
      if (typeof entry.tag !== "string" || entry.tag.length === 0) {
        throw new Error(`Migration journal entry ${index} is missing a tag`);
      }
      return entry.tag;
    });

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);

  await ensureSnapshotChainIntegrity();
}

await main();
