import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { classifyNativeEvidence } from "./evidence-classifier.js";

const workProductId = "00000000-0000-4000-8000-000000000001";
const evidenceRef = `work_product:${workProductId}`;

function evidenceDb(row: Record<string, unknown> = {
  id: workProductId,
  status: "approved",
  reviewState: "approved",
}): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([row]),
        }),
      }),
    }),
  } as unknown as Db;
}

function result(status: "satisfied" | "not_satisfied", objectiveSatisfied: boolean) {
  return {
    reportedWorkDisposition: "done",
    summary: "Classified",
    completionClaim: {
      contractRevision: "1",
      objectiveSatisfied,
      criteria: [{ criterionId: "objective", status, evidenceRefs: [evidenceRef] }],
      remainingWork: [],
    },
    verification: [{ commandOrCheck: "test", status: "passed", artifactRef: evidenceRef }],
  };
}

const input = {
  db: evidenceDb(),
  companyId: "company",
  issueId: "issue",
  runId: "run",
  contract: {
    revision: "1",
    objective: "Classify evidence",
    criteria: [{ id: "objective", requirement: "Use accepted durable evidence" }],
  },
};

describe("classifyNativeEvidence", () => {
  it("accepts a satisfied claim backed by an approved durable work product", async () => {
    await expect(classifyNativeEvidence({
      ...input,
      result: result("satisfied", true),
    })).resolves.toEqual(expect.objectContaining({
      objectiveSatisfied: true,
      allCriteriaSatisfied: true,
      verificationPassed: true,
      acceptedEvidenceRefs: [evidenceRef],
    }));
  });

  it("does not turn durable evidence into completion when the claim says the criterion is unsatisfied", async () => {
    const assessment = await classifyNativeEvidence({
      ...input,
      result: result("not_satisfied", false),
    });
    expect(assessment).toEqual(expect.objectContaining({
      objectiveSatisfied: false,
      allCriteriaSatisfied: false,
      verificationPassed: true,
    }));
    expect(assessment.criterionAssessments).toEqual([
      expect.objectContaining({ outcome: "rejected", reasonCode: "criterion_reported_not_satisfied" }),
    ]);
  });

  it("normalizes DOT-29-style environment attention into a non-blocking verification caveat", async () => {
    const assessment = await classifyNativeEvidence({
      ...input,
      result: {
        ...result("satisfied", true),
        verification: [{ commandOrCheck: "Run npm test", status: "not_run" }],
        attentionRequests: [{
          kind: "environment_constraint",
          summary: "Node and npm are unavailable in this sandbox.",
        }],
      },
    });

    expect(assessment.objectiveClaimSatisfied).toBe(true);
    expect(assessment.hasFailedVerification).toBe(false);
    expect(assessment.attentionRequests).toEqual([]);
    expect(assessment.verificationCaveats).toEqual([{
      commandOrCheck: "Run npm test",
      reasonCode: "tool_unavailable",
      detail: "Node and npm are unavailable in this sandbox.",
    }]);
    expect(assessment.ignoredAttentionRequests).toEqual([
      expect.objectContaining({
        sourceKind: "environment_constraint",
        disposition: "verification_caveat",
      }),
    ]);
  });

  it("accepts an annotated interaction UUID without sending the annotation to Postgres", async () => {
    const interactionId = "00000000-0000-4000-8000-000000000029";
    const annotatedRef = `interaction:${interactionId} (request_confirmation, status accepted)`;
    const assessment = await classifyNativeEvidence({
      ...input,
      db: evidenceDb({ id: interactionId, status: "accepted", result: { outcome: "accepted" } }),
      result: {
        reportedWorkDisposition: "done",
        summary: "Plan accepted",
        completionClaim: {
          contractRevision: "1",
          objectiveSatisfied: true,
          criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [annotatedRef] }],
          remainingWork: [],
        },
        verification: [],
      },
    });

    expect(assessment.objectiveSatisfied).toBe(true);
    expect(assessment.acceptedEvidenceRefs).toEqual([annotatedRef]);
    expect(assessment.criterionAssessments[0]?.evidenceRefs[0]).toMatchObject({
      durableRecordId: interactionId,
      outcome: "accepted",
      reasonCode: "interaction_resolved",
    });
  });
});
