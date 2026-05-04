import { describe, expect, it } from "vitest";
import {
  CONTINUATION_CHUNK_MAX_BYTES,
  CONTINUATION_WORKSPACE_TOTAL_MAX_BYTES,
  ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS,
  assembleContinuationSummaryBody,
  buildContinuationSummaryMarkdown,
} from "../services/issue-continuation-summary.js";

describe("issue continuation summaries", () => {
  it("builds bounded issue-local handoff context with required sections", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: [
          "## Objective",
          "",
          "Keep work resumable after adapter session reset.",
          "",
          "## Acceptance Criteria",
          "",
          "- Summary is issue-local",
          "- Wake context includes the summary",
        ].join("\n"),
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-1",
        status: "succeeded",
        error: null,
        resultJson: {
          summary: "Updated server/src/services/heartbeat.ts and packages/adapter-utils/src/server-utils.ts.",
        },
        stdoutExcerpt: null,
        stderrExcerpt: null,
        finishedAt: new Date("2026-04-18T12:00:00.000Z"),
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("# Continuation Summary");
    expect(body).toContain("## Objective");
    expect(body).toContain("Keep work resumable after adapter session reset.");
    expect(body).toContain("## Acceptance Criteria");
    expect(body).toContain("- Summary is issue-local");
    expect(body).toContain("## Recent Concrete Actions");
    expect(body).toContain("Run `run-1` finished with status `succeeded`");
    expect(body).toContain("`server/src/services/heartbeat.ts`");
    expect(body).toContain("## Commands Run");
    expect(body).toContain("## Blockers / Decisions");
    expect(body).toContain("## Next Action");
    expect(body.length).toBeLessThanOrEqual(ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
  });

  it("uses failure state to point the next run at the error", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-2",
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        resultJson: null,
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("Latest run error (adapter_failed): adapter failed");
    expect(body).toContain("Inspect the failed run, fix the cause");
  });
});

describe("assembleContinuationSummaryBody", () => {
  it("returns the chunk unchanged when it is under the 30KB ceiling", () => {
    const newChunk = "# Continuation Summary\n\nSmall chunk.";
    const { body, chunkTruncated, workspaceTruncated } = assembleContinuationSummaryBody({
      newChunk,
      existingBody: null,
    });
    expect(body).toBe(newChunk);
    expect(chunkTruncated).toBe(false);
    expect(workspaceTruncated).toBe(false);
  });

  it("truncates a chunk that exceeds 30KB and appends the spec truncation marker", () => {
    const bigChunk = "x".repeat(CONTINUATION_CHUNK_MAX_BYTES + 500);
    const { body, chunkTruncated } = assembleContinuationSummaryBody({
      newChunk: bigChunk,
      existingBody: null,
    });
    expect(chunkTruncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(CONTINUATION_CHUNK_MAX_BYTES);
    expect(body).toContain("[TRUNCATED — continuation context exceeded safe threshold at");
    expect(body).toContain("Run context was reset.]");
  });

  it("prepends the new chunk to the existing body", () => {
    const newChunk = "# New Run";
    const existingBody = "# Old Run";
    const { body } = assembleContinuationSummaryBody({ newChunk, existingBody });
    expect(body.indexOf("# New Run")).toBeLessThan(body.indexOf("# Old Run"));
  });

  it("rolls off oldest summaries when workspace total exceeds 500KB", () => {
    const chunkSize = 10 * 1024; // 10KB each
    const chunk = "A".repeat(chunkSize);
    // Build an accumulated body just over 500KB
    const repetitions = Math.ceil(CONTINUATION_WORKSPACE_TOTAL_MAX_BYTES / chunkSize) + 1;
    const bigExisting = Array(repetitions).fill(chunk).join("\n\n---\n\n");

    const { body, workspaceTruncated } = assembleContinuationSummaryBody({
      newChunk: chunk,
      existingBody: bigExisting,
    });

    expect(workspaceTruncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(CONTINUATION_WORKSPACE_TOTAL_MAX_BYTES + 200);
    expect(body).toContain("[Oldest continuation summaries removed — workspace ceiling exceeded.]");
  });

  it("does not truncate normal runs under both thresholds", () => {
    const normalChunk = "# Continuation Summary\n\n- Item 1\n- Item 2\n";
    const smallExisting = "# Previous Summary\n\n- Prior item\n";
    const { body, chunkTruncated, workspaceTruncated } = assembleContinuationSummaryBody({
      newChunk: normalChunk,
      existingBody: smallExisting,
    });
    expect(chunkTruncated).toBe(false);
    expect(workspaceTruncated).toBe(false);
    expect(body).toContain("# Continuation Summary");
    expect(body).toContain("# Previous Summary");
  });
});
