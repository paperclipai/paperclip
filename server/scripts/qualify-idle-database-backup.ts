import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveBackupQualificationPair, assertDistinctEmptyRestore, seedBackupQualificationFixture, qualifyBackupRestore } from "./lib/backup-qualification.js";

const pair = resolveBackupQualificationPair();
if (!pair) throw new Error("Set both PAPERCLIP_BACKUP_CHECKPOINT_SOURCE_TEST_DATABASE_URL and PAPERCLIP_BACKUP_CHECKPOINT_RESTORE_TEST_DATABASE_URL");
const output = process.argv[2];
const engine = process.argv[3] ?? "pg_dump";
if (!output || !["pg_dump", "javascript"].includes(engine)) throw new Error("Usage: qualify-idle-database-backup.ts <new-output-directory> [pg_dump|javascript]");
await mkdir(output);
await assertDistinctEmptyRestore(pair);
await seedBackupQualificationFixture(pair.sourceUrl);
const binaries = Object.fromEntries([process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump", process.env.PAPERCLIP_PSQL_PATH || "psql"]
  .map(binary => [binary, execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()]));
const result = await qualifyBackupRestore(pair, output, engine as "pg_dump" | "javascript");
const receipt = { version: 1, qualifiedAt: new Date().toISOString(), sourceDatabase: new URL(pair.sourceUrl).pathname.slice(1),
  restoreDatabase: new URL(pair.restoreUrl).pathname.slice(1), binaries, ...result,
  limits: ["Local logical restore proof; persistent provider volume and deployed sleep/wake require separate qualification"] };
await writeFile(path.join(output, "qualification.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
