import { describe, expect, it } from "vitest";
import {
  PARSE_REVIEW_VERDICT_MAX_BODY_BYTES,
  parseReviewVerdict,
} from "../services/productivity-review.js";

function makeLargeBody(minBytes: number): string {
  const line = "This is filler text to exceed the body size limit. ".repeat(10);
  const count = Math.ceil(minBytes / line.length) + 1;
  return line.repeat(count);
}

describe("parseReviewVerdict", () => {
  // ---------------------------------------------------------------------------
  // Positive cases: should satisfy PC-3 (high or medium confidence)
  // ---------------------------------------------------------------------------

  it("detects **APPROVE** with structured AC table", () => {
    const body = [
      "## Code Review",
      "",
      "**APPROVE**",
      "",
      "| # | Criterion | Result |",
      "|---|-----------|--------|",
      "| 1 | No hardcoded secrets | PASS |",
      "| 2 | Error handling present | PASS |",
      "| 3 | Tests added | PASS |",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("detects **REQUEST_CHANGES** with findings table", () => {
    const body = [
      "## Review Findings",
      "",
      "**REQUEST_CHANGES**",
      "",
      "| Severity | Count | Description |",
      "|----------|-------|-------------|",
      "| CRITICAL | 1 | Hardcoded API key in auth module |",
      "| MEDIUM | 2 | Missing error handling in utils |",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("detects **LGTM** with severity bullet list", () => {
    const body = [
      "## Security Review",
      "",
      "**LGTM**",
      "",
      "### Findings",
      "",
      "- **LOW**: Consider using Zod for input validation",
      "- **LOW**: Minor naming inconsistency in helper function",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("LGTM");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("detects **Verdict:** APPROVE with reviewer identity line", () => {
    const body = [
      "## Review Summary",
      "",
      "**Reviewer:** code-reviewer-agent",
      "",
      "After thorough analysis of the changes:",
      "",
      "**Verdict:** APPROVE",
      "",
      "The implementation follows established patterns.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("detects ## APPROVE heading with any structured element", () => {
    const body = [
      "## Detailed Review",
      "",
      "## **APPROVE**",
      "",
      "| Check | Status |",
      "|-------|--------|",
      "| No console.log | PASS |",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("detects **APPROVED** (past tense) and normalises to APPROVE", () => {
    const body = [
      "**APPROVED**",
      "",
      "| # | Criterion | Result |",
      "|---|-----------|--------|",
      "| 1 | Tests pass | PASS |",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  // ---------------------------------------------------------------------------
  // Negative cases: should NOT satisfy PC-3
  // ---------------------------------------------------------------------------

  it("rejects plain English 'I think we should approve this'", () => {
    const body = [
      "I think we should approve this PR. The changes look reasonable",
      "and follow the existing code patterns. Good job overall.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
  });

  it("rejects inline 'approved' in a sentence", () => {
    const body = [
      "The team approved the design during yesterday's standup.",
      "We can now proceed with implementation.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
  });

  it("rejects empty body", () => {
    const result = parseReviewVerdict("");
    expect(result.hasVerdict).toBe(false);
    expect(result.hasStructuredElements).toBe(false);
    expect(result.confidence).toBe("low");
  });

  it("rejects body exceeding 50KB", () => {
    const body = makeLargeBody(PARSE_REVIEW_VERDICT_MAX_BODY_BYTES + 1);

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
    expect(result.confidence).toBe("low");
  });

  it("skips audit-bot system comments (authorType 'user')", () => {
    const body = [
      "**APPROVE**",
      "",
      "| # | Criterion | Result |",
      "|---|-----------|--------|",
      "| 1 | Tests pass | PASS |",
    ].join("\n");

    const result = parseReviewVerdict(body, "user");
    expect(result.hasVerdict).toBe(false);
    expect(result.confidence).toBe("low");
  });

  it("rejects lowercase 'approve' not in bold markdown", () => {
    const body = [
      "Looks good. I approve of these changes.",
      "Let's merge when ready.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
  });

  it("rejects verdict keyword without structured elements (medium confidence, no structured)", () => {
    const body = [
      "**APPROVE**",
      "",
      "Looks good, ship it!",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.hasStructuredElements).toBe(false);
    expect(result.confidence).toBe("medium");
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it("strips fenced code block containing inline backticks (template literals)", () => {
    const body = [
      "```typescript",
      "const approve = (id: string) => `{id} is approved`;",
      "const x = `REQUEST_CHANGES`;",
      "```",
      "",
      "This is just helper code. Nothing to review here.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
  });

  it("strips fenced code blocks before parsing", () => {
    const body = [
      "```typescript",
      "const approve = () => console.log('approve');",
      "const REQUEST_CHANGES = 'some config';",
      "```",
      "",
      "The code above is just helper functions. Nothing to review here.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
  });

  it("handles code blocks only (all stripped, no content left)", () => {
    const body = [
      "```python",
      "def approve(request):",
      "    return request.status == 200",
      "```",
      "",
      "```json",
      '{ "approved": true }',
      "```",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
  });

  it("parses mixed content: code blocks + review content", () => {
    const body = [
      "```diff",
      "- const apiKey = 'hardcoded'",
      "+ const apiKey = process.env.API_KEY",
      "```",
      "",
      "## Review",
      "",
      "**REQUEST_CHANGES**",
      "",
      "| Severity | Count |",
      "|----------|-------|",
      "| CRITICAL | 1 |",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("takes the most authoritative verdict when multiple are present", () => {
    const body = [
      "## Review",
      "",
      "**LGTM**",
      "",
      "Actually, on second thought:",
      "",
      "**REQUEST_CHANGES**",
      "",
      "| Severity | Count |",
      "|----------|-------|",
      "| HIGH | 2 |",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    // REQUEST_CHANGES is more authoritative than LGTM
    expect(result.verdict).toBe("REQUEST_CHANGES");
  });

  it("handles non-English content without false positives", () => {
    const body = [
      "Este cambio parece bueno. Se aprueba la propuesta.",
      "Las pruebas cubren los casos principales.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
  });

  it("detects **Reviewer:** identity as a structured element", () => {
    const body = [
      "**Reviewer:** security-reviewer-agent",
      "",
      "**APPROVE**",
      "",
      "No findings to report.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.hasStructuredElements).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("accepts body at exactly PARSE_REVIEW_VERDICT_MAX_BODY_BYTES", () => {
    // Build a body of EXACTLY the max bytes with a verdict keyword
    const verdictBlock = "\n**APPROVE**\n\n| # | C | R |\n|---|---|---|\n| 1 | A | PASS |";
    const filler = "x".repeat(
      PARSE_REVIEW_VERDICT_MAX_BODY_BYTES - Buffer.byteLength(verdictBlock, "utf-8")
    );
    const body = filler + verdictBlock;

    expect(Buffer.byteLength(body, "utf-8")).toBe(PARSE_REVIEW_VERDICT_MAX_BODY_BYTES);

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
  });

  it("rejects body at PARSE_REVIEW_VERDICT_MAX_BODY_BYTES + 1", () => {
    const verdictBlock = "\n**APPROVE**\n\n| # | C | R |\n|---|---|---|\n| 1 | A | PASS |";
    const filler = "x".repeat(
      PARSE_REVIEW_VERDICT_MAX_BODY_BYTES - Buffer.byteLength(verdictBlock, "utf-8") + 1
    );
    const body = filler + verdictBlock;

    expect(Buffer.byteLength(body, "utf-8")).toBe(PARSE_REVIEW_VERDICT_MAX_BODY_BYTES + 1);

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(false);
    expect(result.confidence).toBe("low");
  });

  it("handles **Verdict:** with APPROVED and normalises correctly", () => {
    const body = [
      "**Reviewer:** ceo-agent",
      "",
      "**Verdict:** APPROVED",
      "",
      "All checks passed.",
    ].join("\n");

    const result = parseReviewVerdict(body);
    expect(result.hasVerdict).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.hasStructuredElements).toBe(true);
  });
});
