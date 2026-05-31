import { afterEach, describe, expect, it } from "vitest";
import {
  CONCURRENT_RUN_BLOCKED_METRIC,
  KNOWN_BLOCKED_REASONS,
  UNKNOWN_AGENT_ID,
  UNKNOWN_REASON,
  __resetMetricsForTest,
  normalizeAgentId,
  normalizeReason,
  recordConcurrentRunBlocked,
  renderMetrics,
} from "../services/metrics.js";

afterEach(() => {
  __resetMetricsForTest();
});

describe("normalizeReason", () => {
  it("keeps every known reason", () => {
    for (const reason of KNOWN_BLOCKED_REASONS) {
      expect(normalizeReason(reason)).toBe(reason);
    }
  });

  it("coerces unknown/empty reasons to the bounded fallback", () => {
    expect(normalizeReason("totally_made_up")).toBe(UNKNOWN_REASON);
    expect(normalizeReason("")).toBe(UNKNOWN_REASON);
    expect(normalizeReason(undefined)).toBe(UNKNOWN_REASON);
    expect(normalizeReason(null)).toBe(UNKNOWN_REASON);
  });
});

describe("normalizeAgentId", () => {
  const roster = new Set(["agent-a", "agent-b"]);

  it("keeps ids that are in the active roster", () => {
    expect(normalizeAgentId("agent-a", roster)).toBe("agent-a");
    expect(normalizeAgentId("agent-b", roster)).toBe("agent-b");
  });

  it("coerces ids outside the roster (or empty) to unknown", () => {
    expect(normalizeAgentId("agent-z", roster)).toBe(UNKNOWN_AGENT_ID);
    expect(normalizeAgentId("", roster)).toBe(UNKNOWN_AGENT_ID);
    expect(normalizeAgentId(undefined, roster)).toBe(UNKNOWN_AGENT_ID);
    expect(normalizeAgentId(null, roster)).toBe(UNKNOWN_AGENT_ID);
    // Empty roster => nothing is known => everything collapses.
    expect(normalizeAgentId("agent-a", new Set())).toBe(UNKNOWN_AGENT_ID);
  });
});

describe("recordConcurrentRunBlocked + renderMetrics", () => {
  it("registers the counter so /metrics carries its TYPE line before any event", async () => {
    const { contentType, body } = await renderMetrics();
    expect(contentType).toContain("text/plain");
    expect(body).toContain(`# TYPE ${CONCURRENT_RUN_BLOCKED_METRIC} counter`);
  });

  it("emits the real agent_id for a roster member", async () => {
    const labels = recordConcurrentRunBlocked({
      agentId: "agent-a",
      reason: "live_job_for_unknown_run",
      knownAgentIds: new Set(["agent-a"]),
    });
    expect(labels).toEqual({ agent_id: "agent-a", reason: "live_job_for_unknown_run" });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_unknown_run"} 1`,
    );
  });

  it("collapses an unknown agent id and unknown reason (cardinality guardrail)", async () => {
    const labels = recordConcurrentRunBlocked({
      agentId: "spoofed-or-typo",
      reason: "garbage",
      knownAgentIds: new Set(["agent-a"]),
    });
    expect(labels).toEqual({ agent_id: UNKNOWN_AGENT_ID, reason: UNKNOWN_REASON });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",reason="${UNKNOWN_REASON}"} 1`,
    );
  });

  it("accumulates repeated events into the same bounded series", async () => {
    const roster = new Set(["agent-a"]);
    recordConcurrentRunBlocked({ agentId: "agent-a", reason: "live_job_for_active_run", knownAgentIds: roster });
    recordConcurrentRunBlocked({ agentId: "agent-a", reason: "live_job_for_active_run", knownAgentIds: roster });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_active_run"} 2`,
    );
  });
});
