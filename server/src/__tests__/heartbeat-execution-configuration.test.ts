import { enableRunFailureReporting } from "./helpers/run-failure-reporting.js";
import { createHash, randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { access, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySkills, createDb, heartbeatRunEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { HttpError } from "../errors.js";
import { heartbeatService } from "../services/heartbeat.js";
import { aiConnectionService } from "../services/ai-connections.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import * as sentry from "../sentry.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const skillFailures = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/company-skills.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/company-skills.js")>();
  return { ...actual, companySkillService: (...args: Parameters<typeof actual.companySkillService>) => {
    const service = actual.companySkillService(...args);
    return { ...service, listRuntimeSkillEntries: async (...input: Parameters<typeof service.listRuntimeSkillEntries>) => {
      const failure = skillFailures.get(input[0]);
      if (failure) throw new Error(failure);
      return service.listRuntimeSkillEntries(...input);
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
    return { companyId, agentId, issueId, credential };
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
