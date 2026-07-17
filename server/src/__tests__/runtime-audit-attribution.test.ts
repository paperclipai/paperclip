import { randomUUID } from "node:crypto";
import type { AdapterRuntimeServiceReport } from "@paperclipai/adapter-utils";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentService } from "../services/environments.ts";
import {
  persistAdapterManagedRuntimeServices,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { workspaceOperationService } from "../services/workspace-operations.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("runtime audit attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-audit-attribution-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(workspaceRuntimeServices);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(environments);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const responsibleUserId = `responsible-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Audit attribution",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: responsibleUserId,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CloudOps",
      role: "operations",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      responsibleUserId,
    });

    return { companyId, agentId, runId, responsibleUserId };
  }

  it("stores actor and responsible-user attribution on workspace operation rows", async () => {
    const { companyId, agentId, runId, responsibleUserId } = await seedRun();
    const recorder = workspaceOperationService(db).createRecorder({
      companyId,
      heartbeatRunId: runId,
      actorAgentId: agentId,
      actorRunId: runId,
      responsibleUserId,
    });

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      command: "git status --short",
      cwd: "/workspace/audit",
      run: async () => ({
        status: "succeeded",
        exitCode: 0,
        stdout: "clean",
      }),
    });

    expect(operation.heartbeatRunId).toBe(runId);
    expect(operation.actorAgentId).toBe(agentId);
    expect(operation.actorRunId).toBe(runId);
    expect(operation.responsibleUserId).toBe(responsibleUserId);

    const row = await db
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, operation.id))
      .then((rows) => rows[0] ?? null);
    expect(row?.actorAgentId).toBe(agentId);
    expect(row?.actorRunId).toBe(runId);
    expect(row?.responsibleUserId).toBe(responsibleUserId);
  });

  it("stores actor and responsible-user attribution on environment test leases", async () => {
    const { companyId, agentId, runId, responsibleUserId } = await seedRun();
    const environmentsSvc = environmentService(db);
    const environment = await environmentsSvc.ensureLocalEnvironment(companyId);

    const lease = await environmentsSvc.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      actorAgentId: agentId,
      actorRunId: runId,
      responsibleUserId,
      provider: "local",
    });

    expect(lease.heartbeatRunId).toBe(runId);
    expect(lease.actorAgentId).toBe(agentId);
    expect(lease.actorRunId).toBe(runId);
    expect(lease.responsibleUserId).toBe(responsibleUserId);

    const row = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.id))
      .then((rows) => rows[0] ?? null);
    expect(row?.actorAgentId).toBe(agentId);
    expect(row?.actorRunId).toBe(runId);
    expect(row?.responsibleUserId).toBe(responsibleUserId);
  });

  it("stores start and manual control attribution on workspace runtime service rows", async () => {
    const { companyId, agentId, runId, responsibleUserId } = await seedRun();
    const workspace: RealizedExecutionWorkspace = {
      baseCwd: "/workspace/audit",
      source: "task_session",
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      strategy: "git_worktree",
      cwd: "/workspace/audit",
      branchName: "audit-runtime-attribution",
      worktreePath: "/workspace/audit",
      warnings: [],
      created: false,
    };
    const runtimeServiceId = randomUUID();
    const reports: AdapterRuntimeServiceReport[] = [
      {
        id: runtimeServiceId,
        serviceName: "web",
        status: "running",
        lifecycle: "ephemeral",
        scopeType: "run",
        providerRef: "adapter-web-ref",
      },
    ];

    const refs = await persistAdapterManagedRuntimeServices({
      db,
      adapterType: "codex_local",
      runId,
      agent: { id: agentId, name: "CloudOps", companyId },
      issue: null,
      workspace,
      responsibleUserId,
      reports,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.startedByAgentId).toBe(agentId);
    expect(refs[0]!.startedByRunId).toBe(runId);
    expect(refs[0]!.responsibleUserId).toBe(responsibleUserId);
    expect(refs[0]!.lastControlledByAgentId).toBe(agentId);
    expect(refs[0]!.lastControlledByRunId).toBe(runId);

    const persisted = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, refs[0]!.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.startedByAgentId).toBe(agentId);
    expect(persisted?.startedByRunId).toBe(runId);
    expect(persisted?.responsibleUserId).toBe(responsibleUserId);
    expect(persisted?.lastControlledByAgentId).toBe(agentId);
    expect(persisted?.lastControlledByRunId).toBe(runId);

    const controllerRunId = randomUUID();
    const controllerResponsibleUserId = `controller-${randomUUID()}`;
    await db.insert(heartbeatRuns).values({
      id: controllerRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual-runtime-stop",
      status: "running",
      responsibleUserId: controllerResponsibleUserId,
    });

    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: randomUUID(),
      runtimeServiceId: refs[0]!.id,
      controlAttribution: {
        actorAgentId: agentId,
        actorRunId: controllerRunId,
        responsibleUserId: controllerResponsibleUserId,
      },
    });

    const stopped = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, refs[0]!.id))
      .then((rows) => rows[0] ?? null);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.startedByAgentId).toBe(agentId);
    expect(stopped?.startedByRunId).toBe(runId);
    expect(stopped?.lastControlledByAgentId).toBe(agentId);
    expect(stopped?.lastControlledByRunId).toBe(controllerRunId);
    expect(stopped?.responsibleUserId).toBe(controllerResponsibleUserId);
    expect(stopped?.lastControlledAt).toBeInstanceOf(Date);
  });
});
