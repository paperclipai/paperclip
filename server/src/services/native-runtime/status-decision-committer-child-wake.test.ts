import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native status child-wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("native status decision child-completion wake routing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-child-wake-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedNativeCompletionCase(input: {
    originKind: string;
    parentStatus?: "todo" | "blocked";
    parentBlockedByChild?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const siblingId = randomUUID();
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `Native child wake ${input.originKind}`,
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native child wake agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        issueNumber: 1,
        title: "Parent issue",
        status: input.parentStatus ?? "todo",
        assigneeAgentId: agentId,
      },
      {
        id: siblingId,
        companyId,
        parentId,
        issueNumber: 2,
        title: "Completed normal sibling",
        status: "done",
        originKind: "manual",
      },
      {
        id: childId,
        companyId,
        parentId,
        issueNumber: 3,
        title: "Native terminal child",
        status: "in_progress",
        assigneeAgentId: agentId,
        originKind: input.originKind,
      },
    ]);
    if (input.parentBlockedByChild) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: childId,
        relatedIssueId: parentId,
        type: "blocks",
      });
    }
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId: childId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: 1, criteria: [] },
      canonicalSha256: `contract:${contractId}`,
      createdByActorType: "system",
      createdByActorId: "native-child-wake-test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: childId,
      completionContractId: contractId,
      completionContractSha256: `contract:${contractId}`,
      contextSnapshot: { issueId: childId },
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId: childId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${resultId}`,
      schemaStatus: "accepted",
      resultJson: { result: { summary: "Native child completed" } },
      canonicalSha256: `result:${resultId}`,
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId: childId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: { source: "native-child-wake-test" },
      inputDigest: `assessment:${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId: childId,
      phase: "arbitrating",
      attempt: 0,
      resultId,
      assessmentId,
    });

    return { companyId, parentId, childId, siblingId, runId, assessmentId };
  }

  async function commitDone(
    fixture: Awaited<ReturnType<typeof seedNativeCompletionCase>>,
  ) {
    const decision: NativeStatusDecision = {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "native_child_wake_test_complete",
      unblockDescriptor: null,
      effects: [],
    };
    return commitNativeStatusDecision({
      db,
      companyId: fixture.companyId,
      issueId: fixture.childId,
      runId: fixture.runId,
      assessmentId: fixture.assessmentId,
      priorStatus: "in_progress",
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision,
    });
  }

  async function wakeRows(companyId: string, reason: string) {
    return db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, reason),
      ));
  }

  it("does not emit child completion when a native exact watchdog finishes beside terminal normal work", async () => {
    const exactWatchdog = await seedNativeCompletionCase({ originKind: "task_watchdog" });
    await commitDone(exactWatchdog);

    expect(await wakeRows(exactWatchdog.companyId, "issue_children_completed")).toHaveLength(0);

    const nearMatch = await seedNativeCompletionCase({ originKind: "task_watchdog_product_bug" });
    await commitDone(nearMatch);

    const nearMatchRows = await wakeRows(nearMatch.companyId, "issue_children_completed");
    expect(nearMatchRows).toHaveLength(1);
    expect(nearMatchRows[0]?.payload).toMatchObject({
      issueId: nearMatch.parentId,
      completedChildIssueId: nearMatch.childId,
      childIssueIds: expect.arrayContaining([nearMatch.siblingId, nearMatch.childId]),
    });
  });

  it("keeps an exact watchdog dependency wake as blockers-resolved without a child-completion wake", async () => {
    const fixture = await seedNativeCompletionCase({
      originKind: "task_watchdog",
      parentStatus: "blocked",
      parentBlockedByChild: true,
    });

    await commitDone(fixture);
    await commitDone(fixture);

    const dependencyRows = await wakeRows(fixture.companyId, "issue_blockers_resolved");
    expect(dependencyRows).toHaveLength(1);
    expect(dependencyRows[0]?.payload).toMatchObject({
      issueId: fixture.parentId,
      resolvedBlockerIssueId: fixture.childId,
      blockerIssueIds: [fixture.childId],
    });
    expect(await wakeRows(fixture.companyId, "issue_children_completed")).toHaveLength(0);
  });
});
