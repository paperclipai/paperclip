import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { companySecrets, createDb, secretAccessEvents, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import * as schema from "../../packages/db/src/schema/index.js";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "../../packages/db/src/response-capture.js";
import { secretService } from "../src/services/secrets.js";
import { createChatCredentials } from "../src/services/chat-channels/credentials.js";
import { seedChatCredentialBenchmark } from "../src/__tests__/helpers/chat-credential-benchmark-fixture.js";

// Synthetic local PostgreSQL only. No provider or network request is made.
const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass --baseline-ref=<pre-fix commit>");
const countOnly = process.argv.includes("--count-only");
const root = fileURLToPath(new URL("../../", import.meta.url));
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const modulePath = "server/src/services/secrets.ts";
const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-credential-benchmark-"));
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.credential-baseline-"));
const oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(temporaryDir, "master.key");
const keepAlive = setInterval(() => {}, 1_000);
let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  const sourceUrl = new URL(`../../${modulePath}`, import.meta.url);
  const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  const baselineFile = path.join(baselineDir, "secrets.ts");
  await fs.writeFile(baselineFile, source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, sourceUrl)))}`));
  const baseline = await import(pathToFileURL(baselineFile).href) as { secretService: typeof secretService };
  pg = await startEmbeddedPostgresTestDatabase("chat-credential-benchmark-");
  db = createDb(pg.connectionString);
  const { companyId, endpoint, expected } = await seedChatCredentialBenchmark(db);
  function reader(database: typeof db & {}, factory: typeof secretService) {
    return createChatCredentials(database, {
      secrets: factory(database), PROVIDER_LABELS: {} as Parameters<typeof createChatCredentials>[1]["PROVIDER_LABELS"],
      REQUIRED_CREDENTIALS: {} as Parameters<typeof createChatCredentials>[1]["REQUIRED_CREDENTIALS"],
      PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: 1_000, fetchImpl: globalThis.fetch,
      redactError: String, credentialFingerprint: JSON.stringify,
      verifyPhotonCredentials: async () => { throw new Error("Unexpected provider call"); },
    });
  }
  async function counted(factory: typeof secretService) {
    const events: Record<string, unknown>[] = [];
    const capture = createDatabaseResponseCapture({ start: Date.now(), end: Date.now() + 60_000 }, event => events.push(event));
    const countedDb = createDb(pg!.connectionString);
    installDatabaseResponseCapture(countedDb, schema, capture);
    try {
      assert.deepEqual(await reader(countedDb, factory).resolveCredentials(endpoint!), expected);
      capture.flush();
      return { summary: events.find(event => event.event === "paperclip.db_response_capture.summary.v2"),
        operations: events.filter(event => event.event === "paperclip.db_response_capture.entry.v2").map(event => ({
          operation: event.operation, table: event.table, calls: event.calls, rows: event.rows })) };
    } finally { capture.flush(); await countedDb.$client.end({ timeout: 0 }); }
  }
  const before = await counted(baseline.secretService), after = await counted(secretService);
  assert.equal(before.summary?.completedQueries, 21, "Baseline must reproduce three reads and two writes per ref plus connection read");
  assert.equal(after.summary?.completedQueries, 13, "Treatment must retain both writes per ref and join the reads");
  for (const result of [before, after]) {
    assert.equal(result.operations.filter(entry => entry.operation === "update").reduce((sum, entry) => sum + Number(entry.calls), 0), 4);
    assert.equal(result.operations.filter(entry => entry.operation === "insert").reduce((sum, entry) => sum + Number(entry.calls), 0), 4);
  }
  const audit = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId));
  assert.equal(audit.length, 8);
  assert.ok(audit.every(event => event.outcome === "success"));
  const resolved = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
  assert.ok(resolved.every(secret => secret.lastResolvedAt));
  const samples = { baseline: [] as { wallMs: number; cpuMs: number }[], treatment: [] as { wallMs: number; cpuMs: number }[] };
  if (!countOnly) {
    const readers = { baseline: reader(db, baseline.secretService), treatment: reader(db, secretService) };
    for (let sample = 0; sample < 9; sample++) {
      for (const version of sample % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
        const cpu = process.cpuUsage(), start = performance.now();
        for (let delivery = 0; delivery < 20; delivery++) assert.deepEqual(await readers[version].resolveCredentials(endpoint), expected);
        const usage = process.cpuUsage(cpu);
        if (sample >= 2) samples[version].push({ wallMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000 });
      }
    }
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    treatmentDiff: execFileSync("git", ["diff", "HEAD", "--", modulePath], { encoding: "utf8" }),
    node: process.version, platform: `${process.platform}/${process.arch}`,
    postgresVersion: (await db.$client.unsafe("SELECT version()"))[0]!.version,
    fixture: { synthetic: true, refs: 4, provider: "real local_encrypted", path: "createChatCredentials.resolveCredentials", deliveriesPerSample: 20 },
    correctness: { equalCredentials: true, successAuditsAfterTwoDeliveries: audit.length, lastResolvedAtUpdated: true },
    queries: { baseline: before, treatment: after }, timings: { uninstrumented: true, warmupSamples: 2, alternatingSamples: 7, samples,
      boundary: "Node process CPU, excludes PostgreSQL CPU; local source service wall time, no hosted claim" } }, null, 2));
} finally {
  await db?.$client.end({ timeout: 0 });
  await pg?.cleanup();
  await fs.rm(baselineDir, { recursive: true, force: true });
  await fs.rm(temporaryDir, { recursive: true, force: true });
  if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = oldKey;
  clearInterval(keepAlive);
}
