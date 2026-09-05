import { describe, expect, it } from "bun:test";
import { validateRunBinding } from "./run-binding.js";

describe("agent run binding", () => {
  it("accepts a missing header when the signed run remains authoritative", () => {
    expect(validateRunBinding("run-1", undefined)).toEqual({ kind: "valid" });
  });

  it("accepts a matching run header", () => {
    expect(validateRunBinding("run-1", " run-1 ")).toEqual({ kind: "valid" });
  });

  it("returns a mismatch without exposing credentials", () => {
    expect(validateRunBinding("run-1", "run-2")).toEqual({
      kind: "mismatch",
      claimRunId: "run-1",
      headerRunId: "run-2",
    });
  });

  it("rejects an empty signed run id", () => {
    expect(validateRunBinding("  ", undefined)).toEqual({
      kind: "invalid",
      reason: "missing_claim_run_id",
    });
  });
});
