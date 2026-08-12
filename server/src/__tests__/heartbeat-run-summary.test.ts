import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
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

  it("counts errors with type field by category", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "done",
      errors: [
        { type: "rate_limit_error", message: "Rate limit reached" },
        { type: "rate_limit_error", message: "Rate limit reached again" },
        { type: "overloaded_error", message: "Overloaded" },
      ],
    });
    expect(summary).not.toBeNull();
    expect(summary!.error_category_counts).toEqual({
      rate_limit_error: 2,
      overloaded_error: 1,
    });
  });

  it("counts string errors by classified category", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "done",
      errors: [
        "Rate limit exceeded for requests",
        "Authentication required",
        "Something unexpected happened",
        "Timed out waiting for response",
      ],
    });
    expect(summary).not.toBeNull();
    expect(summary!.error_category_counts).toEqual({
      rate_limit: 1,
      authentication: 1,
      unknown: 1,
      timeout: 1,
    });
  });

  it("includes errorFamily in category counts", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "done",
      errorFamily: "transient_upstream",
    });
    expect(summary).not.toBeNull();
    expect(summary!.error_category_counts).toEqual({
      transient_upstream: 1,
    });
  });

  it("combines errors array and errorFamily", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "done",
      errors: [
        { type: "rate_limit_error", message: "Rate limited" },
        { type: "overloaded_error", message: "Overloaded" },
      ],
      errorFamily: "transient_upstream",
    });
    expect(summary).not.toBeNull();
    expect(summary!.error_category_counts).toEqual({
      rate_limit_error: 1,
      overloaded_error: 1,
      transient_upstream: 1,
    });
  });

  it("uses category field as fallback for typed errors", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "done",
      errors: [{ category: "api_error", message: "Something broke" }],
    });
    expect(summary).not.toBeNull();
    expect(summary!.error_category_counts).toEqual({
      api_error: 1,
    });
  });

  it("omits error_category_counts when no errors or errorFamily", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "all good",
    });
    expect(summary).not.toBeNull();
    expect(summary).not.toHaveProperty("error_category_counts");
  });

  it("skips empty string errors", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "done",
      errors: ["", "   ", { type: "rate_limit_error", message: "limited" }],
    });
    expect(summary).not.toBeNull();
    expect(summary!.error_category_counts).toEqual({
      rate_limit_error: 1,
    });
  });

  it("skips null and non-object/non-string error entries", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "done",
      errors: [null, 42, true, { type: "permission_error", message: "Forbidden" }],
    });
    expect(summary).not.toBeNull();
    expect(summary!.error_category_counts).toEqual({
      permission_error: 1,
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
    expect(buildHeartbeatRunIssueComment(merged)).toBe(
      "## Summary\n\n1. first thing\n2. second thing",
    );
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
    ).toEqual({ summary: "adapter result", stdout: "raw stdout" });
  });
});
