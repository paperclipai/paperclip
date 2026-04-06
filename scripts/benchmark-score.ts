#!/usr/bin/env -S node --import tsx/esm

/**
 * Paperclip Fork — Commit Benchmark Score (v2)
 *
 * Computes a composite quality score across 8 dimensions:
 *   - Test pass rate (15%)
 *   - Code coverage (20%)
 *   - TypeScript typecheck (10%)
 *   - Build success (10%)
 *   - Security audit (15%)
 *   - Code health (15%)
 *   - Lint / diagnostics (10%)
 *   - Documentation (5%)
 *
 * Each dimension produces a 0-100 score. The composite is the weighted average.
 * Exit code 0 = pass, 1 = below threshold.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCORE_WEIGHTS = {
  tests: 0.15,
  coverage: 0.20,
  typecheck: 0.10,
  build: 0.10,
  security: 0.15,
  codeHealth: 0.15,
  lint: 0.10,
  docs: 0.05,
} as const;

const DEFAULT_SCORE_THRESHOLD = 70;

// Code health thresholds (graduated scoring)
const ANY_COUNT_IDEAL = 0;
const ANY_COUNT_ACCEPTABLE = 50;
const ANY_COUNT_MAX = 200; // above this = 0 points

const FILE_SIZE_WARN = 1000; // lines
const FILE_SIZE_MAX = 3000; // lines — above this penalizes heavily

const TODO_FIXME_IDEAL = 0;
const TODO_FIXME_MAX = 100; // above this = 0 points

// Source directories to scan
const SOURCE_DIRS = [
  "server/src",
  "packages/*/src",
  "packages/adapters/*/src",
  "cli/src",
  "ui/src",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface SecurityDetails {
  npmAuditVulns: { critical: number; high: number; moderate: number; low: number };
  forbiddenTokensClean: boolean;
  hardcodedSecrets: number;
}

interface CodeHealthDetails {
  anyCount: number;
  oversizedFiles: number;
  totalSourceFiles: number;
  todoFixmeCount: number;
  maxFileLines: number;
}

interface LintDetails {
  tsDiagnosticCount: number;
  unusedExports: number;
}

interface DocsDetails {
  exportedFunctions: number;
  documentedFunctions: number;
  coveragePct: number;
}

interface DimensionScore<D = unknown> {
  score: number;
  weight: number;
  details: D;
}

interface Scorecard {
  version: 2;
  timestamp: string;
  commit: string;
  branch: string;
  scores: {
    tests: DimensionScore<TestResults>;
    coverage: DimensionScore<{ lines: number; statements: number; functions: number; branches: number }>;
    typecheck: DimensionScore<CheckResult>;
    build: DimensionScore<CheckResult>;
    security: DimensionScore<SecurityDetails>;
    codeHealth: DimensionScore<CodeHealthDetails>;
    lint: DimensionScore<LintDetails>;
    docs: DimensionScore<DocsDetails>;
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
  skipSecurity: boolean;
  markdownSummary: string | null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    output: null,
    threshold: DEFAULT_SCORE_THRESHOLD,
    skipBuild: false,
    skipTypecheck: false,
    skipSecurity: false,
    markdownSummary: null,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--json": options.json = true; break;
      case "--output": options.output = argv[++i] ?? null; break;
      case "--threshold":
        options.threshold = Number.parseInt(argv[++i] ?? "", 10) || DEFAULT_SCORE_THRESHOLD;
        break;
      case "--skip-build": options.skipBuild = true; break;
      case "--skip-typecheck": options.skipTypecheck = true; break;
      case "--skip-security": options.skipSecurity = true; break;
      case "--markdown-summary": options.markdownSummary = argv[++i] ?? null; break;
      case "--help": printHelp(); process.exit(0); break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: tsx scripts/benchmark-score.ts [options]

Computes a composite quality score (v2) for the current commit.

Dimensions: tests (15%), coverage (20%), typecheck (10%), build (10%),
security (15%), code health (15%), lint (10%), docs (5%)

Options:
  --json                 Output JSON scorecard to stdout
  --output <path>        Write scorecard JSON to file
  --threshold <n>        Minimum passing score (default: ${DEFAULT_SCORE_THRESHOLD})
  --skip-build           Skip the build step
  --skip-typecheck       Skip the typecheck step
  --skip-security        Skip npm audit
  --markdown-summary <f> Write markdown summary to file (for GitHub step summary)
  --help                 Show this help
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getGitInfo(): Promise<{ commit: string; branch: string }> {
  try {
    const [commitResult, branchResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--short", "HEAD"]),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    return { commit: commitResult.stdout.trim(), branch: branchResult.stdout.trim() };
  } catch {
    return { commit: "unknown", branch: "unknown" };
  }
}

function resolveProjectRoot(): string {
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

/** Linear interpolation: score 100 at `ideal`, 0 at `worst`. Clamped [0,100]. */
function linearScore(value: number, ideal: number, worst: number): number {
  if (ideal === worst) return value <= ideal ? 100 : 0;
  const raw = ((value - worst) / (ideal - worst)) * 100;
  return Math.max(0, Math.min(100, raw));
}

async function execQuiet(cmd: string, args: string[], opts?: { cwd?: string; maxBuffer?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(cmd, args, {
      maxBuffer: opts?.maxBuffer ?? 20 * 1024 * 1024,
      cwd: opts?.cwd ?? PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: "development" },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      exitCode: error?.code ?? 1,
    };
  }
}

async function globSourceFiles(): Promise<string[]> {
  // Find all .ts source files by scanning each known source directory individually
  // to avoid `find` failing entirely when one directory doesn't exist
  const candidateDirs = [
    path.join(PROJECT_ROOT, "server", "src"),
    path.join(PROJECT_ROOT, "packages"),
    path.join(PROJECT_ROOT, "cli", "src"),
    path.join(PROJECT_ROOT, "ui", "src"),
  ];

  const files: string[] = [];
  for (const dir of candidateDirs) {
    // Check if directory exists first
    try { await fs.access(dir); } catch { continue; }
    const result = await execQuiet("find", [
      dir,
      "-name", "*.ts",
      "-not", "-name", "*.d.ts",
      "-not", "-name", "*.test.ts",
      "-not", "-name", "*.spec.ts",
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/dist/*",
      "-type", "f",
    ]);
    files.push(...result.stdout.trim().split("\n").filter(Boolean));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Dimension 1: Tests (15%)
// ---------------------------------------------------------------------------

async function runTests(): Promise<TestResults> {
  const startMs = Date.now();
  const jsonOutputFile = path.join(os.tmpdir(), `vitest-results-${Date.now()}.json`);
  try {
    try {
      await execFileAsync(
        "npx",
        [
          "vitest", "run", "--coverage",
          "--reporter=default", "--reporter=json",
          "--outputFile.json", jsonOutputFile,
        ],
        {
          maxBuffer: 50 * 1024 * 1024,
          cwd: PROJECT_ROOT,
          env: { ...process.env, NODE_ENV: "development" },
          // Ensure vitest finds the root config
          shell: false,
        },
      );
    } catch (error: any) {
      try { await fs.access(jsonOutputFile); } catch {
        const combined = (error?.stdout ?? "") + (error?.stderr ?? "");
        if (combined) return parseVitestJson(combined, Date.now() - startMs);
        return emptyTestResults(Date.now() - startMs);
      }
    }
    const jsonContent = await fs.readFile(jsonOutputFile, "utf8");
    return parseVitestJson(jsonContent, Date.now() - startMs);
  } catch {
    return emptyTestResults(Date.now() - startMs);
  } finally {
    fs.unlink(jsonOutputFile).catch(() => {});
  }
}

function emptyTestResults(durationMs: number): TestResults {
  return { totalTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0, totalSuites: 0, passedSuites: 0, failedSuites: 0, durationMs };
}

function parseVitestJson(content: string, durationMs: number): TestResults {
  const jsonMatch = content.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (!jsonMatch) return parseVitestSummary(content, durationMs);
  try {
    const data = JSON.parse(jsonMatch[0]);
    const testResults = data.testResults ?? [];
    let passed = 0, failed = 0, skipped = 0, passedSuites = 0, failedSuites = 0;
    for (const suite of testResults) {
      if (suite.status === "passed") passedSuites++;
      else if (suite.status === "failed") failedSuites++;
      for (const test of suite.assertionResults ?? []) {
        if (test.status === "passed") passed++;
        else if (test.status === "failed") failed++;
        else skipped++;
      }
    }
    return { totalTests: passed + failed + skipped, passedTests: passed, failedTests: failed, skippedTests: skipped, totalSuites: testResults.length, passedSuites, failedSuites, durationMs };
  } catch {
    return parseVitestSummary(content, durationMs);
  }
}

function parseVitestSummary(output: string, durationMs: number): TestResults {
  const suitesMatch = output.match(/Test Files\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed\s+\((\d+)\)/);
  const testsMatch = output.match(/Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?\s+\((\d+)\)/);
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

function computeTestScore(results: TestResults): number {
  if (results.totalTests === 0) return 0;
  // Penalize heavily: each failed test costs proportionally more than just pass rate
  const passRate = results.passedTests / results.totalTests;
  // Below 95% pass rate = sharp drop-off
  if (passRate >= 0.99) return 100;
  if (passRate >= 0.95) return 80 + (passRate - 0.95) * 500; // 80-100 for 95-99%
  return passRate * 84; // 0-80 for 0-95%
}

// ---------------------------------------------------------------------------
// Dimension 2: Coverage (20%)
// ---------------------------------------------------------------------------

async function readCoverage(): Promise<CoverageSummary["total"] | null> {
  // Try multiple possible coverage locations
  const candidates = [
    path.join(PROJECT_ROOT, "coverage", "coverage-summary.json"),
    path.join(PROJECT_ROOT, "server", "coverage", "coverage-summary.json"),
    path.join(process.cwd(), "coverage", "coverage-summary.json"),
  ];
  for (const coveragePath of candidates) {
    try {
      const raw = await fs.readFile(coveragePath, "utf8");
      console.error(`Coverage data found at: ${coveragePath}`);
      return (JSON.parse(raw) as CoverageSummary).total;
    } catch { /* try next */ }
  }
  // Debug: list what's in the coverage directory
  try {
    const coverageDir = path.join(PROJECT_ROOT, "coverage");
    const files = await fs.readdir(coverageDir);
    console.error(`Coverage dir contents: ${files.join(", ")}`);
  } catch {
    console.error(`No coverage directory found at ${path.join(PROJECT_ROOT, "coverage")}`);
  }
  return null;
}

function computeCoverageScore(coverage: CoverageSummary["total"] | null): number {
  if (!coverage) return 0;
  // Weighted average, but with higher expectations: 80%+ coverage = good
  const raw = coverage.lines.pct * 0.30 + coverage.branches.pct * 0.30 + coverage.functions.pct * 0.25 + coverage.statements.pct * 0.15;
  // Scale: 80%+ coverage = 100 score, <30% = 0
  return linearScore(raw, 80, 30);
}

// ---------------------------------------------------------------------------
// Dimension 3: Typecheck (10%)
// ---------------------------------------------------------------------------

async function runTypecheck(): Promise<CheckResult> {
  const startMs = Date.now();
  const result = await execQuiet("pnpm", ["-r", "typecheck"]);
  return {
    passed: result.exitCode === 0,
    durationMs: Date.now() - startMs,
    error: result.exitCode !== 0 ? result.stderr.slice(0, 500) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Dimension 4: Build (10%)
// ---------------------------------------------------------------------------

async function runBuild(): Promise<CheckResult> {
  const startMs = Date.now();
  const result = await execQuiet("pnpm", ["-r", "build"]);
  return {
    passed: result.exitCode === 0,
    durationMs: Date.now() - startMs,
    error: result.exitCode !== 0 ? result.stderr.slice(0, 500) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Dimension 5: Security (15%)
// ---------------------------------------------------------------------------

async function runSecurityChecks(skip: boolean): Promise<{ score: number; details: SecurityDetails }> {
  const details: SecurityDetails = {
    npmAuditVulns: { critical: 0, high: 0, moderate: 0, low: 0 },
    forbiddenTokensClean: true,
    hardcodedSecrets: 0,
  };

  if (skip) return { score: 100, details };

  // npm audit
  let auditScore = 100;
  try {
    const auditResult = await execQuiet("pnpm", ["audit", "--json"], { maxBuffer: 50 * 1024 * 1024 });
    try {
      const auditData = JSON.parse(auditResult.stdout);
      const meta = auditData.metadata?.vulnerabilities ?? {};
      details.npmAuditVulns = {
        critical: meta.critical ?? 0,
        high: meta.high ?? 0,
        moderate: meta.moderate ?? 0,
        low: meta.low ?? 0,
      };
    } catch {
      // pnpm audit output format varies; try line-based parsing
      const criticalMatch = auditResult.stdout.match(/(\d+)\s+critical/i);
      const highMatch = auditResult.stdout.match(/(\d+)\s+high/i);
      if (criticalMatch) details.npmAuditVulns.critical = parseInt(criticalMatch[1]);
      if (highMatch) details.npmAuditVulns.high = parseInt(highMatch[1]);
    }
    // Critical = -40, High = -20, Moderate = -5 each
    auditScore = Math.max(0, 100
      - details.npmAuditVulns.critical * 40
      - details.npmAuditVulns.high * 20
      - details.npmAuditVulns.moderate * 5
      - details.npmAuditVulns.low * 1);
  } catch { /* audit unavailable */ }

  // Forbidden tokens check
  let tokensScore = 100;
  try {
    const tokensResult = await execQuiet("node", ["scripts/check-forbidden-tokens.mjs"]);
    details.forbiddenTokensClean = tokensResult.exitCode === 0;
    if (!details.forbiddenTokensClean) tokensScore = 0;
  } catch {
    // Script may not exist; skip gracefully
  }

  // Hardcoded secrets scan (grep for common patterns)
  let secretsScore = 100;
  try {
    const secretPatterns = [
      "sk-[a-zA-Z0-9]{20,}",            // OpenAI keys
      "AKIA[0-9A-Z]{16}",               // AWS access keys
      "ghp_[a-zA-Z0-9]{36}",            // GitHub PATs
      "gho_[a-zA-Z0-9]{36}",            // GitHub OAuth tokens
      "password\\s*[:=]\\s*[\"'][^\"']+[\"']", // hardcoded passwords
    ];
    for (const pattern of secretPatterns) {
      const result = await execQuiet("grep", [
        "-rn", "-E", pattern,
        "--include=*.ts", "--include=*.js", "--include=*.json",
        "--exclude-dir=node_modules", "--exclude-dir=dist",
        "--exclude-dir=.git", "--exclude=pnpm-lock.yaml",
        "--exclude=benchmark-score.ts", // exclude this script's patterns
        ".",
      ]);
      const matches = result.stdout.trim().split("\n").filter(Boolean);
      // Filter out test files and mock data
      const realMatches = matches.filter(m =>
        !m.includes(".test.") && !m.includes("__mocks__") && !m.includes("fixtures/")
        && !m.includes("// example") && !m.includes("mock")
      );
      details.hardcodedSecrets += realMatches.length;
    }
    // Each hardcoded secret costs 25 points
    secretsScore = Math.max(0, 100 - details.hardcodedSecrets * 25);
  } catch { /* grep unavailable */ }

  // Composite: audit 50%, tokens 25%, secrets 25%
  const score = auditScore * 0.50 + tokensScore * 0.25 + secretsScore * 0.25;
  return { score, details };
}

// ---------------------------------------------------------------------------
// Dimension 6: Code Health (15%)
// ---------------------------------------------------------------------------

async function runCodeHealthChecks(): Promise<{ score: number; details: CodeHealthDetails }> {
  const sourceFiles = await globSourceFiles();
  const details: CodeHealthDetails = {
    anyCount: 0,
    oversizedFiles: 0,
    totalSourceFiles: sourceFiles.length,
    todoFixmeCount: 0,
    maxFileLines: 0,
  };

  // Count `any` usage across source
  try {
    const result = await execQuiet("grep", [
      "-rn", "-E", ":\\s*any\\b|as\\s+any\\b|<any>",
      "--include=*.ts",
      "--exclude-dir=node_modules", "--exclude-dir=dist",
      "--exclude=*.d.ts", "--exclude=*.test.ts",
      ".",
    ]);
    details.anyCount = result.stdout.trim().split("\n").filter(Boolean).length;
  } catch { /* skip */ }

  // Check file sizes and find oversized files
  for (const file of sourceFiles) {
    try {
      const content = await fs.readFile(file, "utf8");
      const lines = content.split("\n").length;
      if (lines > details.maxFileLines) details.maxFileLines = lines;
      if (lines > FILE_SIZE_WARN) details.oversizedFiles++;
    } catch { /* skip */ }
  }

  // Count TODO/FIXME/HACK/XXX
  try {
    const result = await execQuiet("grep", [
      "-rn", "-E", "\\b(TODO|FIXME|HACK|XXX)\\b",
      "--include=*.ts",
      "--exclude-dir=node_modules", "--exclude-dir=dist",
      ".",
    ]);
    details.todoFixmeCount = result.stdout.trim().split("\n").filter(Boolean).length;
  } catch { /* skip */ }

  // Score components
  const anyScore = linearScore(details.anyCount, ANY_COUNT_IDEAL, ANY_COUNT_MAX);
  const fileSizeScore = details.totalSourceFiles > 0
    ? linearScore(details.oversizedFiles, 0, Math.ceil(details.totalSourceFiles * 0.1))
    : 100;
  const todoScore = linearScore(details.todoFixmeCount, TODO_FIXME_IDEAL, TODO_FIXME_MAX);

  // Weighted: any 50%, file size 30%, TODO debt 20%
  const score = anyScore * 0.50 + fileSizeScore * 0.30 + todoScore * 0.20;
  return { score, details };
}

// ---------------------------------------------------------------------------
// Dimension 7: Lint / Diagnostics (10%)
// ---------------------------------------------------------------------------

async function runLintChecks(): Promise<{ score: number; details: LintDetails }> {
  const details: LintDetails = { tsDiagnosticCount: 0, unusedExports: 0 };

  // Count TypeScript diagnostics (errors + warnings from tsc)
  // Use --noEmit --pretty false for parseable output
  try {
    const result = await execQuiet("npx", [
      "tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json",
    ]);
    if (result.exitCode !== 0) {
      // Count error lines: "file.ts(line,col): error TS..."
      const errorLines = result.stdout.split("\n").filter(l => l.includes(": error TS"));
      details.tsDiagnosticCount = errorLines.length;
    }
  } catch { /* skip */ }

  // Count unused exports (rough heuristic: exported functions not imported elsewhere)
  // This is expensive for large repos, so we just count `export` density as a proxy
  try {
    const result = await execQuiet("grep", [
      "-rn", "-E", "^export (const|function|class|type|interface|enum) ",
      "--include=*.ts", "--exclude=*.d.ts", "--exclude=*.test.ts",
      "--exclude-dir=node_modules", "--exclude-dir=dist",
      "server/src",
    ]);
    const exports = result.stdout.trim().split("\n").filter(Boolean);
    // Check how many of these are imported somewhere
    let unused = 0;
    for (const line of exports.slice(0, 100)) { // cap to avoid timeout
      const nameMatch = line.match(/export (?:const|function|class|type|interface|enum) (\w+)/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const importCheck = await execQuiet("grep", [
        "-rn", "-l", name,
        "--include=*.ts", "--exclude=*.d.ts",
        "--exclude-dir=node_modules", "--exclude-dir=dist",
        ".",
      ]);
      const importFiles = importCheck.stdout.trim().split("\n").filter(Boolean);
      // If only found in the defining file, it's likely unused
      if (importFiles.length <= 1) unused++;
    }
    details.unusedExports = unused;
  } catch { /* skip */ }

  // Score: 0 diagnostics = 100, each diagnostic costs 5 points
  const diagScore = Math.max(0, 100 - details.tsDiagnosticCount * 5);
  // Unused exports: minor penalty
  const unusedScore = Math.max(0, 100 - details.unusedExports * 2);

  const score = diagScore * 0.70 + unusedScore * 0.30;
  return { score, details };
}

// ---------------------------------------------------------------------------
// Dimension 8: Documentation (5%)
// ---------------------------------------------------------------------------

async function runDocsChecks(): Promise<{ score: number; details: DocsDetails }> {
  const details: DocsDetails = { exportedFunctions: 0, documentedFunctions: 0, coveragePct: 0 };

  try {
    // Find exported functions in server/src
    const result = await execQuiet("grep", [
      "-rn", "-B1", "export function ",
      "--include=*.ts", "--exclude=*.d.ts", "--exclude=*.test.ts",
      "--exclude-dir=node_modules", "--exclude-dir=dist",
      "server/src",
    ]);
    const lines = result.stdout.split("\n");
    let exported = 0;
    let documented = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("export function ")) {
        exported++;
        // Check if previous line(s) have JSDoc or comment
        const prev = lines[i - 1] ?? "";
        if (prev.includes("*/") || prev.includes("//") || prev.includes("/**")) {
          documented++;
        }
      }
    }
    details.exportedFunctions = exported;
    details.documentedFunctions = documented;
    details.coveragePct = exported > 0 ? (documented / exported) * 100 : 100;
  } catch { /* skip */ }

  // Score = documentation coverage percentage
  return { score: details.coveragePct, details };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function buildMarkdownSummary(scorecard: Scorecard): string {
  const { scores, composite, pass, threshold } = scorecard;
  const emoji = pass ? "✅" : "❌";
  const t = scores.tests.details;
  const c = scores.coverage.details;
  const s = scores.security.details;
  const h = scores.codeHealth.details;
  const l = scores.lint.details;
  const d = scores.docs.details;

  return `## ${emoji} Benchmark Score: ${composite.toFixed(1)} / 100

| Dimension | Score | Weight | Details |
|-----------|-------|--------|---------|
| Tests | ${scores.tests.score.toFixed(1)} | ${(scores.tests.weight * 100).toFixed(0)}% | ${t.passedTests}/${t.totalTests} passed (${t.failedTests} failed) |
| Coverage | ${scores.coverage.score.toFixed(1)} | ${(scores.coverage.weight * 100).toFixed(0)}% | L:${c.lines.toFixed(1)}% B:${c.branches.toFixed(1)}% F:${c.functions.toFixed(1)}% |
| Typecheck | ${scores.typecheck.score.toFixed(1)} | ${(scores.typecheck.weight * 100).toFixed(0)}% | ${scores.typecheck.details.passed ? "PASS" : "FAIL"} |
| Build | ${scores.build.score.toFixed(1)} | ${(scores.build.weight * 100).toFixed(0)}% | ${scores.build.details.passed ? "PASS" : "FAIL"} |
| Security | ${scores.security.score.toFixed(1)} | ${(scores.security.weight * 100).toFixed(0)}% | audit: ${s.npmAuditVulns.critical}C/${s.npmAuditVulns.high}H/${s.npmAuditVulns.moderate}M, tokens: ${s.forbiddenTokensClean ? "clean" : "FAIL"}, secrets: ${s.hardcodedSecrets} |
| Code Health | ${scores.codeHealth.score.toFixed(1)} | ${(scores.codeHealth.weight * 100).toFixed(0)}% | any:${h.anyCount}, oversized:${h.oversizedFiles}/${h.totalSourceFiles}, TODO:${h.todoFixmeCount} |
| Lint | ${scores.lint.score.toFixed(1)} | ${(scores.lint.weight * 100).toFixed(0)}% | TS errors:${l.tsDiagnosticCount}, unused exports:${l.unusedExports} |
| Docs | ${scores.docs.score.toFixed(1)} | ${(scores.docs.weight * 100).toFixed(0)}% | ${d.documentedFunctions}/${d.exportedFunctions} exported fns documented (${d.coveragePct.toFixed(0)}%) |

**Threshold:** ${threshold} | **Commit:** ${scorecard.commit} | **Branch:** ${scorecard.branch}
`;
}

function printHumanSummary(sc: Scorecard) {
  const { scores } = sc;
  const t = scores.tests.details;
  const h = scores.codeHealth.details;
  const s = scores.security.details;
  console.log("═══════════════════════════════════════════════════");
  console.log("  Paperclip Fork — Benchmark Scorecard (v2)");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Commit:    ${sc.commit} (${sc.branch})`);
  console.log(`  Timestamp: ${sc.timestamp}`);
  console.log("─────────────────────────────────────────────────");
  console.log(`  Tests:       ${scores.tests.score.toFixed(1).padStart(5)}  (${t.passedTests}/${t.totalTests} passed)`);
  console.log(`  Coverage:    ${scores.coverage.score.toFixed(1).padStart(5)}  (L:${scores.coverage.details.lines.toFixed(1)}% B:${scores.coverage.details.branches.toFixed(1)}%)`);
  console.log(`  Typecheck:   ${scores.typecheck.score.toFixed(1).padStart(5)}  (${scores.typecheck.details.passed ? "PASS" : "FAIL"})`);
  console.log(`  Build:       ${scores.build.score.toFixed(1).padStart(5)}  (${scores.build.details.passed ? "PASS" : "FAIL"})`);
  console.log(`  Security:    ${scores.security.score.toFixed(1).padStart(5)}  (${s.npmAuditVulns.critical}C/${s.npmAuditVulns.high}H, secrets:${s.hardcodedSecrets})`);
  console.log(`  Code Health: ${scores.codeHealth.score.toFixed(1).padStart(5)}  (any:${h.anyCount}, oversized:${h.oversizedFiles}, TODO:${h.todoFixmeCount})`);
  console.log(`  Lint:        ${scores.lint.score.toFixed(1).padStart(5)}  (TS errors:${scores.lint.details.tsDiagnosticCount})`);
  console.log(`  Docs:        ${scores.docs.score.toFixed(1).padStart(5)}  (${scores.docs.details.coveragePct.toFixed(0)}% exported fns documented)`);
  console.log("─────────────────────────────────────────────────");
  console.log(`  COMPOSITE: ${sc.composite.toFixed(1)} / 100  ${sc.pass ? "PASS" : "FAIL"} (threshold: ${sc.threshold})`);
  console.log(`  Duration:  ${(sc.durationMs / 1000).toFixed(1)}s`);
  console.log("═══════════════════════════════════════════════════");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const overallStart = Date.now();
  const gitInfo = await getGitInfo();

  // Phase 1: Tests + coverage (sequential — tests generate coverage data)
  console.error("Phase 1/4: Running tests...");
  const testResults = await runTests();
  const testScore = computeTestScore(testResults);
  const coverageData = await readCoverage();
  const coverageScore = computeCoverageScore(coverageData);

  // Phase 2: Typecheck + build (sequential — build depends on typecheck for some packages)
  console.error("Phase 2/4: Typecheck + build...");
  const typecheckResult = options.skipTypecheck
    ? { passed: true, durationMs: 0 } as CheckResult
    : await runTypecheck();
  const buildResult = options.skipBuild
    ? { passed: true, durationMs: 0 } as CheckResult
    : await runBuild();

  // Phase 3: Security + code health + lint + docs (parallel — independent)
  console.error("Phase 3/4: Security, code health, lint, docs...");
  const [securityResult, codeHealthResult, lintResult, docsResult] = await Promise.all([
    runSecurityChecks(options.skipSecurity),
    runCodeHealthChecks(),
    runLintChecks(),
    runDocsChecks(),
  ]);

  // Phase 4: Compute composite
  console.error("Phase 4/4: Computing score...");
  const composite =
    testScore * SCORE_WEIGHTS.tests +
    coverageScore * SCORE_WEIGHTS.coverage +
    (typecheckResult.passed ? 100 : 0) * SCORE_WEIGHTS.typecheck +
    (buildResult.passed ? 100 : 0) * SCORE_WEIGHTS.build +
    securityResult.score * SCORE_WEIGHTS.security +
    codeHealthResult.score * SCORE_WEIGHTS.codeHealth +
    lintResult.score * SCORE_WEIGHTS.lint +
    docsResult.score * SCORE_WEIGHTS.docs;

  const scorecard: Scorecard = {
    version: 2,
    timestamp: new Date().toISOString(),
    commit: gitInfo.commit,
    branch: gitInfo.branch,
    scores: {
      tests: { score: testScore, weight: SCORE_WEIGHTS.tests, details: testResults },
      coverage: {
        score: coverageScore,
        weight: SCORE_WEIGHTS.coverage,
        details: {
          lines: coverageData?.lines.pct ?? 0,
          statements: coverageData?.statements.pct ?? 0,
          functions: coverageData?.functions.pct ?? 0,
          branches: coverageData?.branches.pct ?? 0,
        },
      },
      typecheck: { score: typecheckResult.passed ? 100 : 0, weight: SCORE_WEIGHTS.typecheck, details: typecheckResult },
      build: { score: buildResult.passed ? 100 : 0, weight: SCORE_WEIGHTS.build, details: buildResult },
      security: { score: securityResult.score, weight: SCORE_WEIGHTS.security, details: securityResult.details },
      codeHealth: { score: codeHealthResult.score, weight: SCORE_WEIGHTS.codeHealth, details: codeHealthResult.details },
      lint: { score: lintResult.score, weight: SCORE_WEIGHTS.lint, details: lintResult.details },
      docs: { score: docsResult.score, weight: SCORE_WEIGHTS.docs, details: docsResult.details },
    },
    composite: Math.round(composite * 10) / 10,
    threshold: options.threshold,
    pass: composite >= options.threshold,
    durationMs: Date.now() - overallStart,
  };

  if (options.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    printHumanSummary(scorecard);
  }

  if (options.output) {
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(options.output, JSON.stringify(scorecard, null, 2), "utf8");
    console.error(`Scorecard written to ${options.output}`);
  }

  if (options.markdownSummary) {
    const md = buildMarkdownSummary(scorecard);
    await fs.appendFile(options.markdownSummary, md, "utf8");
    console.error(`Markdown summary appended to ${options.markdownSummary}`);
  }

  process.exit(scorecard.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
