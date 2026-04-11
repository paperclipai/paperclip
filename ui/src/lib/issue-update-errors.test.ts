import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { describeIssueUpdateError } from "./issue-update-errors";

describe("describeIssueUpdateError", () => {
  it("maps known qa gate reason codes to operator-friendly text", () => {
    const err = new ApiError("Request failed", 422, {
      reasonCode: "qa_gate_missing_qa_pass",
      message: "Latest QA-authored comment must include [QA PASS] before moving to done",
    });

    const parsed = describeIssueUpdateError(err);
    expect(parsed.title).toBe("Ship blocked: missing QA PASS");
    expect(parsed.body).toContain("[QA PASS]");
  });

  it("falls back to generic errors when reasonCode is absent", () => {
    const err = new ApiError("Bad request", 400, { error: "Bad request" });
    const parsed = describeIssueUpdateError(err);
    expect(parsed.title).toBe("Issue update failed");
    expect(parsed.body).toBe("Bad request");
  });

  it("handles unknown thrown values", () => {
    const parsed = describeIssueUpdateError("oops");
    expect(parsed.title).toBe("Issue update failed");
  });
});

