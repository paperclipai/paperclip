import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  isPublishableRunSummary,
  mergeHeartbeatRunResultJson,
  readHeartbeatRunCommentCandidate,
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

  it("suppresses lone brace/bracket fragments from torn streams", () => {
    expect(buildHeartbeatRunIssueComment({ summary: "{" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "}" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "[" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "[{" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ result: "{" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ message: "[{" })).toBeNull();
  });

  it("suppresses pure whitespace/punctuation fragments", () => {
    expect(buildHeartbeatRunIssueComment({ summary: "..." })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "—" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "-- ~~ !!" })).toBeNull();
  });

  it("suppresses text that starts like JSON but fails to parse", () => {
    expect(buildHeartbeatRunIssueComment({ summary: '{"summary": "partial resu' })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: '[{"type": "text",' })).toBeNull();
  });

  // Fall-through is deliberate: a torn `summary` fragment must not shadow a
  // well-formed `result`/`message` candidate from the same payload.
  it("falls through to the next candidate when an earlier one is garbage", () => {
    expect(
      buildHeartbeatRunIssueComment({ summary: "{", result: "Recovered the deploy." }),
    ).toBe("Recovered the deploy.");
    expect(
      buildHeartbeatRunIssueComment({ summary: "[{", message: "completed" }),
    ).toBe("completed");
  });

  it("keeps legitimate short answers publishable", () => {
    expect(buildHeartbeatRunIssueComment({ summary: "Done." })).toBe("Done.");
    expect(buildHeartbeatRunIssueComment({ result: "OK — merged." })).toBe("OK — merged.");
  });
});

describe("isPublishableRunSummary", () => {
  it("rejects lone or unbalanced brace/bracket fragments", () => {
    expect(isPublishableRunSummary("{")).toBe(false);
    expect(isPublishableRunSummary("}")).toBe(false);
    expect(isPublishableRunSummary("[")).toBe(false);
    expect(isPublishableRunSummary("]")).toBe(false);
    expect(isPublishableRunSummary("[{")).toBe(false);
    expect(isPublishableRunSummary(" { ")).toBe(false);
  });

  it("rejects pure whitespace and punctuation", () => {
    expect(isPublishableRunSummary("")).toBe(false);
    expect(isPublishableRunSummary("   \n\t")).toBe(false);
    expect(isPublishableRunSummary("...")).toBe(false);
    expect(isPublishableRunSummary("—")).toBe(false);
    expect(isPublishableRunSummary("*** --- !!!")).toBe(false);
  });

  it("rejects text that starts like a JSON object/array but fails JSON.parse", () => {
    expect(isPublishableRunSummary('{"summary": "partial resu')).toBe(false);
    expect(isPublishableRunSummary('[{"type": "text", "text": "cut off')).toBe(false);
    expect(isPublishableRunSummary('{"a": 1,')).toBe(false);
  });

  // Decided behavior: a COMPLETE, parseable JSON object/array stays
  // publishable. The guard targets torn-stream structural garbage, not
  // adapters that legitimately return a JSON-shaped final summary; a complete
  // document is well-formed output, so publication policy stays unchanged.
  it("keeps complete, parseable JSON publishable", () => {
    expect(isPublishableRunSummary('{"summary": "done", "cost": 1.2}')).toBe(true);
    expect(isPublishableRunSummary('["step one", "step two"]')).toBe(true);
  });

  it("keeps short answers and real sentences publishable without a length floor", () => {
    expect(isPublishableRunSummary("Done.")).toBe(true);
    expect(isPublishableRunSummary("OK — merged.")).toBe(true);
    expect(isPublishableRunSummary("ok")).toBe(true);
    expect(isPublishableRunSummary("Fixed the deploy config and posted the issue update.")).toBe(true);
    expect(isPublishableRunSummary("## Summary\n\n- fixed deploy config")).toBe(true);
  });

  it("does not reject prose that merely contains braces mid-text", () => {
    expect(isPublishableRunSummary("All done { see notes below }")).toBe(true);
    expect(isPublishableRunSummary("Use `${VAR}` for interpolation.")).toBe(true);
  });
});

describe("readHeartbeatRunCommentCandidate", () => {
  it("returns the first non-empty candidate even when it is garbage", () => {
    expect(readHeartbeatRunCommentCandidate({ summary: "{" })).toBe("{");
    expect(readHeartbeatRunCommentCandidate({ result: "[{" })).toBe("[{");
    expect(readHeartbeatRunCommentCandidate({ summary: " ", message: "}" })).toBe("}");
  });

  it("returns null when no text candidate exists at all", () => {
    expect(readHeartbeatRunCommentCandidate(null)).toBeNull();
    expect(readHeartbeatRunCommentCandidate({})).toBeNull();
    expect(readHeartbeatRunCommentCandidate({ costUsd: 1.2 })).toBeNull();
    expect(readHeartbeatRunCommentCandidate({ summary: "   " })).toBeNull();
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
