import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  agentRuntimeState,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Regression coverage for RENA-54683: "execution workspace not persisted" was
// killing wakes before adapter start whenever previousSessionParams carried a
// project-bound workspaceId (e.g. from a prior session, or an explicit resume
// request) while the issue/run no longer resolves any project for the
// current run (project link removed between sessions, or never bound to
// begin with). resolveAnchorWorkspaceForRun()'s task_session branch used to
// propagate that workspaceId unconditionally, which made
// assertGitSensitiveAdapterWorkspaceValid() require a persisted execution
// workspace that could never exist without a resolved project.
//
// This exercises previousSessionParams via context.resumeSessionParams
// (rather than a stored agent_task_sessions row) so the scenario is not
// entangled with the unrelated task-session config-freshness reset logic.

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "fresh-session" },
  sessionDisplayId: "fresh-session",
  summary: "Stale session workspace regression test run.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-session-workspace tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat stale session workspace without a resolved project", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-session-workspace-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      await db.delete(agentTaskSessions);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("does not fail with missing_persisted_execution_workspace when previousSessionParams has a stale workspaceId and no project is resolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    // Stands in for a cwd a *previous*, project-bound session recorded. Its
    // existence on disk is what lets resolveAnchorWorkspaceForRun() reach the
    // task_session branch instead of falling back to agent_home.
    const staleSessionCwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-stale-session-cwd-"));
    tempRoots.push(staleSessionCwd);

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      title: "Projectless issue with a stale project-bound session resume",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      identifier: "PAP-9200",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        // Stale params from an earlier, project-bound session: the
        // workspaceId here can no longer be backed by any persisted
        // execution workspace because this run resolves no project.
        resumeSessionParams: {
          sessionId: "stale-project-bound-session",
          cwd: staleSessionCwd,
          workspaceId: randomUUID(),
        },
      },
    });

    expect(run).not.toBeNull();
    const finished = await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).not.toBe("queued");
      expect(latest?.status).not.toBe("running");
      return latest;
    }, { timeout: 10_000 });

    expect(finished?.error ?? "").not.toMatch(/execution workspace/i);
    expect(finished?.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const refreshedRun = await db
      .select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0]);
    expect(
      (refreshedRun?.resultJson as { workspaceValidation?: { reason?: string } } | null)
        ?.workspaceValidation?.reason,
    ).not.toBe("missing_persisted_execution_workspace");
  }, 20_000);
});
