#!/usr/bin/env node

export const MINIMAX_URL = "https://api.minimax.io/v1/chat/completions";
export const MODEL = "MiniMax-M2.7";
const MAX_DIFF_BYTES = 100_000;
const REQUEST_TIMEOUT_MS = 90_000;
const REVIEW_RETRY_OPTIONS = [
  { response_format: { type: "json_object" } },
  {},
];

const SYSTEM_PROMPT = `You are a senior code reviewer for the Paperclip agent platform, a TypeScript monorepo with a Node.js server, PostgreSQL database, Docker deployment, and GitHub Actions CI/CD.

Review pull request diffs for:
- secret exposure or unsafe credential handling
- CI/CD and deployment regressions
- runtime bugs, auth regressions, or migration risks
- broken tests or missing coverage for risky changes

Severity rules:
- critical => secrets exposure, credential exfiltration, broken deploy logic, runtime-breaking bugs
- high risk => deploy workflow changes, trading execution changes, env/secrets handling changes
- warning => test gaps, error-handling gaps, risky assumptions
- note => minor follow-ups

Verdict rules:
1. Any critical finding => FAIL
2. No critical findings but high-risk areas changed => HIGH_RISK
3. Warnings only => PASS_WITH_NOTES
4. No findings => PASS

Respond with JSON only:
{
  "verdict": "PASS | PASS_WITH_NOTES | FAIL | HIGH_RISK",
  "summary": "One-line summary under 140 characters",
  "findings": [
    {
      "severity": "critical | warning | note",
      "message": "Finding text",
      "file": "path/to/file.ts",
      "line": 10
    }
  ]
}`;

export function prepareDiff(rawDiff, maxBytes = MAX_DIFF_BYTES) {
  if (!rawDiff) return { diff: "(empty diff)", truncated: false };
  const bytes = Buffer.byteLength(rawDiff, "utf8");
  if (bytes <= maxBytes) return { diff: rawDiff, truncated: false };
  const truncated = rawDiff.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf("\n");
  return {
    diff: (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) + "\n\n[... diff truncated ...]",
    truncated: true,
  };
}

export function buildUserPrompt({ title, body, filesChanged, additions, deletions, diff, truncated }) {
  return [
    `PR: ${title}`,
    body ? `Description:\n${body}` : "",
    `Files changed: ${filesChanged}`,
    `Additions: ${additions}`,
    `Deletions: ${deletions}`,
    truncated ? "Diff was truncated." : "",
    "Diff:",
    "```diff",
    diff,
    "```",
  ].filter(Boolean).join("\n\n");
}

function extractMessageContent(message) {
  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

async function callMiniMaxOnce(apiKey, systemPrompt, userPrompt, extraBody = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(MINIMAX_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        ...extraBody,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "(no body)");
      throw new Error(`MiniMax API error ${res.status}: ${errorBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = extractMessageContent(data?.choices?.[0]?.message);
    if (!content) throw new Error("MiniMax returned empty content");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callMiniMax(apiKey, systemPrompt, userPrompt) {
  let lastError = null;
  for (const options of REVIEW_RETRY_OPTIONS) {
    try {
      return await callMiniMaxOnce(apiKey, systemPrompt, userPrompt, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("MiniMax review failed");
}

export function parseVerdict(raw) {
  let text = String(raw || "").trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  const candidates = [text];
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch && objectMatch[0] !== text) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const verdict = String(parsed.verdict || "FAIL").toUpperCase();
      const validVerdicts = ["PASS", "PASS_WITH_NOTES", "FAIL", "HIGH_RISK"];
      return {
        verdict: validVerdicts.includes(verdict) ? verdict : "FAIL",
        summary: String(parsed.summary || "Review completed").slice(0, 140),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      };
    } catch {
      continue;
    }
  }

  try {
    return {
      verdict: "HIGH_RISK",
      summary: "AI review response was not valid JSON",
      findings: [{ severity: "note", message: "AI review returned non-JSON content; no blocking findings were trusted.", file: "", line: 0 }],
    };
  } catch {
    return {
      verdict: "HIGH_RISK",
      summary: "AI review response was not valid JSON",
      findings: [{ severity: "note", message: "AI review returned non-JSON content; no blocking findings were trusted.", file: "", line: 0 }],
    };
  }
}

export async function runReview({ apiKey, diff: rawDiff, title, body, filesChanged, additions, deletions }) {
  if (!apiKey) throw new Error("MINIMAX_API_KEY is required");
  const { diff, truncated } = prepareDiff(rawDiff);
  const userPrompt = buildUserPrompt({ title, body, filesChanged, additions, deletions, diff, truncated });
  const responseText = await callMiniMax(apiKey, SYSTEM_PROMPT, userPrompt);
  const result = parseVerdict(responseText);

  if (truncated && result.verdict === "PASS") {
    result.verdict = "PASS_WITH_NOTES";
    result.findings.push({ severity: "note", message: "Diff exceeded 100KB and was truncated.", file: "", line: 0 });
  }

  return result;
}

async function main() {
  try {
    const result = await runReview({
      apiKey: process.env.MINIMAX_API_KEY,
      diff: process.env.PR_DIFF,
      title: process.env.PR_TITLE || `PR #${process.env.PR_NUMBER || ""}`,
      body: process.env.PR_BODY || "",
      filesChanged: process.env.PR_FILES_CHANGED || "",
      additions: process.env.PR_ADDITIONS || "",
      deletions: process.env.PR_DELETIONS || "",
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({
      verdict: "HIGH_RISK",
      summary: String(error.message || "AI review unavailable; manual fallback advised").slice(0, 140),
      findings: [
        {
          severity: "note",
          message: "AI provider was unavailable or returned an unusable response; automated review did not complete.",
          file: "",
          line: 0,
        },
      ],
    }));
  }
}

main();
