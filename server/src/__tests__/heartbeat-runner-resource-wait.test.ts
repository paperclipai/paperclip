import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  NATIVE_WRITER_ROOT_BUSY_REASON_CODE,
  RUNNER_RESOURCE_WAIT_EXIT_CODE,
} from "../services/execution-resource-admission.ts";
import {
  WORKSPACE_BUSY_ERROR_CODE,
  WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
  WORKSPACE_BUSY_RETRY_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runner resource-wait tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const WRITER_ROOT_KEY = `writer-root-v1:${"b".repeat(64)}`;
const CONFIG_IDENTITY = `writer-config-v1:${"c".repeat(64)}`;

describeEmbeddedPostgres("runner resource waits on the legacy process adapter path", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtureDir!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runner-resource-wait-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runner-wait-"));
  }, 20_000);

  afterEach(async () => {
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
  });

  afterAll(async () => {
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function cleanupFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issueComments);
        await db.delete(issueRelations);
        await db.delete(issues);
        await db.delete(executionWorkspaces);
        await db.delete(projectWorkspaces);
        await db.delete(projects);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(budgetPolicies);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function writeScript(name: string, source: string) {
    const scriptPath = path.join(fixtureDir, name);
    await fs.writeFile(scriptPath, source, "utf8");
    return scriptPath;
  }

  async function seedFixture(input: {
    adapterConfig: Record<string, unknown>;
    issueOverrides?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runner wait project",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessWorker",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: input.adapterConfig,
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Runner wait issue",
      description: "Fixture issue for runner resource-wait admission.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "responsible-user",
      identifier: `T-${issueId.slice(0, 6)}`,
      ...(input.issueOverrides ?? {}),
    });
    return { companyId, projectId, agentId, issueId, now };
  }

  /**
   * A live holder admitted on one canonical writer root. The holder owns its
   * OWN issue: a synthetic running run for the same issue would suppress the
   * incoming wake before writer-root admission is ever consulted.
   */
  async function seedWriterRootHolder(input: {
    companyId: string;
    writerRootKey: string;
    activityAt?: Date;
  }) {
    const holderRunId = randomUUID();
    const holderAgentId = randomUUID();
    const holderIssueId = randomUUID();
    const at = input.activityAt ?? new Date();
    await db.insert(agents).values({
      id: holderAgentId,
      companyId: input.companyId,
      name: `WriterHolder ${holderAgentId.slice(0, 6)}`,
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: holderIssueId,
      companyId: input.companyId,
      title: "Holder issue",
      description: "Live holder issue for writer-root admission.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: holderAgentId,
      createdByUserId: "responsible-user",
      identifier: `T-${holderIssueId.slice(0, 6)}`,
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId: input.companyId,
      agentId: holderAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: at,
      lastOutputAt: at,
      contextSnapshot: {
        issueId: holderIssueId,
        executionWriterResource: {
          access: "exclusive",
          writerRootKey: input.writerRootKey,
          configIdentity: CONFIG_IDENTITY,
        },
      },
      updatedAt: at,
    });
    return { holderRunId, holderAgentId, holderIssueId };
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function waitForRetryRun(originalRunId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, originalRunId))
        .then((rows) => rows[0] ?? null);
      if (retryRun) return retryRun;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  it("defers a contained run that refused before model launch instead of failing it", async () => {
    const refuseScript = await writeScript("refuse.mjs", `
const runId = process.env.PAPERCLIP_RUN_ID;
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  kind: "run_admission",
  status: "deferred",
  runId,
  reasonCode: "writer_root_busy",
  detail: "another container still owns this writer root",
  owner: "technical-recovery",
  nextAction: "Re-admit after the writer root is free.",
  retryCondition: "after the canonical writer root is released",
  containerName: "paperclip-worker-fixture",
  modelStarted: false,
  exitCode: ${RUNNER_RESOURCE_WAIT_EXIT_CODE},
}) + "\\n");
process.exit(${RUNNER_RESOURCE_WAIT_EXIT_CODE});
`);
    const fixture = await seedFixture({
      adapterConfig: {
        command: process.execPath,
        args: [refuseScript],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
      },
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    // Contention is not a failure: the run is cancelled as a deferral, keeps the
    // workspace-busy error code, and records which refusal it saw.
    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(
      (finishedRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({
      source: "runner_containment",
      reasonCode: "writer_root_busy",
      containerName: "paperclip-worker-fixture",
    });

    const retryRun = await waitForRetryRun(run!.id);
    expect(retryRun?.scheduledRetryReason).toBe(WORKSPACE_BUSY_RETRY_REASON);
    expect(
      (retryRun?.contextSnapshot as Record<string, unknown> | null)?.workspaceBusyDeferredWhileAssignee,
    ).toBe(true);
  }, 30_000);

  it("keeps an unrelated process failure that exits with the reserved code a failure", async () => {
    const bareScript = await writeScript("bare.mjs", `
process.stdout.write("unrelated failure\\n");
process.exit(${RUNNER_RESOURCE_WAIT_EXIT_CODE});
`);
    const fixture = await seedFixture({
      adapterConfig: {
        command: process.execPath,
        args: [bareScript],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
      },
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    // The reserved exit code alone decides nothing: without the runner's
    // contention envelope this stays an ordinary failure. An ordinary recovery
    // continuation may exist; what must NOT exist is a workspace-busy deferral.
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    const workspaceBusyRetries = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.retryOfRunId, run!.id),
          eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
        ),
      );
    expect(workspaceBusyRetries).toHaveLength(0);
  }, 30_000);

  it("admits an exclusive canonical writer root and defers a second run that shares it", async () => {
    const resolverScript = await writeScript("resolve.mjs", `
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  kind: "paperclip_execution_writer_resource",
  access: "exclusive",
  writerRootKey: ${JSON.stringify(WRITER_ROOT_KEY)},
  configIdentity: ${JSON.stringify(CONFIG_IDENTITY)},
}) + "\\n");
process.exit(0);
`);
    const workingScript = await writeScript("work.mjs", "process.exit(0);\n");
    const fixture = await seedFixture({
      adapterConfig: {
        command: process.execPath,
        args: [workingScript],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: {
          command: process.execPath,
          entry: resolverScript,
          template: resolverScript,
        },
      },
    });

    // A live holder on the same canonical writer root: another run, admitted
    // under the same exclusive writer key.
    const { holderRunId } = await seedWriterRootHolder({
      companyId: fixture.companyId,
      writerRootKey: WRITER_ROOT_KEY,
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(
      (finishedRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({
      source: "native_canonical_writer_root",
      reasonCode: NATIVE_WRITER_ROOT_BUSY_REASON_CODE,
      holderRunId,
    });
    expect(await waitForRetryRun(run!.id)).not.toBeNull();
  }, 30_000);

  it("keeps a quiet but still-running holder's root reserved until its run is terminal", async () => {
    const resolverScript = await writeScript("resolve-silent.mjs", `
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  kind: "paperclip_execution_writer_resource",
  access: "exclusive",
  writerRootKey: ${JSON.stringify(WRITER_ROOT_KEY)},
  configIdentity: ${JSON.stringify(CONFIG_IDENTITY)},
}) + "\\n");
process.exit(0);
`);
    const workingScript = await writeScript("work-silent.mjs", "process.exit(0);\n");
    const fixture = await seedFixture({
      adapterConfig: {
        command: process.execPath,
        args: [workingScript],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
        executionResourceResolver: {
          command: process.execPath,
          entry: resolverScript,
          template: resolverScript,
        },
      },
    });
    // Well past any suspicion bar: age alone must never hand this root over.
    const silentSince = new Date(Date.now() - WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS - 60_000);
    const { holderRunId } = await seedWriterRootHolder({
      companyId: fixture.companyId,
      writerRootKey: WRITER_ROOT_KEY,
      activityAt: silentSince,
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    // The reservation is released by the run lifecycle (terminal disposition),
    // never by a timestamp: a quiet live writer still owns its root.
    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(
      (finishedRun?.resultJson as Record<string, unknown> | null)?.workspaceBusy,
    ).toMatchObject({
      source: "native_canonical_writer_root",
      holderRunId,
    });
    const retryRun = await waitForRetryRun(run!.id);
    expect(retryRun?.scheduledRetryReason).toBe(WORKSPACE_BUSY_RETRY_REASON);
    const holderRun = await heartbeat.getRun(holderRunId);
    expect(holderRun?.status).toBe("running");
  }, 30_000);
});
