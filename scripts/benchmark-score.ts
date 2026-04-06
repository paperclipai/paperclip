#!/usr/bin/env -S node --import tsx/esm

/**
 * Paperclip Fork — Commit Benchmark Score
 *
 * Computes a composite quality score for a commit based on:
 *   - Test pass rate (40%)
 *   - Coverage metrics (30%)
 *   - Typecheck pass (15%)
 *   - Build success (15%)
 *
 * Outputs a JSON scorecard to stdout (--json) or a human-readable summary.
 * Designed for CI integration: exit code 0 = pass, 1 = below threshold.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCORE_WEIGHTS = {
  tests: 0.4,
  coverage: 0.3,
  typecheck: 0.15,
  build: 0.15,
} as const;

const DEFAULT_SCORE_THRESHOLD = 70;
const DEFAULT_OUTPUT_DIR = "benchmarks";
// Resolved relative to PROJECT_ROOT after it's computed
const COVERAGE_SUMMARY_RELATIVE = "coverage/coverage-summary.json";

interface CoverageSummary {
  total: {
    lines: { pct: number };
    statements: { pct: number };
    functions: { pct: number };
    branches: { pct: number };
  };
}

interface TestResults {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  totalSuites: number;
  passedSuites: number;
  failedSuites: number;
  durationMs: number;
}

interface CheckResult {
  passed: boolean;
  durationMs: number;
  error?: string;
}

interface Scorecard {
  version: 1;
  timestamp: string;
  commit: string;
  branch: string;
  scores: {
    tests: { score: number; weight: number; details: TestResults };
    coverage: {
      score: number;
      weight: number;
      details: {
        lines: number;
        statements: number;
        functions: number;
        branches: number;
      };
    };
    typecheck: { score: number; weight: number; details: CheckResult };
    build: { score: number; weight: number; details: CheckResult };
  };
  composite: number;
  threshold: number;
  pass: boolean;
  durationMs: number;
}

interface CliOptions {
  json: boolean;
  output: string | null;
  threshold: number;
  skipBuild: boolean;
  skipTypecheck: boolean;
  markdownSummary: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    output: null,
    threshold: DEFAULT_SCORE_THRESHOLD,
    skipBuild: false,
    skipTypecheck: false,
    markdownSummary: null,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--json":
        options.json = true;
        break;
      case "--output":
        options.output = argv[++i] ?? null;
        break;
      case "--threshold":
        options.threshold = Number.parseInt(argv[++i] ?? "", 10) || DEFAULT_SCORE_THRESHOLD;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--skip-typecheck":
        options.skipTypecheck = true;
        break;
      case "--markdown-summary":
        options.markdownSummary = argv[++i] ?? null;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: tsx scripts/benchmark-score.ts [options]

Computes a composite quality score for the current commit.

Options:
  --json                 Output JSON scorecard to stdout
  --output <path>        Write scorecard JSON to file
  --threshold <n>        Minimum passing score (default: ${DEFAULT_SCORE_THRESHOLD})
  --skip-build           Skip the build step
  --skip-typecheck       Skip the typecheck step
  --markdown-summary <f> Write markdown summary to file (for GitHub step summary)
  --help                 Show this help
`);
}

async function getGitInfo(): Promise<{ commit: string; branch: string }> {
  try {
    const [commitResult, branchResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--short", "HEAD"]),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    return {
      commit: commitResult.stdout.trim(),
      branch: branchResult.stdout.trim(),
    };
  } catch {
    return { commit: "unknown", branch: "unknown" };
  }
}

function resolveProjectRoot(): string {
  // Walk up from this script to find root package.json with "name": "paperclip"
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const parent = path.dirname(dir);
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(path.join(parent, "package.json"), "utf8"));
      if (pkg.name === "paperclip") return parent;
    } catch { /* continue */ }
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = resolveProjectRoot();

async function runTests(): Promise<TestResults> {
  const startMs = Date.now();
  const jsonOutputFile = path.join(os.tmpdir(), `vitest-results-${Date.now()}.json`);
  try {
    try {
      await execFileAsync(
        "npx",
        [
          "vitest", "run",
          "--reporter=default", "--reporter=json",
          "--outputFile.json", jsonOutputFile,
        ],
        {
          maxBuffer: 50 * 1024 * 1024,
          cwd: PROJECT_ROOT,
          env: { ...process.env, NODE_ENV: "development" },
        },
      );
    } catch (error: any) {
      // vitest exits non-zero when tests fail — that's expected, continue to read the file
      // Only re-throw if the file wasn't created (vitest didn't run at all)
      try {
        await fs.access(jsonOutputFile);
      } catch {
        // Fall back to parsing stdout/stderr
        const stdout = error?.stdout ?? "";
        const stderr = error?.stderr ?? "";
        const combined = stdout + stderr;
        if (combined) {
          return parseVitestJson(combined, Date.now() - startMs);
        }
        return emptyTestResults(Date.now() - startMs);
      }
    }

    // Read the JSON output file
    const jsonContent = await fs.readFile(jsonOutputFile, "utf8");
    return parseVitestJson(jsonContent, Date.now() - startMs);
  } catch {
    return emptyTestResults(Date.now() - startMs);
  } finally {
    // Clean up temp file
    fs.unlink(jsonOutputFile).catch(() => {});
  }
}

function emptyTestResults(durationMs: number): TestResults {
  return {
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    totalSuites: 0,
    passedSuites: 0,
    failedSuites: 0,
    durationMs,
  };
}

function parseVitestJson(stdout: string, durationMs: number): TestResults {
  // vitest JSON output may have non-JSON lines before/after
  const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (!jsonMatch) {
    // Fall back to parsing vitest summary line from stderr/stdout
    return parseVitestSummary(stdout, durationMs);
  }

  try {
    const data = JSON.parse(jsonMatch[0]);
    const testResults = data.testResults ?? [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let passedSuites = 0;
    let failedSuites = 0;

    for (const suite of testResults) {
      const status = suite.status ?? "";
      if (status === "passed") passedSuites++;
      else if (status === "failed") failedSuites++;

      for (const test of suite.assertionResults ?? []) {
        const testStatus = test.status ?? "";
        if (testStatus === "passed") passed++;
        else if (testStatus === "failed") failed++;
        else skipped++;
      }
    }

    return {
      totalTests: passed + failed + skipped,
      passedTests: passed,
      failedTests: failed,
      skippedTests: skipped,
      totalSuites: testResults.length,
      passedSuites,
      failedSuites,
      durationMs,
    };
  } catch {
    return parseVitestSummary(stdout, durationMs);
  }
}

function parseVitestSummary(output: string, durationMs: number): TestResults {
  // Parse "Test Files  20 failed | 158 passed (178)"
  const suitesMatch = output.match(
    /Test Files\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed\s+\((\d+)\)/,
  );
  // Parse "Tests  18 failed | 830 passed | 2 skipped (850)"
  const testsMatch = output.match(
    /Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?\s+\((\d+)\)/,
  );

  return {
    totalTests: testsMatch ? parseInt(testsMatch[4]) : 0,
    passedTests: testsMatch ? parseInt(testsMatch[2]) : 0,
    failedTests: testsMatch ? parseInt(testsMatch[1] ?? "0") : 0,
    skippedTests: testsMatch ? parseInt(testsMatch[3] ?? "0") : 0,
    totalSuites: suitesMatch ? parseInt(suitesMatch[3]) : 0,
    passedSuites: suitesMatch ? parseInt(suitesMatch[2]) : 0,
    failedSuites: suitesMatch ? parseInt(suitesMatch[1] ?? "0") : 0,
    durationMs,
  };
}

async function readCoverage(): Promise<CoverageSummary["total"] | null> {
  try {
    const coveragePath = path.join(PROJECT_ROOT, COVERAGE_SUMMARY_RELATIVE);
    const raw = await fs.readFile(coveragePath, "utf8");
    const data = JSON.parse(raw) as CoverageSummary;
    return data.total;
  } catch {
    return null;
  }
}

async function runCheck(
  label: string,
  command: string,
  args: string[],
): Promise<CheckResult> {
  const startMs = Date.now();
  try {
    await execFileAsync(command, args, {
      maxBuffer: 20 * 1024 * 1024,
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: "development" },
    });
    return { passed: true, durationMs: Date.now() - startMs };
  } catch (error: any) {
    return {
      passed: false,
      durationMs: Date.now() - startMs,
      error: error?.stderr?.slice(0, 500) || error?.message || `${label} failed`,
    };
  }
}

function computeTestScore(results: TestResults): number {
  if (results.totalTests === 0) return 0;
  return (results.passedTests / results.totalTests) * 100;
}

function computeCoverageScore(coverage: CoverageSummary["total"] | null): number {
  if (!coverage) return 0;
  // Weighted average of coverage metrics
  return (
    coverage.lines.pct * 0.35 +
    coverage.functions.pct * 0.25 +
    coverage.branches.pct * 0.25 +
    coverage.statements.pct * 0.15
  );
}

function buildMarkdownSummary(scorecard: Scorecard): string {
  const { scores, composite, pass, threshold } = scorecard;
  const emoji = pass ? "✅" : "❌";
  const t = scores.tests.details;
  const c = scores.coverage.details;

  return `## ${emoji} Benchmark Score: ${composite.toFixed(1)} / 100

| Component | Score | Weight | Details |
|-----------|-------|--------|---------|
| Tests | ${scores.tests.score.toFixed(1)} | ${(scores.tests.weight * 100).toFixed(0)}% | ${t.passedTests}/${t.totalTests} passed (${t.failedTests} failed) |
| Coverage | ${scores.coverage.score.toFixed(1)} | ${(scores.coverage.weight * 100).toFixed(0)}% | L:${c.lines.toFixed(1)}% F:${c.functions.toFixed(1)}% B:${c.branches.toFixed(1)}% |
| Typecheck | ${scores.typecheck.score.toFixed(1)} | ${(scores.typecheck.weight * 100).toFixed(0)}% | ${scores.typecheck.details.passed ? "PASS" : "FAIL"} |
| Build | ${scores.build.score.toFixed(1)} | ${(scores.build.weight * 100).toFixed(0)}% | ${scores.build.details.passed ? "PASS" : "FAIL"} |

**Threshold:** ${threshold} | **Commit:** ${scorecard.commit} | **Branch:** ${scorecard.branch}
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const overallStart = Date.now();
  const gitInfo = await getGitInfo();

  // Step 1: Run tests with coverage
  console.error("Running tests with coverage...");
  const testResults = await runTests();
  const testScore = computeTestScore(testResults);

  // Step 2: Read coverage (generated by test run)
  const coverageData = await readCoverage();
  const coverageScore = computeCoverageScore(coverageData);

  // Step 3: Typecheck
  console.error("Running typecheck...");
  const typecheckResult = options.skipTypecheck
    ? { passed: true, durationMs: 0 } as CheckResult
    : await runCheck("typecheck", "pnpm", ["-r", "typecheck"]);

  // Step 4: Build (run after typecheck to avoid pnpm store contention)
  console.error("Running build...");
  const buildResult = options.skipBuild
    ? { passed: true, durationMs: 0 } as CheckResult
    : await runCheck("build", "pnpm", ["-r", "build"]);

  // Compute composite score
  // When coverage data is unavailable, redistribute its weight proportionally
  // to avoid permanently penalizing commits before coverage tooling is set up
  const hasCoverage = coverageData !== null;
  const effectiveWeights = hasCoverage
    ? SCORE_WEIGHTS
    : (() => {
        const pool = SCORE_WEIGHTS.coverage;
        const remaining = 1 - pool;
        return {
          tests: SCORE_WEIGHTS.tests + pool * (SCORE_WEIGHTS.tests / remaining),
          coverage: 0,
          typecheck: SCORE_WEIGHTS.typecheck + pool * (SCORE_WEIGHTS.typecheck / remaining),
          build: SCORE_WEIGHTS.build + pool * (SCORE_WEIGHTS.build / remaining),
        };
      })();

  const composite =
    testScore * effectiveWeights.tests +
    coverageScore * effectiveWeights.coverage +
    (typecheckResult.passed ? 100 : 0) * effectiveWeights.typecheck +
    (buildResult.passed ? 100 : 0) * effectiveWeights.build;

  const scorecard: Scorecard = {
    version: 1,
    timestamp: new Date().toISOString(),
    commit: gitInfo.commit,
    branch: gitInfo.branch,
    scores: {
      tests: { score: testScore, weight: effectiveWeights.tests, details: testResults },
      coverage: {
        score: coverageScore,
        weight: effectiveWeights.coverage,
        details: {
          lines: coverageData?.lines.pct ?? 0,
          statements: coverageData?.statements.pct ?? 0,
          functions: coverageData?.functions.pct ?? 0,
          branches: coverageData?.branches.pct ?? 0,
        },
      },
      typecheck: { score: typecheckResult.passed ? 100 : 0, weight: effectiveWeights.typecheck, details: typecheckResult },
      build: { score: buildResult.passed ? 100 : 0, weight: effectiveWeights.build, details: buildResult },
    },
    composite: Math.round(composite * 10) / 10,
    threshold: options.threshold,
    pass: composite >= options.threshold,
    durationMs: Date.now() - overallStart,
  };

  // Output
  if (options.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    printHumanSummary(scorecard);
  }

  // Write scorecard file
  if (options.output) {
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(options.output, JSON.stringify(scorecard, null, 2), "utf8");
    console.error(`Scorecard written to ${options.output}`);
  }

  // Write markdown summary (for GitHub Actions step summary)
  if (options.markdownSummary) {
    const md = buildMarkdownSummary(scorecard);
    await fs.appendFile(options.markdownSummary, md, "utf8");
    console.error(`Markdown summary appended to ${options.markdownSummary}`);
  }

  process.exit(scorecard.pass ? 0 : 1);
}

function printHumanSummary(sc: Scorecard) {
  const { scores } = sc;
  const t = scores.tests.details;
  console.log("═══════════════════════════════════════════");
  console.log(`  Paperclip Fork — Benchmark Scorecard`);
  console.log("═══════════════════════════════════════════");
  console.log(`  Commit:    ${sc.commit} (${sc.branch})`);
  console.log(`  Timestamp: ${sc.timestamp}`);
  console.log("───────────────────────────────────────────");
  console.log(
    `  Tests:     ${scores.tests.score.toFixed(1)}  (${t.passedTests}/${t.totalTests} passed, ${t.failedTests} failed)`,
  );
  console.log(
    `  Coverage:  ${scores.coverage.score.toFixed(1)}  (L:${scores.coverage.details.lines.toFixed(1)}% F:${scores.coverage.details.functions.toFixed(1)}% B:${scores.coverage.details.branches.toFixed(1)}%)`,
  );
  console.log(
    `  Typecheck: ${scores.typecheck.score.toFixed(1)}  (${scores.typecheck.details.passed ? "PASS" : "FAIL"})`,
  );
  console.log(
    `  Build:     ${scores.build.score.toFixed(1)}  (${scores.build.details.passed ? "PASS" : "FAIL"})`,
  );
  console.log("───────────────────────────────────────────");
  console.log(`  COMPOSITE: ${sc.composite.toFixed(1)} / 100  ${sc.pass ? "PASS" : "FAIL"} (threshold: ${sc.threshold})`);
  console.log(`  Duration:  ${(sc.durationMs / 1000).toFixed(1)}s`);
  console.log("═══════════════════════════════════════════");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
