// Reports whether migrations can be applied while the previous release is
// still running. See "Migration compatibility with the running release" in
// doc/DATABASE.md.
//
//   tsx scripts/migration-compatibility.ts                 summary of every migration
//   tsx scripts/migration-compatibility.ts --json          per-migration results as JSON
//   tsx scripts/migration-compatibility.ts <file.sql>...   classify the named files
//   tsx scripts/migration-compatibility.ts --check [--base <ref>]
//       fail when a migration added since the merge base with <ref>
//       (default origin/master, then master) is `unknown` without an override
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkNewMigrationCompatibility,
  classifyMigrationSequence,
  parseNonTransactionalMigrations,
  summarizeMigrationCompatibility,
  type MigrationCompatInput,
} from "../src/migration-compatibility.js";

const migrationsDir = fileURLToPath(new URL("../src/migrations", import.meta.url));
const executorPath = fileURLToPath(new URL("../src/client.ts", import.meta.url));

function journalFiles(): string[] {
  const journal = JSON.parse(readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  // Apply order: journal idx, then file name (the journal repeats an idx).
  return [...journal.entries]
    .sort((left, right) => left.idx - right.idx || left.tag.localeCompare(right.tag))
    .map((entry) => `${entry.tag}.sql`);
}

function read(file: string): MigrationCompatInput {
  return { fileName: path.basename(file), sql: readFileSync(file, "utf8") };
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: migrationsDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Journal migrations split by whether the merge base has them, or null without git history. */
function migrationsAddedSince(requestedBase: string | null): { base: string; prior: string[]; files: string[] } | null {
  for (const ref of requestedBase ? [requestedBase] : ["origin/master", "master"]) {
    const base = git(["merge-base", "HEAD", ref])?.trim();
    if (!base) continue;
    // ls-tree lists the current directory (the migrations folder) of the base.
    const listed = git(["ls-tree", "--name-only", base]);
    if (!listed?.includes(".sql")) continue;
    const existing = new Set(listed.split("\n"));
    const journal = journalFiles();
    return { base, prior: journal.filter((file) => existing.has(file)), files: journal.filter((file) => !existing.has(file)) };
  }
  return null;
}

function check(requestedBase: string | null): number {
  const added = migrationsAddedSince(requestedBase);
  if (!added) {
    // A source archive or shallow clone has no base to compare with. The pull
    // request policy job runs the same guard with full history.
    console.log("migration compatibility: no merge base available, skipped.");
    return requestedBase ? 2 : 0;
  }
  const nonTransactionalMigrations = parseNonTransactionalMigrations(readFileSync(executorPath, "utf8"));
  if (!nonTransactionalMigrations) {
    console.error("error: MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS was not found in packages/db/src/client.ts.");
    return 1;
  }
  const result = checkNewMigrationCompatibility(added.files.map((file) => read(path.join(migrationsDir, file))), {
    priorMigrationSql: added.prior.map((file) => read(path.join(migrationsDir, file)).sql),
    nonTransactionalMigrations,
  });
  for (const notice of result.notices) console.log(`notice: ${notice}`);
  for (const error of result.errors) console.error(`error: ${error}`);
  if (result.passed) {
    console.log(`migration compatibility: ${added.files.length} new migration(s) since ${added.base.slice(0, 12)}, none unclassified.`);
  }
  return result.passed ? 0 : 1;
}

function main(): number {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const baseIndex = args.indexOf("--base");
  const base = baseIndex === -1 ? null : args[baseIndex + 1] ?? null;
  if (flag("--check")) return check(base);

  const named = args.filter((arg, index) => !arg.startsWith("--") && (baseIndex === -1 || index !== baseIndex + 1));
  const journal = journalFiles().map((file) => read(path.join(migrationsDir, file)));
  // A named file is judged after the journal migrations that precede it, or
  // after the whole journal when it is not in the journal yet.
  const results = named.length === 0
    ? classifyMigrationSequence(journal.map((input) => input.sql)).map((result, index) => ({ fileName: journal[index].fileName, ...result }))
    : named.map(read).map((input) => {
      const position = journal.findIndex((entry) => entry.fileName === input.fileName);
      const prior = (position === -1 ? journal : journal.slice(0, position)).map((entry) => entry.sql);
      return { fileName: input.fileName, ...classifyMigrationSequence([input.sql], prior)[0] };
    });
  if (flag("--json")) {
    console.log(JSON.stringify(results, null, 2));
    return 0;
  }
  if (named.length > 0) {
    for (const result of results) {
      console.log(`${result.fileName}: ${result.compatibility}${result.override ? " (override)" : ""}`);
      for (const reason of result.reasons) {
        const where = reason.statements.length ? ` [statement ${reason.statements.join(", ")}]` : "";
        console.log(`  ${reason.compatibility} ${reason.code}${where}: ${reason.message}`);
      }
    }
    return 0;
  }
  const summary = summarizeMigrationCompatibility(results);
  const percent = (count: number) => `${((count / Math.max(summary.total, 1)) * 100).toFixed(1)}%`;
  console.log(`${summary.total} migrations, ${summary.overrides} with an override`);
  for (const [compatibility, count] of Object.entries(summary.byCompatibility)) {
    console.log(`  ${compatibility.padEnd(18)} ${String(count).padStart(4)}  ${percent(count)}`);
  }
  console.log("Migrations per blocking reason:");
  for (const reason of summary.blockingReasons) {
    console.log(`  ${String(reason.migrations).padStart(4)}  ${reason.compatibility.padEnd(16)} ${reason.code}`);
  }
  return 0;
}

process.exitCode = main();
