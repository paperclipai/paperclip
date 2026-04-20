import { describe, expect, it } from "vitest";
import {
  assignmentToCheckoutLatencyMs,
  buildStaleHandoffGuardrailComment,
  isStaleHandoffLatency,
  STALE_HANDOFF_THRESHOLD_MS,
} from "../routes/issues-handoff-guardrails.js";

describe("issues handoff guardrails", () => {
  it("calculates assignment->checkout latency in milliseconds", () => {
    const createdAt = new Date("2026-04-10T13:29:47.352Z");
    const startedAt = new Date("2026-04-10T13:30:25.308Z");
    expect(assignmentToCheckoutLatencyMs({ createdAt, startedAt })).toBe(37_956);
  });

  it("flags stale handoffs above threshold", () => {
    expect(isStaleHandoffLatency(37_956, STALE_HANDOFF_THRESHOLD_MS)).toBe(true);
    expect(isStaleHandoffLatency(5_000, STALE_HANDOFF_THRESHOLD_MS)).toBe(false);
  });

  it("renders a deterministic guardrail comment body", () => {
    const body = buildStaleHandoffGuardrailComment({
      issueIdentifier: "SHAAA-46",
      latencyMs: 37_956,
      thresholdMs: STALE_HANDOFF_THRESHOLD_MS,
    });

    expect(body).toContain("Guardrail Alert: Stale Handoff Detected");
    expect(body).toContain("Issue SHAAA-46 crossed assignment->checkout latency threshold.");
    expect(body).toContain("Assignment->checkout latency: 37.956s");
  });
});
