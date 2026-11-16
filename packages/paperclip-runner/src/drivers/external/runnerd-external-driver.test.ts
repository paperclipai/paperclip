import { describe, expect, it } from "vitest";
import { isRetryableOperationRejection } from "./runnerd-external-driver.js";

describe("external provider operation retry", () => {
  it("issues a fresh command only after a retryable rejection", () => {
    const rejected = { status: "rejected", requestId: "op-1", error: { code: "tool_calls_in_flight", retryable: true } };
    expect(isRetryableOperationRejection("completed", rejected)).toBe(true);
    expect(isRetryableOperationRejection("completed", { status: "pending", requestId: "op-1" })).toBe(false);
    expect(isRetryableOperationRejection("completed", { ...rejected, error: { ...rejected.error, retryable: false } })).toBe(false);
    expect(isRetryableOperationRejection("failed", rejected)).toBe(false);
    expect(isRetryableOperationRejection(undefined, undefined)).toBe(false);
  });
});
