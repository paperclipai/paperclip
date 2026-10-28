import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { companies, companySkills, companySkillVersions, companySkillRepositorySnapshots, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createRunPreparationTiming, withRunExecutionTiming } from "../services/execution-preparation-timing.js";
import { skillSnapshotHash } from "../services/skill-snapshot.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// This test owns its in-memory tracer; do not start the application exporter.
vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
const { companySkillService } = await import("../services/company-skills.js");
const { withSkillVersionCacheLock } = await import("../services/skill-version-cache.js");
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("runtime skill observability", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const exporter = new InMemorySpanExporter();
  const lifecycle: string[] = [];
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter }), {
    onStart: span => { lifecycle.push(`start:${span.name}`); },
    onEnd: span => { lifecycle.push(`end:${span.name}`); },
    forceFlush: async () => {}, shutdown: async () => {},
  }] });
  const manager = new AsyncLocalStorageContextManager();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("skill-observability-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-observability-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    expect(context.setGlobalContextManager(manager.enable())).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await provider.shutdown();
    trace.disable(); context.disable(); manager.disable();
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  async function fixture() {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const key = `company/${companyId}/traced`;
    const files = [{ path: "skills/traced/SKILL.md", kind: "skill" as const,
      content: "---\nname: traced\ndescription: Trace fixture\n---\nReport the model ID.\n" }];
    await db.insert(companies).values({ id: companyId, name: "Trace fixture", issuePrefix: `TR${companyId.slice(0, 6)}` });
    await db.insert(companySkills).values({ id: skillId, companyId, key, slug: "traced", name: "Traced",
      sourceType: "github", sourceLocator: "https://example.invalid/immutable-fixture", markdown: files[0]!.content });
    const [snapshot] = await db.insert(companySkillRepositorySnapshots).values({ companyId,
      contentHash: skillSnapshotHash(files), fileInventory: files }).returning();
    const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skillId,
      revisionNumber: 1, repositorySnapshotId: snapshot!.id, repositorySkillPath: files[0]!.path }).returning();
    await db.update(companySkills).set({ currentVersionId: version!.id }).where(eq(companySkills.id, skillId));
    const service = companySkillService(db);
    const options = { onlyKeys: new Set([key]), versionSelections: new Map([[key, version!.id]]), snapshotLatest: true };
    return { companyId, service, options };
  }

  it("parents real preparation work and ends acquisition before the consumer settles", async () => {
    const f = await fixture();
    exporter.reset();
    lifecycle.length = 0;
    const entered = deferred(), release = deferred();
    const runId = randomUUID();
    const preparation = withRunExecutionTiming(runId, () => createRunPreparationTiming(runId)("configuration_skills",
      () => f.service.withRuntimeSkillEntries(f.companyId, f.options, async entries => {
        entered.resolve(); await release.promise; return entries;
      })));
    try {
      await Promise.race([entered.promise, preparation]);
      expect(exporter.getFinishedSpans().filter(span => span.name === "skills.cache.acquire")).toHaveLength(1);
      expect(exporter.getFinishedSpans().some(span => span.name === "skills.consume")).toBe(false);
    } finally { release.resolve(); await preparation; }
    expect(await preparation).toMatchObject([{ sourceStatus: "available" }]);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const span = (name: string) => { const found = spans.find(candidate => candidate.name === name); assert.ok(found, name); return found; };
    for (const [child, parent] of [
      ["heartbeat.prepare.configuration_skills", "task.execution_attempt"],
      ["skills.inventory", "heartbeat.prepare.configuration_skills"],
      ["skills.inventory.bundled", "skills.inventory"],
      ["skills.inventory.releases", "skills.inventory"],
      ["skills.inventory.folders", "skills.inventory"],
      ["skills.inventory.local_sources", "skills.inventory"],
      ["skills.cache.acquire", "heartbeat.prepare.configuration_skills"],
      ["skills.rows", "heartbeat.prepare.configuration_skills"],
      ["skills.version.read", "heartbeat.prepare.configuration_skills"],
      ["skills.version.materialize", "heartbeat.prepare.configuration_skills"],
      ["skills.repository.read", "skills.version.materialize"],
      ["skills.version.verify", "skills.version.materialize"],
      ["skills.consume", "heartbeat.prepare.configuration_skills"],
    ]) expect(span(child!).parentSpanContext?.spanId, child).toBe(span(parent!).spanContext().spanId);
    const acquisition = span("skills.cache.acquire");
    expect(acquisition.status.code).not.toBe(SpanStatusCode.ERROR);
    // SDK timestamps can differ by less than a millisecond at this boundary.
    // Observe actual lifecycle order instead of comparing rounded wall clocks.
    expect(lifecycle.indexOf("end:skills.cache.acquire")).toBeLessThan(lifecycle.indexOf("start:skills.rows"));
    expect(new Set(spans.map(value => value.spanContext().traceId)).size).toBe(1);
    expect(spans.every(value => Object.keys(value.attributes).every(key => [
      "paperclip.task.run.run_id", "paperclip.execution.fileCount", "paperclip.execution.bytes",
    ].includes(key)))).toBe(true);
  }, 30_000);

  it("ends a failed real lock acquisition and preserves the database error", async () => {
    const f = await fixture();
    await f.service.listRuntimeSkillEntries(f.companyId, f.options);
    const name = new URL(database.connectionString).pathname.slice(1);
    assert.match(name, /^[a-zA-Z0-9_-]+$/);
    await db.$client.unsafe(`ALTER DATABASE "${name}" SET lock_timeout TO '100ms'`);
    const entered = deferred(), release = deferred();
    const holder = withSkillVersionCacheLock(db, f.companyId, async () => { entered.resolve(); await release.promise; });
    try {
      await Promise.race([entered.promise, holder]);
      exporter.reset();
      const runId = randomUUID();
      await expect(withRunExecutionTiming(runId, () => createRunPreparationTiming(runId)("configuration_skills",
        () => f.service.listRuntimeSkillEntries(f.companyId, f.options)))).rejects.toMatchObject({ cause: { code: "55P03" } });
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      const acquisitions = spans.filter(span => span.name === "skills.cache.acquire");
      expect(acquisitions).toHaveLength(1);
      expect(acquisitions[0]!.status.code).toBe(SpanStatusCode.ERROR);
      const configuration = spans.find(span => span.name === "heartbeat.prepare.configuration_skills");
      expect(acquisitions[0]!.parentSpanContext?.spanId).toBe(configuration?.spanContext().spanId);
      expect(spans.some(span => span.name === "skills.rows")).toBe(false);
    } finally { release.resolve(); await holder; }
    expect(await f.service.listRuntimeSkillEntries(f.companyId, f.options)).toMatchObject([{ sourceStatus: "available" }]);
  }, 30_000);
});
