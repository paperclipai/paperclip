import { describe, expect, it } from "vitest";
import { normalizeHeartbeatRunId } from "../heartbeat-run-id.js";

describe("normalizeHeartbeatRunId", () => {
  it("returns null for non-string values", () => {
    expect(normalizeHeartbeatRunId(undefined)).toBeNull();
    expect(normalizeHeartbeatRunId(null)).toBeNull();
  });

  it("returns null for empty or whitespace values", () => {
    expect(normalizeHeartbeatRunId("")).toBeNull();
    expect(normalizeHeartbeatRunId("   ")).toBeNull();
  });

  it("returns null for malformed UUID values", () => {
    expect(normalizeHeartbeatRunId("not-a-run-id")).toBeNull();
    expect(normalizeHeartbeatRunId("run-1")).toBeNull();
  });

  it("returns trimmed lowercase UUID values", () => {
    expect(normalizeHeartbeatRunId(" 11111111-1111-4111-8111-111111111111 ")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(normalizeHeartbeatRunId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
