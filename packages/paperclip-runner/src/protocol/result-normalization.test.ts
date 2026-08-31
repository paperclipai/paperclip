import { describe, expect, it } from "vitest";
import {
  normalizeLegacyPrpStructuredRunResult,
  normalizePrpResultSignals,
} from "./result-normalization.js";
import { validatePrpStructuredRunResult } from "./replay-contract.js";

describe("normalizePrpResultSignals", () => {
  it("accepts legacy completion aliases as one canonical PRP result", () => {
    const legacy = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "completed",
      summary: "Implemented and verified the utility.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: true,
        criteria: [
          {
            criterionId: "objective",
            status: "satisfied",
            evidenceRefs: ["file:a"],
          },
        ],
        remainingWork: [],
      },
      evidence: [{ ref: "file:a" }],
      verification: [
        {
          command: "node --test",
          cwd: "fixture",
          status: "passed",
          result: "4 passed",
        },
      ],
    };

    expect(normalizeLegacyPrpStructuredRunResult(legacy)).toMatchObject({
      reportedWorkDisposition: "done",
      attentionRequests: [],
      artifacts: [],
      verification: [
        { commandOrCheck: "node --test", status: "passed", detail: "4 passed" },
      ],
    });
    expect(validatePrpStructuredRunResult(legacy)).toMatchObject({
      ok: true,
      result: { reportedWorkDisposition: "done" },
    });
  });

  it("restores the canonical schema discriminator omitted by a provider tool caller", () => {
    const withoutSchema = {
      reportedWorkDisposition: "done",
      summary: "Completed the requested work.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: true,
        criteria: [
          { criterionId: "objective", status: "satisfied", evidenceRefs: [] },
        ],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
    };
    expect(validatePrpStructuredRunResult(withoutSchema)).toMatchObject({
      ok: true,
      result: { schema: "paperclip.run_result.v1" },
    });
  });

  it("requires an identified owner for blocked results", () => {
    const blockedResult = {
      reportedWorkDisposition: "blocked",
      summary: "External input is required.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: false,
        criteria: [
          { criterionId: "objective", status: "not_satisfied", evidenceRefs: [] },
        ],
        remainingWork: [
          { description: "Wait for external input.", blocksCompletion: true },
        ],
      },
      evidence: [],
      verification: [],
      blocker: {
        reasonCode: "external_input_required",
        owner: {},
        unblockAction: "Provide the required input.",
        scope: "current_track",
      },
    };

    expect(validatePrpStructuredRunResult(blockedResult)).toMatchObject({
      ok: false,
    });
    expect(
      validatePrpStructuredRunResult({
        ...blockedResult,
        blocker: {
          ...blockedResult.blocker,
          owner: { kind: "external", name: "External input" },
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("normalizes unambiguous completion aliases emitted by smaller tool callers", () => {
    const toolShaped = {
      schema: "paperclip_paperclip_finish",
      reportedWorkDisposition: "completed",
      summary: "Answered the question.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: true,
        criteria: [
          { criterionId: "objective", status: "passed", evidenceRefs: [] },
        ],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
    };
    expect(validatePrpStructuredRunResult(toolShaped)).toMatchObject({
      ok: true,
      result: {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "done",
        completionClaim: {
          criteria: [{ status: "satisfied" }],
        },
      },
    });
  });

  it("normalizes unambiguous verification aliases from smaller tool callers", () => {
    expect(
      validatePrpStructuredRunResult({
        reportedWorkDisposition: "completed",
        summary: "Answered the question.",
        completionClaim: {
          contractRevision: "1",
          objectiveSatisfied: true,
          criteria: [
            { criterionId: "objective", status: "pass", evidenceRefs: [] },
          ],
          remainingWork: [],
        },
        evidence: [],
        verification: [{ commandOrCheck: "model check", status: "success" }],
      }),
    ).toMatchObject({
      ok: true,
      result: {
        verification: [{ commandOrCheck: "model check", status: "passed" }],
      },
    });
  });

  it("turns legacy environment_constraint attention into a verification caveat", () => {
    const normalized = normalizePrpResultSignals({
      verification: [
        {
          commandOrCheck: "Run npm test",
          status: "not_run",
        },
      ],
      attentionRequests: [
        {
          kind: "environment_constraint",
          summary: "Node and npm are unavailable in this sandbox.",
        },
      ],
    });

    expect(normalized.actionableAttentionRequests).toEqual([]);
    expect(normalized.verification).toEqual([
      expect.objectContaining({
        commandOrCheck: "Run npm test",
        status: "not_run",
        reasonCode: "tool_unavailable",
        detail: "Node and npm are unavailable in this sandbox.",
      }),
    ]);
    expect(normalized.ignoredAttentionRequests).toEqual([
      expect.objectContaining({
        sourceKind: "environment_constraint",
        disposition: "verification_caveat",
        reasonCode: "legacy_environment_constraint_normalized",
      }),
    ]);

    const canonical = normalizeLegacyPrpStructuredRunResult({
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "done",
      summary: "Work is complete; local verification was unavailable.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: true,
        criteria: [
          { criterionId: "objective", status: "satisfied", evidenceRefs: [] },
        ],
        remainingWork: [],
      },
      evidence: [],
      verification: [
        {
          command: "npm test",
          status: "blocked",
          result: "Node is unavailable.",
        },
      ],
      attentionRequests: [
        {
          kind: "environment_constraint",
          summary: "Node and npm are unavailable in this sandbox.",
        },
      ],
    });
    expect(canonical).toMatchObject({
      attentionRequests: [],
      verification: [
        {
          commandOrCheck: "npm test",
          status: "not_run",
          reasonCode: "tool_unavailable",
          detail:
            "Node is unavailable.\nNode and npm are unavailable in this sandbox.",
        },
      ],
    });
    expect(validatePrpStructuredRunResult(canonical)).toMatchObject({
      ok: true,
    });
  });

  it("normalizes an unavailable command reported as failed into a not-run caveat", () => {
    const normalized = normalizePrpResultSignals({
      verification: [
        {
          commandOrCheck: "tsc --noEmit",
          status: "failed",
          reasonCode: "dependency_missing",
          detail:
            "Repository dependencies are not installed, so the compiler could not start.",
        },
      ],
    });

    expect(normalized.verification).toEqual([
      expect.objectContaining({
        commandOrCheck: "tsc --noEmit",
        status: "not_run",
        reasonCode: "dependency_missing",
      }),
    ]);
  });

  it("preserves typed actionable requests and legacy review requests", () => {
    const normalized = normalizePrpResultSignals({
      attentionRequests: [
        {
          kind: "approval",
          summary: "Approve publication",
          ownerClass: "human",
        },
        { kind: "review", summary: "Review the result" },
      ],
    });

    expect(normalized.actionableAttentionRequests).toEqual([
      expect.objectContaining({
        kind: "approval",
        ownerClass: "human",
        legacy: false,
      }),
      expect.objectContaining({
        kind: "review",
        ownerClass: "human",
        legacy: true,
      }),
    ]);
  });

  it("records unknown and malformed attention as diagnostics instead of throwing", () => {
    const normalized = normalizePrpResultSignals({
      attentionRequests: [
        { kind: "future_provider_value", summary: "Unknown request" },
        { kind: "approval" },
        null,
      ],
    });

    expect(normalized.actionableAttentionRequests).toEqual([]);
    expect(normalized.ignoredAttentionRequests).toEqual([
      expect.objectContaining({
        disposition: "ignored",
        reasonCode: "attention_request_kind_unsupported",
      }),
      expect.objectContaining({
        disposition: "rejected",
        reasonCode: "attention_request_malformed",
      }),
      expect.objectContaining({
        disposition: "rejected",
        reasonCode: "attention_request_malformed",
      }),
    ]);
  });
});
