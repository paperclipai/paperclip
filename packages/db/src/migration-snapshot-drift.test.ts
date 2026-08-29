import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

// The newest snapshot in `src/migrations/meta` is the state `drizzle-kit
// generate` diffs the schema against. When it drifts from the schema, the next
// generated migration silently carries the drift: it re-adds a column an
// earlier migration already created (which fails on a fresh database) and drops
// a column the schema never had. This test reproduces the diff `generate`
// performs — schema modules versus newest snapshot — and fails when it is not
// empty, so drift is caught in CI instead of inside someone else's migration.

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("./schema", import.meta.url));

type JournalEntry = { idx: number; tag: string };

async function readNewestSnapshot(): Promise<{ file: string; snapshot: Record<string, unknown> }> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  const newest = journal.entries.at(-1);
  if (!newest) throw new Error("migration journal has no entries");
  const file = `${String(newest.idx).padStart(4, "0")}_snapshot.json`;
  const snapshot = JSON.parse(await readFile(path.join(migrationsDir, "meta", file), "utf8")) as Record<
    string,
    unknown
  >;
  return { file, snapshot };
}

// drizzle.config.ts points drizzle-kit at every module in the schema directory,
// so the test imports the same set rather than the hand-maintained barrel — a
// table missing from the barrel must not hide from this check.
async function importSchemaModules(): Promise<Record<string, unknown>> {
  const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".ts")).sort();
  const exports: Record<string, unknown> = {};
  // The barrel re-exports the same table objects the per-table modules export,
  // so dedupe by identity: serializing one table twice trips drizzle-kit's
  // duplicate-index guard.
  const seen = new Set<unknown>();
  for (const file of files) {
    const module = (await import(pathToFileURL(path.join(schemaDir, file)).href)) as Record<
      string,
      unknown
    >;
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) continue;
        seen.add(value);
      }
      exports[`${file}#${name}`] = value;
    }
  }
  return exports;
}

describe("migration snapshot drift", () => {
  it("keeps the newest snapshot in sync with the drizzle schema", async () => {
    const { file, snapshot } = await readNewestSnapshot();
    const current = generateDrizzleJson(await importSchemaModules(), snapshot.id as string);
    const statements = await generateMigration(
      snapshot as Parameters<typeof generateMigration>[0],
      current as Parameters<typeof generateMigration>[1],
    );

    expect(
      statements,
      `${file} no longer matches src/schema. Run \`pnpm --filter @paperclipai/db generate\` and commit the migration it emits; do not hand-edit the snapshot.`,
    ).toEqual([]);
  });
});
