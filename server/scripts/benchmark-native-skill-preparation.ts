/** Real skill resolution, PostgreSQL, and filesystem work; no provider is started. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createServer, type Socket } from "node:net";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { eq, sql } from "drizzle-orm";
import { authUsers, companyMemberships, companySkillSources, heartbeatRuns, projects, projectSkillSources,
  companies, companySkills, companySkillVersions, companySkillRepositorySnapshots,
  applyPendingMigrations, closeRegisteredClients, createDb, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { createRunPreparationTiming, withRunExecutionTiming } from "../src/services/execution-preparation-timing.js";
import { repositorySkillProjection } from "../src/services/skill-repository-package.js";
import { skillFileBytes, skillSnapshotHash } from "../src/services/skill-snapshot.js";

const argument = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const exportOtlp = argument("--export-otlp") === "true";
const authenticated = argument("--actor") === "agent";
const stagingShape = argument("--staging-shape") === "true";
// This standalone benchmark owns its tracer. Load the service graph with the
// app-wide SDK disabled, then restore the operator's export configuration.
const operatorEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
let companySkillService: typeof import("../src/services/company-skills.js").companySkillService;
let withSkillActor: typeof import("../src/services/skill-access.js").withSkillActor;
let createAgentLifecycle: typeof import("../src/services/agent-lifecycle.js").createAgentLifecycle;
try {
  ({ companySkillService } = await import("../src/services/company-skills.js"));
  ({ withSkillActor } = await import("../src/services/skill-access.js"));
  ({ createAgentLifecycle } = await import("../src/services/agent-lifecycle.js"));
}
finally {
  if (operatorEndpoint !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = operatorEndpoint;
}
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
}).trim();
const sourceHash = createHash("sha256");
for (const file of [import.meta.url, new URL("../src/services/company-skills.ts", import.meta.url),
  new URL("../src/services/skill-version-cache.ts", import.meta.url), new URL("../src/services/execution-preparation-timing.ts", import.meta.url)]) {
  sourceHash.update(await fs.readFile(new URL(file)));
}
const sourceChangesHash = sourceHash.digest("hex");
if (exportOtlp) assert.ok(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim(), "OTLP export requires an operator-configured endpoint");
const snapshotFile = argument("--snapshot-file");
const entrypoint = argument("--entrypoint") ?? "skills/diagnostic/SKILL.md";
const files: CompanySkillVersionFileInventoryEntry[] = snapshotFile
  ? JSON.parse(await fs.readFile(snapshotFile, "utf8"))
  : [{ path: entrypoint, kind: "skill", content: "---\nname: diagnostic\ndescription: Native preparation benchmark\n---\nReport the model ID.\n" },
    ...Array.from({ length: 207 }, (_, index) => ({ path: `assets/${index}.txt`, kind: "reference" as const, content: "x".repeat(52_000) }))];
const projected = repositorySkillProjection(files, entrypoint);
const previous = { home: process.env.PAPERCLIP_HOME, instance: process.env.PAPERCLIP_INSTANCE_ID, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT };
const home = await fs.mkdtemp(path.join(os.tmpdir(), "native-skill-benchmark-"));
let provider: TracerProvider | undefined;
let manager: AsyncLocalStorageContextManager | undefined;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let proxy: ReturnType<typeof createServer> | null = null;
const connections = new Set<Socket>();
try {
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = exportOtlp ? previous.endpoint : "http://127.0.0.1:4318";
  const exporter = new InMemorySpanExporter();
  const processors = [new SimpleSpanProcessor({ exporter })];
  const exportResults: number[] = [];
  if (exportOtlp) {
    const packages: Record<string, string> = { grpc: "@opentelemetry/exporter-trace-otlp-grpc",
      "http/protobuf": "@opentelemetry/exporter-trace-otlp-proto", "http/json": "@opentelemetry/exporter-trace-otlp-http" };
    const packageName = packages[process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "grpc"];
    assert.ok(packageName, "Unsupported OTLP protocol");
    const { OTLPTraceExporter } = await import(packageName);
    const live = new OTLPTraceExporter();
    processors.push(new SimpleSpanProcessor({ exporter: {
      export: (spans, callback) => live.export(spans, (result: { code: number }) => { exportResults.push(result.code); callback(result); }),
      shutdown: () => live.shutdown(),
    } }));
  }
  provider = new TracerProvider({ spanProcessors: processors, resource: resourceFromAttributes({
    "service.name": process.env.OTEL_SERVICE_NAME || "paperclip",
    "service.version": `local-skill-bench-${sourceChangesHash.slice(0, 12)}`,
    "deployment.environment.name": "local-diagnostic",
  }) });
  manager = new AsyncLocalStorageContextManager().enable();
  assert.ok(context.setGlobalContextManager(manager));
  assert.ok(trace.setGlobalTracerProvider(provider));
  async function startDatabase() {
    const port = argument("--postgres-port");
    if (!port) return startEmbeddedPostgresTestDatabase("native-skill-benchmark-");
    assert.match(port, /^\d{1,5}$/);
    assert.ok(Number(port) > 0 && Number(port) <= 65535);
    const username = argument("--postgres-user") ?? os.userInfo().username;
    const adminUrl = `postgres://${encodeURIComponent(username)}@127.0.0.1:${port}/postgres`;
    const name = `native_skill_bench_${randomUUID().replaceAll("-", "")}`;
    const connectionString = `postgres://${encodeURIComponent(username)}@127.0.0.1:${port}/${name}`;
    const admin = createDb(adminUrl, { maxConnections: 1 }).$client;
    try { await admin.unsafe(`CREATE DATABASE "${name}"`); }
    finally { await admin.end({ timeout: 1 }); }
    const cleanup = async () => {
      await closeRegisteredClients(connectionString);
      const cleanupAdmin = createDb(adminUrl, { maxConnections: 1 }).$client;
      try { await cleanupAdmin.unsafe(`DROP DATABASE "${name}"`); }
      finally { await cleanupAdmin.end({ timeout: 1 }); }
    };
    try { await applyPendingMigrations(connectionString); }
    catch (error) { await cleanup(); throw error; }
    return { connectionString, cleanup };
  }
  database = await startDatabase();
  const networkDelayMs = Number(argument("--network-delay-ms") ?? 0);
  assert.ok(Number.isFinite(networkDelayMs) && networkDelayMs >= 0 && networkDelayMs <= 100);
  const target = new URL(database.connectionString);
  const upstreamPort = Number(target.port);
  proxy = networkDelayMs ? createServer(client => {
    const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true);
      connections.add(socket);
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
      socket.on("close", () => { connections.delete(socket); });
    }
    const relay = (source: Socket, destination: Socket) => {
      let pendingBytes = 0;
      source.on("data", chunk => {
        pendingBytes += chunk.length;
        if (pendingBytes >= 2 * 1024 * 1024) source.pause();
        setTimeout(() => {
          pendingBytes -= chunk.length;
          if (destination.destroyed) return;
          const writable = destination.write(chunk);
          if (writable && pendingBytes < 2 * 1024 * 1024) source.resume();
        }, networkDelayMs);
      });
      destination.on("drain", () => { if (pendingBytes < 2 * 1024 * 1024) source.resume(); });
      source.on("end", () => setTimeout(() => destination.end(), networkDelayMs));
    };
    relay(client, upstream); relay(upstream, client);
  }) : null;
  if (proxy) {
    const server = proxy;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    target.port = String(address.port);
  }
  db = createDb(target.href);
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = randomUUID();
  const skillId = randomUUID();
  const key = `company/${companyId}/diagnostic`;
  const samples: unknown[] = [];
  let rootPoolQueries = 0;
  db.$client.options.debug = () => { rootPoolQueries++; };
  await db.insert(companies).values({ id: companyId, name: "Native preparation benchmark", issuePrefix: "BENCH" });
  if (authenticated) {
    await createAgentLifecycle(db).requestHire(companyId, {
      id: agentId, name: "Diagnostic reader", adapterType: "paperclip_runner", status: "paused",
    }, { runnerResolved: true });
    await db.insert(authUsers).values({ id: userId, name: "Diagnostic owner", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner" },
    ]);
  }
  if (stagingShape) {
    // Match observed staging cardinalities without copying unrelated company content.
    const projectRows = await db.insert(projects).values(Array.from({ length: 14 }, (_, i) => ({ companyId, name: `Fixture ${i}` }))).returning();
    const sourceRows = await db.insert(companySkillSources).values(Array.from({ length: 10 }, (_, i) => ({
      companyId, repositoryUrl: `https://example.invalid/fixture-${i}`, fullName: `fixture/${i}`, trackingRef: "main",
      accessScope: i < 4 ? "projects" as const : "company" as const,
    }))).returning();
    await db.insert(projectSkillSources).values(Array.from({ length: 8 }, (_, i) => ({ companyId,
      projectId: projectRows[i % 5]!.id, sourceId: sourceRows[i]!.id,
      repositoryUrl: sourceRows[i]!.repositoryUrl, trackingRef: "main", status: "ready" as const,
    })));
    await db.insert(companySkills).values(Array.from({ length: 155 }, (_, i) => ({ companyId,
      key: `fixture/unselected-${i}`, slug: `unselected-${i}`, name: `Unselected ${i}`, sourceType: "github",
      sourceLocator: "https://example.invalid/immutable-fixture", markdown: "x".repeat(7_330),
      accessSourceId: sourceRows[i % sourceRows.length]!.id,
    })));
    await db.insert(companySkills).values({ companyId, key: "fixture/catalog", slug: "catalog", name: "Unselected catalog", sourceType: "catalog", markdown: "x".repeat(1_578) });
  }
  await db.insert(companySkills).values({ id: skillId, companyId, key, slug: "diagnostic", name: "Diagnostic",
    markdown: files.find(file => file.path === entrypoint)!.content, sourceType: "github",
    sourceLocator: "https://example.invalid/immutable-fixture", metadata: { packageMode: "repository", snapshotHash: "fixture" } });
  const [snapshot] = await db.insert(companySkillRepositorySnapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: files }).returning();
  const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skillId, revisionNumber: 1,
    repositorySnapshotId: snapshot!.id, repositorySkillPath: entrypoint }).returning();
  await db.update(companySkills).set({ currentVersionId: version!.id }).where(eq(companySkills.id, skillId));
  const benchmarkDb = db;
  const service = companySkillService(db);
  for (const label of ["cold", "warm-1", "warm-2", "warm-new-service"]) {
    exporter.reset();
    rootPoolQueries = 0;
    const selected: ReturnType<typeof companySkillService> = label === "warm-new-service" ? companySkillService(db) : service;
    const runId = randomUUID();
    if (authenticated) await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: { executionPolicy: {} } });
    rootPoolQueries = 0;
    const measuredStarted = performance.now();
    const resolve = () => selected.withRuntimeSkillEntries(companyId, {
      onlyKeys: new Set([key]), versionSelections: new Map([[key, version!.id]]), snapshotLatest: true,
    }, async entries => {
      if (authenticated) await benchmarkDb.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ skillVersions: { [key]: version!.id }, skillSelectionSnapshot: true })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
      return entries;
    });
    const entries: Awaited<ReturnType<typeof selected.listRuntimeSkillEntries>> = await withRunExecutionTiming(runId, () => createRunPreparationTiming(runId)("configuration_skills", () => authenticated
      ? withSkillActor({ type: "agent", agentId, companyId, runId, source: "agent_jwt", onBehalfOfUserId: userId }, resolve)
      : resolve()));
    const elapsedMs = performance.now() - measuredStarted;
    const queryCount = rootPoolQueries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sourceStatus, "available", entries[0]!.missingDetail ?? "Skill unavailable");
    // Verify the whole delivered repository, not just its authored SKILL.md.
    for (const file of projected) {
      const location = path.join(entries[0]!.source, file.path);
      assert.deepEqual(await fs.readFile(location), skillFileBytes(file));
      if (process.platform !== "win32") assert.equal(Boolean((await fs.stat(location)).mode & 0o111), Boolean(file.executable));
    }
    await provider.forceFlush();
    if (exportOtlp) assert.ok(exportResults.length > 0 && exportResults.every(code => code === 0), "OTLP export failed");
    const spans = exporter.getFinishedSpans();
    assert.ok(spans.some(span => span.name === "skills.version.verify" && span.attributes["paperclip.execution.fileCount"] === projected.length));
    assert.equal(new Set(spans.map(span => span.spanContext().traceId)).size, 1);
    assert.ok(spans.every(span => Object.keys(span.attributes).every(key => ["paperclip.task.run.run_id", "paperclip.execution.fileCount", "paperclip.execution.bytes"].includes(key))));
    samples.push({ label, elapsedMs, rootPoolQueries: queryCount, traceId: spans[0]!.spanContext().traceId,
      phases: spans.filter(span => span.name.startsWith("skills.")).map(span => ({ name: span.name,
        durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
        spanId: span.spanContext().spanId, parentSpanId: span.parentSpanContext?.spanId,
        attributes: span.attributes })) });
    console.error(JSON.stringify({ label, elapsedMs, rootPoolQueries: queryCount }));
  }
  console.log(JSON.stringify({ schema: "paperclip.native-skill-preparation-benchmark.v1",
    sourceRevision, sourceChangesHash, exportedOtlp: exportOtlp,
    source: snapshotFile ? "supplied immutable snapshot" : "synthetic repository",
    networkDelayMsPerDirection: networkDelayMs, authenticated, stagingShape,
    repositoryHash: skillSnapshotHash(files), repositoryFiles: files.length, runtimeFiles: projected.length,
    runtimeBytes: projected.reduce((sum, file) => sum + skillFileBytes(file).length, 0), samples }, null, 2));
} finally {
  await db?.$client.end({ timeout: 1 });
  if (proxy) {
    for (const socket of connections) socket.destroy();
    const server = proxy;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await database?.cleanup();
  await provider?.shutdown();
  trace.disable(); context.disable(); manager?.disable();
  for (const [name, value] of Object.entries({ PAPERCLIP_HOME: previous.home, PAPERCLIP_INSTANCE_ID: previous.instance, OTEL_EXPORTER_OTLP_ENDPOINT: previous.endpoint })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
}
