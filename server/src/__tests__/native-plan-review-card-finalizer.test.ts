import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  statusDecisions,
  workspaceOperations,
} from "@paperclipai/db";
import { CONTROL_PLANE_CONFORMANCE_OPEN } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { documentService } from "../services/documents.js";
import { recoveryService } from "../services/recovery/service.js";

const cardFailure = vi.hoisted(() => ({ next: false }));
vi.mock("../services/native-runtime/native-plan-review-card.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-plan-review-card.js")>();
  return {
    ...actual,
    ensureNativePlanReviewCard: async (...args: Parameters<typeof actual.ensureNativePlanReviewCard>) => {
      if (cardFailure.next) {
        cardFailure.next = false;
        throw new Error("connection reset while opening the card");
      }
      return actual.ensureNativePlanReviewCard(...args);
    },
  };
});

const committedPlanWait = vi.hoisted(() => ({ runIds: new Set<string>() }));
vi.mock("../services/native-runtime/native-plan-wait.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-plan-wait.js")>();
  return {
    ...actual,
    hasCommittedNativePlanWait: async (...args: Parameters<typeof actual.hasCommittedNativePlanWait>) =>
      committedPlanWait.runIds.has(args[1].runId) || actual.hasCommittedNativePlanWait(...args),
  };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PLAN_REVIEW_FINALIZER_TEST_DATABASE_URL");

// The live failure: the Antigravity process was killed mid Plan-mode run; the
// automatic continuation wrote a new plan revision and yielded "waiting for
// plan review" without opening the Approve / Request changes card. The task
// sat in progress with nothing for the user to act on.
describe("Plan-mode run settle opens the plan review", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = "72300000-0000-4000-8000-000000000001";
  const agentId = "72300000-0000-4000-8000-000000000002";
  let seq = 0;

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-plan-review-finalizer-");
    db = createDb(external ?? temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Plan review", issuePrefix: "PRF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Gemma Antigravity", adapterType: "antigravity_local", status: "running" });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  const yielded = {
    schema: "paperclip.run_result.v1" as const,
    reportedWorkDisposition: "yielded" as const,
    summary: "Saved the plan. Waiting for plan review before executing.",
    completionClaim: {
      contractRevision: "plan-v1", objectiveSatisfied: false,
      criteria: [{ criterionId: "objective", status: "unknown" as const, evidenceRefs: [] }],
      remainingWork: [],
    },
    evidence: [], verification: [], attentionRequests: [], artifacts: [],
    continuation: { kind: "response_wake" as const, summary: "Waiting for plan review", idempotencyKey: "plan-review-wake-v1" },
  };

  async function settleRun(options: { workMode: "planning" | "standard"; writePlan: boolean }) {
    seq += 1;
    const id = (n: number) => `72300000-0000-4000-8${String(seq).padStart(3, "0")}-${String(n).padStart(12, "0")}`;
    const issueId = id(1), contractId = id(2), runId = id(3);
    await db.insert(issues).values({ id: issueId, companyId, title: `Plan ${seq}`, status: "in_progress",
      assigneeAgentId: agentId, workMode: options.workMode });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "plan-v1", objective: "Plan the file",
        criteria: [{ id: "objective", requirement: "The plan is approved" }] },
      canonicalSha256: `plan-contract-${seq}`, createdByActorType: "system", createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      runtimeModeReason: "persisted_before_kill_switch", nativeIssueId: issueId, nativeSessionId: runId,
      runnerInstanceId: contractId, completionContractId: contractId,
      completionContractSha256: `plan-contract-${seq}`, contextSnapshot: { issueId },
    });
    if (options.writePlan) {
      await documentService(db).upsertIssueDocument({ issueId, key: "plan", title: "Plan", format: "markdown",
        body: "# Create crash-proof.txt\n\n1. Write CRASH.", createdByAgentId: agentId, createdByRunId: runId });
    }
    const port = new PaperclipControlPlanePort(db, {
      companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: `plan-contract-${seq}`, sourceInstanceId: contractId,
      controlPlaneSourceInstanceId: `plan-control-${seq}`,
    });
    await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN,
      identity: { companyId, issueId, runId, agentId, sessionId: runId }, sourceInstanceId: contractId });
    await port.completeRun({ result: yielded, terminal: { schema: "paperclip.prp.terminal.v1",
      turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "yielded" },
      callerResultId: `plan-result-${seq}` });
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: runId, issueId,
      phase: "workspace_finalize", status: "succeeded" });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, issue!.lastStatusDecisionId!));
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, agentId)));
    return { issueId, runId, issue: issue!, decision: decision!, cards,
      wakes: wakes.filter(wake => JSON.stringify(wake.payload ?? {}).includes(issueId)) };
  }

  it("opens one review card for the new plan revision and waits on it", async () => {
    const settled = await settleRun({ workMode: "planning", writePlan: true });

    expect(settled.cards).toHaveLength(1);
    expect(settled.cards[0]).toMatchObject({ kind: "request_confirmation", status: "pending", sourceRunId: settled.runId });
    expect(settled.cards[0]!.payload).toMatchObject({ target: { type: "issue_document", key: "plan", revisionNumber: 1 } });
    expect(settled.issue.status).toBe("in_review");
    expect(settled.decision.reasonCode).toBe("governed_response_waiting");
  });

  it("asks the agent for its plan when a Plan-mode run yields with none", async () => {
    const settled = await settleRun({ workMode: "planning", writePlan: false });

    expect(settled.cards).toHaveLength(0);
    expect(settled.decision.reasonCode).toBe("plan_mode_plan_not_produced");
    expect(settled.wakes.some(wake => JSON.stringify(wake.payload).includes("Plan mode"))).toBe(true);
  });

  it("gives a task left without its card by an older release one on the next recovery pass", async () => {
    const settled = await settleRun({ workMode: "planning", writePlan: true });
    // The state an older release left: settled, waiting, no card.
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, settled.issueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, settled.issueId));
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues({ companyId, issueId: settled.issueId });
    await recovery.reconcileStrandedAssignedIssues({ companyId, issueId: settled.issueId });

    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, settled.issueId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "request_confirmation", status: "pending" });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("settles the run when opening the card fails, and the next recovery pass opens it", async () => {
    cardFailure.next = true;
    const settled = await settleRun({ workMode: "planning", writePlan: true });

    expect(settled.cards).toHaveLength(0);
    expect(settled.issue.status).toBe("in_progress");
    expect(settled.decision.reasonCode).toBe("response_wake_waiting_for_input");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, settled.runId));
    expect(run).toMatchObject({ status: "succeeded" });

    await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) })
      .reconcileStrandedAssignedIssues({ companyId, issueId: settled.issueId });
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, settled.issueId));
    expect(cards).toEqual([expect.objectContaining({ kind: "request_confirmation", status: "pending" })]);
  });

  it.each(["finalization reason", "committed plan wait"])("never opens a second card for a plan the user already accepted (%s)", async (proof) => {
    const settled = await settleRun({ workMode: "planning", writePlan: true });
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, settled.issueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, settled.issueId));
    if (proof === "finalization reason") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, settled.runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson as Record<string, unknown>),
        finalizationReasonCode: "native_plan_accepted_waiting_for_continuation" } }).where(eq(heartbeatRuns.id, settled.runId));
    } else committedPlanWait.runIds.add(settled.runId);

    await recoveryService(db, { enqueueWakeup: vi.fn(async () => null) })
      .reconcileStrandedAssignedIssues({ companyId, issueId: settled.issueId });

    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, settled.issueId))).toHaveLength(0);
  });

  it("leaves a Standard-mode response wait unchanged", async () => {
    const settled = await settleRun({ workMode: "standard", writePlan: true });

    expect(settled.cards).toHaveLength(0);
    expect(settled.issue.status).toBe("in_progress");
    expect(settled.decision.reasonCode).toBe("response_wake_waiting_for_input");
  });
});
