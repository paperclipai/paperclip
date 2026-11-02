import { describe, expect, it } from "vitest";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";
import {
  CONTEXT_RESEED_KEY,
  CONTEXT_RESEED_MAX_ANCESTORS,
  CONTEXT_RESEED_MAX_DESCRIPTION_CHARS,
  CONTEXT_RESEED_NOTE,
  boundAncestors,
  boundContinuationSummary,
  boundIssueDescription,
  boundReseedInputs,
  buildContextReseedSnapshot,
  readContextReseedDirective,
} from "../services/context-reseed.js";

/**
 * TON-868: a context-window overflow used to be retried with the SAME
 * accumulated context, so the retry died identically - five failures, one
 * cause. The overflow now carries its own error code, and the retry is
 * marked as a RE-SEED: the next attempt rebuilds the prompt from a bounded
 * context instead of replaying the oversized one.
 *
 * These tests pin the contract that makes that work:
 *   - the re-seed directive is carried on the retry's context snapshot,
 *   - a re-seeded prompt is SMALLER than the original,
 *   - a normal (non-re-seed) attempt is untouched.
 */
describe("context re-seed directive", () => {
  it("round-trips through the context snapshot", () => {
    const snapshot = buildContextReseedSnapshot({ sourceRunId: "run-1", attempt: 2 });
    const directive = readContextReseedDirective(snapshot);
    expect(directive).toEqual({
      reason: "context_overflow",
      sourceRunId: "run-1",
      attempt: 2,
    });
    expect(snapshot[CONTEXT_RESEED_KEY]).toBeTruthy();
  });

  it("reads no directive from a normal run's context snapshot", () => {
    expect(readContextReseedDirective({ issueId: "issue-1" })).toBeNull();
    expect(readContextReseedDirective({})).toBeNull();
    expect(readContextReseedDirective(null)).toBeNull();
    expect(readContextReseedDirective(undefined)).toBeNull();
  });

  it("does not mistake an unrelated contextReseed value for a directive", () => {
    expect(readContextReseedDirective({ [CONTEXT_RESEED_KEY]: "yes" })).toBeNull();
  });
});

describe("bounded re-seed inputs", () => {
  const longDescription = "d".repeat(CONTEXT_RESEED_MAX_DESCRIPTION_CHARS * 3);
  const longSummary = "s".repeat(CONTEXT_RESEED_MAX_DESCRIPTION_CHARS * 3);
  const ancestors = Array.from({ length: 10 }, (_, index) => ({
    id: `ancestor-${index}`,
    identifier: `TON-${index}`,
    title: `Ancestor ${index}`,
    status: "done",
    priority: "normal",
  }));

  it("truncates an oversized issue description", () => {
    const bounded = boundIssueDescription(longDescription);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text!.length).toBe(CONTEXT_RESEED_MAX_DESCRIPTION_CHARS);
    expect(bounded.originalLength).toBe(longDescription.length);
  });

  it("leaves a short issue description untouched", () => {
    const bounded = boundIssueDescription("short");
    expect(bounded.truncated).toBe(false);
    expect(bounded.text).toBe("short");
  });

  it("bounds the continuation summary", () => {
    const bounded = boundContinuationSummary(longSummary);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text!.length).toBe(CONTEXT_RESEED_MAX_DESCRIPTION_CHARS);
  });

  it("keeps only the nearest ancestors", () => {
    const bounded = boundAncestors(ancestors);
    expect(bounded).toHaveLength(CONTEXT_RESEED_MAX_ANCESTORS);
    expect(bounded[0]).toBe(ancestors[0]);
  });

  it("reports truncation across all three inputs", () => {
    const bounded = boundReseedInputs({
      description: longDescription,
      ancestors,
      continuationSummaryBody: longSummary,
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.description!.length).toBeLessThan(longDescription.length);
    expect(bounded.continuationSummaryBody!.length).toBeLessThan(longSummary.length);
    expect(bounded.ancestors.length).toBeLessThan(ancestors.length);
  });

  it("does not report truncation for a small context", () => {
    const bounded = boundReseedInputs({
      description: "small",
      ancestors: ancestors.slice(0, 1),
      continuationSummaryBody: "small",
    });
    expect(bounded.truncated).toBe(false);
  });
});

describe("a re-seeded prompt is smaller than the original", () => {
  const issue = {
    id: "issue-1",
    identifier: "TON-868",
    title: "Split the 2013 overflow into its own error code",
    workMode: "standard",
    description: "d".repeat(CONTEXT_RESEED_MAX_DESCRIPTION_CHARS * 4),
  };
  const ancestors = Array.from({ length: 8 }, (_, index) => ({
    id: `ancestor-${index}`,
    identifier: `TON-${index}`,
    title: `Ancestor ${index}`,
    status: "done",
    priority: "normal",
  }));

  it("shrinks the task markdown", () => {
    const original = buildPaperclipTaskMarkdown({ issue, ancestors })!;
    const bounded = boundReseedInputs({
      description: issue.description,
      ancestors,
      continuationSummaryBody: null,
    });
    const reseeded = buildPaperclipTaskMarkdown({
      issue: { ...issue, description: bounded.description },
      ancestors: bounded.ancestors,
    })!;

    expect(reseeded.length).toBeLessThan(original.length);
  });

  it("tells the agent the context is partial", () => {
    const reseeded = `${buildPaperclipTaskMarkdown({ issue })}\n\n${CONTEXT_RESEED_NOTE}`;
    expect(reseeded).toContain("re-seeded after a context-window overflow");
    expect(reseeded).toContain("issue thread");
  });
});
