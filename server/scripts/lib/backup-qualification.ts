import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createDb, runDatabaseBackup, runDatabaseRestore, type RunDatabaseBackupOptions } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../src/lib/dedicated-test-database-url.js";
import { verifyIdleDatabaseBackup } from "../../src/services/idle-database-backup.js";

export const SOURCE_ENV = "PAPERCLIP_BACKUP_CHECKPOINT_SOURCE_TEST_DATABASE_URL";
export const RESTORE_ENV = "PAPERCLIP_BACKUP_CHECKPOINT_RESTORE_TEST_DATABASE_URL";
export const retention = { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 };

export function resolveBackupQualificationPair(source = process.env[SOURCE_ENV], restore = process.env[RESTORE_ENV]) {
  const sourceUrl = resolveExternalTestDatabaseUrl(SOURCE_ENV, source);
  const restoreUrl = resolveExternalTestDatabaseUrl(RESTORE_ENV, restore);
  if (!sourceUrl && !restoreUrl) return undefined;
  if (!sourceUrl || !restoreUrl) throw new Error("Backup qualification requires both source and restore test database URLs");
  const a = new URL(sourceUrl), b = new URL(restoreUrl);
  if (a.hostname.toLowerCase() === b.hostname.toLowerCase() && (a.port || "5432") === (b.port || "5432")
    && decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname)) throw new Error("Backup source and restore databases must differ");
  return { sourceUrl, restoreUrl };
}

export type QualificationPair = NonNullable<ReturnType<typeof resolveBackupQualificationPair>>;

export async function assertDistinctEmptyRestore(pair: QualificationPair) {
  const source = createDb(pair.sourceUrl, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0, connectTimeoutSeconds: 5 }).$client;
  const target = createDb(pair.restoreUrl, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0, connectTimeoutSeconds: 5 }).$client;
  const key = randomBytes(8); const a = key.readInt32BE(0), b = key.readInt32BE(4);
  let sourceLocked = false, targetLocked = false;
  try {
    await source`SELECT pg_advisory_lock(${a}, ${b})`; sourceLocked = true;
    const [result] = await target`SELECT pg_try_advisory_lock(${a}, ${b}) AS acquired`;
    targetLocked = result!.acquired === true;
    if (!targetLocked) throw new Error("Backup source and restore resolve to the same actual database");
    const rows = await target`SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
      UNION ALL SELECT 1 FROM pg_depend
      WHERE refclassid = 'pg_namespace'::regclass AND refobjid = 'public'::regnamespace LIMIT 1`;
    if (rows.length) throw new Error("Backup restore target must be empty before restore");
  } finally {
    try {
      await Promise.all([
        ...(targetLocked ? [target`SELECT pg_advisory_unlock(${a}, ${b})`] : []),
        ...(sourceLocked ? [source`SELECT pg_advisory_unlock(${a}, ${b})`] : []),
      ]);
    } finally { await Promise.all([source.end({ timeout: 5 }), target.end({ timeout: 5 })]); }
  }
}

export async function seedBackupQualificationFixture(sourceUrl: string) {
  const source = createDb(sourceUrl, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0, connectTimeoutSeconds: 5 }).$client;
  try {
    await source`CREATE SCHEMA backup_qualification`;
    await source`CREATE TABLE backup_qualification.parents (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)`;
    await source`CREATE TABLE backup_qualification.children (id integer PRIMARY KEY, parent_id bigint REFERENCES backup_qualification.parents(id),
      value text, bytes bytea)`;
    await source`CREATE TABLE backup_qualification.binary_arrays (id integer PRIMARY KEY, payloads bytea[])`;
    await source.begin(async tx => {
      await tx`INSERT INTO backup_qualification.parents (value) VALUES ('last committed state — 雪 ☃')`;
      await tx`INSERT INTO backup_qualification.children VALUES (1, 1, NULL, decode('00ff10275c', 'hex')), (2, 1, 'empty bytes', decode('', 'hex')), (3, 1, 'null bytes', NULL)`;
      await tx`INSERT INTO backup_qualification.binary_arrays VALUES
        (1, ARRAY[decode('00ff10275c', 'hex'), convert_to('雪 ☃', 'UTF8'), decode('', 'hex'), NULL]::bytea[]),
        (2, ARRAY[]::bytea[]), (3, NULL),
        (4, ARRAY[[decode('00ff', 'hex'), NULL], [decode('', 'hex'), convert_to('雪', 'UTF8')]]::bytea[]),
        (5, array_fill(decode('00ff', 'hex'), ARRAY[2,2], ARRAY[0,3]))`;
    });
  } finally { await source.end({ timeout: 5 }); }
}

export async function inspectRestoredFixture(restoreUrl: string) {
  const target = createDb(restoreUrl, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0, connectTimeoutSeconds: 5 }).$client;
  try {
    const [row] = await target`SELECT p.id::text AS id, p.value, c.value AS nullable, encode(c.bytes, 'hex') AS binary
      FROM backup_qualification.parents p JOIN backup_qualification.children c ON c.parent_id = p.id WHERE c.id = 1`;
    if (!row || row.id !== "1" || row.value !== "last committed state — 雪 ☃" || row.nullable !== null || row.binary !== "00ff10275c") {
      throw new Error("Restored relational, Unicode, binary or null fixture differs");
    }
    const [empty] = await target`SELECT octet_length(bytes) AS size FROM backup_qualification.children WHERE id = 2`;
    if (empty?.size !== 0) throw new Error("Restored empty binary value differs");
    const [nullBytes] = await target`SELECT bytes IS NULL AS is_null FROM backup_qualification.children WHERE id = 3`;
    if (nullBytes?.is_null !== true) throw new Error("Restored null binary value differs");
    const arrays = await target`SELECT id, pg_typeof(payloads)::text AS type, array_dims(payloads) AS dimensions,
      CASE id
        WHEN 1 THEN payloads IS NOT DISTINCT FROM ARRAY[decode('00ff10275c', 'hex'), convert_to('雪 ☃', 'UTF8'), decode('', 'hex'), NULL]::bytea[]
        WHEN 2 THEN payloads IS NOT DISTINCT FROM ARRAY[]::bytea[]
        WHEN 3 THEN payloads IS NULL
        WHEN 4 THEN payloads IS NOT DISTINCT FROM ARRAY[[decode('00ff', 'hex'), NULL], [decode('', 'hex'), convert_to('雪', 'UTF8')]]::bytea[]
        WHEN 5 THEN payloads IS NOT DISTINCT FROM array_fill(decode('00ff', 'hex'), ARRAY[2,2], ARRAY[0,3])
      END AS matches FROM backup_qualification.binary_arrays ORDER BY id`;
    const expected = [
      { id: 1, type: "bytea[]", dimensions: "[1:4]", matches: true },
      { id: 2, type: "bytea[]", dimensions: null, matches: true },
      { id: 3, type: "bytea[]", dimensions: null, matches: true },
      { id: 4, type: "bytea[]", dimensions: "[1:2][1:2]", matches: true },
      { id: 5, type: "bytea[]", dimensions: "[0:1][3:4]", matches: true },
    ];
    if (JSON.stringify(arrays) !== JSON.stringify(expected)) throw new Error("Restored binary array values, dimensions or types differ");
    const [next] = await target`INSERT INTO backup_qualification.parents (value) VALUES ('sequence after restore') RETURNING id::text`;
    if (next?.id !== "2") throw new Error("Restored identity sequence did not resume at 2");
    try {
      await target`INSERT INTO backup_qualification.children VALUES (999, 999, NULL, decode('', 'hex'))`;
      throw new Error("Restored foreign key was not enforced");
    } catch (error) { if ((error as { code?: string }).code !== "23503") throw error; }
    return { relational: true, unicode: true, binary: true, emptyBinary: true, nullBinary: true, binaryArrays: true, nestedBinaryArrays: true, binaryArrayBounds: true, nullable: true, nextIdentity: next.id, foreignKeyEnforced: true };
  } finally { await target.end({ timeout: 5 }); }
}

export async function qualifyBackupRestore(pair: QualificationPair, backupDir: string, engine: RunDatabaseBackupOptions["backupEngine"]) {
  await assertDistinctEmptyRestore(pair);
  const archive = await runDatabaseBackup({ connectionString: pair.sourceUrl, backupDir, retention,
    backupEngine: engine, verifyBeforePrune: verifyIdleDatabaseBackup });
  await assertDistinctEmptyRestore(pair);
  await runDatabaseRestore({ connectionString: pair.restoreUrl, backupFile: archive.backupFile });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive.backupFile)) hash.update(chunk);
  return { engine, archive: archive.backupFile, sizeBytes: archive.sizeBytes,
    sha256: hash.digest("hex"),
    restored: await inspectRestoredFixture(pair.restoreUrl) };
}
