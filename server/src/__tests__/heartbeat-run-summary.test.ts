import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  mergeHeartbeatRunResultJson,
  MAX_FALLBACK_COMMENT_CHARS,
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

  it("suppresses raw transcript when the summary reads like inter-tool narration", () => {
    const narration =
      "Let me check the issue thread first. I'll fetch the latest comments and then decide what to do next.";
    const comment = buildHeartbeatRunIssueComment({ summary: narration });

    expect(comment).not.toContain("Let me check");
    expect(comment).toContain("did not post a summary comment");
  });

  it("suppresses each narration opener variant", () => {
    for (const opener of [
      "Let me look into this.",
      "I'll start by reading the file.",
      "I need to inspect the config.",
      "I can see the problem now.",
      "Looking at the logs, the error is clear.",
      "Fetching the run details from the API.",
      "Checking the current branch state.",
      "First, I will reproduce the bug.",
      "I’m going to trace the fallback path.",
      "Now I'll push the follow-up commit.",
      "Next, I'll re-run the suite.",
    ]) {
      expect(buildHeartbeatRunIssueComment({ summary: opener })).toContain(
        "did not post a summary comment",
      );
    }
  });

  it("does not treat the apostrophe opener as a regex wildcard", () => {
    // Prior regex used `i.ll` where `.` matched any char; these must pass through.
    for (const summary of ["Iall greetings logged.", "I-ll formatting kept."]) {
      expect(buildHeartbeatRunIssueComment({ summary })).toBe(summary);
    }
  });

  // BRO-2310. Length and narration were one branch, and they are different problems.
  //
  // Narration is unusable at any length — BRO-1507/1516 withheld it for content, correctly.
  // Length is not a content judgement. A long, declarative status report is exactly what a
  // productive run produces, and discarding it told the board the agent had reported nothing.
  //
  // Real case: BRO-2300 ended four runs with a 2214-character status beginning "Status:
  // assets ready for CEO QC; branch committed locally, pending push to open PR", followed by
  // a file manifest. It was declarative, correct, and the only record of finished work. Each
  // run replaced it with "did not post a summary comment", so the disposition check saw
  // nothing, moved the issue to `missing_disposition`, and blocked it on a recovery owner
  // that was the same stalled agent. The work stayed invisible for five hours.
  //
  // Truncation keeps the front of the message, which is where a status report puts its
  // conclusion, and points at the run log for the rest.
  it("truncates an over-long summary instead of discarding it", () => {
    const summary = "Status: done. " + "x".repeat(2000);
    const comment = buildHeartbeatRunIssueComment({ summary });

    expect(comment).not.toBeNull();
    expect(comment).toContain("Status: done.");
    expect(comment).not.toContain("did not post a summary comment");
  });

  it("marks a truncated summary as truncated and points at the run log", () => {
    const comment = buildHeartbeatRunIssueComment({ summary: "Status: done. " + "x".repeat(2000) });

    expect(comment).toContain("truncated");
    expect(comment).toContain("run log");
  });

  it("keeps a truncated summary within the character budget", () => {
    const comment = buildHeartbeatRunIssueComment({ summary: "Status: done. " + "x".repeat(9000) });

    // The marker is allowed on top of the cap; the body it carries is not.
    expect(comment!.length).toBeLessThanOrEqual(MAX_FALLBACK_COMMENT_CHARS + 200);
  });

  it("still withholds narration outright, however long it is", () => {
    // The narration branch is unchanged: content, not length, decides it.
    const comment = buildHeartbeatRunIssueComment({ summary: "Let me check the thread. " + "y".repeat(2000) });

    expect(comment).toContain("did not post a summary comment");
    expect(comment).not.toContain("yyyy");
  });

  it("posts a clean, in-length summary with no narration opener normally", () => {
    const summary = "## Summary\n\n- fixed the fallback gate\n- added regression tests";
    expect(buildHeartbeatRunIssueComment({ summary })).toBe(summary);
  });

  it("posts a summary exactly at the length cap", () => {
    const summary = "S" + "x".repeat(1199);
    expect(summary.length).toBe(1200);
    expect(buildHeartbeatRunIssueComment({ summary })).toBe(summary);
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

  it("posts only the final adapter summary when raw output contains intermediate narration", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "Intermediate setup that must not be published" },
      "## Final update\n\n- Remediation verified",
    );

    expect(buildHeartbeatRunIssueComment(merged)).toBe(
      "## Final update\n\n- Remediation verified",
    );
    expect(buildHeartbeatRunIssueComment(merged)).not.toContain("Intermediate setup");
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
