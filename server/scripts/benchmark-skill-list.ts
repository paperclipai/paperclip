import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, createServer, type Socket } from "node:net";
import express from "express";
import { get as httpGet } from "node:http";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { eq } from "drizzle-orm";
import { authUsers, companies, companyMemberships, companySkills, companySkillSources,
  projectSkillSources, projects, applyPendingMigrations, closeRegisteredClients, createDb,
  startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import * as schema from "../../packages/db/src/schema/index.js";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "../../packages/db/src/response-capture.js";
import { withRunExecutionTiming } from "../src/services/execution-preparation-timing.js";

const argument = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const sampleCount = Number(argument("--samples") ?? 5);
const baselineRef = argument("--baseline-ref");
const delayMs = Number(argument("--network-delay-ms") ?? 3.5);
const captureArgument = argument("--capture-values") ?? "true";
assert.ok(["true", "false"].includes(captureArgument));
const captureValues = captureArgument === "true";
assert.ok(Number.isInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 10);
assert.ok(Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 20);
const previous = { home: process.env.PAPERCLIP_HOME, instance: process.env.PAPERCLIP_INSTANCE_ID,
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT };
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const { companySkillService } = await import("../src/services/company-skills.js");
const { createAgentLifecycle } = await import("../src/services/agent-lifecycle.js");
const { companySkillRoutes } = await import("../src/routes/company-skills.js");
const { skillAccessRequestContext, withSkillActor } = await import("../src/services/skill-access.js");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-list-benchmark-"));
const sourceFiles = [fileURLToPath(import.meta.url), fileURLToPath(new URL("../src/services/company-skills.ts", import.meta.url))];
const sourceHash = async () => {
  const hash = createHash("sha256");
  for (const file of sourceFiles) hash.update(await fs.readFile(file));
  return hash.digest("hex");
};
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" }).trim();
const measuredSourceHash = await sourceHash();
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let proxy: ReturnType<typeof createServer> | undefined;
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baselineFile: string | undefined;
let baselineRevision: string | undefined;
let baselineSourceHash: string | undefined;
let provider: TracerProvider | undefined;
let manager: AsyncLocalStorageContextManager | undefined;
const sockets = new Set<Socket>();
try {
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  const port = argument("--postgres-port");
  if (port) {
    assert.match(port, /^\d{1,5}$/);
    assert.ok(Number(port) > 0 && Number(port) < 65536);
    const user = encodeURIComponent(argument("--postgres-user") ?? os.userInfo().username);
    const name = `skill_list_${randomUUID().replaceAll("-", "")}_test`;
    const adminUrl = `postgres://${user}@127.0.0.1:${port}/postgres`;
    const connectionString = `postgres://${user}@127.0.0.1:${port}/${name}`;
    const admin = createDb(adminUrl, { maxConnections: 1 }).$client;
    try { await admin.unsafe(`CREATE DATABASE "${name}"`); } finally { await admin.end({ timeout: 1 }); }
    const cleanup = async () => {
      await closeRegisteredClients(connectionString);
      const client = createDb(adminUrl, { maxConnections: 1 }).$client;
      try { await client.unsafe(`DROP DATABASE "${name}"`); } finally { await client.end({ timeout: 1 }); }
    };
    database = { connectionString, cleanup };
    await applyPendingMigrations(connectionString);
  } else database = await startEmbeddedPostgresTestDatabase("skill-list-benchmark-");

  const target = new URL(database.connectionString);
  const upstreamPort = Number(target.port);
  if (delayMs) {
    proxy = createServer(client => {
      const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
      for (const socket of [client, upstream]) {
        socket.setNoDelay(true); sockets.add(socket);
        socket.on("error", () => { client.destroy(); upstream.destroy(); });
        socket.on("close", () => sockets.delete(socket));
      }
      const relay = (from: Socket, to: Socket) => {
        from.on("data", chunk => { from.pause(); setTimeout(() => {
          if (to.destroyed) return;
          if (to.write(chunk)) from.resume();
          else to.once("drain", () => from.resume());
        }, delayMs); });
        from.on("end", () => setTimeout(() => to.end(), delayMs));
      };
      relay(client, upstream); relay(upstream, client);
    });
    await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
    const address = proxy.address(); assert.ok(address && typeof address !== "string");
    target.port = String(address.port);
  }
  db = createDb(target.href);
  const companyId = randomUUID(), userId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Skill list benchmark", issuePrefix: "SLB" });
  await db.insert(authUsers).values({ id: userId, name: "Fixture owner", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
  const projectRows = await db.insert(projects).values(Array.from({ length: 14 }, (_, i) => ({ companyId, name: `Fixture ${i}` }))).returning();
  const sources = await db.insert(companySkillSources).values(Array.from({ length: 10 }, (_, i) => ({ companyId,
    repositoryUrl: `https://example.invalid/fixture-${i}`, fullName: `fixture/${i}`, trackingRef: "main",
    accessScope: i < 4 ? "projects" as const : "company" as const }))).returning();
  await db.insert(projectSkillSources).values(sources.slice(0, 8).map((source, i) => ({ companyId, sourceId: source.id,
    projectId: projectRows[i % 5]!.id, repositoryUrl: source.repositoryUrl, trackingRef: "main", status: "ready" as const })));
  const skills = await db.insert(companySkills).values(Array.from({ length: 155 }, (_, i) => ({ companyId,
    key: `fixture/skill-${i}`, slug: `skill-${i}`, name: `Skill ${String(i).padStart(3, "0")}`,
    markdown: "Synthetic unused markdown. ".repeat(280), sourceType: "github",
    sourceLocator: "https://example.invalid/immutable-fixture", accessSourceId: sources[i % 10]!.id,
    metadata: { unused: "metadata ".repeat(1000) }, fileInventory: [{ path: "SKILL.md", kind: "skill" as const }],
  }))).returning();
  const lifecycle = createAgentLifecycle(db);
  for (let i = 0; i < 40; i++) await lifecycle.requestHire(companyId, {
    name: `Reader ${i}`, adapterType: "process", status: i === 39 ? "terminated" : "paused",
    adapterConfig: { instructions: "Synthetic agent context. ".repeat(2600),
      paperclipSkillSync: { desiredSkills: [skills[i % 155]!.key, { key: skills[(i + 1) % 155]!.id, versionId: null }] } },
    runtimeConfig: { unused: "runtime ".repeat(1000) }, metadata: { unused: "metadata ".repeat(1000) },
  }, { runnerResolved: true });
  await companySkillService(db).list(companyId);

  const actor = { type: "board" as const, source: "session" as const, userId, companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner" }] };
  let baselineService: ReturnType<typeof companySkillService> | undefined;
  if (baselineRef) {
    assert.equal(captureValues, false, "Paired acceptance uses --capture-values=false");
    baselineRevision = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
    const source = execFileSync("git", ["show", `${baselineRevision}:server/src/services/company-skills.ts`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    baselineSourceHash = createHash("sha256").update(source).digest("hex");
    baselineFile = fileURLToPath(new URL(`../src/services/.company-skills-benchmark-${randomUUID()}.ts`, import.meta.url));
    await fs.writeFile(baselineFile, source, { flag: "wx", mode: 0o600 });
    const baselineModule = await import(pathToFileURL(baselineFile).href) as { companySkillService: typeof companySkillService };
    baselineService = baselineModule.companySkillService(db);
    await withSkillActor(actor, () => baselineService!.list(companyId));
  }

  const exporter = new InMemorySpanExporter();
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  manager = new AsyncLocalStorageContextManager().enable();
  assert.ok(context.setGlobalContextManager(manager)); assert.ok(trace.setGlobalTracerProvider(provider));
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
  const app = express();
  app.use((req, res, next) => {
    req.actor = actor;
    void withRunExecutionTiming(randomUUID(), () => new Promise<void>(resolve => { res.once("finish", resolve); next(); })).catch(next);
  });
  const candidateService = companySkillService(db);
  if (baselineService) app.get("/paired/:variant", skillAccessRequestContext, async (req, res) => {
    const selected = req.params.variant === "baseline" ? baselineService! : candidateService;
    res.json(await selected.list(companyId));
  });
  app.use("/api", companySkillRoutes(db));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/companies/${companyId}/skills`;
  let queryCount = 0;
  db.$client.options.debug = () => { queryCount++; };
  const request = async (etag?: string, requestUrl = url) => {
    queryCount = 0; exporter.reset();
    const started = performance.now();
    const response = await new Promise<{ status: number; body: string; etag: string | undefined }>((resolve, reject) => {
      const request = httpGet(requestUrl, { headers: etag ? { "if-none-match": etag } : {} }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8"), etag: response.headers.etag }));
      });
      request.setTimeout(20_000, () => request.destroy(new Error("Local benchmark request timed out")));
      request.on("error", reject);
    });
    const body = response.body;
    const elapsedMs = performance.now() - started;
    assert.equal(response.status, etag ? 304 : 200, "Unexpected local skills-list HTTP status");
    if (!etag) {
      const items = JSON.parse(body) as Array<{ key: string; attachedAgentCount: number }>;
      assert.ok(items.length >= 155);
      assert.equal(items.find(item => item.key === skills[0]!.key)?.attachedAgentCount, 1);
      assert.equal(items.find(item => item.key === skills[39]!.key)?.attachedAgentCount, 1);
      assert.equal(items.find(item => item.key === skills[40]!.key)?.attachedAgentCount, 0);
    }
    await provider!.forceFlush();
    return { elapsedMs, queryCount, status: response.status, etag: response.etag,
      bodyHash: createHash("sha256").update(body).digest("hex"),
      phases: exporter.getFinishedSpans().filter(span => span.name.startsWith("skills.")).map(span => ({ name: span.name,
        durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6 })) };
  };
  const first = await request(); assert.ok(first.etag);
  const events: Array<Record<string, unknown>> = [], now = Date.now();
  const capture = captureValues ? createDatabaseResponseCapture({ start: now - 1, end: now + 59_000 }, event => events.push(event)) : undefined;
  if (capture) installDatabaseResponseCapture(db, schema, capture);
  const samples = [];
  try {
    for (let i = 0; i < sampleCount; i++) {
      const variants = baselineService ? (i % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) : ["candidate"];
      for (const variant of variants) {
        const requestUrl = baselineService ? `http://127.0.0.1:${address.port}/paired/${variant}` : url;
        const result = await request(i % 2 ? first.etag! : undefined, requestUrl);
        if (result.status === 200) assert.equal(result.bodyHash, first.bodyHash, "Baseline and candidate must return the complete same list");
        samples.push({ variant, pair: i, ...result });
        console.error(JSON.stringify({ sample: i, variant, elapsedMs: result.elapsedMs, queries: result.queryCount, status: result.status }));
      }
    }
    if (capture) assert.ok(Date.now() < now + 59_000, "Capture expired; repeat with fewer samples or less injected delay");
  } finally { capture?.flush(); }
  assert.equal(await sourceHash(), measuredSourceHash, "Source changed during measurement");
  const timings = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1");
  if (capture) assert.ok(summary && summary.inFlightAtEnd === 0 && summary.overflowCalls === 0);
  const rowCount = (await db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).length;
  console.log(JSON.stringify({ schema: "paperclip.skill-list-benchmark.v1", sourceRevision, measuredSourceHash,
    fixture: { remoteSkills: 155, totalSkills: rowCount, agents: 40, nonterminatedAgents: 39, projects: 14, sources: 10 },
    captureValues, networkDelayMsPerDirection: delayMs, postgresVersion: await db.$client`select version()`,
    boundary: "production router and real service; synthetic authenticated board actor; postgres-js response values",
    medianMs: timings[Math.floor(timings.length / 2)], minMs: timings[0], maxMs: timings.at(-1),
    baselineRevision, baselineSourceHash,
    baselineDependencyScope: baselineService ? "Only company-skills.ts differs; imported helpers and runtime dependencies use this checkout for both versions" : null,
    variantResults: ["baseline", "candidate"].flatMap(variant => {
      const selected = samples.filter(sample => sample.variant === variant);
      if (!selected.length) return [];
      const durations = selected.map(sample => sample.elapsedMs).sort((a, b) => a - b);
      return [{ variant, samples: selected.length, medianMs: durations[Math.floor(durations.length / 2)], minMs: durations[0], maxMs: durations.at(-1) }];
    }),
    samples, responseCapture: events }, null, 2));
} finally {
  const failures: unknown[] = [];
  const clean = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
  await clean(async () => { if (baselineFile) await fs.rm(baselineFile, { force: true }); });
  await clean(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); } });
  await clean(async () => db?.$client.end({ timeout: 1 }));
  for (const socket of sockets) socket.destroy();
  await clean(async () => { if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve())); });
  await clean(async () => database?.cleanup());
  await clean(async () => provider?.shutdown());
  trace.disable(); context.disable(); manager?.disable();
  for (const [name, value] of Object.entries({ PAPERCLIP_HOME: previous.home, PAPERCLIP_INSTANCE_ID: previous.instance, OTEL_EXPORTER_OTLP_ENDPOINT: previous.endpoint })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await clean(() => fs.rm(home, { recursive: true, force: true }));
  if (failures.length) throw new AggregateError(failures, "Local benchmark cleanup failed");
}
