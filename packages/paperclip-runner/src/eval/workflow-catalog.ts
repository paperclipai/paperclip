import {
  RUNNER_WORKFLOW_EVAL_CASE_SCHEMA,
  RUNNER_WORKFLOW_IDS,
  assertRunnerWorkflowEvalCase,
  type RunnerWorkflowEvalCase,
} from "./workflow-contracts.js";

const ALL_PROVIDERS = ["codex", "opencode", "acpx"] as const;

function workflow(input: Omit<RunnerWorkflowEvalCase, "schema" | "version">): RunnerWorkflowEvalCase {
  const value: RunnerWorkflowEvalCase = {
    schema: RUNNER_WORKFLOW_EVAL_CASE_SCHEMA,
    version: 1,
    ...input,
  };
  assertRunnerWorkflowEvalCase(value);
  return Object.freeze(value);
}

/** The twelve deterministic workflows distilled from the stress findings. */
export const RUNNER_WORKFLOW_CATALOG: readonly RunnerWorkflowEvalCase[] = Object.freeze([
  workflow({
    id: "final-response",
    title: "Preserve one substantive final response",
    tags: ["response", "resolver", "long-output"],
    providers: [...ALL_PROVIDERS], steps: [{ kind: "run_start", taskMode: "ask" }],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", maxRuns: 1,
      commentCount: 1, responseSource: "final_agent_message",
      orderedMarkers: ["commentary", "activity", "final"],
      requiredPrpEventTypes: ["run.result.accepted", "run.presentation.resolved", "run.terminal"],
      forbiddenPrpEventTypes: ["run.presentation.placeholder"],
      requiredOperationIds: ["finish_task"],
    },
  }),
  workflow({
    id: "rich-activity",
    title: "Render structured provider activity through settlement",
    tags: ["activity", "tools", "search"],
    providers: [...ALL_PROVIDERS], steps: [{ kind: "run_start", taskMode: "execute" }],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done",
      orderedMarkers: ["commentary", "research", "tool", "file", "test", "final"],
      requiredPrpEventTypes: ["research.completed", "tool.execution.completed", "run.terminal"],
      requiredActivityFamilies: ["research", "tool_execution"],
      requiredOperationIds: ["report_progress", "finish_task"],
    },
  }),
  workflow({
    id: "verification-policy",
    title: "Resolve unavailable and externally required verification",
    tags: ["verification", "caveat", "review"],
    providers: [...ALL_PROVIDERS], steps: [{ kind: "run_start", taskMode: "execute" }],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", recoveryOwner: "none",
      commentCount: 1, requiredPrpEventTypes: ["run.result.accepted", "run.terminal"],
      requiredOperationIds: ["finish_task"],
    },
  }),
  workflow({
    id: "governed-interaction",
    title: "Park and resume governed interactions",
    tags: ["interaction", "wait", "continuation"],
    providers: [...ALL_PROVIDERS],
    steps: [
      { kind: "run_start", taskMode: "ask" },
      { kind: "interaction_response", interaction: "questions" },
      { kind: "interaction_response", interaction: "suggest_tasks" },
      { kind: "interaction_response", interaction: "checkbox" },
      { kind: "interaction_response", interaction: "item_verdicts", partial: true },
      { kind: "interaction_response", interaction: "item_verdicts" },
    ],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", maxRuns: 3,
      commentCount: 1, orderedMarkers: ["question", "answer", "continuation", "final"],
      requiredPrpEventTypes: ["interaction.requested", "run.result.accepted", "run.terminal"],
      forbiddenPrpEventTypes: ["run.presentation.placeholder"],
      requiredOperationIds: ["request_human_input", "finish_task"],
    },
  }),
  workflow({
    id: "steering-causality",
    title: "Keep queued and active steering causally ordered",
    tags: ["steering", "ordering", "idempotency"],
    providers: [...ALL_PROVIDERS],
    steps: [
      { kind: "run_start", taskMode: "execute" },
      { kind: "steer", delivery: "queued" },
      { kind: "steer", delivery: "active_turn", duplicate: true },
    ],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", maxRuns: 2,
      orderedMarkers: ["pre-steer", "steering", "post-steer", "final"],
      requiredPrpEventTypes: ["turn.steering.acknowledged", "run.terminal"],
      requiredOperationIds: ["finish_task"],
    },
  }),
  workflow({
    id: "planning-lifecycle",
    title: "Reject, revise, accept, and execute a cohesive plan on the source",
    tags: ["plan", "same-issue", "approval"],
    providers: [...ALL_PROVIDERS],
    steps: [
      { kind: "run_start", taskMode: "plan" },
      { kind: "review_decision", decision: "reject" },
      { kind: "review_decision", decision: "approve" },
    ],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", maxRuns: 4,
      orderedMarkers: ["plan-v1", "rejection", "plan-v2", "acceptance", "same-issue", "parent-final"],
      requiredPrpEventTypes: ["plan.updated", "run.result.accepted", "run.terminal"],
      requiredOperationIds: ["write_document", "request_human_input", "finish_task"],
    },
  }),
  workflow({
    id: "review-lifecycle",
    title: "Reject narrowly and approve human completion review",
    tags: ["review", "ownership", "narrow-repair"],
    providers: [...ALL_PROVIDERS],
    steps: [
      { kind: "run_start", taskMode: "execute" },
      { kind: "review_decision", decision: "reject" },
      { kind: "review_decision", decision: "approve" },
    ],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "needs_review", recoveryOwner: "human", maxRuns: 2,
      orderedMarkers: ["review", "rejection", "verification-only", "replacement-review", "approval"],
      requiredPrpEventTypes: ["run.result.accepted", "interaction.requested", "run.terminal"],
      requiredOperationIds: ["request_human_input", "finish_task"],
    },
  }),
  workflow({
    id: "delegation-return",
    title: "Decompose an accepted plan for a justified independent boundary",
    tags: ["plan", "delegation", "dependency", "cross-provider"],
    providers: [...ALL_PROVIDERS],
    steps: [
      { kind: "run_start", taskMode: "plan" },
      { kind: "review_decision", decision: "approve" },
      { kind: "child_completion", childProvider: "opencode" },
    ],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", maxRuns: 2,
      orderedMarkers: ["child-result", "parent-wake", "parent-final"],
      requiredPrpEventTypes: ["delegation.completed", "run.result.accepted", "run.terminal"],
      forbiddenPrpEventTypes: ["delegation.duplicate_wake"],
      requiredOperationIds: ["write_document", "request_human_input", "create_task", "set_dependencies", "finish_task"],
    },
  }),
  workflow({
    id: "completion-robustness",
    title: "Normalize completion and bound missing-result recovery",
    tags: ["completion", "schema", "exhaustion"],
    providers: [...ALL_PROVIDERS], steps: [{ kind: "run_start", taskMode: "execute" }],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", maxAttempts: 3, maxRuns: 1, recoveryOwner: "none",
      commentCount: 1, responseSource: "semantic_result_summary",
      requiredPrpEventTypes: ["run.result.accepted", "run.terminal"], forbiddenPrpEventTypes: ["run.presentation.placeholder"],
      requiredOperationIds: ["finish_task"],
    },
  }),
  workflow({
    id: "restart-recovery",
    title: "Recover once without stale finalizer authority",
    tags: ["restart", "checkpoint", "authority"],
    providers: [...ALL_PROVIDERS],
    steps: [
      { kind: "run_start", taskMode: "execute" },
      { kind: "process_restart", phase: "provider_turn" },
      { kind: "process_restart", phase: "finalization" },
    ],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done", maxAttempts: 2, maxRuns: 1,
      requiredPrpEventTypes: ["run.result.accepted", "run.terminal"],
      forbiddenPrpEventTypes: ["native_finalization_superseded_mutation"],
      requiredOperationIds: ["report_progress", "finish_task"],
    },
  }),
  workflow({
    id: "cancellation-permissions",
    title: "Normalize cancellation and scoped permissions",
    tags: ["cancellation", "permission", "interruption"],
    providers: [...ALL_PROVIDERS],
    steps: [
      { kind: "run_start", taskMode: "execute" },
      { kind: "permission_decision", decision: "accept_for_session" },
      { kind: "cancel", actor: "operator" },
    ],
    assertions: {
      issueStatus: "cancelled", runStatus: "cancelled", maxRuns: 1, commentCount: 0, responseSource: "none",
      orderedMarkers: ["permission", "activity", "stopped"],
      requiredPrpEventTypes: ["runtime_request.resolved", "run.terminal"],
      forbiddenPrpEventTypes: ["provider.notice.false_abort_failure"],
      requiredOperationIds: [],
    },
  }),
  workflow({
    id: "trace-lineage",
    title: "Correlate provider frames through PRP and presentation",
    tags: ["trace", "lineage", "redaction"],
    providers: [...ALL_PROVIDERS], steps: [{ kind: "run_start", taskMode: "execute" }],
    assertions: {
      issueStatus: "done", runStatus: "succeeded", semanticDisposition: "done",
      requiredPrpEventTypes: ["item.started", "run.result.proposed", "item.completed", "run.presentation.resolved", "run.terminal"],
      trace: {
        capture: "on", digestVerified: true, ordered: true,
        dispositions: ["mapped", "generic", "ignored", "rejected", "operator_only"],
        lineage: ["one_to_one", "one_to_many", "many_to_one"],
      },
      requiredOperationIds: ["finish_task"],
    },
  }),
]);

export function runnerWorkflowCase(id: string): RunnerWorkflowEvalCase {
  const found = RUNNER_WORKFLOW_CATALOG.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown Runner workflow eval case: ${id}`);
  return found;
}

export function assertRunnerWorkflowCatalog(): void {
  const ids = RUNNER_WORKFLOW_CATALOG.map((entry) => entry.id);
  if (ids.length !== RUNNER_WORKFLOW_IDS.length || new Set(ids).size !== RUNNER_WORKFLOW_IDS.length) {
    throw new Error(`Runner workflow catalog must contain ${RUNNER_WORKFLOW_IDS.length} unique cases`);
  }
  for (const id of RUNNER_WORKFLOW_IDS) {
    if (!ids.includes(id)) throw new Error(`Runner workflow catalog is missing ${id}`);
  }
  RUNNER_WORKFLOW_CATALOG.forEach(assertRunnerWorkflowEvalCase);
}
