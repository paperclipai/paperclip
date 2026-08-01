import { describe, expect, it } from "vitest";
import {
  ADAPTER_POLICY_ECHO_ERROR_CODE,
  assessAdapterPolicyEchoResult,
  assessAdapterPolicyEchoText,
} from "../services/adapter-policy-echo.ts";

describe("adapter policy echo detection", () => {
  it("flags wake-handling policy echoes with strong markers and low residual text", () => {
    const assessment = assessAdapterPolicyEchoText(`
      ## Paperclip Wake Payload

      Paperclip runtime identity:
      You are agent 123. Fallback fetch needed: no.
      Managed agent instructions apply. Final disposition checklist:
      satisfy the "acknowledge the latest comment" rule and do not call /api/issues/{id}/checkout again.
      Execution contract: leave a status update and use X-Paperclip-Run-Id.
    `);

    expect(assessment.isEcho).toBe(true);
    expect(assessment.reason).toBeTruthy();
    expect(assessment.strongHits).toBeGreaterThanOrEqual(2);
  });

  it("does not flag real work summaries that include concrete implementation evidence", () => {
    const assessment = assessAdapterPolicyEchoText(`
      Implemented the closeContract defaulting path for matrix cells and patched the done gate.
      Tests passed with pnpm vitest issue-execution-policy-routes.test.ts.
      Verification artifact banked under work-products/TSMC-18905 and commit abcdef12 was recorded.
    `);

    expect(assessment.isEcho).toBe(false);
    expect(assessment.reason).toBeNull();
  });

  it("uses comment output in the settle-time classifier input", () => {
    const assessment = assessAdapterPolicyEchoResult({
      resultJson: { summary: "Short success" },
      commentBodies: [
        "## Paperclip Wake Payload\nManaged agent instructions.\nPaperclip runtime identity.\nFinal disposition checklist.\nExecution contract:",
      ],
    });

    expect(assessment.isEcho).toBe(true);
    expect(ADAPTER_POLICY_ECHO_ERROR_CODE).toBe("adapter_policy_echo");
  });
});
