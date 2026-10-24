import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

export type BundledMigrationRelease = {
  /** sha256 over every bundled `.sql` file (name + content hash) and the journal. */
  migrationsDigest: string;
  latestMigration: string;
  migrationCount: number;
};

/**
 * Identity of the migration set shipped with this build. A managed embedded
 * stack only runs the migrator whose digest the harness pinned for the
 * target release, so a tampered or mismatched image fails before mutation.
 */
export async function readBundledMigrationRelease(
  migrationsFolder: string = MIGRATIONS_FOLDER,
  journalFile: string = MIGRATIONS_JOURNAL_JSON,
): Promise<BundledMigrationRelease> {
  const files = (await readdir(migrationsFolder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error(`No bundled migrations found in ${migrationsFolder}`);

  const digest = createHash("sha256");
  for (const name of files) {
    const content = await readFile(`${migrationsFolder}/${name}`);
    digest.update(`file:${name}:${createHash("sha256").update(content).digest("hex")}\n`);
  }
  const journal = await readFile(journalFile);
  digest.update(`journal:${createHash("sha256").update(journal).digest("hex")}\n`);

  return {
    migrationsDigest: digest.digest("hex"),
    latestMigration: files[files.length - 1]!,
    migrationCount: files.length,
  };
}
