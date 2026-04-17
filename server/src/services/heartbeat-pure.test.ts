import { describe, it, expect } from "vitest";
import {
  compactRunLogChunk,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
  formatRuntimeWorkspaceWarningLog,
} from "./heartbeat.js";

// ---------------------------------------------------------------------------
// compactRunLogChunk
// ---------------------------------------------------------------------------

describe("compactRunLogChunk", () => {
  it("returns the chunk unchanged when it fits within maxChars", () => {
    expect(compactRunLogChunk("hello world", 100)).toBe("hello world");
  });

  it("truncates the chunk when it exceeds maxChars", () => {
    const long = "a".repeat(1000);
    const result = compactRunLogChunk(long, 100);
    expect(result).toContain("[paperclip truncated run log chunk:");
    expect(result.length).toBeLessThan(long.length);
  });

  it("preserves head and tail portions when truncating", () => {
    const head = "HEAD_DATA";
    const middle = "x".repeat(200);
    const tail = "TAIL_DATA";
    const result = compactRunLogChunk(`${head}${middle}${tail}`, 50);
    expect(result).toContain("HEAD_DATA");
    expect(result).toContain("TAIL_DATA");
  });

  it("mentions the number of omitted chars in the truncation marker", () => {
    const long = "x".repeat(1000);
    const result = compactRunLogChunk(long, 100);
    expect(result).toMatch(/omitted \d+ chars/);
  });

  it("uses the default maxChars when not provided", () => {
    const short = "small";
    expect(compactRunLogChunk(short)).toBe(short);
  });

  it("redacts base64 image data embedded in the chunk", () => {
    const base64Data = "A".repeat(1024);
    const withBase64 = `{"type":"image","source":{"type":"base64","data":"${base64Data}"}}`;
    const result = compactRunLogChunk(withBase64, 100000);
    expect(result).toContain("[omitted base64 image data:");
  });
});

// ---------------------------------------------------------------------------
// summarizeHeartbeatRunContextSnapshot
// ---------------------------------------------------------------------------

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("returns null for null input", () => {
    expect(summarizeHeartbeatRunContextSnapshot(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(summarizeHeartbeatRunContextSnapshot(undefined)).toBeNull();
  });

  it("returns null when no recognized keys have non-empty string values", () => {
    expect(summarizeHeartbeatRunContextSnapshot({ unknownKey: "value" })).toBeNull();
  });

  it("includes issueId when present and non-empty", () => {
    const result = summarizeHeartbeatRunContextSnapshot({ issueId: "issue-123" });
    expect(result?.issueId).toBe("issue-123");
  });

  it("includes wakeReason when present", () => {
    const result = summarizeHeartbeatRunContextSnapshot({ wakeReason: "comment_added" });
    expect(result?.wakeReason).toBe("comment_added");
  });

  it("omits keys with empty or whitespace values", () => {
    const result = summarizeHeartbeatRunContextSnapshot({ issueId: "id-1", commentId: "" });
    expect(result?.commentId).toBeUndefined();
  });

  it("returns only the recognized keys (omits unknown keys)", () => {
    const result = summarizeHeartbeatRunContextSnapshot({ issueId: "id-1", randomKey: "value" });
    expect(result).not.toHaveProperty("randomKey");
    expect(result?.issueId).toBe("id-1");
  });

  it("includes multiple recognized keys when all are present", () => {
    const result = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      wakeReason: "wake",
      wakeSource: "api",
    });
    expect(result?.issueId).toBe("issue-1");
    expect(result?.wakeReason).toBe("wake");
    expect(result?.wakeSource).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// summarizeHeartbeatRunListResultJson
// ---------------------------------------------------------------------------

describe("summarizeHeartbeatRunListResultJson", () => {
  it("returns null when all inputs are null/empty", () => {
    expect(summarizeHeartbeatRunListResultJson({})).toBeNull();
  });

  it("includes summary when provided", () => {
    const result = summarizeHeartbeatRunListResultJson({ summary: "done" });
    expect(result?.summary).toBe("done");
  });

  it("includes result when provided", () => {
    const result = summarizeHeartbeatRunListResultJson({ result: "ok" });
    expect(result?.result).toBe("ok");
  });

  it("includes message and error when provided", () => {
    const result = summarizeHeartbeatRunListResultJson({
      message: "hello",
      error: "oops",
    });
    expect(result?.message).toBe("hello");
    expect(result?.error).toBe("oops");
  });

  it("parses totalCostUsd as a number when provided as a parseable string", () => {
    const result = summarizeHeartbeatRunListResultJson({ totalCostUsd: "1.23" });
    expect(result?.total_cost_usd).toBe(1.23);
  });

  it("omits cost fields when the string is not a valid number", () => {
    const result = summarizeHeartbeatRunListResultJson({
      summary: "done",
      totalCostUsd: "not-a-number",
    });
    expect(result).not.toHaveProperty("total_cost_usd");
  });

  it("omits null/empty text fields", () => {
    const result = summarizeHeartbeatRunListResultJson({
      summary: null,
      result: "",
      message: "hello",
    });
    expect(result).not.toHaveProperty("summary");
    expect(result).not.toHaveProperty("result");
    expect(result?.message).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// formatRuntimeWorkspaceWarningLog
// ---------------------------------------------------------------------------

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("returns an object with stream 'stdout' and the formatted chunk", () => {
    const result = formatRuntimeWorkspaceWarningLog("workspace not ready");
    expect(result.stream).toBe("stdout");
    expect(result.chunk).toContain("[paperclip]");
    expect(result.chunk).toContain("workspace not ready");
  });

  it("appends a newline to the chunk", () => {
    const result = formatRuntimeWorkspaceWarningLog("test");
    expect(result.chunk.endsWith("\n")).toBe(true);
  });
});
