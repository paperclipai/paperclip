import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import type { NativeStatusDecision } from "./status-arbiter.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn(), hashPrivateRef: vi.fn((value: string) => `hashed:${value}`) }));
const mockTrackAgentTaskCompleted = vi.hoisted(() => vi.fn());

vi.mock("../../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentTaskCompleted: mockTrackAgentTaskCompleted };
});

import { commitNativeStatusDecision } from "./status-decision-committer.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native task completion telemetry tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const doneDecision: NativeStatusDecision = {
  policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
  statusAction: "done",
  toStatus: "done",
  reasonCode: "completion_contract_satisfied",
  unblockDescriptor: null,
  effects: [{ kind: "release_checkout" }],
};

describeEmbeddedPostgres("native task completion telemetry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-task-completed-telemetry-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Telemetry fixture", issuePrefix: "TLM" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer",
      adapterType: "codex_local", adapterConfig: { model: "fixture-model" }, status: "running" });
  }, 30_000);

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedArbitratedRun(status: "in_progress" | "done" = "in_progress") {
    const issueId = randomUUID(), contractId = randomUUID(), runId = randomUUID();
    const resultId = randomUUID(), assessmentId = randomUUID();
    const contractSha256 = `contract-${contractId}`;
    await db.insert(issues).values({ id: issueId, companyId, title: "Native completion telemetry fixture",
      status, assigneeAgentId: agentId, workMode: "standard" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "task-completed-telemetry-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "task-completed-telemetry-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractSha256, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: randomUUID(), completionContractId: contractId,
      completionContractSha256: contractSha256, contextSnapshot: { issueId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId,
      completionContractId: contractId, serverFingerprint: `fp-${resultId}`, schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: `sha-${resultId}` });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId,
      contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: companyId,
      priorIssueStatus: status, priorStatusVersion: 0, policyVersion: "task-completed-telemetry-v1", assessmentJson: {},
      inputDigest: `digest-${assessmentId}` });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "arbitrating", resultId });
    return { issueId, runId, assessmentId, status };
  }

  function commitDone(fixture: Awaited<ReturnType<typeof seedArbitratedRun>>) {
    return commitNativeStatusDecision({
      db, companyId, issueId: fixture.issueId, runId: fixture.runId, assessmentId: fixture.assessmentId,
      priorStatus: fixture.status, priorStatusVersion: 0, priorDecisionId: null, decision: doneDecision,
    });
  }

  it("sends agent.task_completed once when the runner closes a task", async () => {
    const fixture = await seedArbitratedRun();

    const committed = await commitDone(fixture);
    expect(committed.issue.status).toBe("done");
    expect(mockTrackAgentTaskCompleted).toHaveBeenCalledTimes(1);
    expect(mockTrackAgentTaskCompleted).toHaveBeenCalledWith(mockTelemetryClient, {
      agentRole: "engineer",
      agentId,
      adapterType: "codex_local",
      model: "fixture-model",
      taskId: fixture.issueId,
    });

    const replayed = await commitDone(fixture);
    expect(replayed.replayed).toBe(true);
    expect(mockTrackAgentTaskCompleted).toHaveBeenCalledTimes(1);
  });

  it("does not send agent.task_completed again for a task the issue route already closed", async () => {
    const fixture = await seedArbitratedRun("done");

    await commitDone(fixture).catch(() => undefined);
    expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]?.status).toBe("done");
    expect(mockTrackAgentTaskCompleted).not.toHaveBeenCalled();
  });
});
