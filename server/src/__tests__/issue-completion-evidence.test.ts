import { describe, expect, it } from "vitest";
import {
  assertIssueCompletionEvidenceOnCreate,
  deriveIssueCompletionEvidenceRequirement,
  evaluateIssueCompletionEvidence,
} from "../services/issue-completion-evidence.ts";

function contract(core: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    contractType: "delegated_task",
    taskType: "qa",
    core: {
      objective: "Verify and hand off the required output.",
      why: "The downstream owner needs durable proof.",
      sourceOfTruth: { files: ["SPEC.md"] },
      handoffNotes: { managerReasoning: "Evidence must survive the agent run." },
      ...core,
    },
  };
}

describe("issue completion evidence contract", () => {
  it("does not gate uncontracted issues or contracts without explicit evidence declarations", () => {
    expect(deriveIssueCompletionEvidenceRequirement(null)).toBeNull();
    expect(deriveIssueCompletionEvidenceRequirement(contract({
      acceptanceChecks: ["The implementation passes QA."],
    }))).toBeNull();
    expect(evaluateIssueCompletionEvidence(null, [])).toMatchObject({
      required: false,
      satisfied: true,
      missingRequirementTypes: [],
    });
    expect(() => assertIssueCompletionEvidenceOnCreate(null)).not.toThrow();
  });

  it("rejects creating an already-done issue when declared evidence cannot exist yet", () => {
    const executionContract = contract({
      acceptanceChecks: ["The deployment is reachable."],
      requiredOutputs: [{ type: "preview_url" }],
    });

    expect(() => assertIssueCompletionEvidenceOnCreate(executionContract)).toThrowError(
      expect.objectContaining({
        status: 422,
        details: expect.objectContaining({
          code: "issue_completion_evidence_missing",
          issueId: null,
          missingRequirementTypes: ["work_product:preview_url"],
        }),
      }),
    );
  });

  it("requires one usable work product for descriptive evidence requirements", () => {
    const executionContract = contract({
      acceptanceChecks: ["Tests pass and evidence is durable."],
      evidenceRequired: ["Record the test command and result."],
    });

    expect(evaluateIssueCompletionEvidence(executionContract, [])).toMatchObject({
      required: true,
      satisfied: false,
      missingRequirementTypes: ["work_product:any"],
    });
    expect(evaluateIssueCompletionEvidence(executionContract, [{
      type: "document",
      status: "active",
      reviewState: "none",
      healthStatus: "unknown",
      externalId: "document:test-results:42",
    }])).toMatchObject({
      required: true,
      satisfied: true,
      qualifyingWorkProductCount: 1,
      qualifyingWorkProductTypes: ["document"],
    });
  });

  it("reports each missing typed output with stable machine-readable requirement types", () => {
    const executionContract = contract({
      acceptanceChecks: ["The deployment is reachable and the QA artifact exists."],
      requiredOutputs: [
        { workProductType: "preview_url" },
        "artifact",
      ],
    });

    expect(deriveIssueCompletionEvidenceRequirement(executionContract)).toEqual({
      acceptanceCheckCount: 1,
      declaredEvidenceCount: 2,
      declaredRequirementTypes: ["work_product:artifact", "work_product:preview_url"],
      requiresAnyWorkProduct: false,
      requiredAnyWorkProductCount: 0,
      requiredWorkProductTypes: ["artifact", "preview_url"],
      invalidDeclaredTypes: [],
    });
    expect(evaluateIssueCompletionEvidence(executionContract, [{
      type: "preview_url",
      status: "ready_for_review",
      url: "https://preview.zenova.id/release-42",
    }])).toMatchObject({
      satisfied: false,
      missingRequirementTypes: ["work_product:artifact"],
    });
    expect(evaluateIssueCompletionEvidence(executionContract, [
      {
        type: "preview_url",
        status: "ready_for_review",
        url: "https://preview.zenova.id/release-42",
      },
      { type: "artifact", status: "active", externalId: "artifact:qa-evidence:release-42" },
    ])).toMatchObject({
      satisfied: true,
      missingRequirementTypes: [],
    });
  });

  it("does not count failed, archived, changes-requested, or unhealthy products", () => {
    const executionContract = contract({
      acceptanceChecks: ["The artifact is usable."],
      requiredOutputs: [{ type: "artifact" }],
    });
    const evaluation = evaluateIssueCompletionEvidence(executionContract, [
      { type: "artifact", status: "failed", externalId: "artifact-1" },
      { type: "artifact", status: "archived", externalId: "artifact-2" },
      {
        type: "artifact",
        status: "active",
        reviewState: "changes_requested",
        externalId: "artifact-3",
      },
      { type: "artifact", status: "active", healthStatus: "unhealthy", externalId: "artifact-4" },
    ]);

    expect(evaluation).toMatchObject({
      required: true,
      satisfied: false,
      qualifyingWorkProductCount: 0,
      missingRequirementTypes: ["work_product:artifact"],
    });
  });

  it("rejects title-only placeholders and requires durable evidence markers", () => {
    const executionContract = contract({
      acceptanceChecks: ["Preview, runtime, and artifact evidence are inspectable."],
      requiredOutputs: ["preview_url", "runtime_service", "artifact"],
    });

    expect(evaluateIssueCompletionEvidence(executionContract, [
      { type: "preview_url", status: "active", url: "not a URL" },
      { type: "runtime_service", status: "active" },
      { type: "artifact", status: "active" },
    ])).toMatchObject({
      satisfied: false,
      qualifyingWorkProductCount: 0,
      missingRequirementTypes: [
        "work_product:artifact",
        "work_product:preview_url",
        "work_product:runtime_service",
      ],
    });

    expect(evaluateIssueCompletionEvidence(executionContract, [
      {
        type: "preview_url",
        status: "active",
        url: "https://preview.zenova.id/release-42",
      },
      {
        type: "runtime_service",
        status: "active",
        runtimeServiceId: "11111111-1111-4111-8111-111111111111",
        healthStatus: "healthy",
      },
      {
        type: "artifact",
        status: "active",
        metadata: { sha256: "a".repeat(64), testSuite: "focused" },
      },
    ])).toMatchObject({
      satisfied: true,
      qualifyingWorkProductCount: 3,
      missingRequirementTypes: [],
    });
  });

  it("requires one distinct durable work product per descriptive evidence declaration", () => {
    const executionContract = contract({
      acceptanceChecks: [],
      evidenceRequired: ["Record full command output", "Record security review"],
    });

    expect(deriveIssueCompletionEvidenceRequirement(executionContract)).toMatchObject({
      acceptanceCheckCount: 0,
      requiredAnyWorkProductCount: 2,
    });
    expect(evaluateIssueCompletionEvidence(executionContract, [{
      type: "document",
      externalId: "document:test-result",
    }])).toMatchObject({
      satisfied: false,
      missingAnyWorkProductCount: 1,
      missingRequirementTypes: ["work_product:any"],
    });
    expect(evaluateIssueCompletionEvidence(executionContract, [
      { type: "document", externalId: "document:test-result" },
      { type: "document", externalId: "document:security-review" },
    ])).toMatchObject({
      satisfied: true,
      missingAnyWorkProductCount: 0,
    });

    expect(deriveIssueCompletionEvidenceRequirement(contract({
      evidenceRequired: {
        testLog: "Record the full command output",
        securityReview: "Record the independent review",
      },
    }))).toMatchObject({
      requiredAnyWorkProductCount: 2,
      declaredEvidenceCount: 2,
    });
  });

  it("preserves descriptive sibling cardinality in records with typed evidence keys", () => {
    const executionContract = contract({
      evidenceRequired: {
        artifact: "Attach the durable test transcript",
        securityReview: "Record the independent security review",
        operatorSignoff: "Record the operator sign-off",
      },
    });

    expect(deriveIssueCompletionEvidenceRequirement(executionContract)).toMatchObject({
      declaredEvidenceCount: 3,
      declaredRequirementTypes: ["work_product:any", "work_product:artifact"],
      requiredAnyWorkProductCount: 2,
      requiredWorkProductTypes: ["artifact"],
    });
    expect(evaluateIssueCompletionEvidence(executionContract, [{
      type: "artifact",
      externalId: "artifact:qa-transcript:release-42",
    }])).toMatchObject({
      satisfied: false,
      missingAnyWorkProductCount: 1,
      missingRequirementTypes: ["work_product:any"],
    });
    expect(evaluateIssueCompletionEvidence(executionContract, [
      { type: "artifact", externalId: "artifact:qa-transcript:release-42" },
      { type: "document", externalId: "document:security-review:release-42" },
    ])).toMatchObject({
      satisfied: true,
      missingAnyWorkProductCount: 0,
    });
  });

  it("fails closed on an unrecognized typed output declaration", () => {
    const executionContract = contract({
      acceptanceChecks: ["Deployment proof exists."],
      requiredOutputs: [{ workProductType: "preview_urll" }],
    });

    expect(evaluateIssueCompletionEvidence(executionContract, [{
      type: "preview_url",
      url: "https://preview.zenova.id/release-42",
    }])).toMatchObject({
      satisfied: false,
      missingRequirementTypes: ["work_product:invalid"],
      requirement: expect.objectContaining({
        invalidDeclaredTypes: ["preview_urll"],
      }),
    });
  });

  it("rejects obvious semantic placeholder URLs, ids, and document markers", () => {
    const executionContract = contract({
      requiredOutputs: ["preview_url", "artifact", "document"],
    });

    expect(evaluateIssueCompletionEvidence(executionContract, [
      { type: "preview_url", url: "https://example.com/preview" },
      { type: "artifact", externalId: "placeholder" },
      { type: "document", metadata: { documentId: "TBD" } },
    ])).toMatchObject({
      satisfied: false,
      qualifyingWorkProductCount: 0,
      missingRequirementTypes: [
        "work_product:artifact",
        "work_product:document",
        "work_product:preview_url",
      ],
    });
  });

  it("rejects obvious placeholder tokens embedded in compound external ids", () => {
    const executionContract = contract({
      requiredOutputs: ["artifact"],
    });

    expect(evaluateIssueCompletionEvidence(executionContract, [
      { type: "artifact", externalId: "dummy-artifact" },
      { type: "artifact", externalId: "sample-artifact" },
      { type: "artifact", externalId: "unknown-artifact" },
      { type: "artifact", externalId: "example-artifact" },
    ])).toMatchObject({
      satisfied: false,
      qualifyingWorkProductCount: 0,
      missingRequirementTypes: ["work_product:artifact"],
    });

    expect(evaluateIssueCompletionEvidence(executionContract, [{
      type: "artifact",
      externalId: "artifact:qa-evidence:release-42",
    }])).toMatchObject({
      satisfied: true,
      qualifyingWorkProductCount: 1,
    });
  });

  it("supports snake-case aliases and grouped work-product type declarations", () => {
    const executionContract = contract({
      acceptance_checks: ["QA and deployment evidence are attached."],
      evidence_required: {
        work_product_types: ["qa report", "deployment URL"],
      },
    });

    expect(deriveIssueCompletionEvidenceRequirement(executionContract)).toMatchObject({
      declaredRequirementTypes: ["work_product:document", "work_product:preview_url"],
      requiredWorkProductTypes: ["document", "preview_url"],
    });
  });
});
