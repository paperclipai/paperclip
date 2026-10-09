// References are executable coverage, not claims that those tests have passed.
const server = "server/src/__tests__/";
const native = "server/src/services/native-runtime/";
export const lanes = {
  unit: {
    files: [
      "tests/lifecycle-baseline/authority.test.ts",
      "tests/lifecycle-baseline/accounting.test.ts",
      "server/src/services/execution-recovery-attempt.test.ts",
      "server/src/services/recovery/legacy-continuation.test.ts",
      `${server}run-liveness.test.ts`,
      `${server}heartbeat-context-summary.test.ts`,
      `${native}native-execution-input.test.ts`,
      `${native}status-arbiter.test.ts`,
      `${native}native-replacement-evidence.test.ts`,
      `${server}run-continuations.test.ts`,
      `${server}disposition-repair.test.ts`,
      `${server}issue-thread-interaction-routes.test.ts`,
    ],
  },
  runner: {
    files: [
      "tests/lifecycle-baseline/runner.test.ts",
      "packages/paperclip-runner/src/native-session-runtime.test.ts",
      "packages/paperclip-runner/src/protocol/result-normalization.test.ts",
      "packages/paperclip-runner/src/contracts/completion-result.test.ts",
    ],
  },
  integration: {
    files: [
      "server/test-baselines/lifecycle-heartbeat.test.ts",
      `${server}activity-service.test.ts`,
      `${server}legacy-continuation-authority.test.ts`,
      `${server}native-status-arbiter-corpus.test.ts`,
      `${server}heartbeat-issue-liveness-escalation.test.ts`,
      `${server}heartbeat-retry-scheduling.test.ts`,
      `${server}heartbeat-stale-queue-invalidation.test.ts`,
      `${server}issue-monitor-scheduler.test.ts`,
      `${server}question-response-delivery.test.ts`,
      `${server}native-finalization-recovery.test.ts`,
      `${native}native-safe-replacement.test.ts`,
      `${server}issue-thread-interactions-service.test.ts`,
    ],
  },
  grading: {
    files: [
      "tests/runner-e2e/lifecycle-baseline.test.ts",
      "tests/runner-e2e/lifecycle-live.test.ts",
      "tests/runner-e2e/accounting.test.ts",
      "tests/runner-e2e/continuation.test.ts",
    ],
  },
};
const ref = (lane, file, pattern = ".") => ({ lane, file, pattern });
const runnerPairs = (id) =>
  ref("runner", "tests/lifecycle-baseline/runner.test.ts", id);
const grading = (id) =>
  ref("grading", "tests/runner-e2e/lifecycle-baseline.test.ts", id);
const unit = (id) => ref("unit", lanes.unit.files[0], id);
const integ = (name, pattern = ".") =>
  ref(
    name === "issue-thread-interaction-routes" ? "unit" : "integration",
    server + name + ".test.ts",
    pattern,
  );
const runner = (pattern) =>
  ref(
    "runner",
    "packages/paperclip-runner/src/native-session-runtime.test.ts",
    pattern,
  );
export const scenarios = [

  {
    id: "LCA-01",
    name: "Ordinary completion",
    expected: "Valid completion, delivered answer, no extra execution",
    coverage: [
      runnerPairs("LCA-01"),
      grading("LCA-01"),
      unit("LCA-01"),
      integ("native-status-arbiter-corpus"),
      ref("integration", lanes.integration.files[0], "LCA-01"),
    ],
    live: [
      "lifecycle-baseline:lifecycle-completion-neutral",
      "lifecycle-baseline:lifecycle-completion-challenge",
      "lifecycle-baseline:lifecycle-blocker-neutral",
      "lifecycle-baseline:lifecycle-blocker-challenge",
      "everyday-workflows:build-revise",
      "runner-evals:finish-task",
    ],
  },
  {
    id: "LCA-02",
    name: "Productive multi-turn continuation",
    expected:
      "Continue without replaying completed work or treating productivity as repeated failure",
    coverage: [
      unit("LCA-02"),
      integ("heartbeat-retry-scheduling", "max-turn"),
      ref("integration", lanes.integration.files[0], "LCA-02"),
    ],
    live: ["continuation:completed-action-resume"],
  },
  {
    id: "LCA-03",
    name: "Durable human question",
    expected: "Bound question precedes wait; matching answer resumes once",
    coverage: [
      grading("LCA-03"),
      unit("LCA-03"),
      integ("question-response-delivery"),
    ],
    live: [
      "lifecycle-baseline:lifecycle-question-neutral",
      "lifecycle-baseline:lifecycle-question-challenge",
      "continuation:answer-updates-scope",
      "continuation:provider-question-bridge",
    ],
  },
  {
    id: "LCA-04",
    name: "Approval and decline",
    expected:
      "Correct authorized approval releases only its gate; decline executes nothing",
    coverage: [
      ref("integration", lanes.integration.files[0], "LCA-04"),
      unit("LCA-04"),
      integ(
        "issue-thread-interaction-routes",
        "confirmation|approval|tool.action",
      ),
      integ("heartbeat-retry-scheduling", "gate|budget|paused"),
    ],
    live: [
      "lifecycle-baseline:lifecycle-approval-neutral",
      "lifecycle-baseline:lifecycle-approval-challenge",
      "lifecycle-baseline:tool-review-approve",
      "lifecycle-baseline:tool-review-decline",
      "lifecycle-baseline:tool-review-always",
      "lifecycle-baseline:lifecycle-untrusted-evidence-neutral",
      "lifecycle-baseline:lifecycle-untrusted-evidence-challenge",
      "continuation:clarification-not-approval",
      "everyday-workflows:service-approve",
      "everyday-workflows:service-decline",
    ],
  },
  {
    id: "LCA-05",
    name: "Plan revision acceptance",
    expected: "Work mode and exact accepted revision authorize execution",
    coverage: [
      grading("LCA-05"),
      unit("LCA-05"),
      ref("unit", `${server}run-liveness.test.ts`, "mode|title and description"),
      ref("unit", `${server}heartbeat-context-summary.test.ts`, "selects directives only"),
      ref("unit", `${native}native-execution-input.test.ts`, "LCA-05"),
      integ("activity-service", "LCA-05"),
      integ("issue-thread-interaction-routes", "plan|revision"),
      integ(
        "issue-thread-interactions-service",
        "Plan.mode|stale.*revision|revision.*stale|plan confirmation",
      ),
    ],
    live: [
      "lifecycle-baseline:lifecycle-plan-revision-neutral",
      "lifecycle-baseline:lifecycle-plan-revision-challenge",
      "lifecycle-baseline:lifecycle-work-mode-neutral",
      "lifecycle-baseline:lifecycle-work-mode-challenge",
      "agent-chat:plan-handoff",
      "continuation:revision-preserves-approval",
    ],
  },
  {
    id: "LCA-06",
    name: "Dependencies",
    expected:
      "All required dependencies release one parent wake; unrelated events do nothing",
    coverage: [integ("heartbeat-issue-liveness-escalation")],
    live: [
      "lifecycle-baseline:lifecycle-dependency-restart-neutral",
      "lifecycle-baseline:lifecycle-dependency-restart-challenge",
      "everyday-workflows:delegate-feedback",
      "runner-evals:set-task-dependencies",
    ],
  },
  {
    id: "LCA-07",
    name: "External monitor wait",
    expected:
      "Durable eligible monitor fires once and respects timeout and exhaustion",
    coverage: [unit("LCA-07"), integ("issue-monitor-scheduler")],
    live: ["runner-evals:schedule-task-wake"],
  },
  {
    id: "LCA-08",
    name: "Ordinary conversation",
    expected:
      "Deliver response without task completion coercion or repair loops",
    coverage: [
      unit("LCA-08"),
      integ("heartbeat-retry-scheduling", "conversation"),
      runner("governed wait|structured input"),
    ],
    live: ["lifecycle-baseline:clarify-reuse", "agent-chat:clarify-reuse"],
  },
  {
    id: "LCA-09",
    name: "Missing disposition and exhausted repair",
    expected:
      "Bounded explicit recovery; prose/comments do not supply authority or reset attempts",
    coverage: [
      runnerPairs("LCA-09"),
      unit("LCA-09"),
      integ("legacy-continuation-authority"),
      ref("unit", "server/src/services/recovery/legacy-continuation.test.ts"),
      ref(
        "integration",
        "server/test-baselines/lifecycle-heartbeat.test.ts",
        "LCA-09",
      ),
      ref("unit", `${server}disposition-repair.test.ts`),
      runner("result.less|proposal.less|semantic result"),
      ref(
        "integration",
        `${native}native-safe-replacement.test.ts`,
        "exhausted|another run id",
      ),
    ],
    live: ["lifecycle-baseline:lifecycle-repair-neutral", "lifecycle-baseline:lifecycle-repair-challenge"],
  },
  {
    id: "LCA-10",
    name: "Stop, pause and budget",
    expected: "Distinct stop/pause semantics; no unauthorized continuation",
    coverage: [
      ref("integration", lanes.integration.files[0], "LCA-10"),
      unit("LCA-10"),
      integ(
        "heartbeat-stale-queue-invalidation",
        "cap|gate|ownership|before adapter",
      ),
      integ("heartbeat-retry-scheduling", "budget|pause|cancel|gate"),
    ],
    live: [
      "lifecycle-baseline:stop-new-resume",
      "everyday-workflows:stop-redirect",
      "agent-chat:stop-new-resume",
    ],
  },
  {
    id: "LCA-11",
    name: "Terminal ordering and cleanup",
    expected:
      "Completion report is not provider success; terminal/cleanup events retain their authority",
    coverage: [
      runnerPairs("LCA-11"),
      unit("LCA-11"),
      runner("terminal|completion report|cleanup|handoff"),
    ],
    live: [],
  },
  {
    id: "LCA-12",
    name: "Replay, restart and stale ownership",
    expected:
      "One successor, preserved receipts/budgets; stale finalizers cannot mutate new ownership",
    coverage: [
      grading("LCA-12"),
      unit("LCA-12"),
      integ("native-finalization-recovery"),
      ref("integration", `${native}native-safe-replacement.test.ts`),
      integ(
        "question-response-delivery",
        "concurrent|interrupted|stale|receipt",
      ),
    ],
    live: [
      "lifecycle-baseline:lifecycle-dependency-restart-neutral",
      "lifecycle-baseline:lifecycle-dependency-restart-challenge",
      "lifecycle-baseline:tool-review-restart",
      "everyday-workflows:recover-controller",
    ],
  },
  {
    id: "LCA-13",
    name: "Owned review",
    expected: "Concrete reviewer; reviewer outcome drives next transition",
    coverage: [
      ref("unit", `${native}status-arbiter.test.ts`, "review"),
      integ("native-status-arbiter-corpus", "ATT|review|corpus"),
    ],
    live: ["runner-evals:request-task-review"],
  },
  ...[
    ["ACCT-01", "Separate productive, repair and infrastructure allowances", "Each lane spends only its own allowance"],
    ["ACCT-02", "False progress and exhaustion", "Comments, wording and raw tool counts cannot replenish attempts"],
    ["ACCT-03", "Late gates", "Stop, approvals, ownership, pause and spending gates remain authoritative"],
    ["ACCT-04", "Restart and replay accounting", "Consumed allowances and causal receipts survive restart and duplicates"],
  ].map(([id, name, expected]) => ({ id, name, expected, coverage: [
    ref("unit", "tests/lifecycle-baseline/accounting.test.ts", id),
    ...(id === "ACCT-01" ? [ref("unit", "server/src/services/execution-recovery-attempt.test.ts"), integ("legacy-continuation-authority", id)] : []),
    ...(id === "ACCT-01" || id === "ACCT-02" ? [integ("heartbeat-retry-scheduling", id)] : []),
    ...(id === "ACCT-02" || id === "ACCT-03" ? [integ("legacy-continuation-authority", id)] : []),
    ...(id === "ACCT-04" ? [runner("ACCT-04"), integ("legacy-continuation-authority", "ACCT-04|replay|restart|fast repair"), integ("heartbeat-retry-scheduling", "concurrent|coalesces|after restart")] : []),
    ...(id === "ACCT-03" ? [ref("integration", "server/test-baselines/lifecycle-heartbeat.test.ts", "LCA-04 LCA-10"), integ("heartbeat-stale-queue-invalidation", "gate|cap|ownership")] : []),
    ref("grading", "tests/runner-e2e/accounting.test.ts"),
  ], live: ["continuation-accounting:accounting-productive-neutral", "continuation-accounting:accounting-productive-noisy", "continuation-accounting:accounting-exhaustion-neutral", "continuation-accounting:accounting-exhaustion-noisy", "continuation-accounting:accounting-repair-stop", "continuation-accounting:accounting-repair-approval"] })),
];
export const combinations = [
  ["completion then failure/cancellation", "LCA-11"],
  ["stream closes without terminal", "LCA-11"],
  ["approval while paused or over budget", "LCA-04"],
  ["answer during cleanup", "LCA-03"],
  ["reassignment/closure before finalization", "LCA-12"],
  ["restart between commit and wake delivery", "LCA-12"],
  ["exhaustion plus comment/new authorized request", "LCA-09"],
  ["stale plan revision approval", "LCA-05"],
  ["duplicate answer/dependency event/reconciler", "LCA-12"],
  ["wrong-company/task or unauthorized response", "LCA-04"],
  ["productive continuation beyond failure retry limit", "LCA-02"],
];
