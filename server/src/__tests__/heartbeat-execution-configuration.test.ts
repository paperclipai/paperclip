import { enableRunFailureReporting } from "./helpers/run-failure-reporting.js";
import { createHash, randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { access, chmod, mkdir, readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySkills, createDb, heartbeatRunEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";
import { withSkillVersionCacheLock } from "../services/skill-version-cache.js";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { HttpError } from "../errors.js";
import { heartbeatService } from "../services/heartbeat.js";
import { bindHeartbeatRunnerHomeMode, prepareHeartbeatExecutionConfiguration, type HeartbeatExecutionConfigurationInput } from "../services/heartbeat/execution-configuration.js";
import { aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";
import { secretService } from "../services/secrets.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { aiConnectionService } from "../services/ai-connections.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import * as sentry from "../sentry.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const skillFailures = vi.hoisted(() => new Map<string, string>());

describe("Runner home mode during recovery preparation", () => {
  it.each([
    ["preconfigured", { schema: "paperclip.native-execution-input.v5" }, "isolated"],
    ["preconfigured", { schema: "paperclip.native-execution-input.v7", homeMode: "isolated" }, "isolated"],
    ["isolated", { schema: "paperclip.native-execution-input.v7", homeMode: "preconfigured" }, "preconfigured"],
  ])("prepares the saved mode after current configuration changes to %s", (current, saved, expected) => {
    const config = { homeMode: current, model: "current-model", env: { TASK_VALUE: "kept" } };
    // Called before router selection and again after mutable task overrides.
    const routed = bindHeartbeatRunnerHomeMode(config, saved);
    const prepared = bindHeartbeatRunnerHomeMode({ ...routed, homeMode: current }, saved);
    expect(prepared).toEqual({ ...config, homeMode: expected });
    expect(config.homeMode).toBe(current);
  });

  it.each(["isolated", "preconfigured", undefined])("uses current mode %s for a new run", homeMode => {
    const config = { homeMode };
    expect(bindHeartbeatRunnerHomeMode(config, null)).toBe(config);
    expect(bindHeartbeatRunnerHomeMode(config, {})).toBe(config);
  });
});
vi.mock("../services/company-skills.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/company-skills.js")>();
  return { ...actual, companySkillService: (...args: Parameters<typeof actual.companySkillService>) => {
    const service = actual.companySkillService(...args);
    return { ...service, withRuntimeSkillEntries: async <T>(companyId: string,
      options: Parameters<typeof service.withRuntimeSkillEntries>[1],
      consume: (entries: Awaited<ReturnType<typeof service.listRuntimeSkillEntries>>) => T | Promise<T>) => {
      const failure = skillFailures.get(companyId);
      if (failure) throw new Error(failure);
      return service.withRuntimeSkillEntries(companyId, options, consume);
    } };
  } };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping execution configuration tests: ${support.reason}`);

describePostgres("heartbeat execution configuration through adapter dispatch", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const captured = new Map<string, AdapterExecutionContext>();
  const inspect = new Map<string, (input: AdapterExecutionContext) => Promise<void>>();
  const adapterType = "codex_local";
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-execution-config-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-execution-skills-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    // Exercise real preparation for a managed-capable adapter without calling a provider.
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        captured.set(input.runId, input);
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        await inspect.get(input.agent.id)?.(input);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); skillFailures.clear(); });
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seed(managed = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), projectId = randomUUID();
    const userId = `configuration-user-${companyId}`;
    const credential = `fixture-api-key-${companyId}`;
    await db.insert(companies).values({ id: companyId, name: "Execution configuration fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const account = managed ? await aiConnectionService(db).save(companyId, userId, {
      provider: "openai", method: "api_key", ownership: "personal", name: "Fixture account", apiKey: credential, agentIds: [], allAgents: true,
    }, credential) : null;
    await db.insert(projects).values({ id: projectId, companyId, name: "Config project", env: { SHARED_VALUE: "project", PROJECT_ONLY: "project-only" } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Configuration reader", adapterType, status: "idle",
      adapterConfig: { model: "agent-model", env: { SHARED_VALUE: "agent", AGENT_ONLY: "agent-only", ...(managed ? { OPENAI_API_KEY: "stale-agent-key" } : {}) } },
      runtimeConfig: account ? { aiConnection: { provider: "openai", method: "api_key", mode: "delegated", connectionId: account.connectionId, grantId: account.grantId } } : {},
    });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Configuration fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1, assigneeAdapterOverrides: { adapterConfig: { model: "issue-model" } } });
    return { companyId, agentId, issueId, userId, credential };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>) {
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: f.issueId }, contextSnapshot: {
      issueId: f.issueId, paperclipSecrets: { manifest: [{ secretKey: "untrusted-wake-value" }] },
      paperclipWake: { connectorSkillInstructions: "untrusted wake instructions" },
    } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(finished).toBeDefined();
    return { finished, input: captured.get(run!.id) };
  }

  it.each([
    { saved: "isolated", managed: true, failure: "saved managed login required" },
    { saved: "isolated", managed: false, failure: "saved isolated skills required" },
    { saved: "preconfigured", managed: true, failure: null },
    { saved: null, managed: true, failure: "saved managed login required" },
  ] as const)("retains $saved preparation after configuration changes (managed: $managed)", async ({ saved, managed, failure }) => {
    const f = await seed(managed);
    const [agent] = await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {
      provider: "codex", model: "gpt-6.1-sol", homeMode: saved === "isolated" ? "preconfigured" : "isolated",
    } }).where(eq(agents.id, f.agentId)).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId },
    }).returning();
    const prepare = vi.spyOn(aiRuntime, "prepareManagedAiRuntime").mockRejectedValue(new Error("saved managed login required"));
    skillFailures.set(f.companyId, "saved isolated skills required");
    // Preparation only reads the persisted mode and whether recovery is active.
    const persisted = saved === null ? null : { schema: saved === "isolated" ? "paperclip.native-execution-input.v5" : "paperclip.native-execution-input.v7",
      ...(saved === "preconfigured" ? { homeMode: saved } : {}),
    } as unknown as HeartbeatExecutionConfigurationInput["environment"]["persistedNativeExecutionInput"];
    const opening = prepareHeartbeatExecutionConfiguration(db, {
      run, agent, task: { issueId: f.issueId, context: {}, responsibleUserId: f.userId,
        acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null, taskProjectContext: null,
        routineEnvContext: { routineId: null, env: null, responsibleUserId: null } },
      config: { sourceWorkspaceConfig: { ...agent.adapterConfig, homeMode: "preconfigured" }, aiBinding: managed
        ? aiRuntimeConnectionBindingSchema.parse(agent.runtimeConfig!.aiConnection) : undefined },
      policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        useIsolatedTaskDirectory: false, explicitTaskDirectory: false },
      environment: { selectedEnvironmentId: null, selectedEnvironmentForConfig: null,
        resolvedInstanceSettings: await instanceSettingsService(db).get(), persistedNativeExecutionInput: persisted },
      services: { secretsSvc: secretService(db), companySkills: companySkillService(db), appendRunEvent: vi.fn(), finalizeAiConnectionBusyDeferral: vi.fn() },
      onFailureSecretsResolved: vi.fn(), onManagedAiRuntimeAcquired: vi.fn(), onIdentityRedactorPrepared: vi.fn(),
    });
    if (failure) await expect(opening).rejects.toThrow(failure);
    else {
      expect(await opening).toMatchObject({ prepared: true, runtimeConfig: { homeMode: "preconfigured" }, runtimeSkillEntries: [] });
      expect(prepare).not.toHaveBeenCalled();
    }
    if (managed && saved === "isolated") expect(prepare).toHaveBeenCalledOnce();
  });

  it.each(["agent", "stored task override"] as const)("uses operator preconfigured mode despite %s configuration", async source => {
    const f = await seed(true);
    const nativeHome = await mkdtemp(path.join(tmpdir(), "paperclip-preconfigured-preparation-"));
    const workspace = path.join(nativeHome, "workspace");
    await mkdir(workspace);
    process.env.PAPERCLIP_HOME = nativeHome;
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {
      provider: "codex", model: "gpt-6.1-sol", homeMode: "preconfigured", cwd: workspace,
    } }).where(eq(agents.id, f.agentId));
    if (source === "stored task override") {
      await db.update(issues).set({ assigneeAdapterOverrides: { adapterConfig: { homeMode: "isolated" } } }).where(eq(issues.id, f.issueId));
      // Old task data cannot change the operator's mode before AI routing.
      await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: "unconfigured-pool" } } }).where(eq(agents.id, f.agentId));
    }
    skillFailures.set(f.companyId, "Preconfigured mode must not resolve assigned skills");
    const prepare = vi.spyOn(aiRuntime, "prepareManagedAiRuntime");
    const beforeNative = vi.fn(async () => { throw new Error("fixture stopped before provider start"); });
    const nativeHeartbeat = heartbeatService(db, { beforeNativeRuntimeSelection: beforeNative });
    try {
      const run = await nativeHeartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      expect(run).not.toBeNull();
      await nativeHeartbeat.drainActiveRunExecutions();
      const saved = await nativeHeartbeat.getRun(run!.id);
      expect(saved?.error).toContain("fixture stopped before provider start");
      expect(beforeNative).toHaveBeenCalledOnce();
      expect(prepare).not.toHaveBeenCalled();
      expect(saved?.contextSnapshot?.aiConnection).toBeUndefined();
    } finally {
      await nativeHeartbeat.drainActiveRunExecutions();
      process.env.PAPERCLIP_HOME = home;
      // Native preparation seals context bundles; release only this test's tree.
      const release = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) await release(path.join(directory, entry.name));
        }
      };
      await release(nativeHome);
      await rm(nativeHome, { recursive: true, force: true });
    }
  });

  async function configuration(f: Awaited<ReturnType<typeof seed>>, config: Record<string, unknown>, snapshot: Record<string, unknown> = {}, type = "paperclip_runner") {
    const [agent] = await db.update(agents).set({ adapterType: type, adapterConfig: config }).where(eq(agents.id, f.agentId)).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, scopeKind: "issue", status: "running", contextSnapshot: snapshot }).returning();
    const resolvedInstanceSettings = await instanceSettingsService(db).get();
    return { run, prepare: () => prepareHeartbeatExecutionConfiguration(db, {
      run, agent,
      task: { issueId: f.issueId, context: { ...snapshot, issueId: f.issueId }, responsibleUserId: null,
        acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null,
        taskProjectContext: null, routineEnvContext: { routineId: null, env: null, responsibleUserId: null } },
      config: { sourceWorkspaceConfig: config, aiBinding: undefined },
      policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} }, useIsolatedTaskDirectory: false, explicitTaskDirectory: false },
      environment: { selectedEnvironmentId: null, selectedEnvironmentForConfig: null,
        resolvedInstanceSettings, persistedNativeExecutionInput: null },
      services: { secretsSvc: secretService(db), companySkills: companySkillService(db), appendRunEvent: vi.fn(), finalizeAiConnectionBusyDeferral: vi.fn() },
      onFailureSecretsResolved: () => {}, onManagedAiRuntimeAcquired: () => {}, onIdentityRedactorPrepared: () => {},
    }) };
  }

  it.each(["fresh", "saved empty"])("prepares a %s native skill selection while another run holds the company cache lock", async kind => {
    const f = await seed();
    const selected = kind === "saved empty" ? await companySkillService(db).createLocalSkill(f.companyId, { name: "Later assignment" }) : null;
    const input = await configuration(f, selected ? { paperclipSkillSync: { desiredSkills: [selected.key] } } : {},
      kind === "saved empty" ? { skillVersions: {}, skillSelectionSnapshot: true } : {});
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const holder = withSkillVersionCacheLock(db, f.companyId, async () => { acquired(); await barrier; });
    await ready;
    const started = performance.now();
    const pending = input.prepare();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
      expect(result, "An empty native selection must not queue behind skill hydration").not.toBeNull();
      console.info("Empty-skill preparation under a held cache lock", { kind, elapsedMs: performance.now() - started });
      expect(result?.prepared).toBe(true);
      if (result?.prepared) expect(result.runtimeSkillEntries).toEqual([]);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.run.id));
      expect(saved.contextSnapshot).toMatchObject({ skillVersions: {}, skillSelectionSnapshot: true });
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await holder;
      await pending;
    }
  });

  it.each(["selected native", "legacy operational"])("retains the cache exclusion for %s skills", async kind => {
    const f = await seed();
    const selected = await companySkillService(db).createLocalSkill(f.companyId, { name: "Selected lock control" });
    const input = await configuration(f, { paperclipSkillSync: { desiredSkills: kind === "selected native" ? [selected.key] : [] } }, {}, kind === "selected native" ? "paperclip_runner" : "codex_local");
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const holder = withSkillVersionCacheLock(db, f.companyId, async () => { acquired(); await barrier; });
    await ready;
    let settled = false;
    const pending = input.prepare().finally(() => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(settled).toBe(false);
    } finally { release(); await holder; }
    const result = await pending;
    expect(result.prepared).toBe(true);
    if (result.prepared) expect(result.runtimeSkillEntries.some(entry => entry.key === (kind === "selected native" ? selected.key : "paperclipai/paperclip/paperclip"))).toBe(true);
  });

  it("applies project environment and issue overrides and replaces caller-supplied runtime fields", async () => {
    const f = await seed();
    const { finished, input } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(input?.config).toMatchObject({ model: "issue-model", env: { SHARED_VALUE: "project", AGENT_ONLY: "agent-only", PROJECT_ONLY: "project-only" } });
    expect(input?.context.paperclipSecrets).toBeUndefined();
    expect(JSON.stringify(input?.context.paperclipWake)).not.toContain("untrusted wake instructions");
  });

  it("delivers the selected credential in an isolated home and removes it after completion", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const f = await seed(true);
    let providerHome: string | undefined;
    inspect.set(f.agentId, async input => {
      const env = input.config.env as Record<string, string>;
      providerHome = env.CODEX_HOME;
      expect(env.OPENAI_API_KEY).toBe(f.credential);
      expect(env.CODEX_API_KEY).toBe(f.credential);
      expect(JSON.parse(await readFile(path.join(providerHome, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: f.credential });
      await input.onMeta?.({ adapterType, command: "fixture", env, prompt: "fixture" });
    });
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    try {
      const { finished, input } = await execute(f);
      expect(finished.status, finished.error ?? undefined).toBe("succeeded");
      expect(input?.context.aiConnection).toMatchObject({ accountName: "Fixture account", provider: "openai" });
      expect(providerHome).toEqual(expect.any(String));
      await expect(access(providerHome!)).rejects.toMatchObject({ code: "ENOENT" });
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, finished.id));
      expect(events.some(event => event.eventType === "adapter.invoke")).toBe(true);
      expect(JSON.stringify(events)).not.toContain(f.credential);
      await provider.forceFlush();
      const runIdHash = createHash("sha256").update(finished.id).digest("hex").slice(0, 12);
      const steps = exporter.getFinishedSpans().filter(span => span.name.startsWith("heartbeat.prepare.configuration_")
        && span.attributes["paperclip.task.run.run_id"] === runIdHash);
      expect(steps.map(span => span.name)).toEqual([
        "configuration_mentions", "configuration_github_identity", "configuration_secrets", "configuration_ai_runtime",
        "configuration_skills", "configuration_connector_assignments", "configuration_connector_skills",
        "configuration_connector_delivery", "configuration_connection_instructions", "configuration_agent_identity",
      ].map(step => `heartbeat.prepare.${step}`));
      for (const span of steps) {
        expect(span.status).toEqual({ code: 0 });
        expect(span.attributes).toEqual({ "paperclip.task.run.run_id": runIdHash });
        expect(span.events).toEqual([]);
      }
    } finally {
      trace.disable();
      await provider.shutdown();
    }
  });

  it("cleans acquired credentials and redacts diagnostics when later skill preparation fails", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const f = await seed(true);
    skillFailures.set(f.companyId, `Invalid fixture skill configuration: ${f.credential}`);
    const capturedFailure = vi.spyOn(sentry, "captureRunFailure").mockImplementation(() => undefined);
    const prepare = aiRuntime.prepareManagedAiRuntime;
    let acquiredHome: string | undefined;
    vi.spyOn(aiRuntime, "prepareManagedAiRuntime").mockImplementation(async (...args) => {
      const runtime = await prepare(...args);
      acquiredHome = runtime.home;
      await access(acquiredHome!);
      return runtime;
    });
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    try {
      const { finished, input } = await execute(f);
      expect(finished.status).toBe("failed");
      expect(input).toBeUndefined();
      expect(acquiredHome).toEqual(expect.any(String));
      await expect(access(acquiredHome!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(finished.error).toContain("Invalid fixture skill configuration");
      await waitForPendingRunFailureReports();
      expect(capturedFailure).toHaveBeenCalled();
      expect(JSON.stringify(capturedFailure.mock.calls)).toContain("Invalid fixture skill configuration");
      expect(JSON.stringify(capturedFailure.mock.calls)).not.toContain(f.credential);
      await provider.forceFlush();
      const runIdHash = createHash("sha256").update(finished.id).digest("hex").slice(0, 12);
      const steps = exporter.getFinishedSpans().filter(span => span.name.startsWith("heartbeat.prepare.configuration_")
        && span.attributes["paperclip.task.run.run_id"] === runIdHash);
      expect(steps.find(span => span.name === "heartbeat.prepare.configuration_ai_runtime")?.status.code).toBe(0);
      expect(steps.find(span => span.name === "heartbeat.prepare.configuration_skills")?.status).toEqual({ code: 2 });
      expect(steps.some(span => span.name === "heartbeat.prepare.configuration_connector_assignments")).toBe(false);
      for (const span of steps) {
        expect(span.attributes).toEqual({ "paperclip.task.run.run_id": runIdHash });
        expect(span.events).toEqual([]);
      }
      expect(JSON.stringify(steps.map(span => ({ name: span.name, status: span.status, attributes: span.attributes, events: span.events })))).not.toContain(f.credential);
    } finally {
      trace.disable();
      await provider.shutdown();
    }
  });

  it("defers a busy account without dispatch and preserves its scheduled retry", async () => {
    const f = await seed(true);
    vi.spyOn(aiRuntime, "prepareManagedAiRuntime").mockRejectedValueOnce(new HttpError(422, "AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" }));
    const { finished, input } = await execute(f);
    expect(input).toBeUndefined();
    expect(finished).toMatchObject({ status: "cancelled", errorCode: "ai_connection_busy", resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } }, contextSnapshot: { aiConnectionBusyDeferredWhileAssignee: true } });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    expect(runs.filter(run => run.id !== finished.id)).toEqual([expect.objectContaining({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_busy" })]);
  });

  it("snapshots only selected immutable skills and omits inaccessible optional assignments", async () => {
    const f = await seed();
    const skills = companySkillService(db);
    const selected = await skills.createLocalSkill(f.companyId, { name: "Selected workflow", markdown: "# Selected\nUse the original workflow.\n" });
    const unused = await skills.createLocalSkill(f.companyId, { name: "Unused workflow" });
    const restricted = await skills.createLocalSkill(f.companyId, { name: "Restricted workflow" });
    await db.update(companySkills).set({ accessSourceId: randomUUID() }).where(eq(companySkills.id, restricted.id));
    await db.update(agents).set({ adapterConfig: { paperclipSkillSync: { desiredSkills: [restricted.key] } } }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ description: "Use [/selected](skill://" + selected.id + "?s=selected-workflow)." }).where(eq(issues.id, f.issueId));
    const { finished, input } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    const inventory = input?.config.paperclipRuntimeSkills as Array<{ key: string; source: string; versionId: string }>;
    expect(inventory.some(entry => entry.key === unused.key || entry.key === restricted.key)).toBe(false);
    const delivered = inventory.find(entry => entry.key === selected.key)!;
    expect(delivered.versionId).toBe(selected.currentVersionId);
    expect(delivered.source).toContain(selected.currentVersionId!);
    expect(await readFile(path.join(delivered.source, "SKILL.md"), "utf8")).toContain("Use the original workflow.");
    expect(finished.contextSnapshot).toMatchObject({ skillSelectionSnapshot: true, skillVersions: { [selected.key]: selected.currentVersionId } });
    expect(Object.keys(finished.contextSnapshot!.skillVersions as object)).not.toContain(unused.key);
    expect(Object.keys(finished.contextSnapshot!.skillVersions as object)).not.toContain(restricted.key);
  });

  it("rejects an inaccessible explicit skill reference before adapter dispatch", async () => {
    const f = await seed();
    const skill = await companySkillService(db).createLocalSkill(f.companyId, { name: "Private reference" });
    await db.update(companySkills).set({ accessSourceId: randomUUID() }).where(eq(companySkills.id, skill.id));
    await db.update(issues).set({ description: "Use [/private](skill://" + skill.id + "?s=private-reference)." }).where(eq(issues.id, f.issueId));
    const { finished, input } = await execute(f);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("referenced skill is unavailable");
    expect(input).toBeUndefined();
  });
});


enableRunFailureReporting();
