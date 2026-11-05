import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { getConversationOwnershipBlocker } from "../services/conversation-continuation.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { heartbeatService } from "../services/heartbeat.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

describePostgres("leases of cancelled runs with no executor", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-release-cancelled-run-leases-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seedRunWithLease() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Leases",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lease agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Leased work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const environment = await environmentService(db).ensureLocalEnvironment(companyId);
    const { lease } = await environmentRuntimeService(db).acquireRunLease({
      companyId,
      environment,
      issueId,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    return { companyId, agentId, issueId, runId, leaseId: lease.id };
  }

  async function readLease(leaseId: string) {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    return lease!;
  }

  it("releases the lease of a run cancelled by the control plane", async () => {
    const { companyId, issueId, runId, leaseId } = await seedRunWithLease();

    const cancelled = await heartbeatService(db).cancelRun(runId, "Cancelled by control plane");

    expect(cancelled?.status).toBe("cancelled");
    const lease = await readLease(leaseId);
    expect(lease.status).toBe("expired");
    expect(lease.releasedAt).toBeInstanceOf(Date);
    expect(await getConversationOwnershipBlocker(db, companyId, issueId)).toBeNull();
  });

  it("releases the lease of a run cancelled because its agent paused", async () => {
    const { companyId, agentId, issueId, runId, leaseId } = await seedRunWithLease();

    await heartbeatService(db).cancelActiveForAgent(agentId, "Cancelled due to agent pause");

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("cancelled");
    expect((await readLease(leaseId)).status).toBe("expired");
    expect(await getConversationOwnershipBlocker(db, companyId, issueId)).toBeNull();
  });
});
