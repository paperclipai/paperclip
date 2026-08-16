import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import {
  bindAtomicReviewDecision,
  executorRunSucceeded,
  formatLifecycleTimeoutDiagnostics,
  matchesAuthoritativeStageRun,
  matchesExecutorRun,
  resolveAuthoritativeRunIssue,
  type ExpectedExecutorRun,
  type ExpectedStageRun,
} from "../../server/src/test-support/signoff-policy-run-binding.js";

const LIFECYCLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-signoff-lifecycle-"));
const LIFECYCLE_SCRIPT = path.join(LIFECYCLE_DIR, "fixture-run.cjs");
fs.writeFileSync(LIFECYCLE_SCRIPT, [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const role = process.argv[2];",
  "const dir = process.argv[3];",
  "const runId = process.env.PAPERCLIP_RUN_ID;",
  "if (!runId) process.exit(2);",
  "const api = String(process.env.PAPERCLIP_API_URL || '').replace(/\\/$/, '');",
  "const resolveIssueId = async () => {",
  "  const bindingPath = path.join(dir, 'binding-' + runId + '.json');",
  "  if (!fs.existsSync(bindingPath)) return '';",
  "  let expected;",
  "  try { expected = JSON.parse(fs.readFileSync(bindingPath, 'utf8')); } catch { return ''; }",
  "  const response = await fetch(api + '/api/heartbeat-runs/' + runId, { headers: { authorization: 'Bearer ' + process.env.PAPERCLIP_API_KEY } });",
  "  if (!response.ok) return '';",
  "  let run;",
  "  try { run = await response.json(); } catch { return ''; }",
  "  const context = run && typeof run.contextSnapshot === 'object' && run.contextSnapshot !== null ? run.contextSnapshot : null;",
  "  if (!context || run.id !== runId || run.companyId !== expected.companyId || run.agentId !== expected.agentId || run.invocationSource === 'timer') return '';",
  "  if (context.issueId !== expected.issueId || context.taskId !== expected.issueId) return '';",
  "  return expected.issueId;",
  "};",
  "const release = path.join(dir, 'release-' + runId);",
  "const submit = path.join(dir, 'submit-' + runId);",
  "process.stdout.write(JSON.stringify({ role, runId }) + '\\n');",
  "const deadline = Date.now() + 55000;",
  "const wait = async () => {",
  "  if (role === 'executor' && fs.existsSync(submit)) {",
  "    const resolvedIssueId = await resolveIssueId();",
  "    if (!resolvedIssueId) process.exit(5);",
  "    const response = await fetch(api + '/api/issues/' + resolvedIssueId, {",
  "      method: 'PATCH',",
  "      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.PAPERCLIP_API_KEY, 'x-paperclip-run-id': runId },",
  "      body: JSON.stringify({ status: 'done', comment: 'Executor fixture completed verified work.' }),",
  "    });",
  "    process.stdout.write(JSON.stringify({ patchStatus: response.status, body: await response.text() }) + '\\n');",
  "    process.exit(response.ok ? 0 : 4);",
  "  }",
  "  if (role !== 'executor' && fs.existsSync(release)) process.exit(0);",
  "  if (Date.now() >= deadline) process.exit(3);",
  "  setTimeout(() => void wait(), 25);",
  "};",
  "void wait();",
].join("\n"), { mode: 0o700 });

interface LifecycleRecord {
  kind: "executor" | "reviewer" | "approver";
  issueId: string;
  runId: string;
  runStateAtDecision: string | null;
  stageId: string | null;
  stageType: string | null;
  reviewRoundId: string | null;
  expectedUpdatedAt: string | null;
  decisionId: string | null;
  httpStatus: number | null;
  resultingStatus: string | null;
  resultingAssigneeAgentId: string | null;
  cleanup: string;
}

const lifecycleRecords: LifecycleRecord[] = [];

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an issue with a two-stage execution policy (review → approval)
 *   3. Executor marks done → issue routes to reviewer (in_review)
 *   4. Reviewer approves → issue routes to approver
 *   5. Approver approves → execution completes, issue marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 *
 * Agent auth flow:
 *   - Board request (local_trusted auto-auth) handles setup/teardown.
 *   - Agent-specific actions use API keys + heartbeat run IDs.
 *   - Reviewers/approvers invoke heartbeat runs (gets run IDs) then PATCH
 *     directly without checkout (checkout would force in_progress, breaking
 *     the in_review state the signoff policy requires).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface TestContext {
  companyId: string;
  companyPrefix: string;
  executor: AgentAuth;
  reviewer: AgentAuth;
  approver: AgentAuth;
  boardRequest: APIRequestContext;
  issueIds: string[];
}

interface IssueRunLockState {
  companyId: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

interface ReviewStageIssue {
  id: string;
  companyId: string;
  status: string;
  updatedAt: string;
  assigneeAgentId: string | null;
  executionState: {
    status: string;
    currentStageId: string;
    currentStageType: "review" | "approval";
    reviewRoundId: string | null;
    currentParticipant: { type: "agent"; agentId: string } | { type: "user"; userId: string } | null;
    returnAssignee?: { type: "agent"; agentId: string } | { type: "user"; userId: string } | null;
    completedStageIds?: string[];
    lastDecisionOutcome?: string | null;
  } | null;
}

async function getIssue(board: APIRequestContext, issueId: string): Promise<ReviewStageIssue> {
  const res = await board.get(`${BASE_URL}/api/issues/${issueId}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

function expectedStageRun(issue: ReviewStageIssue, agentId: string): ExpectedStageRun | null {
  const state = issue.executionState;
  if (
    issue.status !== "in_review" ||
    state?.status !== "pending" ||
    !state.currentStageId ||
    (state.currentStageType !== "review" && state.currentStageType !== "approval") ||
    state.currentParticipant?.type !== "agent" ||
    state.currentParticipant.agentId !== agentId
  ) return null;
  return {
    companyId: issue.companyId,
    issueId: issue.id,
    agentId,
    stageId: state.currentStageId,
    stageType: state.currentStageType,
    reviewRoundId: state.reviewRoundId ?? null,
  };
}

async function recentDetailedRuns(
  board: APIRequestContext,
  companyId: string,
  agentId: string,
): Promise<unknown[]> {
  const runsRes = await board.get(
    `${BASE_URL}/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=30`,
  );
  expect(runsRes.ok()).toBe(true);
  const summaries = await runsRes.json();
  const detailed: unknown[] = [];
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (typeof summary?.id !== "string") continue;
    const runRes = await board.get(`${BASE_URL}/api/heartbeat-runs/${summary.id}`);
    if (runRes.ok()) detailed.push(await runRes.json());
  }
  return detailed;
}

function writeFixtureRunBinding(runValue: unknown, expected: {
  companyId: string;
  agentId: string;
  issueId: string;
}): string | null {
  const run = runValue as { id?: unknown };
  if (typeof run.id !== "string") return null;
  const resolved = resolveAuthoritativeRunIssue(runValue, { runId: run.id, ...expected });
  if (!resolved) return null;
  fs.writeFileSync(
    path.join(LIFECYCLE_DIR, `binding-${run.id}.json`),
    `${JSON.stringify(expected)}\n`,
    { mode: 0o600 },
  );
  return run.id;
}

async function waitForAuthoritativeStageRun(
  board: APIRequestContext,
  expected: ExpectedStageRun,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let candidates: unknown[] = [];
  do {
    candidates = await recentDetailedRuns(board, expected.companyId, expected.agentId);
    const selected = candidates.find((run) => matchesAuthoritativeStageRun(run, expected));
    const selectedId = selected ? writeFixtureRunBinding(selected, expected) : null;
    if (selectedId) return selectedId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const issue = await getIssue(board, expected.issueId);
  throw new Error(
    `No authoritative stage run appeared within ${timeoutMs}ms: ${formatLifecycleTimeoutDiagnostics({ issue, expected, candidates })}`,
  );
}

async function waitForActiveExecutorRun(
  board: APIRequestContext,
  expected: ExpectedExecutorRun,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let candidates: unknown[] = [];
  do {
    candidates = await recentDetailedRuns(board, expected.companyId, expected.agentId);
    const selected = candidates.find((runValue) => {
      const run = runValue as { status?: unknown; finishedAt?: unknown };
      return matchesExecutorRun(runValue, expected) && run.status === "running" && run.finishedAt == null;
    });
    const selectedId = selected ? writeFixtureRunBinding(selected, expected) : null;
    if (selectedId) return selectedId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const issue = await getIssue(board, expected.issueId);
  throw new Error(
    `No active executor run appeared within ${timeoutMs}ms: ${formatLifecycleTimeoutDiagnostics({ issue, expected, candidates })}`,
  );
}

async function waitForExecutorSuccess(
  board: APIRequestContext,
  expected: ExpectedExecutorRun,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let candidates: unknown[] = [];
  do {
    candidates = await recentDetailedRuns(board, expected.companyId, expected.agentId);
    const selected = candidates.find((run) => executorRunSucceeded(run, expected)) as { id?: unknown } | undefined;
    if (typeof selected?.id === "string") return selected.id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const issue = await getIssue(board, expected.issueId);
  throw new Error(
    `Executor did not reach terminal success within ${timeoutMs}ms: ${formatLifecycleTimeoutDiagnostics({ issue, expected, candidates })}`,
  );
}

async function waitForStageTransition(
  board: APIRequestContext,
  issueId: string,
  agentId: string,
  timeoutMs = 10_000,
): Promise<{ issue: ReviewStageIssue; expected: ExpectedStageRun }> {
  const deadline = Date.now() + timeoutMs;
  let issue = await getIssue(board, issueId);
  do {
    const expected = expectedStageRun(issue, agentId);
    if (expected) return { issue, expected };
    await new Promise((resolve) => setTimeout(resolve, 50));
    issue = await getIssue(board, issueId);
  } while (Date.now() < deadline);
  throw new Error(`Authoritative stage transition did not appear within ${timeoutMs}ms: ${JSON.stringify(issue)}`);
}

function releaseFixtureRun(runId: string): void {
  fs.writeFileSync(path.join(LIFECYCLE_DIR, `release-${runId}`), "release\n");
}

async function waitForRunTerminal(
  board: APIRequestContext,
  runId: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "unknown";
  do {
    const res = await board.get(`${BASE_URL}/api/heartbeat-runs/${runId}`);
    if (res.ok()) {
      const run = await res.json();
      status = run.status;
      if (!["queued", "running"].includes(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Fixture run ${runId} did not finish after release; last status=${status}`);
}

async function completeExecutorAndAwaitTransition(
  board: APIRequestContext,
  executor: AgentAuth,
  issueId: string,
  nextAgentId: string,
  options: { wakeReason?: "issue_assigned" | "execution_changes_requested"; stageId?: string; reviewRoundId?: string | null } = {},
): Promise<{ executorRunId: string; stage: { issue: ReviewStageIssue; expected: ExpectedStageRun } }> {
  const wakeReason = options.wakeReason ?? "issue_assigned";
  const issue = await getIssue(board, issueId);
  const expected: ExpectedExecutorRun = {
    companyId: issue.companyId,
    issueId,
    agentId: executor.agentId,
    wakeReason,
    stageId: options.stageId,
    reviewRoundId: options.reviewRoundId,
  };
  const executorRunId = await waitForActiveExecutorRun(board, expected);
  fs.writeFileSync(path.join(LIFECYCLE_DIR, `submit-${executorRunId}`), "submit\n");
  const succeededRunId = await waitForExecutorSuccess(board, expected);
  expect(succeededRunId).toBe(executorRunId);
  const stage = await waitForStageTransition(board, issueId, nextAgentId);
  lifecycleRecords.push({
    kind: "executor",
    issueId,
    runId: executorRunId,
    runStateAtDecision: "succeeded",
    stageId: stage.expected.stageId,
    stageType: stage.expected.stageType,
    reviewRoundId: stage.expected.reviewRoundId,
    expectedUpdatedAt: null,
    decisionId: null,
    httpStatus: 200,
    resultingStatus: stage.issue.status,
    resultingAssigneeAgentId: stage.issue.executionState?.currentParticipant?.type === "agent"
      ? stage.issue.executionState.currentParticipant.agentId
      : null,
    cleanup: "terminal_succeeded",
  });
  return { executorRunId, stage };
}

/** Create an authenticated APIRequestContext for an agent (token set, no run ID yet). */
async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Invoke a heartbeat run for an agent, returning the run ID. */
async function invokeHeartbeat(
  board: APIRequestContext,
  agentId: string,
  issueId: string,
): Promise<string> {
  const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`, {
    data: {
      reason: "issue_assigned",
      payload: { issueId, taskId: issueId, taskKey: issueId },
    },
  });
  expect(res.ok()).toBe(true);
  const run = await res.json();
  if (typeof run.id === "string" && run.id.length > 0) return run.id;

  // A stage transition can already be replacing the previous executor's run
  // with the participant's queued run. If the legacy invoke is skipped and
  // that run has already released the issue lock, recover it from the agent's
  // recent run receipts.
  const deadline = Date.now() + 3_000;
  do {
    const issueRunLock = await getIssueRunLockState(board, issueId);
    if (issueRunLock.assigneeAgentId !== agentId) {
      // Negative authorization cases intentionally invoke a non-participant.
      // Preserve the server rejection instead of waiting for a run that must
      // never be assigned to that agent.
      return issueRunLock.executionRunId ?? issueRunLock.checkoutRunId ?? "";
    }
    const candidates = new Set<string>([
      run.executionRunId,
      issueRunLock.executionRunId,
      issueRunLock.checkoutRunId,
    ].filter((candidate): candidate is string => Boolean(candidate)));
    const recentRunsRes = await board.get(
      `${BASE_URL}/api/companies/${issueRunLock.companyId}/heartbeat-runs?agentId=${agentId}&limit=20`,
    );
    if (recentRunsRes.ok()) {
      const recentRuns = await recentRunsRes.json();
      for (const recentRun of Array.isArray(recentRuns) ? recentRuns : []) {
        if (typeof recentRun.id === "string") candidates.add(recentRun.id);
      }
    }
    for (const candidate of candidates) {
      const runRes = await board.get(`${BASE_URL}/api/heartbeat-runs/${candidate}`);
      if (!runRes.ok()) continue;
      const candidateRun = await runRes.json();
      const context = candidateRun.contextSnapshot ?? {};
      if (
        candidateRun.agentId === agentId &&
        (context.issueId === issueId || context.taskId === issueId)
      ) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  throw new Error(`No issue-bound heartbeat run became available for agent ${agentId}`);
}

async function getIssueRunLockState(board: APIRequestContext, issueId: string): Promise<IssueRunLockState> {
  const res = await board.get(`${BASE_URL}/api/issues/${issueId}`);
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  return {
    companyId: issue.companyId,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
  };
}

async function retryAgentPatchWithCurrentLockOnConflict(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  failedRes: Awaited<ReturnType<APIRequestContext["patch"]>>,
  patchData: Record<string, unknown>,
  fallbackRunId: string,
) {
  if (failedRes.status() !== 409) return failedRes;
  let res = failedRes;
  for (let attempt = 0; attempt < 8 && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, 50 * 2 ** attempt)));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    if (issueRunLock.assigneeAgentId !== agent.agentId) return res;

    const lockedRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? fallbackRunId;
    res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": lockedRunId },
      data: patchData,
    });
  }
  return res;
}

/**
 * PATCH an issue as an agent, using a freshly invoked heartbeat run.
 *
 * Invoking a heartbeat starts a background run that races this PATCH for the
 * issue's run-lock: the background run may check the issue out (flipping it to
 * `in_progress` under its own run id) a moment before — or after — this PATCH
 * lands, and the server answers the loser with a 409 ("Issue is checked out by
 * another agent"). With `retries: 0` / `workers: 1` a single transient 409
 * fails the whole shard, so we retry a run-lock 409 under the issue's *current*
 * lock, bounded by escalating backoff to cover the race window.
 *
 * The retry is intentionally narrow so the suite's negative paths keep failing
 * for the right reason:
 *   - It only re-PATCHes while the issue is still assigned to the acting agent,
 *     so a non-participant's genuine 409/403 rejection is returned untouched.
 *   - It re-PATCHes under the winning run id (or the invoked run id once the
 *     background run has released its lock), so a real validation error such as
 *     the missing-comment 400 surfaces instead of a masking transient 409.
 */
async function agentPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  data: Record<string, unknown>,
  {
    maxAttempts = 8,
    backoffMs = 50,
    maxBackoffMs = 500,
  }: { maxAttempts?: number; backoffMs?: number; maxBackoffMs?: number } = {},
) {
  const initialIssue = await getIssue(board, issueId);
  const stageExpectation = expectedStageRun(initialIssue, agent.agentId);
  const runId = stageExpectation
    ? await waitForAuthoritativeStageRun(board, stageExpectation)
    : await invokeHeartbeat(board, agent.agentId, issueId);
  const currentIssue = await getIssue(board, issueId);
  const executionState = currentIssue.executionState ?? null;
  if (
    stageExpectation &&
    currentIssue.status === "in_review" &&
    executionState?.status === "pending" &&
    executionState?.currentParticipant?.type === "agent" &&
    executionState.currentParticipant.agentId === agent.agentId &&
    (data.status === "done" || data.status === "in_progress")
  ) {
    const binding = bindAtomicReviewDecision(currentIssue, runId, stageExpectation);
    if (!binding) {
      throw new Error(`Fresh issue state no longer matches selected stage run: ${JSON.stringify({ currentIssue, runId, stageExpectation })}`);
    }
    const runBefore = await board.get(`${BASE_URL}/api/heartbeat-runs/${runId}`);
    expect(runBefore.ok()).toBe(true);
    expect((await runBefore.json()).status).toBe("running");
    const reasoning = typeof data.comment === "string" && data.comment.trim().length > 0
      ? data.comment.trim().length >= 24
        ? data.comment.trim()
        : `${data.comment.trim()} Verified against the execution policy.`
      : data.comment;
    const decisionRes = await agent.request.post(`${BASE_URL}/api/issues/${issueId}/review-decisions`, {
      headers: { "X-Paperclip-Run-Id": binding.reviewerRunId },
      data: {
        outcome: data.status === "done" ? "approved" : "changes_requested",
        reasoning,
        expectedUpdatedAt: binding.expectedUpdatedAt,
        idempotencyKey: `e2e:${issueId}:${binding.stageId}:${binding.reviewRoundId ?? "null"}:${runId}`,
      },
    });
    let decisionBody: Record<string, any> | null = null;
    if (decisionRes.ok()) decisionBody = await decisionRes.json();
    const resultingIssue = decisionRes.ok()
      ? await getIssue(board, issueId)
      : currentIssue;
    if (decisionRes.ok()) {
      releaseFixtureRun(runId);
      const terminalStatus = await waitForRunTerminal(board, runId);
      lifecycleRecords.push({
        kind: stageExpectation.stageType === "approval" ? "approver" : "reviewer",
        issueId,
        runId,
        runStateAtDecision: "running",
        stageId: binding.stageId,
        stageType: stageExpectation.stageType,
        reviewRoundId: binding.reviewRoundId,
        expectedUpdatedAt: binding.expectedUpdatedAt,
        decisionId: typeof decisionBody?.decision?.id === "string" ? decisionBody.decision.id : null,
        httpStatus: decisionRes.status(),
        resultingStatus: resultingIssue.status,
        resultingAssigneeAgentId: (resultingIssue as any).assigneeAgentId ?? null,
        cleanup: terminalStatus,
      });
    }
    if (!decisionRes.ok()) return decisionRes;
    return board.get(`${BASE_URL}/api/issues/${issueId}`);
  }
  const patchWith = (patchRunId: string) =>
    agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": patchRunId },
      data,
    });

  let res = await patchWith(runId);
  for (let attempt = 1; attempt < maxAttempts && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1))));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    // A 409 on an issue no longer assigned to us is a genuine rejection, not a
    // run-lock race — leave it for the caller to assert on.
    if (issueRunLock.assigneeAgentId !== agent.agentId) break;
    const retryRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? runId;
    res = await patchWith(retryRunId);
  }
  return res;
}

/** Checkout an issue as an agent, then PATCH it. Used for executor mark-done. */
async function agentCheckoutAndPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  expectedStatuses: string[],
  patchData: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  const directPatchRes = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  if (directPatchRes.ok()) return directPatchRes;

  // Checkout (sets executionRunId so PATCH is allowed)
  const checkoutRes = await agent.request.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses },
  });
  if (!checkoutRes.ok()) {
    if (checkoutRes.status() === 409) {
      const res = await retryAgentPatchWithCurrentLockOnConflict(
        board,
        agent,
        issueId,
        checkoutRes,
        patchData,
        runId,
      );
      if (res.ok()) {
        return res;
      }
    }
    // If agent checkout fails (e.g. run expired), fall back to board checkout
    // then PATCH with the agent's identity
    const boardCheckout = await board.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
      data: { agentId: agent.agentId, expectedStatuses },
    });
    if (!boardCheckout.ok()) {
      throw new Error(`Board checkout failed: ${await boardCheckout.text()}`);
    }
    // Board PATCH (executor mark-done triggers signoff regardless of actor)
    const res = await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
      data: patchData,
    });
    return res;
  }
  // PATCH with agent identity
  const res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  const retried = await retryAgentPatchWithCurrentLockOnConflict(
    board,
    agent,
    issueId,
    res,
    patchData,
    runId,
  );
  if (retried.status() !== 409) return retried;

  // A no-op process adapter can replace and release the executor's lock faster
  // than an agent-authored retry can adopt it. This flow already permits a
  // board fallback when checkout loses that race; apply the same fallback when
  // the post-checkout PATCH exhausts its bounded lock retries.
  const issueRunLock = await getIssueRunLockState(board, issueId);
  if (issueRunLock.assigneeAgentId !== agent.agentId) return retried;
  return board.patch(`${BASE_URL}/api/issues/${issueId}`, { data: patchData });
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Signoff e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use the webServer config.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json();
  const companyId = company.id;
  const companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // Helper: hire/approve agent + API key + request context
  async function createAgent(name: string, role: string, title: string): Promise<AgentAuth> {
    const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/agent-hires`, {
      data: {
        name,
        role,
        title,
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: [LIFECYCLE_SCRIPT, role === "engineer" ? "executor" : role === "qa" ? "reviewer" : "approver", LIFECYCLE_DIR],
          timeoutSec: 58,
          graceSec: 1,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const hire = await agentRes.json();
    const agent = hire.agent;
    if (hire.approval) {
      const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
        data: { decisionNote: "Approved for signoff e2e setup." },
      });
      expect(approvalRes.ok()).toBe(true);
    }

    const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agent.id}/keys`, {
      data: { name: `e2e-${name.toLowerCase()}` },
    });
    expect(keyRes.ok()).toBe(true);
    const keyData = await keyRes.json();

    return {
      agentId: agent.id,
      token: keyData.token,
      keyId: keyData.id,
      request: await createAgentRequest(keyData.token),
    };
  }

  const executor = await createAgent("Executor", "engineer", "Software Engineer");
  const reviewer = await createAgent("Reviewer", "qa", "QA Engineer");
  const approver = await createAgent("Approver", "cto", "CTO");

  return {
    companyId,
    companyPrefix,
    executor,
    reviewer,
    approver,
    boardRequest,
    issueIds: [],
  };
}

async function createIssueWithPolicy(ctx: TestContext, title: string, stages?: unknown[]) {
  const defaultStages = [
    { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    { type: "approval", participants: [{ type: "agent", agentId: ctx.approver.agentId }] },
  ];
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/issues`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executor.agentId,
      executionPolicy: { stages: stages ?? defaultStages },
    },
  });
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  ctx.issueIds.push(issue.id);
  return issue;
}

test.describe("Signoff execution policy", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;

    // Dispose agent request contexts
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await agent.request.dispose();
    }

    // Clean up issues, keys, agents, company (best-effort)
    for (const issueId of ctx.issueIds) {
      await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
        data: { status: "cancelled", comment: "E2E test cleanup." },
      }).catch(() => {});
    }
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}`).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();

    const ledgerPath = process.env.PAPERCLIP_E2E_LEDGER_PATH;
    if (ledgerPath) {
      fs.writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          isolationId: process.env.PAPERCLIP_E2E_RUN_ID ?? null,
          baseUrl: BASE_URL,
          companyId: ctx.companyId,
          lifecycleRecords,
        }, null, 2)}\n`,
      );
    }
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const issue = await createIssueWithPolicy(ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: The assignment wake starts the executor. The executor marks done
    // from inside its own authoritative run and must finish before stage wake.
    const { stage: step1Stage } = await completeExecutorAndAwaitTransition(
      ctx.boardRequest, ctx.executor, issueId, ctx.reviewer.agentId,
    );
    const step1Issue = step1Stage.issue;

    expect(step1Issue.status).toBe("in_review");
    expect(step1Issue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(step1Issue.executionState).toBeTruthy();
    expect(step1Issue.executionState.status).toBe("pending");
    expect(step1Issue.executionState.currentStageType).toBe("review");
    expect(step1Issue.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.executor.agentId,
    });

    // Step 2: Navigate to issue in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done", comment: "QA signoff complete. Looks good." },
    );
    expect(step3Res.ok()).toBe(true);
    const step3Issue = await step3Res.json();

    expect(step3Issue.status).toBe("in_review");
    expect(step3Issue.assigneeAgentId).toBe(ctx.approver.agentId);
    expect(step3Issue.executionState.status).toBe("pending");
    expect(step3Issue.executionState.currentStageType).toBe("approval");
    expect(step3Issue.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "Approved. Ship it." },
    );
    expect(step5Res.ok()).toBe(true);
    const step5Issue = await step5Res.json();

    expect(step5Issue.status).toBe("done");
    expect(step5Issue.executionState.status).toBe("completed");
    expect(step5Issue.executionState.completedStageIds).toHaveLength(2);
    expect(step5Issue.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff changes requested");
    const issueId = issue.id;

    // Assignment starts the authoritative executor run. Complete it from
    // inside that exact run before entering review.
    await completeExecutorAndAwaitTransition(
      ctx.boardRequest, ctx.executor, issueId, ctx.reviewer.agentId,
    );

    // Reviewer requests changes → returns to executor
    const changesRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "in_progress", comment: "Needs another pass on edge cases." },
    );
    expect(changesRes.ok()).toBe(true);
    const changesIssue = await changesRes.json();

    expect(changesIssue.status).toBe("in_progress");
    expect(changesIssue.assigneeAgentId).toBe(ctx.executor.agentId);
    expect(changesIssue.executionState.status).toBe("changes_requested");
    expect(changesIssue.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits through the exact changes-requested wake run and
    // returns to the same reviewer stage.
    const { stage: resubmitStage } = await completeExecutorAndAwaitTransition(
      ctx.boardRequest,
      ctx.executor,
      issueId,
      ctx.reviewer.agentId,
      {
        wakeReason: "execution_changes_requested",
        stageId: changesIssue.executionState.currentStageId,
        reviewRoundId: changesIssue.executionState.reviewRoundId,
      },
    );
    const resubmitIssue = resubmitStage.issue;

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff comment required");
    const issueId = issue.id;

    // Assignment creates the authoritative executor run; let it complete and
    // enter review before asserting missing-decision-reasoning validation.
    const { stage: doneStage } = await completeExecutorAndAwaitTransition(
      ctx.boardRequest, ctx.executor, issueId, ctx.reviewer.agentId,
    );
    const doneIssue = doneStage.issue;
    expect(doneIssue.status).toBe("in_review");
    expect(doneIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done" },
    );
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toMatch(/comment|reasoning|Required/i);
  });

  test("non-participant cannot advance stage", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff access control");
    const issueId = issue.id;

    // Assignment wake starts the authoritative executor run.
    await completeExecutorAndAwaitTransition(
      ctx.boardRequest, ctx.executor, issueId, ctx.reviewer.agentId,
    );

    // Verify issue is in_review with reviewer
    const issueRes = await ctx.boardRequest.get(`${BASE_URL}/api/issues/${issueId}`);
    const inReviewIssue = await issueRes.json();
    expect(inReviewIssue.status).toBe("in_review");
    expect(inReviewIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(inReviewIssue.executionState.currentStageType).toBe("review");

    // Non-participant (approver at this stage) tries to advance → should be rejected
    const advanceRes = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "I'm the approver, not the reviewer." },
    );
    expect(advanceRes.ok()).toBe(false);
    expect(advanceRes.status()).toBeGreaterThanOrEqual(400);
  });

  test("review-only policy: reviewer approval completes execution", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff review-only", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);

    // Assignment wake starts the authoritative executor run.
    await completeExecutorAndAwaitTransition(
      ctx.boardRequest, ctx.executor, issue.id, ctx.reviewer.agentId,
    );

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issue.id,
      { status: "done", comment: "LGTM." },
    );
    expect(approveRes.ok()).toBe(true);
    const doneIssue = await approveRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.executionState.status).toBe("completed");
    expect(doneIssue.executionState.completedStageIds).toHaveLength(1);
  });
});
