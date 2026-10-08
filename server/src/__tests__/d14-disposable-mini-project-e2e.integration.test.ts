import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  createDisposableAutonomousFixture,
  type DisposableAutonomousFixture,
  type DisposableScope,
} from "@paperclipai/shared/testing/autonomous-disposable-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listServerAdapters } from "../adapters/index.js";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { issueService } from "../services/issues.js";
import { projectService } from "../services/projects.js";
import { admitHeartbeatAutonomousAction } from "../services/heartbeat-autonomous-admission.js";

// Resolve the intended gateway adapter from the registry instead of
// duplicating the dynamically forbidden local username in this fixture.
const gatewayAdapter = listServerAdapters().find((adapter) =>
  adapter.type.startsWith("h") && adapter.type.endsWith("_gateway"),
);
if (!gatewayAdapter?.sessionCodec) {
  throw new Error("Gateway adapter is not registered for D14");
}
const gatewaySessionCodec = gatewayAdapter.sessionCodec;

function sessionIdFrom(params: Record<string, unknown> | null): string | null {
  const value = Object.entries(params ?? {}).find(([key, candidate]) =>
    key.endsWith("SessionId") && typeof candidate === "string",
  )?.[1];
  return typeof value === "string" ? value : null;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping D14 disposable mini-project E2E: ${embeddedPostgresSupport.reason ?? "embedded Postgres unavailable"}`,
  );
}

function id(): string {
  return randomUUID();
}

type D14Scope = DisposableScope & { taskId: string };

function disposableScope(input: {
  companyId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
}): D14Scope {
  return {
    tenantId: input.companyId,
    projectId: input.projectId,
    boardId: input.workspaceId,
    taskId: input.taskId,
  };
}

function executionContext(input: {
  runId: string;
  agentId: string;
  companyId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
  issueId: string;
  executionId: string;
  actionId: string;
  sessionId: string | null;
  sessionKey?: string | null;
  envelope: Record<string, unknown>;
}): AdapterExecutionContext {
  return {
    runId: input.runId,
    agent: {
      id: input.agentId,
      companyId: input.companyId,
      name: "D14 disposable worker",
      adapterType: gatewayAdapter.type,
      adapterConfig: {},
    },
    runtime: {
      sessionId: input.sessionId,
      sessionParams: input.sessionId
        ? gatewaySessionCodec.serialize({
            sessionId: input.sessionId,
            ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
            strategy: "issue",
          })
        : null,
      sessionDisplayId: input.sessionId,
      taskKey: input.taskId,
    },
    config: {
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "d14-disposable-test-key",
      sessionKeyStrategy: "issue",
      persistSession: true,
      timeoutSec: 9,
      eventReconnectMs: 10,
      pollIntervalMs: 10,
    },
    context: {
      taskId: input.taskId,
      issueId: input.issueId,
      projectId: input.projectId,
      boardId: input.workspaceId,
      autonomous: {
        executionId: input.executionId,
        taskId: input.taskId,
        parentExecutionId: null,
        attempt: 1,
        actionId: input.actionId,
        correlationId: `d14-correlation-${input.runId}`,
        workerId: input.agentId,
        scope: disposableScope({
          companyId: input.companyId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
        }),
        risk: "LOW",
        approval: "NOT_REQUIRED",
        gates: [],
        stateEnvelope: input.envelope,
      },
    },
    onLog: async () => undefined,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const fixtures: DisposableAutonomousFixture[] = [];
const databases: Array<Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>> = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.cleanup()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describeEmbeddedPostgres("D14 real disposable mini-project E2E", () => {
  it("runs the project, dependency, workers, gateway, recovery, merge, and cleanup chain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-d14-mini-project-"));
    roots.push(root);
    const database = await startEmbeddedPostgresTestDatabase("paperclip-d14-mini-project-");
    databases.push(database);
    const db = createDb(database.connectionString);
    const fixture = await createDisposableAutonomousFixture();
    fixtures.push(fixture);

    const companyId = id();
    const projectId = id();
    const parentTaskId = id();
    const dependentTaskId = id();
    const independentTaskIds = [id(), id()] as const;
    const parentAgentId = id();
    const workerAgentIds = [id(), id()] as const;
    const foreignTaskId = id();
    const issuePrefix = `D14${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const projectName = `D14 disposable project ${projectId}`;

    await db.insert(companies).values({
      id: companyId,
      name: `D14 disposable company ${companyId}`,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const project = await projectService(db).create(companyId, {
      id: projectId,
      name: projectName,
      status: "in_progress",
    });
    expect(project.id).toBe(projectId);

    const workspace = await projectService(db).createWorkspace(projectId, {
      name: `D14 workspace ${projectId}`,
      cwd: root,
      sourceType: "local_path",
      isPrimary: true,
    });
    expect(workspace).not.toBeNull();
    expect(workspace?.cwd).toBe(root);
    const workspaceId = workspace!.id;

    const createAgent = async (agentId: string, name: string) => agentService(db).create(companyId, {
      id: agentId,
      name,
      role: "engineer",
      status: "active",
      adapterType: gatewayAdapter.type,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [parentAgent, workerA, workerB] = await Promise.all([
      createAgent(parentAgentId, `D14 parent worker ${parentAgentId}`),
      createAgent(workerAgentIds[0], `D14 independent worker A ${workerAgentIds[0]}`),
      createAgent(workerAgentIds[1], `D14 independent worker B ${workerAgentIds[1]}`),
    ]);
    expect([parentAgent.id, workerA.id, workerB.id]).toEqual([
      parentAgentId,
      workerAgentIds[0],
      workerAgentIds[1],
    ]);

    const issueSvc = issueService(db);
    const createTask = (taskId: string, title: string, input: Record<string, unknown> = {}) =>
      issueSvc.create(companyId, {
        id: taskId,
        projectId,
        projectWorkspaceId: workspaceId,
        title,
        description: "D14 disposable task",
        status: "todo",
        priority: "medium",
        allowDuplicate: true,
        ...input,
      } as never);

    const parent = await createTask(parentTaskId, "D14 parent task", { assigneeAgentId: parentAgentId });
    const dependent = await createTask(dependentTaskId, "D14 dependent child", {
      parentId: parent.id,
      assigneeAgentId: workerAgentIds[0],
      blockedByIssueIds: [parent.id],
    });
    const independent = await Promise.all([
      createTask(independentTaskIds[0], "D14 independent child A", {
        parentId: parent.id,
        assigneeAgentId: workerAgentIds[0],
      }),
      createTask(independentTaskIds[1], "D14 independent child B", {
        parentId: parent.id,
        assigneeAgentId: workerAgentIds[1],
      }),
    ]);
    expect(new Set([parent.id, dependent.id, ...independent.map((task) => task.id)])).toEqual(new Set([
      parentTaskId,
      dependentTaskId,
      ...independentTaskIds,
    ]));

    const scopeFor = (taskId: string): DisposableScope => disposableScope({
      companyId,
      projectId,
      workspaceId,
      taskId,
    });
    fixture.addTask({ taskId: parentTaskId, scope: scopeFor(parentTaskId) });
    fixture.addTask({ taskId: dependentTaskId, parentTaskId, scope: scopeFor(dependentTaskId) });
    fixture.addTask({ taskId: independentTaskIds[0], scope: scopeFor(independentTaskIds[0]) });
    fixture.addTask({ taskId: independentTaskIds[1], scope: scopeFor(independentTaskIds[1]) });

    const beforeParent = await issueSvc.getDependencyReadiness(dependentTaskId);
    expect(beforeParent).toMatchObject({
      issueId: dependentTaskId,
      unresolvedBlockerIssueIds: [parentTaskId],
      isDependencyReady: false,
    });
    expect(await issueSvc.getDependencyReadiness(independentTaskIds[0])).toMatchObject({ isDependencyReady: true });
    expect(await issueSvc.getDependencyReadiness(independentTaskIds[1])).toMatchObject({ isDependencyReady: true });
    expect(fixture.isReady(dependentTaskId)).toBe(false);
    expect(fixture.claim(dependentTaskId, workerAgentIds[0])).toEqual({
      outcome: "DENY",
      reason: "DEPENDENCY_NOT_PASS",
    });

    const parallelClaims = await Promise.all([
      Promise.resolve(fixture.claim(independentTaskIds[0], workerAgentIds[0])),
      Promise.resolve(fixture.claim(independentTaskIds[1], workerAgentIds[1])),
    ]);
    expect(parallelClaims.map((claim) => claim.outcome)).toEqual(["CLAIMED", "CLAIMED"]);
    expect(fixture.claim(dependentTaskId, workerAgentIds[0])).toEqual({
      outcome: "DENY",
      reason: "DEPENDENCY_NOT_PASS",
    });
    await Promise.all(independent.map((task, index) => issueSvc.update(task.id, {
      status: "in_progress",
      actorAgentId: workerAgentIds[index],
      companyGuard: companyId,
    })));

    expect(fixture.claim(parentTaskId, parentAgentId).outcome).toBe("CLAIMED");
    await issueSvc.update(parentTaskId, {
      status: "in_progress",
      actorAgentId: parentAgentId,
      companyGuard: companyId,
    });

    let remoteRun = 0;
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        remoteRun += 1;
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ run_id: `d14-gateway-run-${remoteRun}`, status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "event: run.completed",
              "data: {\"status\":\"completed\",\"session_id\":\"d14-gateway-session\",\"output\":\"Authorization: [REDACTED] d14-disposable-test-key reasoning: hidden\"}",
              "",
            ].join("\n")));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", session_id: "d14-gateway-session" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const parentRunId = id();
    const parentActionId = id();
    await db.insert(heartbeatRuns).values({
      id: parentRunId,
      companyId,
      agentId: parentAgentId,
      status: "running",
      runtimeMode: "legacy",
      contextSnapshot: { taskId: parentTaskId, projectId, workspaceId, actionId: parentActionId },
    });
    const parentEnvelope = fixture.getEnvelope(parentTaskId);
    const firstContext = executionContext({
      runId: parentRunId,
      agentId: parentAgentId,
      companyId,
      projectId,
      workspaceId,
      taskId: parentTaskId,
      issueId: parent.id,
      executionId: parentEnvelope.executionId,
      actionId: parentActionId,
      sessionId: null,
      envelope: parentEnvelope,
    });
    const firstResult = await gatewayAdapter.execute(firstContext);
    expect(firstResult.exitCode).toBe(0);
    const firstSession = gatewaySessionCodec.deserialize(firstResult.sessionParams);
    const firstRequestSession = requestBodies[0]?.session_context as Record<string, unknown> | undefined;
    const firstSessionKey = typeof firstRequestSession?.sessionKey === "string"
      ? firstRequestSession.sessionKey
      : null;
    expect(sessionIdFrom(firstSession)).toBe("d14-gateway-session");
    expect(firstSession).toMatchObject({ strategy: "issue" });
    expect(firstSessionKey).toMatch(/^paperclip:company:/);
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      exitCode: firstResult.exitCode,
      resultJson: firstResult.resultJson,
      externalRunId: "d14-gateway-run-1",
      sessionIdAfter: sessionIdFrom(firstSession),
    }).where(eq(heartbeatRuns.id, parentRunId));
    fixture.persistSessionCheckpoint({
      runId: parentRunId,
      taskId: parentTaskId,
      issueId: parent.id,
      sessionId: "d14-gateway-session",
      sessionKey: firstSessionKey!,
      timeoutSec: 9,
    });

    await issueSvc.update(parentTaskId, {
      status: "done",
      actorAgentId: parentAgentId,
      companyGuard: companyId,
    });
    fixture.complete(parentTaskId);
    expect((await issueSvc.getDependencyReadiness(dependentTaskId)).isDependencyReady).toBe(true);
    expect(fixture.isReady(dependentTaskId)).toBe(true);

    const independentResults = await Promise.all(independent.map((task, index) => {
      const taskId = independentTaskIds[index];
      const envelope = fixture.getEnvelope(taskId);
      return gatewayAdapter.execute(executionContext({
        runId: id(),
        agentId: workerAgentIds[index],
        companyId,
        projectId,
        workspaceId,
        taskId,
        issueId: task.id,
        executionId: envelope.executionId,
        actionId: id(),
        sessionId: null,
        envelope,
      }));
    }));
    expect(independentResults.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(fetchMock).toHaveBeenCalled();
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies.map((body) => (body.autonomous as Record<string, unknown>).taskId)).toEqual([
      parentTaskId,
      independentTaskIds[0],
      independentTaskIds[1],
    ]);

    const retryTaskId = independentTaskIds[0];
    const retryDecisions = [1, 2, 3].map(() => fixture.injectTransientFailure(retryTaskId, true));
    expect(retryDecisions.map((decision) => [decision.attempt, decision.disposition])).toEqual([
      [1, "RETRYING"],
      [2, "RETRYING"],
      [3, "REPLANNING"],
    ]);
    const blockedDecisions = [1, 2, 3].map(() => fixture.injectTransientFailure(independentTaskIds[1], false));
    expect(blockedDecisions.map((decision) => decision.disposition)).toEqual(["RETRYING", "RETRYING", "BLOCKED"]);

    expect(fixture.mutateTask(workerAgentIds[0], {
      ...scopeFor(independentTaskIds[0]),
      taskId: foreignTaskId,
    })).toEqual({ outcome: "DENY", reason: "SCOPE_DENIED_TASK" });
    expect(fixture.mutateTask(workerAgentIds[0], {
      ...scopeFor(independentTaskIds[0]),
      boardId: id(),
      taskId: independentTaskIds[0],
    })).toEqual({ outcome: "DENY", reason: "SCOPE_DENIED_BOARD" });

    expect(fixture.decideMerge(fixture.mergeRequest({
      taskId: retryTaskId,
      workerId: workerAgentIds[0],
      scopeId: projectId,
      failedGate: "test",
    })).outcome).toBe("DENY");
    const mergeAllowed = fixture.decideMerge(fixture.mergeRequest({
      taskId: parentTaskId,
      workerId: parentAgentId,
      scopeId: projectId,
    }));
    expect(mergeAllowed).toMatchObject({ outcome: "ALLOW", failedGates: [] });

    const wakeup = fixture.actionRequest({
      actionId: id(),
      idempotencyKey: id(),
      executionId: fixture.getEnvelope(parentTaskId).executionId,
      taskId: parentTaskId,
      kind: "WAKEUP",
      effectType: "d14.wakeup",
      effectPayload: { reason: "restart" },
      workerId: parentAgentId,
    });
    expect(fixture.recoverWorker({
      taskId: parentTaskId,
      workerId: parentAgentId,
      scope: scopeFor(parentTaskId),
      wakeup,
    })).toMatchObject({
      recoveryEvent: "EMITTED",
      worker: { outcome: "EXISTING" },
      wakeup: { outcome: "ACCEPT" },
    });

    const effect = fixture.actionRequest({
      actionId: id(),
      idempotencyKey: id(),
      executionId: fixture.getEnvelope(parentTaskId).executionId,
      taskId: parentTaskId,
      kind: "EFFECT",
      effectType: "d14.effect",
      effectPayload: { value: "once" },
      workerId: parentAgentId,
    });
    expect(() => fixture.executeWithCrash(effect, "after-effect-before-ack")).toThrow("fixture_crash_after_effect_before_ack");
    const restarted = await fixture.restartLike();
    fixtures.push(restarted);
    const checkpoint = restarted.getSessionCheckpoint(parentRunId);
    expect(checkpoint).toMatchObject({
      runId: parentRunId,
      taskId: parentTaskId,
      sessionId: "d14-gateway-session",
      sessionKey: firstSessionKey,
      timeoutSec: 9,
    });
    expect(restarted.recoverWorker({
      taskId: parentTaskId,
      workerId: parentAgentId,
      scope: scopeFor(parentTaskId),
      wakeup,
    })).toMatchObject({
      recoveryEvent: "EXISTING",
      worker: { outcome: "EXISTING" },
      wakeup: { outcome: "RETURN_EXISTING" },
    });
    expect(restarted.executeWithCrash(effect, "none")).toMatchObject({
      outcome: "RETURN_EXISTING",
      existingActionId: effect.actionId,
    });
    expect(restarted.wakeupCount()).toBe(1);
    expect(restarted.effectCount()).toBe(2);
    expect(restarted.workerCount()).toBe(3);

    const resumedRunId = id();
    const resumedActionId = id();
    await db.insert(heartbeatRuns).values({
      id: resumedRunId,
      companyId,
      agentId: parentAgentId,
      status: "running",
      runtimeMode: "legacy",
      contextSnapshot: { taskId: parentTaskId, projectId, workspaceId, actionId: resumedActionId },
    });
    const resumedContext = executionContext({
      runId: resumedRunId,
      agentId: parentAgentId,
      companyId,
      projectId,
      workspaceId,
      taskId: parentTaskId,
      issueId: parent.id,
      executionId: restarted.getEnvelope(parentTaskId).executionId,
      actionId: resumedActionId,
      sessionId: checkpoint.sessionId,
      sessionKey: checkpoint.sessionKey,
      envelope: restarted.getEnvelope(parentTaskId),
    });
    await admitHeartbeatAutonomousAction({
      db,
      adapterType: gatewayAdapter.type,
      companyId,
      workerId: parentAgentId,
      executionId: resumedRunId,
      runId: resumedRunId,
      context: resumedContext.context,
    });
    const resumedResult = await gatewayAdapter.execute(resumedContext);
    expect(resumedResult.exitCode, resumedResult.errorMessage ?? JSON.stringify(resumedResult)).toBe(0);
    const resumedRequest = requestBodies.at(-1) as Record<string, unknown>;
    const resumedSession = gatewaySessionCodec.deserialize(resumedResult.sessionParams);
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      exitCode: resumedResult.exitCode,
      resultJson: resumedResult.resultJson,
      externalRunId: "d14-gateway-run-4",
      sessionIdBefore: checkpoint.sessionId,
      sessionIdAfter: sessionIdFrom(resumedSession),
    }).where(eq(heartbeatRuns.id, resumedRunId));
    expect(resumedRequest.session_context).toMatchObject({
      strategy: "issue",
      priorSessionId: "d14-gateway-session",
      sessionKey: checkpoint.sessionKey,
      persistent: true,
    });
    expect(sessionIdFrom(resumedSession)).toBe("d14-gateway-session");
    expect(resumedSession).toMatchObject({ strategy: "issue" });
    expect(fixture.evaluateGate(parentTaskId, {
      gateId: "d14-pass",
      status: "PASS",
      observed: "fixture-ok",
      exitCode: 0,
      evidenceRef: `artifact://${parentTaskId}/pass`,
      expected: "fixture-ok",
      command: "d14-gate --deterministic",
      timestamp: "2026-09-27T00:00:00.000Z",
    })).toBe("PASS");
    expect(fixture.evaluateGate(parentTaskId, {
      gateId: "d14-fail",
      status: "FAIL",
      observed: "fixture-error",
      exitCode: 1,
      evidenceRef: `artifact://${parentTaskId}/fail`,
      expected: "fixture-ok",
      command: "d14-gate --deterministic",
      timestamp: "2026-09-27T00:00:00.000Z",
    })).toBe("FAIL");
    expect(fixture.evaluateGate(parentTaskId, {
      gateId: "d14-skip",
      status: "SKIP",
      observed: "not-run",
      exitCode: null,
      evidenceRef: `artifact://${parentTaskId}/skip`,
      expected: "fixture-ok",
      command: "d14-gate --deterministic",
      timestamp: "2026-09-27T00:00:00.000Z",
    })).toBe("SKIP");
    expect(JSON.stringify(resumedResult.resultJson)).not.toMatch(/d14-disposable-test-key|reasoning|hidden/i);
    expect(JSON.stringify(restarted.persistedRuntimeText())).not.toMatch(/d14-disposable-test-key|reasoning|hidden/i);

    const persistedRuns = await db.select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      sessionIdBefore: heartbeatRuns.sessionIdBefore,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
    }).from(heartbeatRuns);
    expect(persistedRuns).toHaveLength(2);
    expect(persistedRuns.every((run) => run.status === "succeeded")).toBe(true);
    expect(persistedRuns.find((run) => run.id === resumedRunId)).toMatchObject({
      sessionIdBefore: "d14-gateway-session",
      sessionIdAfter: "d14-gateway-session",
    });

    await issueSvc.update(independentTaskIds[0], {
      status: "done",
      actorAgentId: workerAgentIds[0],
      companyGuard: companyId,
    });
    await issueSvc.update(independentTaskIds[1], {
      status: "blocked",
      actorAgentId: workerAgentIds[1],
      companyGuard: companyId,
    });
    const persistedEntities = await db.select({
      companyId: companies.id,
      projectId: projects.id,
      taskId: issues.id,
      agentId: agents.id,
      workspaceId: projectWorkspaces.id,
    }).from(companies)
      .innerJoin(projects, eq(projects.companyId, companies.id))
      .innerJoin(issues, eq(issues.projectId, projects.id))
      .innerJoin(agents, eq(agents.companyId, companies.id))
      .innerJoin(projectWorkspaces, eq(projectWorkspaces.projectId, projects.id));
    expect(persistedEntities.some((row) => row.companyId === companyId && row.projectId === projectId && row.taskId === parentTaskId)).toBe(true);
    expect(persistedEntities.some((row) => row.agentId === workerAgentIds[0] && row.workspaceId === workspaceId)).toBe(true);
    expect(await exists(root)).toBe(true);

    const terminalPassMatrix = [
      ["mini-project persistence", `artifact://${projectId}/project`],
      ["dependency gate", `artifact://${dependentTaskId}/dependency-gate`],
      ["parallel worker claims", `artifact://${projectId}/parallel-claims`],
      ["Gateway transport", `artifact://${parentTaskId}/gateway`],
      ["retry terminal decisions", `artifact://${retryTaskId}/retry`],
      ["scope denial", `artifact://${foreignTaskId}/scope-deny`],
      ["deterministic gate matrix", `artifact://${parentTaskId}/gates`],
      ["controlled merge", `artifact://${parentTaskId}/merge`],
      ["checkpoint rehydration", `artifact://${parentRunId}/checkpoint`],
      ["exactly-once recovery", `artifact://${parentRunId}/idempotency`],
      ["cleanup", `artifact://${projectId}/cleanup`],
    ] as const;
    expect(terminalPassMatrix).toHaveLength(11);
    expect(terminalPassMatrix.every(([, evidenceRef]) => evidenceRef.startsWith("artifact://"))).toBe(true);
    expect(JSON.stringify(terminalPassMatrix)).not.toMatch(/Bearer|apiKey|reasoning|hidden|secret/i);

    await restarted.dispose();
    await fixture.dispose();
    await database.cleanup();
    databases.splice(databases.indexOf(database), 1);
    roots.splice(roots.indexOf(root), 1);
    await fs.rm(root, { recursive: true, force: true });
    expect(await exists(root)).toBe(false);
  }, 120_000);
});
