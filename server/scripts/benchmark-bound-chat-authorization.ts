import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SQL } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { seedBoundChatAuthorization } from "../src/__tests__/helpers/bound-chat-authorization.js";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { authorizeChatConversationForBoundRun as treatment } from "../src/services/native-runtime/chat-attachment-reuse.js";

const baselineRef = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass --baseline-ref=<pre-fix commit>");
const root = fileURLToPath(new URL("../../", import.meta.url));
const baselineRevision = execFileSync("git", ["rev-parse", `${baselineRef}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const treatmentRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const modulePath = "server/src/services/native-runtime/chat-attachment-reuse.ts";
const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { cwd: root, encoding: "utf8" });
const currentSource = await readFile(path.join(root, modulePath), "utf8");
assert.notEqual(source, currentSource, "Baseline must precede the optimization");
const baselineDir = await mkdtemp(path.join(root, "server/scripts/.bound-chat-baseline-"));
const baselineFile = path.join(baselineDir, "chat-attachment-reuse.ts");
const moduleUrl = pathToFileURL(path.join(root, modulePath));
await writeFile(baselineFile, source.replace(/from "(\.{1,2}\/[^\"]+)"/g,
  (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, moduleUrl)))}`));
const keepAlive = setInterval(() => {}, 1_000);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  const { authorizeChatConversationForBoundRun: baseline } = await import(pathToFileURL(baselineFile).href) as
    typeof import("../src/services/native-runtime/chat-attachment-reuse.js");
  temporary = await startEmbeddedPostgresTestDatabase("bound-chat-benchmark-");
  db = createDb(temporary.connectionString);
  const fixture = await seedBoundChatAuthorization(db);
  const readers = { baseline, treatment };
  const expected = { endpointId: fixture.endpointId, conversationId: fixture.conversationId };
  for (const reader of Object.values(readers)) {
    for (let n = 0; n < 500; n++) assert.deepEqual(await reader(db, fixture.binding, fixture.context, "read"), expected);
  }
  const iterations = 500;
  const samples = [];
  for (let round = 0; round < 7; round++) {
    for (const label of round % 2 ? ["treatment", "baseline"] as const : ["baseline", "treatment"] as const) {
      const cpuStart = process.cpuUsage(), start = performance.now();
      for (let n = 0; n < iterations; n++) {
        assert.deepEqual(await readers[label](db, fixture.binding, fixture.context, "read"), expected);
      }
      const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
      const sample = { round, label, iterations, cpuMs: (cpu.user + cpu.system) / 1_000, wallMs };
      samples.push(sample);
      process.stdout.write(JSON.stringify(sample) + "\n");
    }
  }
  const compilationCounts: Record<string, number> = {};
  const original = SQL.prototype.toQuery;
  for (const label of ["baseline", "treatment"] as const) {
    let compilations = 0;
    SQL.prototype.toQuery = function (...args) {
      compilations++;
      return Reflect.apply(original, this, args);
    };
    try {
      assert.deepEqual(await readers[label](db, fixture.binding, fixture.context, "read"), expected);
    } finally { SQL.prototype.toQuery = original; }
    compilationCounts[label] = compilations;
  }
  assert.equal(compilationCounts.baseline - compilationCounts.treatment, 1);
  process.stdout.write(JSON.stringify({ baselineRevision, treatmentRevision, node: process.version,
    platform: process.platform, arch: process.arch, iterations, rounds: 7, warmups: 500,
    data: "one active Slack conversation, processed inbound message, linked member, enabled destination",
    surface: "authorizeChatConversationForBoundRun, real PostgreSQL, read mode, warmed exact root handle",
    compilationCounts, samples }) + "\n");
} finally {
  await db?.$client.end({ timeout: 1 });
  await temporary?.cleanup();
  await rm(baselineDir, { recursive: true, force: true });
  clearInterval(keepAlive);
}
