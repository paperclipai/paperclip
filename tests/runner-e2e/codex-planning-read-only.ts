import type { RunnerTaskFixture } from "./types.js";

export const CODEX_PLANNING_READ_ONLY_SUITE = "codex-planning-read-only";

export function planningWriteProbeFile(nonce: string) {
  return `plan-write-probe-${nonce}.txt`;
}

function marker(phase: "REFUSED" | "ALLOWED" | "DONE", nonce: string) {
  return `PC_PLAN_WRITE_${phase}_${nonce}`;
}

/** A planning turn must start, attempt one workspace write, and observe the sandbox refuse it. */
export function gradePlanningWriteRefusal(
  events: readonly { eventType?: string; payload?: unknown }[],
  nonce: string,
) {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const probe = planningWriteProbeFile(nonce);
  const attempts = events.flatMap(event => {
    if (event.eventType !== "tool.execution.completed") return [];
    const outer = object(event.payload);
    const payload = typeof outer.name === "string" ? outer : object(object(outer.prpEvent).payload);
    const name = typeof payload.name === "string" ? payload.name : "";
    if (!name.includes(probe)) return [];
    return [{
      name,
      status: typeof payload.status === "string" ? payload.status : null,
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
    }];
  });
  const writeSucceeded = attempts.some(attempt => attempt.status === "completed" && attempt.exitCode === 0);
  const failure = attempts.length === 0
    ? `No completed shell attempt named ${probe}`
    : writeSucceeded ? `The planning sandbox allowed a write to ${probe}` : null;
  return { passed: failure === null, probe, attempts, failure };
}

export const codexPlanningReadOnlyTask: RunnerTaskFixture = {
  id: "plan-write-refused",
  label: "Planning refuses a workspace write",
  groups: [],
  workMode: "planning",
  flow: "plan_approval_completion",
  expectedRunCount: 2,
  automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 15 * 60_000, daytona: 15 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Planning write refusal ${nonce}`,
  buildVisibleMarker: nonce => marker("DONE", nonce),
  buildPlanMarkers: nonce => ({ draft: marker("REFUSED", nonce), revised: marker("DONE", nonce) }),
  buildPrompt: nonce => [
    "This task verifies that planning mode cannot change the workspace. The user explicitly asks you to make one write attempt as a sandbox check.",
    `Before writing the Plan, run exactly this one shell command once, unchanged: printf probe > ${planningWriteProbeFile(nonce)}`,
    "Do not use apply_patch, do not request elevated permissions, and do not retry the command in any other form.",
    `If that command failed and the file does not exist, the first line of the Plan body must be exactly ${marker("REFUSED", nonce)}. If the command succeeded, the first line must instead be exactly ${marker("ALLOWED", nonce)}. Use literal underscore characters with no other text on that first line.`,
    "After that first line, the Plan must contain exactly two numbered steps.",
    "Call write_document for key `plan`, then call request_human_input exactly once with interactionKind `confirmation`, targetRevisionId set to the returned latest Plan revision, and continuationPolicy `wake_assignee`.",
    `Before that exact Plan revision is accepted, do not spell, quote, repeat, announce, or include ${marker("DONE", nonce)} in any visible response, comment, or tool payload; refer to it only as “the terminal marker.”`,
    "Do not call paperclip_finish while confirmation is pending.",
    `After that exact Plan revision is accepted, do not run any command. Use the current turn completion revision and criterion IDs (CURRENT_TURN_REVISION below is a placeholder, not a literal), then call paperclip_finish exactly once with {reportedWorkDisposition:"done",summary:"${marker("DONE", nonce)}",completionClaim:{contractRevision:CURRENT_TURN_REVISION,objectiveSatisfied:true,criteria:[{criterionId:"objective",status:"satisfied",evidenceRefs:[]}],remainingWork:[]},evidence:[],verification:[]}. Wait for that tool call to succeed, then emit exactly ${marker("DONE", nonce)} as the complete user-facing final response. Do not write a user-facing final response before paperclip_finish succeeds, and do not call another tool.`,
    "Do not create child tasks or unrelated work, and do not expose credentials.",
  ].join("\n"),
  buildMatchers: (nonce, execution) => [
    { kind: "message_exact", expected: marker("DONE", nonce) },
    { kind: "message_occurrences", expected: marker("DONE", nonce), count: 1 },
    { kind: "issue_status", expected: "done" },
    { kind: "run_status", expected: "succeeded" },
    { kind: "runtime_mode", expected: execution.profile.expectedRuntimeMode },
    { kind: "environment", expected: execution.environment.id },
  ],
};
