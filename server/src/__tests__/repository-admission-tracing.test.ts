import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { withDirectoryPublicationLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { createDb, executionWorkspaceRepositories, executionWorkspaces, issues, projects, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunPreparationTiming, withRunExecutionTiming } from "../services/execution-preparation-timing.js";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { authorizationService } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addReadyWorkspaceHistoryRepository, createWorkspacePreparationHistoryFixture } from "./helpers/workspace-preparation-history-fixture.js";

// Only the external catalog is replaced. Identity, authorization, receipts,
// publication locks and existing-checkout inspection use their real implementations.
const catalog = vi.hoisted(() => ({ list: vi.fn(async () => ({ repositories: [] })) }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ listProjectRepositories: catalog.list }) }));

const exec = promisify(execFile);
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("repository admission tracing with real persistence and Git", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  let fixture: Awaited<ReturnType<typeof createWorkspacePreparationHistoryFixture>>;
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;
  let manager: AsyncLocalStorageContextManager;
  let started: string[];
  let lifecycle: string[];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-repository-admission-tracing-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "repository-admission-tracing-"));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    vi.stubEnv("PAPERCLIP_HOME", path.join(directory, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "admission-tracing");
    catalog.list.mockClear();
    started = [];
    lifecycle = [];
    exporter = new InMemorySpanExporter();
    const starts: SpanProcessor = {
      onStart: span => { started.push(span.name); lifecycle.push(`${span.spanContext().spanId}:start`); },
      onEnd: span => { lifecycle.push(`${span.spanContext().spanId}:end`); },
      forceFlush: async () => {}, shutdown: async () => {},
    };
    provider = new TracerProvider({ spanProcessors: [starts, new SimpleSpanProcessor({ exporter })] });
    manager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    fixture = await createWorkspacePreparationHistoryFixture(db, path.join(directory, `source-${Date.now()}`), {
      workspaces: 0, sharedRoots: 0, sources: 0, readers: 0,
    });
    const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Selected source" }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: fixture.companyId,
      projectId: project.id, name: "Selected checkout", cwd: fixture.cwd }).returning();
    await db.update(issues).set({ projectWorkspaceId: source.id }).where(eq(issues.id, fixture.issueId));
    await db.update(executionWorkspaces).set({ projectId: project.id, projectWorkspaceId: source.id })
      .where(eq(executionWorkspaces.id, fixture.workspaceId));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    trace.disable(); context.disable(); manager.disable();
    await provider.shutdown();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  function admit(beforeAdmission?: () => Promise<void>) {
    return withRunExecutionTiming(fixture.runId, async () => {
      await beforeAdmission?.();
      return createRunPreparationTiming(fixture.runId)("workspace_repository_admission",
        () => executionWorkspaceRepositoryService(db).prepareForAdmission(fixture.input));
    });
  }

  function only(spans: ReadableSpan[], name: string, parent?: ReadableSpan) {
    const found = spans.filter(span => span.name === name
      && (!parent || span.parentSpanContext?.spanId === parent.spanContext().spanId));
    expect(found, `${name} under ${parent?.name ?? "trace"}`).toHaveLength(1);
    return found[0]!;
  }

  // SDK spans anchor their wall clocks independently at millisecond precision.
  // Processor event order proves causal containment without sub-millisecond jitter.
  const startsAt = (span: ReadableSpan) => lifecycle.indexOf(`${span.spanContext().spanId}:start`);
  const endsAt = (span: ReadableSpan) => lifecycle.indexOf(`${span.spanContext().spanId}:end`);

  function expectChild(child: ReadableSpan, parent: ReadableSpan) {
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(startsAt(child)).toBeGreaterThanOrEqual(startsAt(parent));
    expect(endsAt(child)).toBeLessThanOrEqual(endsAt(parent));
  }

  async function recordGitCommands() {
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const bin = path.join(fixture.cwd, "test-bin");
    const log = path.join(fixture.cwd, "git-commands.jsonl");
    await fs.mkdir(bin);
    // Pass through to real Git and retain only local synthetic test evidence.
    await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}\nconst fs = require("node:fs");\nconst cp = require("node:child_process");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\nconst result = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio: "inherit", env: process.env});\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    return async () => (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  }

  function expectPrivateFieldsAbsent(spans: ReadableSpan[]) {
    for (const span of spans) {
      expect(Object.keys(span.attributes)).toEqual(["paperclip.task.run.run_id"]);
      expect(span.events).toEqual([]);
      expect(span.status.message).toBeUndefined();
    }
    const exported = JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events, status: span.status })));
    for (const privateValue of [fixture.companyId, fixture.issueId, fixture.workspaceId, fixture.runId, fixture.cwd, fixture.pin]) {
      expect(exported).not.toContain(privateValue);
    }
  }

  it("exports repeated current checks and separates real lock contention from ready-checkout work", async () => {
    const repository = await addReadyWorkspaceHistoryRepository(db, fixture);
    const dirtyFile = path.join(repository.checkout, "result.txt");
    await fs.appendFile(dirtyFile, "Uncommitted task work\n");
    const commands = await recordGitCommands();
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = withDirectoryPublicationLock(repository.checkout, async () => { acquired(); await gate; });
    await ready;
    const admission = admit(async () => {
      const authorization = authorizationService(db);
      // Startup performs many unrelated decisions before repository admission.
      // They must not exhaust the workspace authorization detail budget.
      for (let index = 0; index < 20; index++) {
        const decision = await authorization.decide({ actor: { type: "board", source: "local_implicit", userId: "local-board" },
          action: "company_scope:read", resource: { type: "company", companyId: fixture.companyId } });
        expect(decision.allowed).toBe(true);
      }
    });
    void admission.catch(() => undefined);
    try {
      await vi.waitFor(() => {
        expect(started).toContain("workspace.repository.lock_wait");
        expect(exporter.getFinishedSpans().some(span => span.name === "workspace.repository.lock_wait")).toBe(false);
        expect(started).not.toContain("workspace.repository.critical_section");
      }, { timeout: 10_000 });
    } finally {
      release();
      await blocker;
      await admission;
    }
    await expect(admission).resolves.toEqual([{ id: repository.row.id, cwd: repository.checkout,
      repoUrl: repository.row.repoUrl, relativePath: repository.row.relativePath, pinnedCommit: fixture.pin, branchName: "main" }]);
    expect(catalog.list).toHaveBeenCalledOnce();
    expect(await fs.readFile(dirtyFile, "utf8")).toBe("Synthetic task workspace\nUncommitted task work\n");
    expect((await commands()).some(args => args.includes("clone"))).toBe(false);
    const [saved] = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, repository.row.id));
    expect(saved).toMatchObject({ state: "ready", pinnedCommit: fixture.pin, branchName: "main", failureCode: null });

    const spans = exporter.getFinishedSpans();
    const attempt = only(spans, "task.execution_attempt");
    const phase = only(spans, "heartbeat.prepare.workspace_repository_admission", attempt);
    for (const span of spans.filter(span => span !== attempt)) {
      const parent = spans.find(candidate => candidate.spanContext().spanId === span.parentSpanContext?.spanId);
      expect(parent, `parent of ${span.name}`).toBeDefined();
      expectChild(span, parent!);
      if (span.name.startsWith("authorization.")) {
        expect(["workspace.access.task_authorization", "workspace.access.authorization"]).toContain(parent!.name);
      }
    }
    const bindings = spans.filter(span => span.name === "workspace.repository.binding");
    expect(bindings).toHaveLength(3);
    for (const binding of bindings) {
      const execution = only(spans, "workspace.access.execution", binding);
      for (const name of ["task_read", "agent_read", "run_read", "workspace_read", "source_read", "projects_read", "trust"]) {
        expectChild(only(spans, `workspace.access.${name}`, execution), execution);
      }
      const taskAuthorization = only(spans, "workspace.access.task_authorization", execution);
      for (const name of ["base", "responsible_user", "authorizing_user", "task_privacy"]) {
        expectChild(only(spans, `authorization.${name}`, taskAuthorization), taskAuthorization);
      }
      for (const name of ["issue", "workspace", "run"]) expectChild(only(spans, `workspace.repository.db.${name}`, binding), binding);
      expectChild(only(spans, "workspace.repository.current_policy", binding), binding);
    }
    const publication = only(spans, "workspace.repository.publication", phase);
    const wait = only(spans, "workspace.repository.lock_wait", publication);
    const critical = only(spans, "workspace.repository.critical_section", publication);
    const releaseSpan = only(spans, "workspace.repository.lock_release", publication);
    expect(endsAt(wait)).toBeLessThanOrEqual(startsAt(critical));
    expect(endsAt(critical)).toBeLessThanOrEqual(startsAt(releaseSpan));
    expectChild(releaseSpan, publication);
    for (const name of ["checkout_identity", "ownership_verify", "materialize", "git_origin", "git_branch"]) {
      expectChild(only(spans, `workspace.repository.${name}`, critical), critical);
    }
    expectChild(only(spans, "workspace.checkout.lookup"), only(spans, "workspace.repository.materialize", critical));
    expect(spans.filter(span => span.name === "workspace.repository.state_write")).toHaveLength(2);
    expect(spans.filter(span => span.name === "workspace.repository.acquisition")).toHaveLength(2);
    expect(spans.some(span => span.name === "workspace.checkout.git_clone")).toBe(false);
    expect(spans.every(span => span.status.code !== 2)).toBe(true);
    expectPrivateFieldsAbsent(spans);
  });

  it("keeps ready admission and its checkout unchanged when the endpoint is disabled", async () => {
    const repository = await addReadyWorkspaceHistoryRepository(db, fixture);
    const commands = await recordGitCommands();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const tracer = vi.spyOn(trace, "getTracer");
    await expect(admit()).resolves.toMatchObject([{ id: repository.row.id, pinnedCommit: fixture.pin, cwd: repository.checkout }]);
    expect(tracer).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(catalog.list).toHaveBeenCalledOnce();
    expect((await commands()).some(args => args.includes("clone"))).toBe(false);
    expect(await fs.readFile(path.join(repository.checkout, "result.txt"), "utf8")).toBe("Synthetic task workspace\n");
  });

  it("preserves receipt repair and releases the publication lock after a real integrity failure", async () => {
    const repository = await addReadyWorkspaceHistoryRepository(db, fixture);
    const markerPath = path.join(repository.checkout, ".git", "paperclip-workspace-owner.json");
    const invalidMarker = JSON.stringify({ version: 1, repositoryId: repository.row.id, pinnedCommit: "1".repeat(40) });
    await fs.writeFile(markerPath, invalidMarker);
    await expect(admit()).rejects.toMatchObject({ status: 409,
      message: "Shared repository publication receipts disagree; repair is required before reuse" });
    expect(catalog.list).toHaveBeenCalledOnce();
    expect(await fs.readFile(markerPath, "utf8")).toBe(invalidMarker);
    const [saved] = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, repository.row.id));
    expect(saved).toMatchObject({ state: "needs_repair", failureCode: "repository_preparation_failed", pinnedCommit: fixture.pin });
    const afterRelease = vi.fn(async () => undefined);
    await withDirectoryPublicationLock(repository.checkout, afterRelease);
    expect(afterRelease).toHaveBeenCalledOnce();
    const spans = exporter.getFinishedSpans();
    const publication = only(spans, "workspace.repository.publication");
    const critical = only(spans, "workspace.repository.critical_section", publication);
    const release = only(spans, "workspace.repository.lock_release", publication);
    expect(critical.status.code).toBe(2);
    expect(publication.status.code).toBe(2);
    expect(only(spans, "workspace.repository.ownership_verify", critical).status.code).toBe(2);
    expect(release.status.code).not.toBe(2);
    expectChild(release, publication);
    expect(endsAt(critical)).toBeLessThanOrEqual(startsAt(release));
    expect(spans.filter(span => span.name === "workspace.repository.state_write")).toHaveLength(2);
    expect(spans.some(span => span.name === "workspace.repository.materialize")).toBe(false);
    expectPrivateFieldsAbsent(spans);
  });

  it("exports the current task authorization denial before any repository or filesystem work", async () => {
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: fixture.issueId,
      responsibleUserId: fixture.principals[1].userId }).where(eq(issues.id, fixture.issueId));
    await expect(admit()).rejects.toMatchObject({ status: 403 });
    expect(catalog.list).not.toHaveBeenCalled();
    const spans = exporter.getFinishedSpans();
    const execution = only(spans, "workspace.access.execution");
    const authorization = only(spans, "workspace.access.task_authorization", execution);
    expectChild(only(spans, "authorization.task_privacy", authorization), authorization);
    expect(execution.status.code).toBe(2);
    expect(only(spans, "workspace.repository.binding").status.code).toBe(2);
    expect(spans.some(span => ["workspace.repository.receipts", "workspace.repository.paths", "workspace.repository.publication"].includes(span.name))).toBe(false);
    expectPrivateFieldsAbsent(spans);
  });

  it("returns empty receipts after current checks without catalog, path checks or publication", async () => {
    await expect(admit()).resolves.toEqual([]);
    expect(catalog.list).not.toHaveBeenCalled();
    const spans = exporter.getFinishedSpans();
    const phase = only(spans, "heartbeat.prepare.workspace_repository_admission");
    only(spans, "workspace.repository.binding", phase);
    only(spans, "workspace.repository.receipts", phase);
    expect(spans.some(span => ["workspace.repository.paths", "workspace.repository.fs_prepare", "workspace.repository.publication"].includes(span.name))).toBe(false);
    expectPrivateFieldsAbsent(spans);
  });
});
