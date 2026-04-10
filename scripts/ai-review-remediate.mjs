#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

import { callMiniMax } from "./ai-review.mjs";

const SYSTEM_PROMPT = `You are an automated CI remediation agent for GitHub workflow and repository config files in a TypeScript monorepo.

Your job is to apply the smallest safe fix for review findings that are limited to workflow/config files.

Rules:
- Only modify files explicitly provided in the input.
- Never modify application source files.
- Preserve existing behavior unless a finding requires a targeted fix.
- Prefer minimal edits over broad rewrites.
- Return full file contents for any changed file.
- If no safe remediation can be produced, return no edits.

Output ONLY JSON:
{
  "summary": "short summary",
  "edits": [
    {
      "file": ".github/workflows/example.yml",
      "content": "full replacement file content"
    }
  ]
}`;

function readJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      summary: `Remediation provider returned invalid JSON: ${message}`.replace(/\s+/g, " ").trim().slice(0, 180),
      edits: [],
    };
  }
  return {
    summary: String(parsed.summary || "Auto-remediation attempted").replace(/\s+/g, " ").trim().slice(0, 180),
    edits: Array.isArray(parsed.edits) ? parsed.edits : [],
  };
}

function buildPrompt({ prTitle, prBody, findings, files }) {
  return [
    `PR title: ${prTitle || ""}`,
    "",
    prBody ? `PR body:\n${prBody}\n` : "",
    "Findings:",
    JSON.stringify(findings, null, 2),
    "",
    "Files:",
    JSON.stringify(
      files.map((file) => ({
        file: file.path,
        content: file.content,
      })),
      null,
      2,
    ),
  ].join("\n");
}

async function main() {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY is required");

  const findings = readJsonEnv("AI_REVIEW_FINDINGS", []);
  const paths = readJsonEnv("AI_REMEDIATE_PATHS", []);
  const prTitle = process.env.PR_TITLE || "";
  const prBody = process.env.PR_BODY || "";

  const files = paths.map((filePath) => ({
    path: filePath,
    content: readFileSync(filePath, "utf8"),
  }));

  if (files.length === 0 || findings.length === 0) {
    process.stdout.write(JSON.stringify({ summary: "No eligible remediation targets", edits: [] }));
    return;
  }

  const prompt = buildPrompt({ prTitle, prBody, findings, files });
  const raw = await callMiniMax(apiKey, SYSTEM_PROMPT, prompt);
  const result = parseResponse(raw);

  const allowedPaths = new Set(paths);
  const safeEdits = result.edits.filter(
    (edit) =>
      edit &&
      typeof edit.file === "string" &&
      typeof edit.content === "string" &&
      allowedPaths.has(edit.file),
  );

  for (const edit of safeEdits) {
    writeFileSync(edit.file, edit.content);
  }

  process.stdout.write(JSON.stringify({ summary: result.summary, edits: safeEdits }));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ summary: `Remediation failed: ${message}`.replace(/\s+/g, " ").trim().slice(0, 180), edits: [] }));
  process.exit(0);
});
