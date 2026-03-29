import fs from "node:fs/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evalResults, evalCaseResults, issueComments, heartbeatRuns } from "@paperclipai/db";
import type {
  EvalBundle,
  EvalCase,
  EvalExpectation,
  EvalExpectationResult,
  EvalResult,
  EvalResultStatus,
  EvalRunSummary,
  EvalSummary,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";

const DEFAULT_TIMEOUT_SEC = 120;
const POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Bundle loading
// ---------------------------------------------------------------------------

export async function loadBundle(bundlePath: string): Promise<EvalBundle> {
  const raw = await fs.readFile(bundlePath, "utf-8");
  const parsed = JSON.parse(raw) as EvalBundle;
  if (!parsed.id || !parsed.name || !Array.isArray(parsed.cases)) {
    throw new Error(`Invalid eval bundle at ${bundlePath}`);
  }
  if (!parsed.createdAt) {
    parsed.createdAt = new Date().toISOString();
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Expectation checking
// ---------------------------------------------------------------------------

export function checkExpectation(
  expectation: EvalExpectation,
  opts: {
    runStatus?: string | null;
    issueStatus?: string | null;
    comments: Array<{ body: string | null; authorAgentId: string | null }>;
    resultJson?: Record<string, unknown> | null;
  },
): EvalExpectationResult {
  const { comments } = opts;

  switch (expectation.type) {
    case "contains": {
      const target = expectation.value ?? "";
      const allText = comments.map((c) => c.body ?? "").join("\n");
      const passed = allText.includes(target);
      return {
        expectation,
        passed,
        actual: passed ? `Found "${target}" in comments` : `"${target}" not found in comments`,
        reason: passed ? undefined : `Expected comment text to contain "${target}"`,
      };
    }
    case "not_contains": {
      const target = expectation.value ?? "";
      const allText = comments.map((c) => c.body ?? "").join("\n");
      const passed = !allText.includes(target);
      return {
        expectation,
        passed,
        actual: passed ? `"${target}" not present` : `Found "${target}" in comments`,
        reason: passed ? undefined : `Expected comment text NOT to contain "${target}"`,
      };
    }
    case "regex": {
      const pattern = new RegExp(expectation.value ?? "");
      const allText = comments.map((c) => c.body ?? "").join("\n");
      const passed = pattern.test(allText);
      return {
        expectation,
        passed,
        actual: passed ? `Regex matched` : `Regex /${expectation.value}/ did not match`,
        reason: passed ? undefined : `Expected comment text to match /${expectation.value}/`,
      };
    }
    case "status_change": {
      const expected = expectation.expectedStatus;
      const passed = opts.issueStatus === expected;
      return {
        expectation,
        passed,
        actual: `Issue status: ${opts.issueStatus ?? "unknown"}`,
        reason: passed ? undefined : `Expected issue status "${expected}", got "${opts.issueStatus}"`,
      };
    }
    case "comment_created": {
      const agentComments = comments.filter((c) => c.authorAgentId != null);
      const passed = agentComments.length > 0;
      return {
        expectation,
        passed,
        actual: `${agentComments.length} agent comment(s)`,
        reason: passed ? undefined : "Expected at least one agent comment",
      };
    }
    case "delegation": {
      const delegationKeywords = [
        "위임", "delegate", "assign", "배정", "담당",
        "@", "에게", "부여",
      ];
      const allText = comments.map((c) => c.body ?? "").join("\n").toLowerCase();
      const passed = delegationKeywords.some((kw) => allText.includes(kw.toLowerCase()));
      return {
        expectation,
        passed,
        actual: passed ? "Delegation-related content found" : "No delegation indicators found",
        reason: passed ? undefined : "Expected delegation behavior in comments",
      };
    }
    case "rubric": {
      // Placeholder: rubric scoring is not yet implemented.
      return {
        expectation,
        passed: true,
        score: 1,
        reason: "Rubric scoring placeholder - always passes (LLM scoring not yet implemented)",
      };
    }
    default: {
      return {
        expectation,
        passed: false,
        reason: `Unknown expectation type: ${(expectation as EvalExpectation).type}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Constraint checking (hard pass/fail gates from EvalCase.constraints)
// ---------------------------------------------------------------------------

export function checkConstraints(
  evalCase: EvalCase,
  result: {
    runCompleted: boolean;
    runStatus: string | null;
    durationMs: number;
    output: string;
  },
): { passed: boolean; failures: string[] } {
  const constraints = evalCase.constraints;
  if (!constraints) return { passed: true, failures: [] };

  const failures: string[] = [];

  // shouldSucceed gate
  if (constraints.shouldSucceed && !result.runCompleted) {
    failures.push("Expected run to succeed but it did not complete");
  }
  if (!constraints.shouldSucceed && result.runCompleted && result.runStatus === "completed") {
    failures.push("Expected run to fail but it succeeded");
  }

  // expectedOutputPatterns
  if (constraints.expectedOutputPatterns) {
    for (const pattern of constraints.expectedOutputPatterns) {
      if (!new RegExp(pattern).test(result.output)) {
        failures.push(`Expected output to match pattern: ${pattern}`);
      }
    }
  }

  // forbiddenPatterns
  if (constraints.forbiddenPatterns) {
    for (const pattern of constraints.forbiddenPatterns) {
      if (new RegExp(pattern).test(result.output)) {
        failures.push(`Output matched forbidden pattern: ${pattern}`);
      }
    }
  }

  // maxDurationMs
  if (constraints.maxDurationMs != null && result.durationMs > constraints.maxDurationMs) {
    failures.push(`Duration ${result.durationMs}ms exceeded max ${constraints.maxDurationMs}ms`);
  }

  return { passed: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Eval runner service
// ---------------------------------------------------------------------------

export function evalRunnerService(db: Db) {
  const issueSvc = issueService(db);
  const heartbeat = heartbeatService(db);

  /**
   * Derive a result status from a case result.
   */
  function deriveStatus(result: { passed: boolean; error?: string }): EvalResultStatus {
    if (result.error) return "error";
    return result.passed ? "passed" : "failed";
  }

  async function runCase(
    evalCase: EvalCase,
    companyId: string,
    agentId: string,
  ): Promise<EvalResult> {
    const start = Date.now();
    const timeoutMs = (evalCase.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;

    try {
      // 1. Create a test issue with the eval case input
      const issue = await issueSvc.create(companyId, {
        title: `[eval] ${evalCase.input.issueTitle}`,
        description: evalCase.input.issueBody,
        status: "open",
        assigneeAgentId: agentId,
      });

      // 2. Trigger the agent via wakeup
      await heartbeat.invoke(
        agentId,
        "assignment",
        {
          issueId: issue.id,
          evalCaseId: evalCase.id,
        },
        "system",
        { actorType: "system", actorId: "eval-runner" },
      );

      // 3. Wait for a run to complete (poll or timeout)
      const deadline = Date.now() + timeoutMs;
      let runCompleted = false;
      let latestRunStatus: string | null = null;

      while (Date.now() < deadline) {
        const recentRuns = await db
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agentId),
              eq(heartbeatRuns.companyId, companyId),
            ),
          )
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(1);

        const latestRun = recentRuns[0] ?? null;
        if (latestRun && latestRun.createdAt.getTime() >= start) {
          latestRunStatus = latestRun.status;
          if (latestRun.status === "completed" || latestRun.status === "failed" || latestRun.status === "error") {
            runCompleted = true;
            break;
          }
        }

        await sleep(POLL_INTERVAL_MS);
      }

      // 4. Gather results: issue status, comments
      const updatedIssue = await issueSvc.getById(issue.id);
      const comments = await db
        .select({
          body: issueComments.body,
          authorAgentId: issueComments.authorAgentId,
        })
        .from(issueComments)
        .where(eq(issueComments.issueId, issue.id))
        .orderBy(issueComments.createdAt);

      // 5. Combine all text for constraint checking
      const allOutput = comments.map((c) => c.body ?? "").join("\n");

      // 6. Check expectations
      const expectationResults = evalCase.expectations.map((exp) =>
        checkExpectation(exp, {
          runStatus: latestRunStatus,
          issueStatus: updatedIssue?.status ?? null,
          comments,
        }),
      );

      // 7. Check hard constraints
      const constraintResult = checkConstraints(evalCase, {
        runCompleted,
        runStatus: latestRunStatus,
        durationMs: Date.now() - start,
        output: allOutput,
      });

      const allExpectationsPassed = expectationResults.every((r) => r.passed);
      const allPassed = allExpectationsPassed && constraintResult.passed;
      const duration = Date.now() - start;

      const failedExpectations = [
        ...expectationResults.filter((r) => !r.passed).map((r) => r.reason ?? "Unknown failure"),
        ...constraintResult.failures,
      ];

      if (!runCompleted) {
        return {
          caseId: evalCase.id,
          caseName: evalCase.name,
          passed: false,
          status: "error",
          duration,
          output: allOutput || undefined,
          expectations: expectationResults,
          failedExpectations,
          error: `Timed out after ${timeoutMs}ms waiting for agent run to complete (last status: ${latestRunStatus ?? "none"})`,
        };
      }

      return {
        caseId: evalCase.id,
        caseName: evalCase.name,
        passed: allPassed,
        status: allPassed ? "passed" : "failed",
        duration,
        output: allOutput || undefined,
        expectations: expectationResults,
        failedExpectations: failedExpectations.length > 0 ? failedExpectations : undefined,
      };
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, caseId: evalCase.id }, "Eval case execution error");
      return {
        caseId: evalCase.id,
        caseName: evalCase.name,
        passed: false,
        status: "error",
        duration,
        expectations: [],
        error: message,
      };
    }
  }

  async function runBundle(
    bundle: EvalBundle,
    companyId: string,
    agentId: string,
  ): Promise<EvalRunSummary> {
    const start = Date.now();
    const results: EvalResult[] = [];

    // Run all cases sequentially
    for (const evalCase of bundle.cases) {
      const result = await runCase(evalCase, companyId, agentId);
      results.push(result);
    }

    const passed = results.filter((r) => r.status === "passed").length;
    const errors = results.filter((r) => r.status === "error").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const totalCostCents = results.reduce((sum, r) => sum + (r.costCents ?? 0), 0);
    const duration = Date.now() - start;

    const summary: EvalRunSummary = {
      bundleId: bundle.id,
      bundleName: bundle.name,
      totalCases: results.length,
      passed,
      failed,
      errors,
      skipped,
      duration,
      totalCostCents,
      results,
      runAt: new Date().toISOString(),
    };

    // Persist summary to DB
    const [insertedResult] = await db.insert(evalResults).values({
      companyId,
      bundleId: bundle.id,
      bundleName: bundle.name,
      agentId,
      totalCases: summary.totalCases,
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      skipped: summary.skipped,
      totalCostCents,
      resultJson: summary as unknown as Record<string, unknown>,
      duration,
    }).returning({ id: evalResults.id });

    // Persist individual case results
    if (insertedResult && results.length > 0) {
      await db.insert(evalCaseResults).values(
        results.map((r) => ({
          companyId,
          evalResultId: insertedResult.id,
          bundleId: bundle.id,
          caseId: r.caseId,
          caseName: r.caseName,
          status: r.status,
          durationMs: r.duration,
          tokenCount: r.tokenCount ?? null,
          costCents: r.costCents ?? null,
          output: r.output ?? null,
          failedExpectations: r.failedExpectations ?? null,
          error: r.error ?? null,
        })),
      );
    }

    return summary;
  }

  // ── Public query methods ──────────────────────────────────────────────

  async function listResults(companyId: string, limit = 50) {
    return db
      .select()
      .from(evalResults)
      .where(eq(evalResults.companyId, companyId))
      .orderBy(desc(evalResults.createdAt))
      .limit(Math.min(limit, 200));
  }

  async function getResult(companyId: string, resultId: string) {
    return db
      .select()
      .from(evalResults)
      .where(and(eq(evalResults.id, resultId), eq(evalResults.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getCaseResults(companyId: string, evalResultId: string) {
    return db
      .select()
      .from(evalCaseResults)
      .where(
        and(
          eq(evalCaseResults.evalResultId, evalResultId),
          eq(evalCaseResults.companyId, companyId),
        ),
      )
      .orderBy(evalCaseResults.createdAt);
  }

  async function getSummary(companyId: string, bundleId: string): Promise<EvalSummary | null> {
    const rows = await db
      .select({
        totalCases: sql<number>`SUM(${evalResults.totalCases})::int`,
        passed: sql<number>`SUM(${evalResults.passed})::int`,
        failed: sql<number>`SUM(${evalResults.failed})::int`,
        errors: sql<number>`SUM(${evalResults.errors})::int`,
        skipped: sql<number>`SUM(${evalResults.skipped})::int`,
        totalDurationMs: sql<number>`SUM(${evalResults.duration})::int`,
        totalCostCents: sql<number>`SUM(${evalResults.totalCostCents})::int`,
      })
      .from(evalResults)
      .where(
        and(
          eq(evalResults.companyId, companyId),
          eq(evalResults.bundleId, bundleId),
        ),
      );

    const row = rows[0];
    if (!row || row.totalCases == null) return null;

    return {
      bundleId,
      totalCases: row.totalCases,
      passed: row.passed ?? 0,
      failed: row.failed ?? 0,
      errors: row.errors ?? 0,
      skipped: row.skipped ?? 0,
      totalDurationMs: row.totalDurationMs ?? 0,
      totalCostCents: row.totalCostCents ?? 0,
    };
  }

  return {
    runCase,
    runBundle,
    listResults,
    getResult,
    getCaseResults,
    getSummary,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
