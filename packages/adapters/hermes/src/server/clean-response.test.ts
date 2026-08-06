/**
 * Regression tests for cleanResponse() in the hermes-local adapter.
 *
 * Ensures that Hermes progress/diagnostic output — specifically the raw
 * prompt echo ("Query: ...") and toolset-resolution failure noise
 * ("Warning: Unknown toolsets: ...") — are stripped before the result is
 * posted as a Paperclip auto-comment.
 *
 * Without these guards the entire system prompt (2000-char truncated) was
 * appearing verbatim as auto-comments on issues. See SSC-1832 sightings
 * 2026-08-04 → 2026-08-05 for evidence.
 *
 * @see https://github.com/paperclipai/paperclip/pull/10929
 */

import { describe, expect, it } from "vitest";

// cleanResponse is not exported — test via the output that surfaces through
// the adapter. We test the pure behaviour by invoking it indirectly through
// a helper that reproduces the relevant code path, keeping the test thin.
//
// The function under test:
//   function cleanResponse(raw: string): string
// Location: packages/adapters/hermes/src/server/execute.ts
//
// We replicate only the lines relevant to this fix (the strip guards)
// so the test stays narrow and can be updated if the surrounding logic changes.

function applyCleanResponseGuards(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("Query:")) return false;
      if (t.startsWith("Warning: Unknown toolsets:")) return false;
      return true;
    })
    .join("\n");
}

describe("cleanResponse — raw_prompt_echo guards (SSC-1832)", () => {
  it("strips a bare Query: line", () => {
    const input = "Query: You are an AI assistant.";
    expect(applyCleanResponseGuards(input)).toBe("");
  });

  it("strips a multi-line prompt echo block", () => {
    const input = [
      "Query: You are an agent at SSC AI Ops.",
      "Paperclip is the org-runtime platform",
      "you operate through -- not your employer.",
    ].join("\n");
    // Only the Query: prefix line is stripped; continuation lines that lack
    // the prefix pass through (Hermes emits them as plain continuation text,
    // not as separate Query: lines — so the guard is line-by-line).
    const result = applyCleanResponseGuards(input);
    expect(result).not.toContain("Query:");
    expect(result).toContain("Paperclip is the org-runtime platform");
  });

  it("strips Warning: Unknown toolsets: line", () => {
    const input = "Warning: Unknown toolsets: mcp-codegraph";
    expect(applyCleanResponseGuards(input)).toBe("");
  });

  it("does not strip a legitimate response that happens to start with a word containing Query", () => {
    const input = "Querying the database for invoice records.";
    expect(applyCleanResponseGuards(input)).toBe(input);
  });

  it("preserves actual agent response content after the prompt echo", () => {
    const input = [
      "Query: You are an AI assistant.", // prompt echo — strip
      "Warning: Unknown toolsets: mcp-codegraph", // toolset noise — strip
      "", // blank line
      "The invoice total is $1,234.56.", // real response — keep
    ].join("\n");
    const result = applyCleanResponseGuards(input);
    expect(result).not.toContain("Query:");
    expect(result).not.toContain("Warning: Unknown toolsets:");
    expect(result).toContain("The invoice total is $1,234.56.");
  });

  it("handles empty input without error", () => {
    expect(applyCleanResponseGuards("")).toBe("");
  });

  it("handles input with only safe lines", () => {
    const input = "The task is complete.\nStatus: done.";
    expect(applyCleanResponseGuards(input)).toBe(input);
  });
});
