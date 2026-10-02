import { describe, expect, it } from "vitest";
import { validatePrpStructuredRunResult } from "../../packages/paperclip-runner/src/protocol/replay-contract.js";
import { normalizePrpResultSignals } from "../../packages/paperclip-runner/src/protocol/result-normalization.js";
import { narratives } from "./narratives.js";
import { observe } from "./observe.js";
const result = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Completed work",
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
describe("LCA runner protocol narrative pairs", () => {
  it.each(narratives.filter(([, text]) => text.length > 0))(
    "LCA-01 structured completion / %s",
    (variant, summary) => {
      const actual = validatePrpStructuredRunResult({ ...result, summary });
      observe("LCA-01", `runner:${variant}`, actual);
      expect(actual).toMatchObject({
        ok: true,
        result: { reportedWorkDisposition: "done" },
      });
    },
  );
  it.each(narratives)(
    "LCA-09 summary cannot replace missing disposition / %s",
    (variant, summary) => {
      const { reportedWorkDisposition, ...withoutDisposition } = result;
      const actual = validatePrpStructuredRunResult({
        ...withoutDisposition,
        summary,
      });
      observe("LCA-09", `runner:missing:${variant}`, actual);
      expect(actual.ok).toBe(false);
    },
  );
  it.each(narratives)(
    "LCA-11 explicit verification reason survives detail / %s",
    (variant, detail) => {
      const actual = normalizePrpResultSignals({
        ...result,
        verification: [
          {
            commandOrCheck: "tests",
            status: "not_run",
            reasonCode: "tool_unavailable",
            detail,
          },
        ],
      });
      observe("LCA-11", `runner:verification:${variant}`, actual);
      expect(actual.verification[0]).toMatchObject({
        status: "not_run",
        reasonCode: "tool_unavailable",
      });
      expect(actual.actionableAttentionRequests).toEqual([]);
    },
  );
});
