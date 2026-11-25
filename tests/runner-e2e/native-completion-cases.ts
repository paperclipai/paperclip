import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";
import { contextIntegrityTasks } from "./context-integrity-cases.js";

export const nativeBlockedReportTask: RunnerTaskFixture = {
  id: "native-blocked-report", label: "Native concrete blocker report", groups: ["native-completion"],
  workMode: "standard", flow: "single_turn", expectedRunCount: 1, automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 5 * 60_000, daytona: 5 * 60_000 },
  expectedTerminalState: { issue: "blocked", run: "succeeded" },
  buildTitle: nonce => `Native blocker report ${nonce}`,
  buildVisibleMarker: nonce => `BLOCKED_${nonce.replace(/[^a-z0-9]/gi, "")}`,
  buildPrompt: nonce => [
    "Deployment cannot proceed because required release access has not been granted.",
    "Release Owner is the external owner of that grant. Do not attempt deployment, run shell/process commands, change files, invoke external services, create documents, agents, interactions or subtasks, or claim the access exists.",
    'Record the whole task as blocked and identify the owner as Release Owner. The exact unblock action is "Grant deployment access" (without quotation marks or trailing punctuation).',
    `Include BLOCKED_${nonce.replace(/[^a-z0-9]/gi, "")} exactly once in your final explanation.`,
  ].join("\n"),
  buildMatchers: nonce => [
    { kind: "issue_status", expected: "blocked" }, { kind: "run_status", expected: "succeeded" },
    { kind: "runtime_mode", expected: "native" },
    { kind: "message_contains", expected: `BLOCKED_${nonce.replace(/[^a-z0-9]/gi, "")}` },
    { kind: "message_contains", expected: "Release Owner" },
    { kind: "message_contains", expected: "Grant deployment access" },
    { kind: "message_regex", pattern: "^(?![\\s\\S]*\\b(?:not blocked|no longer blocked|access (?:is |has been |was )?already granted|completed Grant deployment access)\\b)[\\s\\S]*\\b(?:blocked|cannot proceed|can't proceed|missing|required access|not (?:yet )?granted|awaiting|waiting|unavailable)\\b", flags: "i" },
    { kind: "json_path", path: "run.resultJson.nativeResult.reportedWorkDisposition", expected: "blocked" },
    { kind: "json_path", path: "run.resultJson.nativeResult.blocker.owner.name", expected: "Release Owner" },
    { kind: "json_path", path: "run.resultJson.nativeResult.blocker.unblockAction", expected: "Grant deployment access" },
    { kind: "json_path", path: "run.resultJson.nativeResult.blocker.scope", expected: "task_wide" },
  ],
};

const assignedSkill = contextIntegrityTasks.find(task => task.id === "assigned-skill-explicit-invocation");
if (!assignedSkill) throw new Error("Missing original assigned-skill completion journey");
// Preserve the original task prompt, skill, durable-document oracle and deadline.
export const nativeCompletionTasks: readonly RunnerTaskFixture[] = [
  { ...assignedSkill, automaticRetryPolicy: "single_attempt" }, nativeBlockedReportTask,
];
export function nativeCompletionDefinitionDigest() {
  const hash = createHash("sha256");
  for (const file of ["native-completion-cases.ts", "native-completion-scoring.ts", "native-completion-content.ts", "native-completion-defaults.ts",
    "native-blocker-visible.ts", "native-completion-admission.ts", "native-completion-checks.mjs",
    "native-completion-source-contract.mjs", "automatic-retry.ts", "context-integrity-cases.ts", "context-integrity-flow.ts", "context-integrity-scoring.ts", "types.ts", "catalog.ts", "live-fixtures.ts", "runner.spec.ts", "launch.ts"]) {
    hash.update(file); hash.update(readFileSync(new URL(file, import.meta.url)));
  }
  return hash.digest("hex");
}
