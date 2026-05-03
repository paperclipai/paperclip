import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  summarizeHeartbeatRunUsageJson,
  buildHeartbeatRunIssueComment,
  mergeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("summarizeHeartbeatRunUsageJson", () => {
  it("keeps compact usage fields and drops unrelated payloads", () => {
    const summary = summarizeHeartbeatRunUsageJson({
      input_tokens: 10,
      outputTokens: 20,
      cache_read_input_tokens: 30,
      billing_type: "metered",
      total_cost_usd: 0.12,
      provider: "anthropic",
      model: "claude",
      biller: "metered",
      rawPayload: "x".repeat(10_000),
    });

    expect(summary).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 30,
      billingType: "metered",
      costUsd: 0.12,
      provider: "anthropic",
      model: "claude",
      biller: "metered",
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunUsageJson(null)).toBeNull();
    expect(summarizeHeartbeatRunUsageJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunUsageJson({ raw: { only: "ignored" } })).toBeNull();
  });

  it("drops non-numeric token and cost fields", () => {
    expect(summarizeHeartbeatRunUsageJson({
      inputTokens: true,
      input_tokens: 10,
      outputTokens: "20",
      output_tokens: 30,
      costUsd: false,
      total_cost_usd: 0.42,
      provider: "anthropic",
    })).toEqual({
      inputTokens: 10,
      outputTokens: 30,
      totalTokens: 40,
      costUsd: 0.42,
      provider: "anthropic",
    });
  });

  it("computes total tokens from input and output tokens only", () => {
    expect(summarizeHeartbeatRunUsageJson({
      inputTokens: 2,
      outputTokens: 5,
      cachedInputTokens: 99,
    })).toEqual({
      inputTokens: 2,
      outputTokens: 5,
      totalTokens: 7,
      cachedInputTokens: 99,
    });
  });

  it("drops blank usage string fields", () => {
    expect(summarizeHeartbeatRunUsageJson({
      provider: "  ",
      model: "\n",
      biller: "test-biller",
    })).toEqual({
      biller: "test-biller",
    });
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });
});
