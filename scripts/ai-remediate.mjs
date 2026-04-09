#!/usr/bin/env node

/**
 * AI Code Remediation Script
 *
 * Takes AI review findings + file contents, sends them to an LLM, and outputs
 * file patches. Designed to work alongside ai-review.mjs.
 *
 * Pure-function exports for testability. CLI entry point at bottom.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { callMiniMax } from "./ai-review.mjs";

const MAX_AFFECTED_FILES = 5;

const REMEDIATION_SYSTEM_PROMPT = `You are a senior TypeScript engineer fixing bounded code review findings.

Rules:
- Fix ONLY the issues described in the findings
- Do NOT refactor, optimize, or change unrelated code
- Preserve existing code style and project conventions
- NEVER modify CI/CD workflow files (.github/workflows/*)
- If a finding cannot be fixed safely, skip it and explain why

Respond with ONLY a JSON object:
{
  "patches": [
    {
      "file": "path/to/file.ts",
      "content": "full updated file contents"
    }
  ],
  "explanation": "Brief summary of what was fixed",
  "skipped": [
    {
      "file": "path/to/file.ts",
      "reason": "Why skipped"
    }
  ]
}`;

export function collectAffectedFiles(findings) {
  if (!Array.isArray(findings)) return [];
  const files = new Set();
  for (const finding of findings) {
    if (finding?.file && typeof finding.file === "string" && finding.file.trim()) {
      files.add(finding.file.trim());
    }
  }
  return [...files];
}

export function hasCriticalFindings(findings) {
  if (!Array.isArray(findings)) return false;
  return findings.some((finding) => finding?.severity === "critical");
}

export function buildRemediationPrompt({ findings, fileContents, diff }) {
  const parts = [
    "## Findings to fix\n",
    "```json",
    JSON.stringify(findings, null, 2),
    "```\n",
  ];

  if (fileContents && Object.keys(fileContents).length > 0) {
    parts.push("## Current file contents\n");
    for (const [filePath, content] of Object.entries(fileContents)) {
      const ext = filePath.split(".").pop() || "txt";
      parts.push(`### ${filePath}\n`, "```" + ext, content, "```\n");
    }
  }

  if (diff) {
    parts.push("## Original PR diff (for context)\n", "```diff", diff, "```");
  }

  return parts.join("\n");
}

export function parseRemediationResponse(raw) {
  if (!raw) return { patches: [], explanation: "", skipped: [] };

  let text = String(raw).trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(text);
    return {
      patches: Array.isArray(parsed.patches)
        ? parsed.patches.filter(
            (patch) => patch?.file && typeof patch.file === "string" && typeof patch.content === "string",
          )
        : [],
      explanation: String(parsed.explanation || ""),
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    };
  } catch {
    return { patches: [], explanation: "Failed to parse remediation response", skipped: [] };
  }
}

export function sanitizePatches(patches, knownFiles) {
  const known = new Set(knownFiles);
  return (patches || []).filter((patch) => {
    if (!patch?.file || typeof patch.file !== "string") return false;
    if (patch.file.startsWith(".github/workflows/")) return false;
    if (!known.has(patch.file)) return false;
    return typeof patch.content === "string";
  });
}

export async function runRemediation({ apiKey, findings, fileContents, diff }) {
  const affectedFiles = collectAffectedFiles(findings);
  if (!apiKey) throw new Error("MINIMAX_API_KEY is required");
  if (affectedFiles.length === 0) {
    return { patches: [], explanation: "No affected files found in findings", skipped: [] };
  }
  if (affectedFiles.length > MAX_AFFECTED_FILES) {
    return {
      patches: [],
      explanation: `Too many affected files (${affectedFiles.length} > ${MAX_AFFECTED_FILES}). Skipping remediation.`,
      skipped: affectedFiles.map((file) => ({ file, reason: "Too many files for automated remediation" })),
    };
  }
  if (hasCriticalFindings(findings)) {
    return {
      patches: [],
      explanation: "Critical findings present — skipping automated remediation",
      skipped: (findings || [])
        .filter((finding) => finding?.severity === "critical")
        .map((finding) => ({ file: finding.file || "", reason: "Critical finding requires human review" })),
    };
  }

  const prompt = buildRemediationPrompt({ findings, fileContents, diff });

  const responseText = await callMiniMax(apiKey, REMEDIATION_SYSTEM_PROMPT, prompt);
  const result = parseRemediationResponse(responseText);
  result.patches = sanitizePatches(result.patches, Object.keys(fileContents || {}));
  return result;
}

function readInput(name, fallback = "") {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    return readFileSync(filePath, "utf8");
  }
  return process.env[name] || fallback;
}

async function main() {
  try {
    const result = await runRemediation({
      apiKey: process.env.MINIMAX_API_KEY,
      findings: JSON.parse(readInput("REMEDIATION_FINDINGS", "[]")),
      fileContents: JSON.parse(readInput("REMEDIATION_FILE_CONTENTS", "{}")),
      diff: readInput("REMEDIATION_DIFF"),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({
      patches: [],
      explanation: `Remediation failed: ${String(error.message || "unknown error")}`,
      skipped: [],
    }));
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
