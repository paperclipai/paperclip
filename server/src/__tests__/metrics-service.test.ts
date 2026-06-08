import { afterEach, describe, expect, it } from "vitest";
import {
  CONCURRENT_RUN_BLOCKED_METRIC,
  HEARTBEAT_RUN_FAILED_METRIC,
  KNOWN_BLOCKED_REASONS,
  KNOWN_INVOCATION_SOURCES,
  UNKNOWN_AGENT_ID,
  UNKNOWN_INVOCATION_SOURCE,
  UNKNOWN_REASON,
  __resetMetricsForTest,
  normalizeAgentId,
  normalizeInvocationSource,
  normalizeReason,
  recordConcurrentRunBlocked,
  recordHeartbeatRunFailed,
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

describe("normalizeInvocationSource", () => {
  it("keeps every known invocation source", () => {
    for (const source of KNOWN_INVOCATION_SOURCES) {
      expect(normalizeInvocationSource(source)).toBe(source);
    }
  });

  it("coerces unknown/empty sources to the bounded fallback", () => {
    expect(normalizeInvocationSource("totally_made_up")).toBe(UNKNOWN_INVOCATION_SOURCE);
    expect(normalizeInvocationSource("")).toBe(UNKNOWN_INVOCATION_SOURCE);
    expect(normalizeInvocationSource(undefined)).toBe(UNKNOWN_INVOCATION_SOURCE);
    expect(normalizeInvocationSource(null)).toBe(UNKNOWN_INVOCATION_SOURCE);
  });
});

describe("recordHeartbeatRunFailed + renderMetrics", () => {
  it("registers the counter so /metrics carries its TYPE line before any event", async () => {
    const { contentType, body } = await renderMetrics();
    expect(contentType).toContain("text/plain");
    expect(body).toContain(`# TYPE ${HEARTBEAT_RUN_FAILED_METRIC} counter`);
  });

  it("emits normalized labels for a known invocation source", async () => {
    const labels = recordHeartbeatRunFailed({
      adapter: "claude_k8s",
      errorCode: "adapter_failed",
      invocationSource: "github_pr_review_submitted",
    });
    expect(labels).toEqual({
      adapter: "claude_k8s",
      error_code: "adapter_failed",
      invocation_source: "github_pr_review_submitted",
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${HEARTBEAT_RUN_FAILED_METRIC}{adapter="claude_k8s",error_code="adapter_failed",invocation_source="github_pr_review_submitted"} 1`,
    );
  });

  it("collapses unknown invocation source to the bounded fallback (cardinality guardrail)", async () => {
    const labels = recordHeartbeatRunFailed({
      adapter: "claude_k8s",
      errorCode: "process_lost",
      invocationSource: "some_unlisted_source",
    });
    expect(labels.invocation_source).toBe(UNKNOWN_INVOCATION_SOURCE);

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${HEARTBEAT_RUN_FAILED_METRIC}{adapter="claude_k8s",error_code="process_lost",invocation_source="${UNKNOWN_INVOCATION_SOURCE}"} 1`,
    );
  });

  it("falls back adapter/error_code to 'unknown' when null or empty", async () => {
    const labels = recordHeartbeatRunFailed({
      adapter: null,
      errorCode: "",
      invocationSource: "capacity_blocked_retry",
    });
    expect(labels).toEqual({
      adapter: "unknown",
      error_code: "unknown",
      invocation_source: "capacity_blocked_retry",
    });
  });

  it("accumulates repeated failures into the same bounded series", async () => {
    recordHeartbeatRunFailed({ adapter: "claude_k8s", errorCode: "k8s_concurrent_run_blocked", invocationSource: "transient_failure_retry" });
    recordHeartbeatRunFailed({ adapter: "claude_k8s", errorCode: "k8s_concurrent_run_blocked", invocationSource: "transient_failure_retry" });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${HEARTBEAT_RUN_FAILED_METRIC}{adapter="claude_k8s",error_code="k8s_concurrent_run_blocked",invocation_source="transient_failure_retry"} 2`,
    );
  });
});
