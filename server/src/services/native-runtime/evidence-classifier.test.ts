import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { classifyNativeEvidence } from "./evidence-classifier.js";

const workProductId = "00000000-0000-4000-8000-000000000001";
const evidenceRef = `work_product:${workProductId}`;

function evidenceDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: workProductId,
            status: "approved",
            reviewState: "approved",
          }]),
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
});
