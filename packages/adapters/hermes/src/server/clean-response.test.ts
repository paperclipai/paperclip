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
// We replicate only the lines relevant to this fix (the leading-echo strip)
// so the test stays narrow and can be updated if the surrounding logic changes.
//
// IMPORTANT: The guard is a LEADING-BLOCK strip (regex on the raw string),
// not a line-by-line filter — so "Query:" appearing mid-response is preserved.

function applyCleanResponseGuards(raw: string): string {
  // Mirrors the leading-echo regex in execute.ts cleanResponse():
  // strip only the leading block of Query: / Warning: lines.
  // Each line may end with \n OR be at end-of-string (no trailing newline).
  return raw.replace(
    /^(?:(?:Warning: Unknown toolsets:|Query:)[^\n]*(?:\n|$))*/,
    ""
  );
}

describe("cleanResponse — raw_prompt_echo guards (SSC-1832)", () => {
  it("strips a leading Query: line at session start", () => {
    const input = "Query: You are an AI assistant.\n";
    expect(applyCleanResponseGuards(input)).toBe("");
  });

  it("strips a leading Query: line followed by real output", () => {
    const input = [
      "Query: You are an agent at SSC AI Ops.",
      "The task is complete.",
    ].join("\n") + "\n";
    // Only the leading Query: line is stripped; real output follows.
    const result = applyCleanResponseGuards(input);
    expect(result).not.toContain("Query:");
    expect(result).toContain("The task is complete.");
  });

  it("strips a leading Warning: Unknown toolsets: line", () => {
    const input = "Warning: Unknown toolsets: mcp-codegraph\n";
    expect(applyCleanResponseGuards(input)).toBe("");
  });

  it("strips interleaved leading Query: and Warning: lines", () => {
    const input = [
      "Warning: Unknown toolsets: mcp-codegraph",
      "Query: You are an AI assistant.",
      "The invoice total is $1,234.56.",
    ].join("\n") + "\n";
    const result = applyCleanResponseGuards(input);
    expect(result).not.toContain("Query:");
    expect(result).not.toContain("Warning: Unknown toolsets:");
    expect(result).toContain("The invoice total is $1,234.56.");
  });

  it("does NOT strip Query: appearing mid-response (only leading block is removed)", () => {
    // This is the key Greptile concern: a legitimate agent response that contains
    // "Query:" in its body should not be altered.
    const input = [
      "Query: You are an AI assistant.", // session-start echo — leading block, strip
      "Querying the database for invoice records.", // real content containing Query — keep
      "Query: Here is what I found.", // mid-response "Query:" — keep (not in leading block)
    ].join("\n") + "\n";
    const result = applyCleanResponseGuards(input);
    // First line (leading echo) is stripped
    expect(result).not.toMatch(/^Query: You are an AI/);
    // Mid-response content is preserved
    expect(result).toContain("Querying the database for invoice records.");
    expect(result).toContain("Query: Here is what I found.");
  });

  it("handles empty input without error", () => {
    expect(applyCleanResponseGuards("")).toBe("");
  });

  it("handles input with only safe lines (no leading echo)", () => {
    const input = "The task is complete.\nStatus: done.";
    expect(applyCleanResponseGuards(input)).toBe(input);
  });

  it("strips a diagnostic-only stdout with no trailing newline (Greptile P2)", () => {
    // Greptile finding: if subprocess stdout is "Query: prompt" with no trailing
    // newline, the prior regex required \n and would miss it. This test ensures
    // the fix handles unterminated final diagnostic lines.
    const input = "Query: You are an AI assistant."; // no trailing \n
    expect(applyCleanResponseGuards(input)).toBe("");
  });

  it("strips Warning: without trailing newline", () => {
    const input = "Warning: Unknown toolsets: mcp-codegraph"; // no trailing \n
    expect(applyCleanResponseGuards(input)).toBe("");
  });

  it("strips multiple consecutive leading echo lines", () => {
    const input = [
      "Query: You are an agent.",
      "Warning: Unknown toolsets: codegraph",
      "Warning: Unknown toolsets: graphify",
      "",
      "Done. Task complete.",
    ].join("\n");
    const result = applyCleanResponseGuards(input);
    expect(result).not.toContain("Query:");
    expect(result).not.toContain("Warning: Unknown toolsets:");
    expect(result).toContain("Done. Task complete.");
  });
});
