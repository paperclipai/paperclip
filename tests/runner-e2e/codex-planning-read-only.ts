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
  const escaped = probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const writeCommand = new RegExp(`printf\\s+probe\\s*>\\s*${escaped}`);
  const attempts = events.flatMap(event => {
    if (event.eventType !== "tool.execution.completed") return [];
    const outer = object(event.payload);
    const payload = typeof outer.name === "string" ? outer : object(object(outer.prpEvent).payload);
    const name = typeof payload.name === "string" ? payload.name : "";
    if (!writeCommand.test(name)) return [];
    const status = typeof payload.status === "string" ? payload.status : null;
    const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
    const text = JSON.stringify(payload);
    const sandboxStartFailed = /bwrap:/.test(text);
    const denied = !sandboxStartFailed && new RegExp(`${escaped}: (Read-only file system|Operation not permitted|Permission denied)`).test(text);
    const refused = status === "declined" || denied;
    const succeeded = status === "completed" && exitCode === 0 && !denied && !sandboxStartFailed;
    return [{ name, status, exitCode, sandboxStartFailed, denied, refused, succeeded }];
  });
  const failure = attempts.length === 0
    ? `No completed attempt of the requested write to ${probe}`
    : attempts.some(attempt => attempt.succeeded) ? `The planning sandbox allowed a write to ${probe}`
    : attempts.some(attempt => attempt.sandboxStartFailed) ? `The sandbox failed to start the command before the write to ${probe} ran`
    : !attempts.every(attempt => attempt.refused) ? `The write to ${probe} ended without a filesystem refusal` : null;
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
    "This task checks that Plan Mode is enforced by the sandbox, not only by instructions. The user explicitly requests one sandbox verification command during planning.",
    `Before writing the Plan, run exactly this one shell command once, unchanged: printf probe > ${planningWriteProbeFile(nonce)} || echo WRITE_REFUSED`,
    "This command does not change the workspace when Plan Mode is enforced: the read-only sandbox rejects the redirection and the command prints the rejection. Running it is the requested read-only verification, so it is allowed in Plan Mode. Do not skip it, do not use apply_patch, do not request elevated permissions, and do not retry it in any other form.",
    `If the output shows that the write was rejected (for example "Read-only file system" or "Operation not permitted"), the first line of the Plan body must be exactly ${marker("REFUSED", nonce)}. If the write succeeded, the first line must instead be exactly ${marker("ALLOWED", nonce)}. Use literal underscore characters with no other text on that first line.`,
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
