import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentFileRoots, agentInstructionWorkingCopies, agents, companies, companySkills, companySkillVersions, environments, executionWorkspaces, heartbeatRuns, providerTraceRecords, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertEphemeralServerData, readEphemeralServerDataEligibility } from "../services/ephemeral-server-contract.js";
import { initializeDurableAgentFiles } from "../services/agent-file-durability.js";
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({ provider: "s3" }) }));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("ephemeral-data-"); db = createDb(database.connectionString); }, 90_000);
afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
afterEach(() => vi.unstubAllEnvs());
it("refuses volume-dependent rows before readiness and accepts their durable replacement", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Deployment gate", issuePrefix: "GATE" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Legacy files" });
  await expect(assertEphemeralServerData(db)).rejects.toThrow("agent_files_require_migration");
  await db.transaction(tx => initializeDurableAgentFiles(tx as unknown as Db, { id: agentId, companyId }));
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "external", instructionsRootPath: "/lost-disk" } }).where(eq(agents.id, agentId));
  await expect(assertEphemeralServerData(db)).rejects.toThrow("external_agent_instructions");
  await db.update(agents).set({ adapterConfig: {} }).where(eq(agents.id, agentId));
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId, mode: "isolated", strategyType: "directory", name: "Legacy workspace", cwd: "/lost-disk/work" }).returning();
  await expect(assertEphemeralServerData(db)).rejects.toThrow("workspaces_require_migration");
  await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id));
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "succeeded", logStore: "local_file", logRef: "old-log" }).returning();
  await expect(assertEphemeralServerData(db)).rejects.toThrow("run_logs_require_migration");
  await db.update(heartbeatRuns).set({ logStore: "s3_segments", logRef: "committed-object-ref" }).where(eq(heartbeatRuns.id, run!.id));
  const [trace] = await db.insert(providerTraceRecords).values({ companyId, runId: run!.id, provider: "fixture", requestedBy: "fixture", traceRef: "old-trace", expiresAt: new Date(Date.now() + 60_000) }).returning();
  await expect(assertEphemeralServerData(db)).rejects.toThrow("provider_traces_require_migration");
  await db.update(providerTraceRecords).set({ deletedAt: new Date(), status: "deleted" }).where(eq(providerTraceRecords.id, trace!.id));
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  await expect(db.transaction(async tx => {
    const [created] = await tx.insert(agents).values({ companyId, name: "Rolled back hire" }).returning();
    await initializeDurableAgentFiles(tx as unknown as Db, created!);
    throw new Error("abort hire");
  })).rejects.toThrow("abort hire");
  expect(await db.select().from(agentFileRoots)).toHaveLength(1);
});

it("keeps replacement readiness independent of a serving controller's unfinished skill selection", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  const companyId = randomUUID(), agentId = randomUUID(), skillId = randomUUID(), versionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Overlapping skill preparation", issuePrefix: "PINS" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Preparing agent" });
  await db.transaction(tx => initializeDurableAgentFiles(tx as unknown as Db, { id: agentId, companyId }));
  await db.insert(companySkills).values({ id: skillId, companyId, key: "overlap", slug: "overlap", name: "Overlap",
    sourceType: "managed", markdown: "# Overlap", fileInventory: [{ path: "SKILL.md", kind: "entrypoint" }] });
  await db.insert(companySkillVersions).values({ id: versionId, companyId, companySkillId: skillId, revisionNumber: 1,
    fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# Overlap" }] });
  await db.update(companySkills).set({ currentVersionId: versionId }).where(eq(companySkills.id, skillId));
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  // Admission marks the run running before preparation publishes its skill pins.
  // That prevents cache eviction/migration, but does not make durable bytes local.
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand",
    status: "running", contextSnapshot: {} }).returning();
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  expect((await readEphemeralServerDataEligibility(db)).blockers).toContain("skills_require_migration");
  await db.update(heartbeatRuns).set({ contextSnapshot: { skillVersions: { overlap: versionId } } }).where(eq(heartbeatRuns.id, run.id));
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  expect((await readEphemeralServerDataEligibility(db)).eligible).toBe(true);
  await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, skillId));
  await expect(assertEphemeralServerData(db)).rejects.toThrow("skills_require_migration");
});

it("keeps an unsettled local instruction copy visible after its canonical files become durable", async () => {
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Private copy preservation", issuePrefix: "COPY" });
  await db.insert(agents).values({ id: agentId, companyId, name: "File owner" });
  await db.transaction(tx => initializeDurableAgentFiles(tx as unknown as Db, { id: agentId, companyId }));
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", finishedAt: new Date() }).returning();
  const [copy] = await db.insert(agentInstructionWorkingCopies).values({ runId: run.id, companyId, agentId,
    responsibleUserId: "preservation-fixture", entryFile: "AGENTS.md", baseHash: "a".repeat(64),
    localRoot: "/private/unsaved-copy", executionRoot: "/private/unsaved-copy", location: "local", state: "pending_collection" }).returning();
  expect((await readEphemeralServerDataEligibility(db, { purpose: "startup" })).blockers)
    .toContain("local_instruction_copies_require_settlement");
  expect((await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, run.id)))[0]).toEqual(copy);
  await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date(),
    receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } }).where(eq(agentInstructionWorkingCopies.runId, run.id));
  expect((await readEphemeralServerDataEligibility(db, { purpose: "startup" })).blockers)
    .not.toContain("local_instruction_copies_require_settlement");
});

it("recognizes a Runner workspace owned by its selected plugin environment", async () => {
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
  const owner = { agentId, environmentId, pluginKey: "fixture.task-storage", driverKey: "tasks" };
  await db.insert(companies).values({ id: companyId, name: "Provider-owned workspace", issuePrefix: "PROV" });
  await db.insert(environments).values({ id: environmentId, name: `Task provider ${environmentId}`,
    driver: "plugin", config: { pluginKey: owner.pluginKey, driverKey: owner.driverKey } });
  await db.insert(agents).values({ id: agentId, companyId, name: "Provider Runner", adapterType: "paperclip_runner" });
  await db.transaction(tx => initializeDurableAgentFiles(tx as unknown as Db, { id: agentId, companyId }));
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Provider task",
    mode: "shared_workspace", strategyType: "project_primary", providerType: "adapter_managed",
    cwd: `/workspaces/provider-only-${randomUUID()}`, metadata: { runnerTaskWorkspaceOwner: owner } }).returning();
  try {
    expect((await readEphemeralServerDataEligibility(db, { purpose: "startup" })).blockers)
      .not.toContain("workspaces_require_migration");
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id)))[0]).toEqual(workspace);
  } finally {
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
  }
});

it("keeps local workspaces and invalid provider ownership as migration blockers", async () => {
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  const companyId = randomUUID(), foreignCompanyId = randomUUID(), agentId = randomUUID(), foreignAgentId = randomUUID();
  const localAgentId = randomUUID(), environmentId = randomUUID(), localEnvironmentId = randomUUID(), emptyEnvironmentId = randomUUID();
  const owner = { agentId, environmentId, pluginKey: "fixture.task-storage", driverKey: "tasks" };
  await db.insert(companies).values([{ id: companyId, name: "Workspace guards", issuePrefix: "OWNR" },
    { id: foreignCompanyId, name: "Foreign owner", issuePrefix: "OTHR" }]);
  await db.insert(environments).values([
    { id: environmentId, name: `Provider ${environmentId}`, driver: "plugin", config: { pluginKey: owner.pluginKey, driverKey: owner.driverKey } },
    { id: localEnvironmentId, name: `Sandbox ${localEnvironmentId}`, driver: "sandbox", config: { pluginKey: owner.pluginKey, driverKey: owner.driverKey } },
    { id: emptyEnvironmentId, name: `Empty ${emptyEnvironmentId}`, driver: "plugin", config: { pluginKey: "", driverKey: "" } },
  ]);
  await db.insert(agents).values([
    { id: agentId, companyId, name: "Runner owner", adapterType: "paperclip_runner" },
    { id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign Runner", adapterType: "paperclip_runner" },
    { id: localAgentId, companyId, name: "Local process", adapterType: "process" },
  ]);
  for (const agent of [{ id: agentId, companyId }, { id: foreignAgentId, companyId: foreignCompanyId }, { id: localAgentId, companyId }]) {
    await db.transaction(tx => initializeDurableAgentFiles(tx as unknown as Db, agent));
  }
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Retained local dependency",
    mode: "shared_workspace", strategyType: "project_primary", providerType: "adapter_managed",
    cwd: `/workspaces/provider-only-${randomUUID()}` }).returning();
  const invalidOwners: { name: string; providerType?: string; owner: unknown }[] = [
    { name: "ordinary local storage", providerType: "local_fs", owner },
    { name: "unmarked adapter storage", owner: undefined },
    { name: "empty marker", owner: {} },
    { name: "array marker", owner: [owner] },
    { name: "foreign company", owner: { ...owner, agentId: foreignAgentId } },
    { name: "local adapter", owner: { ...owner, agentId: localAgentId } },
    { name: "non-plugin environment", owner: { ...owner, environmentId: localEnvironmentId } },
    { name: "missing environment", owner: { ...owner, environmentId: "not-a-uuid" } },
    { name: "different plugin", owner: { ...owner, pluginKey: "fixture.other-storage" } },
    { name: "different driver", owner: { ...owner, driverKey: "other" } },
    { name: "empty provider binding", owner: { ...owner, environmentId: emptyEnvironmentId, pluginKey: "", driverKey: "" } },
  ];
  try {
    for (const invalid of invalidOwners) {
      await db.update(executionWorkspaces).set({ providerType: invalid.providerType ?? "adapter_managed",
        metadata: invalid.owner === undefined ? {} : { runnerTaskWorkspaceOwner: invalid.owner } }).where(eq(executionWorkspaces.id, workspace.id));
      expect((await readEphemeralServerDataEligibility(db, { purpose: "startup" })).blockers, invalid.name)
        .toContain("workspaces_require_migration");
    }
  } finally {
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
  }
});
