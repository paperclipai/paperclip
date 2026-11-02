import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentFileRoots, agents, companies, companySkills, companySkillVersions, executionWorkspaces, heartbeatRuns, providerTraceRecords, createDb } from "@paperclipai/db";
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
  await db.transaction(tx => initializeDurableAgentFiles(tx, { id: agentId, companyId }));
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
    await initializeDurableAgentFiles(tx, created!);
    throw new Error("abort hire");
  })).rejects.toThrow("abort hire");
  expect(await db.select().from(agentFileRoots)).toHaveLength(1);
});

it("keeps replacement readiness independent of a serving controller's unfinished skill selection", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  const companyId = randomUUID(), agentId = randomUUID(), skillId = randomUUID(), versionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Overlapping skill preparation", issuePrefix: "PINS" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Preparing agent" });
  await db.transaction(tx => initializeDurableAgentFiles(tx, { id: agentId, companyId }));
  await db.insert(companySkills).values({ id: skillId, companyId, key: "overlap", slug: "overlap", name: "Overlap",
    sourceType: "managed", markdown: "# Overlap", fileInventory: [{ path: "SKILL.md", kind: "entrypoint" }] });
  await db.insert(companySkillVersions).values({ id: versionId, companyId, companySkillId: skillId, revisionNumber: 1,
    fileInventory: [{ path: "SKILL.md", kind: "entrypoint", content: "# Overlap" }] });
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
