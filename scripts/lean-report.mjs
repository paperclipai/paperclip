#!/usr/bin/env node
// Parses a vitest JSON report and prints only what a developer needs to act on:
// each failing test as `file:line · test name` followed by its first error
// lines, then a one-line tally. Hard-capped output. No dependencies.
//
// Usage: node lean-report.mjs test <report.json> [maxLines]
import { readFileSync } from "node:fs";

const [, , mode, reportPath, maxLinesArg] = process.argv;
const MAX_LINES = Number.parseInt(maxLinesArg ?? "60", 10) || 60;

if (mode !== "test") {
  console.error(`lean-report: unknown mode '${mode}'`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`lean-report: could not parse ${reportPath}: ${err.message}`);
  process.exit(2);
}

const out = [];
let truncated = false;
function emit(line) {
  if (out.length >= MAX_LINES) {
    truncated = true;
    return;
  }
  out.push(line);
}

// Pull the first informative line out of a vitest failure message (strip ANSI,
// skip blank lines), plus the first stack frame that points at a source file.
function firstErrorLines(messages) {
  const lines = [];
  let sourceFrameShown = false;
  for (const raw of messages ?? []) {
    const cleaned = String(raw).replace(/\[[0-9;]*m/g, "");
    for (const line of cleaned.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("at ")) {
        // Keep only the first project-source stack frame; node_modules is noise.
        if (sourceFrameShown || trimmed.includes("node_modules")) continue;
        sourceFrameShown = true;
      }
      lines.push(trimmed);
      if (lines.length >= 4) return lines;
    }
  }
  return lines;
}

const results = report.testResults ?? [];
let passed = report.numPassedTests ?? 0;
let failed = report.numFailedTests ?? 0;

for (const file of results) {
  const failing = (file.assertionResults ?? []).filter((a) => a.status === "failed");
  if (failing.length === 0) continue;
  const rel = (file.name ?? "<unknown file>").replace(`${process.cwd()}/`, "");
  for (const a of failing) {
    const loc = a.location ? `:${a.location.line}` : "";
    const title = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(" › ");
    emit(`✗ ${rel}${loc} · ${title}`);
    for (const errLine of firstErrorLines(a.failureMessages)) {
      emit(`    ${errLine}`);
    }
  }
}

if (failed === 0) {
  console.log(`✓ ${passed} passed, 0 failed`);
  process.exit(0);
}

console.log(out.join("\n"));
if (truncated) {
  console.log(`… output capped at ${MAX_LINES} lines.`);
}
console.log(`\n${passed} passed / ${failed} failed`);
