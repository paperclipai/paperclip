#!/usr/bin/env node

/**
 * AI Code Review Script
 *
 * Sends a PR diff to MiniMax M2.7 via OpenRouter for automated code review.
 * Outputs a structured verdict JSON to stdout.
 *
 * Environment variables:
 *   OPENROUTER_API_KEY  — required
 *   PR_DIFF             — the full PR diff text
 *   PR_NUMBER           — PR number
 *   PR_TITLE            — PR title
 *   PR_BODY             — PR description (optional)
 *   PR_URL              — PR HTML URL
 *   PR_FILES_CHANGED    — number of files changed
 *   PR_ADDITIONS        — lines added
 *   PR_DELETIONS        — lines removed
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "minimax/minimax-m2.7";
const MAX_DIFF_BYTES = 100_000;
const REQUEST_TIMEOUT_MS = 90_000;

const SYSTEM_PROMPT = `You are a senior code reviewer for the Paperclip agent platform — a TypeScript monorepo with a Node.js server, PostgreSQL database, Docker deployment, and GitHub Actions CI/CD.

Your job is to review pull request diffs and produce a structured verdict.

## Scoring criteria

**Critical** (any one → FAIL):
- Security vulnerabilities: injection, auth bypass, secret exposure, XSS
- Logic bugs that will cause runtime errors or data corruption
- Breaking changes to public APIs without migration path
- Database migrations that lose data

**High-risk** (any one → HIGH_RISK):
- Changes to auth/authz logic
- Changes to secrets/env handling
- CI/CD workflow modifications
- Infrastructure config changes
- Database migrations (non-destructive)

**Warning** (warnings only → PASS_WITH_NOTES):
- Missing error handling at system boundaries
- Missing tests for new logic branches
- Performance concerns (N+1 queries, unbounded loops)
- Inconsistent naming or patterns vs. codebase conventions

**Note** (informational, never affects verdict):
- Style suggestions
- Documentation improvements
- Minor refactoring opportunities

## Verdict rules

1. Any critical finding → verdict: FAIL
2. No critical findings but auth/secrets/CI/infra/migration changes → verdict: HIGH_RISK
3. Only warnings and notes → verdict: PASS_WITH_NOTES
4. Clean review → verdict: PASS

## Output format

Respond with ONLY a JSON object (no markdown fences, no explanation):

{
  "verdict": "PASS | PASS_WITH_NOTES | FAIL | HIGH_RISK",
  "summary": "One-line summary, max 140 characters",
  "findings": [
    {
      "severity": "critical | warning | note",
      "message": "Description of the finding",
      "file": "path/to/file.ts",
      "line": 42
    }
  ]
}

If the diff is clean with no findings, return an empty findings array.
The summary MUST be under 140 characters — it will be used as a GitHub status description.`;

/**
 * Truncate diff if it exceeds the byte limit.
 * Returns { diff, truncated }.
 */
export function prepareDiff(rawDiff, maxBytes = MAX_DIFF_BYTES) {
  if (!rawDiff) return { diff: "(empty diff)", truncated: false };
  const bytes = Buffer.byteLength(rawDiff, "utf8");
  if (bytes <= maxBytes) return { diff: rawDiff, truncated: false };
  // Truncate to maxBytes, then cut at the last newline to avoid splitting a line
  const truncated = rawDiff.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf("\n");
  const clean = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
  return {
    diff: clean + "\n\n[... diff truncated — exceeded 100KB limit ...]",
    truncated: true,
  };
}

/**
 * Build the user prompt from PR metadata and diff.
 */
export function buildUserPrompt({ title, body, filesChanged, additions, deletions, diff, truncated }) {
  const parts = [
    `## Pull Request: ${title}`,
    "",
    body ? `### Description\n${body}\n` : "",
    `### Stats`,
    `- Files changed: ${filesChanged}`,
    `- Lines added: ${additions}`,
    `- Lines removed: ${deletions}`,
    truncated ? "- **Note: Diff was truncated (>100KB). Review is based on partial diff.**" : "",
    "",
    "### Diff",
    "```diff",
    diff,
    "```",
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Call OpenRouter API and return the raw response text.
 */
export async function callOpenRouter(apiKey, systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Viraforge/paperclip",
        "X-Title": "Paperclip AI Review",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "(no body)");
      throw new Error(`OpenRouter API error ${res.status}: ${errorBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`OpenRouter returned empty content: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse the LLM response into a structured verdict.
 * Handles markdown-wrapped JSON and malformed responses gracefully.
 */
export function parseVerdict(raw) {
  let text = raw.trim();
  // Strip markdown code fences if present
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(text);
    const verdict = String(parsed.verdict || "FAIL").toUpperCase();
    const validVerdicts = ["PASS", "PASS_WITH_NOTES", "FAIL", "HIGH_RISK"];
    return {
      verdict: validVerdicts.includes(verdict) ? verdict : "FAIL",
      summary: String(parsed.summary || "Review completed").slice(0, 140),
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  } catch {
    return {
      verdict: "FAIL",
      summary: "Failed to parse review response",
      findings: [{ severity: "critical", message: `Unparseable LLM response: ${text.slice(0, 200)}`, file: "", line: 0 }],
    };
  }
}

/**
 * Format findings as a markdown PR comment.
 */
export function formatComment(verdict, summary, findings, prUrl) {
  const icon = { PASS: "\u2705", PASS_WITH_NOTES: "\u2705", FAIL: "\u274C", HIGH_RISK: "\u26A0\uFE0F" }[verdict] || "\u2753";
  const lines = [
    `## ${icon} AI Review: ${verdict}`,
    "",
    summary,
    "",
  ];

  if (findings.length > 0) {
    const grouped = { critical: [], warning: [], note: [] };
    for (const f of findings) {
      const sev = grouped[f.severity] ? f.severity : "note";
      grouped[sev].push(f);
    }
    for (const [severity, items] of Object.entries(grouped)) {
      if (items.length === 0) continue;
      const label = { critical: "Critical", warning: "Warnings", note: "Notes" }[severity];
      lines.push(`### ${label}`, "");
      for (const f of items) {
        const loc = f.file ? (f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``) : "";
        lines.push(`- ${loc ? `${loc} — ` : ""}${f.message}`);
      }
      lines.push("");
    }
  }

  lines.push("---", `*Automated review by [Paperclip AI Review](${prUrl})*`);
  return lines.join("\n");
}

/**
 * Main entry point. Reads env vars, runs the review, outputs JSON to stdout.
 */
export async function runReview({ apiKey, diff: rawDiff, title, body, number, url, filesChanged, additions, deletions } = {}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
  if (!rawDiff && rawDiff !== "") throw new Error("PR_DIFF is required");

  const { diff, truncated } = prepareDiff(rawDiff);
  const userPrompt = buildUserPrompt({ title: title || `PR #${number}`, body, filesChanged, additions, deletions, diff, truncated });

  const responseText = await callOpenRouter(apiKey, SYSTEM_PROMPT, userPrompt);
  const result = parseVerdict(responseText);

  // If diff was truncated and verdict is PASS, upgrade to PASS_WITH_NOTES
  if (truncated && result.verdict === "PASS") {
    result.verdict = "PASS_WITH_NOTES";
    result.findings.push({ severity: "note", message: "Diff exceeded 100KB and was truncated. Manual review recommended for full coverage.", file: "", line: 0 });
  }

  return result;
}

async function main() {
  try {
    const result = await runReview({
      apiKey: process.env.OPENROUTER_API_KEY,
      diff: process.env.PR_DIFF,
      title: process.env.PR_TITLE,
      body: process.env.PR_BODY,
      number: process.env.PR_NUMBER,
      url: process.env.PR_URL,
      filesChanged: process.env.PR_FILES_CHANGED || "0",
      additions: process.env.PR_ADDITIONS || "0",
      deletions: process.env.PR_DELETIONS || "0",
    });
    console.log(JSON.stringify(result));
  } catch (err) {
    // Output a structured error verdict so the workflow can still post a status
    const errorResult = {
      verdict: "ERROR",
      summary: `Review failed: ${err.message}`.slice(0, 140),
      findings: [],
    };
    console.log(JSON.stringify(errorResult));
    process.exit(1);
  }
}

// Run main() only when executed directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) main();
