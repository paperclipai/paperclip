import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issues, pluginCompanySettings, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, PluginPrepareAgentRunRequest, PluginPrepareAgentRunResult } from "@paperclipai/shared";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping plugin run configuration tests: ${support.reason}`);

describePostgres("plugin run configuration through adapter dispatch", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let home: string;
  const oldHome = process.env.PAPERCLIP_HOME;
  const adapterType = "codex_local";
  const pluginId = randomUUID();
  const captured = new Map<string, AdapterExecutionContext>();
  const prepare = vi.fn<(request: PluginPrepareAgentRunRequest) => Promise<PluginPrepareAgentRunResult>>();
  const manifest: PaperclipPluginManifestV1 = { id: "fixture.run-configuration", apiVersion: 1, version: "0.1.0", displayName: "Run configuration",
    description: "Fixture", author: "Tests", categories: ["automation"], capabilities: ["agent.runs.configure", "issues.read"], entrypoints: { worker: "worker.js" } };
  const workerManager = {
    isRunning: (id: string) => id === pluginId,
    getWorker: (id: string) => (id === pluginId ? { supportedMethods: ["prepareAgentRun"] } : undefined),
    call: vi.fn(async (_id: string, _method: string, params: PluginPrepareAgentRunRequest) => prepare(params)),
  } as unknown as PluginWorkerManager;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-plugin-run-config-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-plugin-run-config-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: manifest.id, version: "0.1.0", manifestJson: manifest, status: "ready" });
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);
  afterEach(() => { prepare.mockReset(); });
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seed(issueOverrides: Record<string, unknown> | null = null) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `run-config-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Run config user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Run configuration fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Configured agent", adapterType, status: "idle",
      adapterConfig: { model: "agent-model", modelReasoningEffort: "high" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Fix a typo", description: "One word in the README.", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1, ...(issueOverrides ? { assigneeAdapterOverrides: { adapterConfig: issueOverrides } } : {}) });
    return { companyId, agentId, issueId };
  }

  async function run(f: Awaited<ReturnType<typeof seed>>) {
    const queued = await heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } });
    expect(queued).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    return { finished: finished!, input: captured.get(queued!.id) };
  }

  it("applies the plugin decision before the adapter starts and records it", async () => {
    const f = await seed();
    prepare.mockResolvedValue({ adapterConfig: { model: "plugin-model", modelReasoningEffort: "low" }, reason: "short task" });
    const { finished, input } = await run(f);
    expect(input?.config).toMatchObject({ model: "plugin-model", modelReasoningEffort: "low" });
    const request = prepare.mock.calls.map(([params]) => params).find((params) => params.runId === finished.id);
    expect(request).toMatchObject({ companyId: f.companyId, agentId: f.agentId, adapterType,
      issueId: f.issueId, issue: { id: f.issueId, title: "Fix a typo", description: "One word in the README." },
      adapterConfig: { model: "agent-model", modelReasoningEffort: "high" }, issueOverrides: {} });
    expect(finished.contextSnapshot?.pluginRunConfiguration).toMatchObject({ runId: finished.id,
      adapterConfig: { model: "plugin-model", modelReasoningEffort: "low" }, decisions: [{ pluginKey: manifest.id, reason: "short task" }] });
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, finished.id), eq(heartbeatRunEvents.eventType, "plugin_run_configuration")));
    expect(events).toHaveLength(1);
  });

  it("keeps per-issue operator overrides above the plugin decision", async () => {
    const f = await seed({ model: "operator-model" });
    prepare.mockResolvedValue({ adapterConfig: { model: "plugin-model", modelReasoningEffort: "low" } });
    const { input } = await run(f);
    expect(prepare).toHaveBeenCalled();
    expect(prepare.mock.calls.every(([params]) => params.issueOverrides.model === "operator-model")).toBe(true);
    expect(input?.config).toMatchObject({ model: "operator-model", modelReasoningEffort: "low" });
  });

  it("runs with the agent configuration when the plugin fails", async () => {
    const f = await seed();
    prepare.mockRejectedValue(new Error("classifier unavailable"));
    const { finished, input } = await run(f);
    expect(input?.config).toMatchObject({ model: "agent-model", modelReasoningEffort: "high" });
    expect(finished.contextSnapshot?.pluginRunConfiguration).toBeUndefined();
  });

  it("does not call a plugin that is disabled for the company", async () => {
    const f = await seed();
    await db.insert(pluginCompanySettings).values({ companyId: f.companyId, pluginId, enabled: false });
    prepare.mockResolvedValue({ adapterConfig: { model: "plugin-model" } });
    const { input } = await run(f);
    expect(prepare).not.toHaveBeenCalled();
    expect(input?.config).toMatchObject({ model: "agent-model" });
  });
});
