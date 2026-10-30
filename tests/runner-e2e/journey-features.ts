import { fileURLToPath } from "node:url";
import { featureIndex } from "../../scripts/feature-map.mjs";
import type { ReportExecution } from "./report-catalog.js";

export const journeyFeatureMap = featureIndex(fileURLToPath(new URL("../../", import.meta.url)));
export const journeyFeatures = journeyFeatureMap.sections.flatMap((section) =>
  section.features.map((feature) => ({ ...feature, section: section.title })),
);
const capabilities = new Map(journeyFeatures.flatMap((feature) =>
  feature.capabilities.map((capability) => [capability.id, { ...capability, feature }] as const),
));
const associations = new Map<string, readonly string[]>();

function associate(suites: readonly string[], cases: Record<string, readonly string[]>) {
  for (const [caseId, ids] of Object.entries(cases)) {
    for (const id of ids) if (!capabilities.has(id)) throw new Error(`Unknown journey capability: ${id}`);
    for (const suite of suites) associations.set(`${suite}/${caseId}`, ids);
  }
}

associate(["product-journeys"], { "task-create": ["tasks/create"], "ask-question": ["questions-and-approvals/questions"],
  "task-properties": ["tasks/properties"], "cloud-onboarding": ["onboarding/first-task"] });
associate(["antigravity-agent-journey"], {
  "saved-subscription-two-turn": ["agents/hire", "agents/instructions", "runs-adapters/validation", "runs-adapters/session",
    "tasks/create", "tasks/completion", "documents-artifacts/attachments", "documents-artifacts/work-products"],
});
associate(["core-compatibility", "openrouter-model-breadth", "extended-harnesses", "grok-qualification", "grok-subscription-qualification"], {
  "message-marker": ["runs-adapters/runs"],
  "hello-complete": ["runs-adapters/runs"],
  "plan-revise-accept": ["questions-and-approvals/plan-review"],
  "plan-approve-complete": ["questions-and-approvals/plan-review"],
  "ask-question": ["questions-and-approvals/questions"],
  "question-resume-complete": ["questions-and-approvals/questions", "questions-and-approvals/continuation"],
});
associate(["local-session-integrity", "extended-harnesses", "grok-qualification", "grok-subscription-qualification"], {
  "structured-question-resume": ["questions-and-approvals/continuation", "runs-adapters/session"],
  "structured-question-restart-resume": ["questions-and-approvals/continuation", "runs-adapters/session"],
});
associate(["question-resume"], {
  "question-answer-resume": ["questions-and-approvals/questions", "questions-and-approvals/continuation"],
});
associate(["feedback-persistence"], {
  "complaint-and-suggestion": ["activity/agent-commentary"],
});
associate(["continuation"], {
  "answer-updates-scope": ["questions-and-approvals/questions", "questions-and-approvals/continuation"],
  "clarification-not-approval": ["questions-and-approvals/questions", "questions-and-approvals/confirmations"],
  "revision-preserves-approval": ["questions-and-approvals/plan-review"],
  "completed-action-resume": ["questions-and-approvals/continuation"],
  "question-tool-documentation": ["questions-and-approvals/questions"],
  "provider-question-bridge": ["questions-and-approvals/questions", "questions-and-approvals/continuation"],
});
associate(["first-task", "confirmation-replies", "completion-updates"], Object.fromEntries([
  "interview-first-response", "clear-task-first-response", "ambiguous-task-first-response",
  "plain-message-first-response", "plan-first-response", "interview-plan-accept",
  "task-card-accept", "accept-while-running", "task-reply-accept", "clarify-propose-accept",
  "revise-accept", "reject-no-execution",
].map((id) => [id, ["onboarding/first-task"]])));
associate(["first-task"], { "ordinary-task-control": ["tasks/completion"] });
associate(["confirmation-replies"], {
  "confirmation-ambiguous": ["questions-and-approvals/confirmations", "questions-and-approvals/audience"],
  "unanswered-question-return": ["questions-and-approvals/dismiss-and-reopen", "questions-and-approvals/continuation"],
});
associate(["agent-chat", "agent-chat-hardening", "grok-qualification", "grok-subscription-qualification", "stock-harness"], {
  "create-backlog": ["tasks/create"],
  "reassign-task": ["tasks/properties"],
  "continuity-restart": ["agent-chat/history", "runs-adapters/session"],
  "new-session": ["agent-chat/history", "runs-adapters/session"],
  "stop-new-resume": ["steering/stop-and-pause", "runs-adapters/session"],
  "stop-startup-new-resume": ["steering/stop-and-pause", "runs-adapters/session"],
  "plan-handoff": ["agent-chat/handoff", "questions-and-approvals/plan-review"],
  "clarify-reuse": ["projects/task-context"],
  "multi-repository": ["projects/repositories"],
  "hire-delegate-reuse": ["agents/hire", "task-coordination/delegation"],
  "committed-send-retry": ["recovery/unknown-outcome"],
});
associate(["agent-chat-qualification"], {
  "active-reassignment": ["tasks/properties"],
  "worker-crash-retry": ["recovery/source-action"],
});
associate(["agent-chat-stories"], {
  "enable-disable-resume": ["agent-chat/history"],
  "followup-while-running": ["steering/queue"],
  "revise-while-running": ["steering/steer"],
});
associate(["completion-updates"], Object.fromEntries([
  "handoff-completion-idle", "handoff-completion-busy", "handoff-completion-multiple", "handoff-completion-restart",
].map((id) => [id, ["agent-chat/handoff", "tasks/completion"]])));
associate(["everyday-workflows", "native-connection-guidance", "grok-qualification", "grok-subscription-qualification"], {
  "build-revise": ["documents-artifacts/work-products"],
  "delegate-feedback": ["task-coordination/delegation", "steering/steer"],
  "agent-review-handoff": ["task-coordination/signoff"],
  "hire-reuse": ["agents/hire", "task-coordination/delegation"],
  "service-approve": ["questions-and-approvals/tool-review", "app-permissions/action-policy"],
  "service-decline": ["questions-and-approvals/tool-review", "app-permissions/action-policy"],
  "connection-decline": ["connection-setup/task-request"],
  "provider-decline": ["connection-setup/task-request"],
  "provider-second": ["connection-setup/task-request"],
  "provider-native": ["connection-setup/task-request"],
  "agentmail-setup": ["connection-setup/task-request"],
  "recover-controller": ["recovery/user-continuation", "documents-artifacts/work-products"],
  "stop-redirect": ["steering/stop-and-pause"],
  "create-skill-studio": ["skills/authoring"],
});
associate(["hiring-templates"], { "hire-coder-template-reuse": ["agents/hire", "task-coordination/delegation"] });
associate(["task-workspaces"], {
  "task-directory-repository-resume": ["workspaces/binding", "workspaces/provisioning", "projects/repositories"],
});
associate(["task-titles"], {
  "prompt-title-standard": ["tasks/create"],
  "prompt-title-ask": ["tasks/create"],
  "preserve-explicit-title": ["tasks/create"],
});
associate(["pi-controls", "native-active-stop"], {
  "pending-permission-stop": ["steering/stop-and-pause"],
  "same-turn-steering": ["steering/steer"],
});

export function journeyCapabilities(execution: Pick<ReportExecution, "suite" | "task">) {
  return (associations.get(`${execution.suite.id}/${execution.task.id}`) ?? [])
    .map((id) => capabilities.get(id)!);
}

export function journeyFeatureIds(execution: Pick<ReportExecution, "suite" | "task">) {
  return [...new Set(journeyCapabilities(execution).map((capability) => capability.feature.id))];
}
