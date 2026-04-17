import { describe, it, expect } from "vitest";
import {
  mergeHeartbeatRunResultJson,
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS,
} from "./heartbeat-run-summary.js";

// ---------------------------------------------------------------------------
// mergeHeartbeatRunResultJson
// ---------------------------------------------------------------------------

describe("mergeHeartbeatRunResultJson", () => {
  it("returns null when both resultJson and summary are null", () => {
    expect(mergeHeartbeatRunResultJson(null, null)).toBeNull();
  });

  it("returns null when resultJson is null and summary is empty string", () => {
    expect(mergeHeartbeatRunResultJson(null, "")).toBeNull();
  });

  it("returns null when resultJson is null and summary is whitespace only", () => {
    expect(mergeHeartbeatRunResultJson(null, "   ")).toBeNull();
  });

  it("returns { summary } when resultJson is null and summary is a non-empty string", () => {
    expect(mergeHeartbeatRunResultJson(null, "done!")).toEqual({ summary: "done!" });
  });

  it("returns the base result unchanged when summary is null", () => {
    const base = { status: "ok", count: 3 };
    expect(mergeHeartbeatRunResultJson(base, null)).toEqual(base);
  });

  it("returns the base result unchanged when it already has a summary", () => {
    const base = { summary: "existing summary", extra: true };
    const result = mergeHeartbeatRunResultJson(base, "new summary");
    expect(result?.summary).toBe("existing summary");
  });

  it("injects the summary when resultJson has no summary field", () => {
    const base = { status: "ok" };
    const result = mergeHeartbeatRunResultJson(base, "injected");
    expect(result?.summary).toBe("injected");
    expect(result?.status).toBe("ok");
  });

  it("treats a whitespace-only existing summary as absent and injects the new one", () => {
    const base = { summary: "   " };
    const result = mergeHeartbeatRunResultJson(base, "replacement");
    expect(result?.summary).toBe("replacement");
  });

  it("returns null when resultJson is an array", () => {
    expect(mergeHeartbeatRunResultJson(["a"] as unknown as Record<string, unknown>, "s")).toEqual({ summary: "s" });
  });
});

// ---------------------------------------------------------------------------
// summarizeHeartbeatRunResultJson
// ---------------------------------------------------------------------------

describe("summarizeHeartbeatRunResultJson", () => {
  it("returns null for null input", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
  });

  it("returns null for an array input", () => {
    expect(summarizeHeartbeatRunResultJson([] as unknown as Record<string, unknown>)).toBeNull();
  });

  it("returns null when no recognized fields are present", () => {
    expect(summarizeHeartbeatRunResultJson({ other: "value" })).toBeNull();
  });

  it("includes the summary field when present", () => {
    const result = summarizeHeartbeatRunResultJson({ summary: "done" });
    expect(result?.summary).toBe("done");
  });

  it("includes the result field when present", () => {
    const result = summarizeHeartbeatRunResultJson({ result: "ok" });
    expect(result?.result).toBe("ok");
  });

  it("includes the message field when present", () => {
    const result = summarizeHeartbeatRunResultJson({ message: "hello" });
    expect(result?.message).toBe("hello");
  });

  it("includes the error field when present", () => {
    const result = summarizeHeartbeatRunResultJson({ error: "oops" });
    expect(result?.error).toBe("oops");
  });

  it("includes cost_usd numeric field", () => {
    const result = summarizeHeartbeatRunResultJson({ cost_usd: 0.05 });
    expect(result?.cost_usd).toBe(0.05);
  });

  it("includes total_cost_usd numeric field", () => {
    const result = summarizeHeartbeatRunResultJson({ total_cost_usd: 1.2 });
    expect(result?.total_cost_usd).toBe(1.2);
  });

  it("includes costUsd numeric field", () => {
    const result = summarizeHeartbeatRunResultJson({ costUsd: 0.001 });
    expect(result?.costUsd).toBe(0.001);
  });

  it("truncates summary text to HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS", () => {
    const long = "x".repeat(HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS + 10);
    const result = summarizeHeartbeatRunResultJson({ summary: long });
    expect(typeof result?.summary).toBe("string");
    expect((result?.summary as string).length).toBe(HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS);
  });

  it("omits unrecognized fields from the output", () => {
    const result = summarizeHeartbeatRunResultJson({ summary: "ok", irrelevant: "field" });
    expect(result).not.toHaveProperty("irrelevant");
  });

  it("omits a numeric field when its value is null", () => {
    const result = summarizeHeartbeatRunResultJson({ cost_usd: null });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHeartbeatRunIssueComment
// ---------------------------------------------------------------------------

describe("buildHeartbeatRunIssueComment", () => {
  it("returns null for null input", () => {
    expect(buildHeartbeatRunIssueComment(null)).toBeNull();
  });

  it("returns null for an array input", () => {
    expect(buildHeartbeatRunIssueComment([] as unknown as Record<string, unknown>)).toBeNull();
  });

  it("returns null when no recognized text fields are present", () => {
    expect(buildHeartbeatRunIssueComment({ cost_usd: 1 })).toBeNull();
  });

  it("returns the summary field when present and non-empty", () => {
    expect(buildHeartbeatRunIssueComment({ summary: "  done  " })).toBe("done");
  });

  it("falls back to result when summary is absent", () => {
    expect(buildHeartbeatRunIssueComment({ result: "ok" })).toBe("ok");
  });

  it("falls back to message when summary and result are absent", () => {
    expect(buildHeartbeatRunIssueComment({ message: "hi" })).toBe("hi");
  });

  it("prefers summary over result and message", () => {
    const result = buildHeartbeatRunIssueComment({
      summary: "summary text",
      result: "result text",
      message: "message text",
    });
    expect(result).toBe("summary text");
  });

  it("returns null when all text fields are whitespace-only", () => {
    expect(buildHeartbeatRunIssueComment({ summary: "   ", result: " " })).toBeNull();
  });
});
