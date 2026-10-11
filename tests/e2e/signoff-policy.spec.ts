import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

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

/** Create an authenticated APIRequestContext for an agent (token set, no run ID yet). */
async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

// The wait below follows the server's own deferral signal. It does not guess
// a delay. WAKEUP_WAIT_TOTAL_MS is a per-call ceiling, not a fixed wait: one
// test can call invokeHeartbeat several times under the suite's 60_000 ms
// per-test timeout (see tests/e2e/playwright.config.ts), so each call caps
// itself to the test's own remaining time, minus a reserve left for the
// assertions that still have to run after the call returns. A stuck wait
// then throws a named error, not a generic Playwright timeout.
// The server's rewake cooldown (ISSUE_REWAKE_BASE_COOLDOWN_MS, 120_000 ms in
// server/src/services/issue-rewake-throttle.ts) can outlast one test's life.
// When that happens, this helper still fails fast and states the reason.
const WAKEUP_WAIT_TOTAL_MS = 45_000;
const WAKEUP_WAIT_RESERVE_MS = 10_000;
const WAKEUP_POLL_INTERVAL_MS = 100;
const MAX_CONSECUTIVE_RUN_READ_FAILURES = 5;

// First-seen start time for the current test, keyed by Playwright's own
// TestInfo object. Playwright does not expose a test start timestamp, so
// this helper records one the first time a test calls invokeHeartbeat.
const testStartTimesMs = new WeakMap<ReturnType<typeof test.info>, number>();

/**
 * Return how long one invokeHeartbeat call may wait this time: the smaller
 * of WAKEUP_WAIT_TOTAL_MS and the current test's remaining time, after
 * WAKEUP_WAIT_RESERVE_MS is set aside for whatever the test still does once
 * this call returns. Returns 0 when the test has no time left to spare, so
 * the caller fails fast instead of starting a wait it cannot finish.
 */
function wakeupWaitBudgetMs(): number {
  const info = test.info();
  const testTimeoutMs = info.timeout;
  if (testTimeoutMs <= 0) return WAKEUP_WAIT_TOTAL_MS; // no test timeout set

  let startedAtMs = testStartTimesMs.get(info);
  if (startedAtMs === undefined) {
    startedAtMs = Date.now();
    testStartTimesMs.set(info, startedAtMs);
  }

  const elapsedMs = Date.now() - startedAtMs;
  const remainingMs = testTimeoutMs - elapsedMs - WAKEUP_WAIT_RESERVE_MS;
  return Math.max(0, Math.min(WAKEUP_WAIT_TOTAL_MS, remainingMs));
}

/**
 * Fetch a candidate run and confirm it belongs to this agent and this issue.
 * Return null when the run fails to load, or when it names a different
 * agent or a different issue. A caller must never treat an unverified lock
 * field as the answer.
 */
async function fetchVerifiedRun(
  board: APIRequestContext,
  candidateRunId: string | null | undefined,
  agentId: string,
  issueId: string,
): Promise<{ id: string; status: string } | null> {
  if (!candidateRunId) return null;
  const runRes = await board.get(`${BASE_URL}/api/heartbeat-runs/${candidateRunId}`);
  if (!runRes.ok()) return null;
  const candidateRun = await runRes.json();
  const context = candidateRun.contextSnapshot ?? {};
  if (candidateRun.agentId !== agentId) return null;
  if (context.issueId !== issueId && context.taskId !== issueId) return null;
  return { id: candidateRunId, status: candidateRun.status };
}

/**
 * Invoke a heartbeat run for an agent, returning the run ID.
 *
 * Posts the wakeup exactly once. A second on-demand wake for the same
 * (agent, issue) pair while the first has not yet produced visible progress
 * reads as a redundant re-poll to the server's rewake throttle, so this
 * never re-posts — it only reads state after the single post.
 *
 * Every returned run ID passes `fetchVerifiedRun` first. The issue's
 * run-lock fields name a candidate, not a verified answer, because the lock
 * holder and the issue assignee can differ during a stage transition.
 */
async function invokeHeartbeat(
  board: APIRequestContext,
  agentId: string,
  issueId: string,
): Promise<string> {
  const res = await board.post(`${BASE_URL}/api/agents/${agentId}/wakeup`, {
    data: {
      source: "on_demand",
      reason: "issue_assigned",
      payload: { issueId, taskId: issueId, taskKey: issueId },
    },
  });
  expect(res.ok()).toBe(true);
  const run = await res.json();
  if (typeof run.id === "string" && run.id.length > 0) return run.id;

  const waitBudgetMs = wakeupWaitBudgetMs();
  const deadline = Date.now() + waitBudgetMs;
  const lastSeen = {
    reason: typeof run.reason === "string" ? run.reason : null,
    checkoutRunId: null as string | null,
    executionRunId: typeof run.executionRunId === "string" ? run.executionRunId : null,
    blockingRunStatus: null as string | null,
    blockingRunReadFailed: false,
  };

  // A stage transition can invoke the next participant before the prior
  // stage's run releases the issue's execution lock. The server names the
  // run that holds the lock for two skip reasons: `issue_execution_deferred`
  // (an active execution run) and `execution_reconciliation_required` (an
  // execution blocker). Both name the blocking run in the same two fields,
  // so this code handles them the same way.
  // A third reason, `wakeup_skipped`, can also carry an `executionRunId`,
  // but only when that run already finished. A finished run is never this
  // agent's turn. So for `wakeup_skipped`, this code ignores `executionRunId`
  // and falls through to the verified wait below.
  if (
    (lastSeen.reason === "issue_execution_deferred" || lastSeen.reason === "execution_reconciliation_required") &&
    typeof run.executionRunId === "string"
  ) {
    if (run.executionAgentId === agentId) {
      // A run for this same agent on this same issue already holds the lock
      // (for example one started when the issue was assigned). Verify it
      // before this code treats it as the agent's current turn.
      const verified = await fetchVerifiedRun(board, run.executionRunId, agentId, issueId);
      if (verified) return verified.id;
    } else {
      // A different agent holds the lock (the prior stage's participant, or
      // the blocker's owner). Wait for that run to finish. It promotes this
      // wake into a real run as part of releasing the lock, so this code
      // waits for that instead of guessing how long the release takes.
      let consecutiveRunReadFailures = 0;
      while (Date.now() < deadline) {
        const runRes = await board.get(`${BASE_URL}/api/heartbeat-runs/${run.executionRunId}`);
        if (runRes.ok()) {
          consecutiveRunReadFailures = 0;
          const blockingRun = await runRes.json();
          lastSeen.blockingRunStatus = typeof blockingRun.status === "string" ? blockingRun.status : null;
          if (lastSeen.blockingRunStatus !== "queued" && lastSeen.blockingRunStatus !== "running") break;
        } else {
          // A 404 or a 500 response must not spin this loop forever. Count
          // repeated read failures and stop once they dominate the wait.
          // The failure then reads as "the run read kept failing", not as a
          // generic timeout.
          consecutiveRunReadFailures += 1;
          if (consecutiveRunReadFailures >= MAX_CONSECUTIVE_RUN_READ_FAILURES) {
            lastSeen.blockingRunReadFailed = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, WAKEUP_POLL_INTERVAL_MS));
      }
    }
  }

  // Read the issue's own run-lock fields, and this agent's recent runs,
  // until this agent's run for this issue appears and passes verification.
  // Negative-authorization tests invoke a non-participant on purpose, so an
  // assignee mismatch is a genuine rejection to return untouched, not a
  // signal to keep waiting for a run that must never exist for that agent.
  while (Date.now() < deadline) {
    const issueRunLock = await getIssueRunLockState(board, issueId);
    lastSeen.checkoutRunId = issueRunLock.checkoutRunId;
    lastSeen.executionRunId = issueRunLock.executionRunId;
    if (issueRunLock.assigneeAgentId !== agentId) {
      return issueRunLock.executionRunId ?? issueRunLock.checkoutRunId ?? "";
    }

    const verifiedCheckout = await fetchVerifiedRun(board, issueRunLock.checkoutRunId, agentId, issueId);
    if (verifiedCheckout) return verifiedCheckout.id;
    const verifiedExecution = await fetchVerifiedRun(board, issueRunLock.executionRunId, agentId, issueId);
    if (verifiedExecution) return verifiedExecution.id;

    const recentRunsRes = await board.get(
      `${BASE_URL}/api/companies/${issueRunLock.companyId}/heartbeat-runs?agentId=${agentId}&limit=20`,
    );
    if (recentRunsRes.ok()) {
      const recentRuns = await recentRunsRes.json();
      for (const recentRun of Array.isArray(recentRuns) ? recentRuns : []) {
        const context = recentRun.contextSnapshot ?? {};
        if (
          typeof recentRun.id === "string" &&
          recentRun.agentId === agentId &&
          (context.issueId === issueId || context.taskId === issueId)
        ) {
          return recentRun.id;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, WAKEUP_POLL_INTERVAL_MS));
  }

  throw new Error(
    `No verified heartbeat run became available for agent ${agentId} on issue ${issueId} ` +
      `within ${waitBudgetMs}ms` +
      `${waitBudgetMs <= 0 ? " (the test's remaining time budget was already spent before this wait could start)" : ""}. ` +
      `Last skip reason: ${lastSeen.reason ?? "none"}. ` +
      `Last checkoutRunId: ${lastSeen.checkoutRunId ?? "none"}. ` +
      `Last executionRunId: ${lastSeen.executionRunId ?? "none"}. ` +
      `Blocking run status: ${lastSeen.blockingRunStatus ?? "none"}` +
      `${lastSeen.blockingRunReadFailed ? " (the blocking run read failed repeatedly)" : ""}.`,
  );
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

async function waitForFixtureRun(
  board: APIRequestContext,
  agentId: string,
  issueId: string,
  runId: string,
) {
  // Negative authorization cases deliberately invoke a non-participant. Leave
  // their API rejection intact instead of waiting for a run they cannot own.
  if ((await getIssueRunLockState(board, issueId)).assigneeAgentId !== agentId) return;
  const waitBudgetMs = wakeupWaitBudgetMs();
  const deadline = Date.now() + waitBudgetMs;
  let status: string | null = null;
  do {
    const run = await fetchVerifiedRun(board, runId, agentId, issueId);
    expect(run, "Fixture run must belong to the acting agent and issue").not.toBeNull();
    status = run!.status;
    if (status === "succeeded") return;
    expect(["queued", "running"], `Fixture run ${runId} ended as ${status}`).toContain(status);
    await new Promise((resolve) => setTimeout(resolve, WAKEUP_POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  throw new Error(`Fixture run ${runId} did not succeed within ${waitBudgetMs}ms (last status: ${status})`);
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
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  // The fixture process only prints "done". Let its startup and cleanup settle
  // before a simulated decision reassigns the issue and cancels that process.
  await waitForFixtureRun(board, agent.agentId, issueId, runId);
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
  await waitForFixtureRun(board, agent.agentId, issueId, runId);
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
          args: ["-e", "process.stdout.write('done\\n')"],
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
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const issue = await createIssueWithPolicy(ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Implemented the feature, ready for review." },
    );
    expect(step1Res.ok()).toBe(true);
    const step1Issue = await step1Res.json();

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

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

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

    // Executor re-submits → goes back to reviewer (same stage)
    const resubmitRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Fixed the edge cases." },
    );
    expect(resubmitRes.ok()).toBe(true);
    const resubmitIssue = await resubmitRes.json();

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff comment required");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);
    const doneIssue = await doneRes.json();
    expect(doneIssue.status).toBe("in_review");
    expect(doneIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done" },
    );
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff access control");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);

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

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

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
