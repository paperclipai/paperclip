#!/usr/bin/env node
/**
 * rt2-v33-acceptance-gate.mjs
 * v3.3 RT2 Engine Convergence — Acceptance Gate
 *
 * Wraps rt2-devplan-alignment-gate.mjs and adds v3.3 milestone-specific checks.
 * Fails closed: any failure is a blocker, not accepted debt.
 *
 * Usage: node scripts/rt2-v33-acceptance-gate.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, ".planning", "v33-acceptance-runs");

// v3.2 baseline score (from v3.2 acceptance gate run on 2026-05-01)
const V32_BASELINE_SCORE_PCT = 100;

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function findPnpm() {
  // Try npm package manager executables on Windows
  const candidates = [
    "pnpm.cmd",
    path.join(ROOT, "node_modules", ".bin", "pnpm.cmd"),
    "npx.cmd",
    "npx",
    "pnpm",
  ];
  for (const p of candidates) {
    try {
      await runCommand(p, ["--version"]);
      return p;
    } catch {
      // continue
    }
  }
  return "pnpm"; // fallback
}

// Windows-safe runCommand using cmd /c for .cmd files
function runCommand(cmd, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    // Use cmd.exe for .cmd files on Windows
    const isCmd = cmd.endsWith(".cmd") || cmd.endsWith(".bat");
    const shellArgs = isCmd ? ["/c", cmd, ...args] : args;
    const shellCmd = isCmd ? "cmd" : cmd;
    const proc = spawn(shellCmd, shellArgs, { cwd, stdio: "pipe", shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}\n${stderr}`));
    });
    proc.on("error", reject);
  });
}

async function main() {
  const errors = [];
  const checks = [];

  // Find pnpm
  const pnpmCmd = await findPnpm();
  console.log(`[gate] Using package manager: ${pnpmCmd}`);

  // ── GATE-01: Run alignment gate ──────────────────────────────────────────
  console.log("[gate] Running rt2-devplan-alignment-gate.mjs...");
  let alignmentResult = null;
  try {
    const out = await runCommand("node", [
      path.join(ROOT, "scripts", "rt2-devplan-alignment-gate.mjs"),
      "--output-dir", path.join(ROOT, ".planning", "v33-devplan-alignment-runs"),
      "--json",
    ]);
    const parsed = JSON.parse(out.stdout);
    // Find the latest run directory
    const runsDir = path.join(ROOT, ".planning", "v33-devplan-alignment-runs");
    const runs = fs.readdirSync(runsDir).filter((f) =>
      fs.statSync(path.join(runsDir, f)).isDirectory()
    ).sort().reverse();
    const latestRunDir = runs[0];
    const summaryJsonPath = path.join(runsDir, latestRunDir, "summary.json");
    alignmentResult = JSON.parse(fs.readFileSync(summaryJsonPath, "utf8"));
    checks.push({
      name: "devplan-alignment-gate",
      passed: alignmentResult.status === "passed",
      detail: `score=${alignmentResult.currentScorePct}% (baseline=${alignmentResult.baselineScorePct}%)`,
    });
    if (alignmentResult.status === "blocker") {
      errors.push(`Alignment gate failed: ${alignmentResult.counts.blockers} blocker(s)`);
    }
  } catch (err) {
    errors.push(`Alignment gate script error: ${err.message}`);
  }

  // ── GATE-02: Run typecheck ───────────────────────────────────────────────
  console.log("[gate] Running typecheck...");
  try {
    await runCommand(pnpmCmd, ["typecheck"], ROOT);
    checks.push({ name: "typecheck", passed: true });
  } catch (err) {
    checks.push({ name: "typecheck", passed: false, detail: err.message });
    errors.push(`typecheck failed: ${err.message}`);
  }

  // ── GATE-03: Run tests ────────────────────────────────────────────────────
  console.log("[gate] Running test...");
  try {
    await runCommand(pnpmCmd, ["test"], ROOT);
    checks.push({ name: "test", passed: true });
  } catch (err) {
    checks.push({ name: "test", passed: false, detail: err.message });
    errors.push(`test failed: ${err.message}`);
  }

  // ── GATE-04: Score delta check ───────────────────────────────────────────
  let scoreDeltaPct = null;
  if (alignmentResult) {
    scoreDeltaPct = alignmentResult.currentScorePct - V32_BASELINE_SCORE_PCT;
    const scoreDeltaPassed = scoreDeltaPct >= 0;
    checks.push({
      name: "score-delta",
      passed: scoreDeltaPassed,
      detail: `delta=${scoreDeltaPct >= 0 ? "+" : ""}${scoreDeltaPct}% (current=${alignmentResult.currentScorePct}% vs v32-baseline=${V32_BASELINE_SCORE_PCT}%)`,
    });
    if (!scoreDeltaPassed) {
      errors.push(`Score delta is ${scoreDeltaPct}% (${scoreDeltaPct < 0 ? "REGRESSION" : "no change"}). Must be positive vs v3.2 baseline.`);
    }
  } else {
    checks.push({ name: "score-delta", passed: false, detail: "skipped (no alignment result)" });
    errors.push("Score delta check skipped — no alignment result available.");
  }

  // ── Generate output artifacts ────────────────────────────────────────────
  ensureDir(OUTPUT_DIR);
  const runId = timestampForPath();
  const runDir = path.join(OUTPUT_DIR, runId);
  ensureDir(runDir);

  const summaryJson = {
    version: 1,
    generatedAt: new Date().toISOString(),
    gate: "v3.3",
    v32BaselineScorePct: V32_BASELINE_SCORE_PCT,
    currentScorePct: alignmentResult?.currentScorePct ?? null,
    baselineScorePct: alignmentResult?.baselineScorePct ?? null,
    scoreDeltaPct,
    status: errors.length === 0 ? "passed" : "failed",
    checks,
    errors,
  };

  const reportMd = [
    "# v3.3 RT2 Engine Convergence — Acceptance Gate",
    "",
    `**Status:** ${errors.length === 0 ? "✅ PASSED" : "❌ FAILED"}`,
    `**Generated:** ${summaryJson.generatedAt}`,
    "",
    "## Score",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| v3.2 baseline | ${V32_BASELINE_SCORE_PCT}% |`,
    `| Current score | ${alignmentResult?.currentScorePct ?? "N/A"}% |`,
    `| v3.0 baseline | ${alignmentResult?.baselineScorePct ?? "N/A"}% |`,
    `| Score delta | ${scoreDeltaPct !== null ? `${scoreDeltaPct >= 0 ? "+" : ""}${scoreDeltaPct}%` : "N/A"} |`,
    "",
    "## Checks",
    "",
    "| Check | Status | Detail |",
    "|-------|--------|--------|",
    ...checks.map(
      (c) => `| ${c.name} | ${c.passed ? "✅ PASS" : "❌ FAIL"} | ${c.detail ?? ""} |`
    ),
    "",
    errors.length > 0
      ? `## Errors\n\n${errors.map((e) => `- ${e}`).join("\n")}`
      : "## Errors\n\nNone.",
  ].join("\n");

  fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(summaryJson, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, "report.md"), reportMd);

  console.log(`\n${"=".repeat(60)}`);
  if (errors.length === 0) {
    console.log("✅ v3.3 Acceptance Gate — ALL CHECKS PASSED");
    console.log(`   Score: ${alignmentResult?.currentScorePct}% (delta: ${scoreDeltaPct >= 0 ? "+" : ""}${scoreDeltaPct}%)`);
  } else {
    console.log("❌ v3.3 Acceptance Gate — FAILED");
    errors.forEach((e) => console.log(`   - ${e}`));
  }
  console.log(`${"=".repeat(60)}`);
  console.log(`Artifacts: ${path.relative(ROOT, runDir)}`);

  process.exit(errors.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});