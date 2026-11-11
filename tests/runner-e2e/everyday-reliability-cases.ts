import type { RunnerTaskFixture } from "./types.js";

/**
 * Staging-soak reliability scenarios. Every case reproduces a real staging
 * failure end to end. They are explicit-only: `--all`, `--suite
 * everyday-workflows` and generic profile/environment selectors never pick
 * them. Select them with `--group reliability`, a `--case`, or an exact `--id`.
 */
export const EVERYDAY_RELIABILITY_GROUP = "reliability";
export const EVERYDAY_RELIABILITY_SLOW_GROUP = "slow";

/** Seconds per silent iteration and iteration count for `long-silent-command`. */
export const LONG_SILENT_ITERATION_SECONDS = 60;
export const LONG_SILENT_ITERATIONS = 13;

/** Soak signature, the observed failure before its fix, and related fix PRs. */
export const everydayReliabilitySignatures = {
  "interrupt-redirect": { signature: "S47", observed: "Interrupted follow-up started after 4 minutes or never; needed a second message.", fixes: ["#19370", "#19355"] },
  "reassign-midrun": { signature: "S48", observed: "Reassigning an active task returned 409 or hung for 20 seconds; the old run kept executing.", fixes: ["#19354"] },
  "three-turn-revise": { signature: "S49", observed: "Turn 3 on an ephemeral Daytona lease (gpt-5.6-sol) stopped behind a reconciliation / send-a-message blocker.", fixes: [] },
  "long-silent-command": { signature: "S52/S52b", observed: "ACPX-facade runs (Grok, Kimi, OpenRouter/Pi) hung 3/3 after a long silent foreground command; Stop disappeared.", fixes: ["#19407", "#19419"] },
  "tree-pause-release": { signature: "S50/S50b", observed: "A child started during a tree pause, or did not resume after release without wakeAgents.", fixes: ["#19394", "#19421"] },
  "queue-steer": { signature: "H2", observed: "Edited, discarded and steered queue entries were lost, replayed, or delivered twice.", fixes: [] },
  "queued-across-restart": { signature: "S55/U9", observed: "Follow-up queued before a controller restart sat as a bare Queued until another message.", fixes: ["#19431"] },
} as const;

export type EverydayReliabilityCaseId = keyof typeof everydayReliabilitySignatures;
export const everydayReliabilityCaseIds = Object.keys(everydayReliabilitySignatures) as EverydayReliabilityCaseId[];

export function isEverydayReliabilityCase(caseId: string): caseId is EverydayReliabilityCaseId {
  return Object.hasOwn(everydayReliabilitySignatures, caseId);
}

/** Bounds encoded in the graders. Soak saw 13-90 s once fixed; 4 minutes or never before. */
export const RELIABILITY_BOUNDS = {
  continuationStartMs: 3 * 60_000,
  reassignRequestMs: 10_000,
  restartDispatchMs: 6 * 60_000,
  silentCompletionAfterCommandMs: 8 * 60_000,
  steeringRetryWindowMs: 2 * 60_000,
  holdObservationMs: 75_000,
} as const;

/** A resumable slow loop: an interrupted or reassigned run must continue from saved files. */
export function slowStepsPrompt(file: string, steps: number, pauseSeconds: number): string {
  return `Create ${file} in the project workspace and record progress one line at a time: for each step from 1 to ${steps}, append the line "step-N" (for example "step-1"), then wait ${pauseSeconds} seconds before the next step. Do the waiting in ordinary foreground shell commands. If ${file} already has some steps, continue from the next missing step; never write a step twice. When all ${steps} steps are recorded, reply with a one-line summary.`;
}

export const interruptRedirectMessage = (nonce: string) =>
  `Change of plan: stop the step loop where it is. Create redirect.txt containing exactly REDIRECT_${nonce} and reply with "Redirected ${nonce}".`;
export const stopSettleMessage = (nonce: string) =>
  `After the stop: leave the step file as it is. Create settled.txt containing exactly SETTLED_${nonce} and reply with "Settled ${nonce}".`;
export const threeTurnRevisions = (nonce: string) => [
  `Add two more items to items.md: "delta ${nonce}" and "epsilon ${nonce}". Keep the existing items.`,
  `Convert items.md into a Markdown table with the columns Number and Item, one row per existing item in the same order. Keep no bullet list.`,
] as const;
export const longSilentCommand = (iterations = LONG_SILENT_ITERATIONS, seconds = LONG_SILENT_ITERATION_SECONDS) =>
  `for i in $(seq 1 ${iterations}); do sleep ${seconds}; echo "tick-$i" >> silent.txt; done`;
export const queueSteerMessages = (nonce: string) => ({
  original: `Also create edited.txt containing exactly ORIGINAL_${nonce}.`,
  edited: `Also create edited.txt containing exactly EDITED_${nonce}.`,
  discarded: `Also create discarded.txt containing exactly DISCARDED_${nonce}.`,
  steered: `While you work, also create steered.txt containing exactly STEERED_${nonce}.`,
});
export const queuedRestartMessage = (nonce: string) =>
  `Next, create after-restart.txt containing exactly RESTARTED_${nonce} and reply with "Restarted ${nonce}".`;

const definitions: ReadonlyArray<{
  id: EverydayReliabilityCaseId;
  label: string;
  prompt: (nonce: string) => string;
  expectedRunCount: number;
  daytonaTimeoutMs: number;
  slow?: boolean;
}> = [
  { id: "interrupt-redirect", label: "Interrupt a run with a follow-up, then send during Stop settlement",
    prompt: () => slowStepsPrompt("steps.txt", 8, 30), expectedRunCount: 6, daytonaTimeoutMs: 35 * 60_000 },
  { id: "reassign-midrun", label: "Reassign an active task to another agent",
    prompt: () => slowStepsPrompt("steps.txt", 8, 30), expectedRunCount: 3, daytonaTimeoutMs: 30 * 60_000 },
  { id: "three-turn-revise", label: "Create and revise one workspace file across three turns",
    prompt: nonce => `Create items.md in the project workspace with a bullet list of exactly three items: "alpha ${nonce}", "beta ${nonce}" and "gamma ${nonce}". Reply when it is saved.`,
    expectedRunCount: 3, daytonaTimeoutMs: 35 * 60_000 },
  { id: "long-silent-command", label: "Finish after a long silent foreground command",
    prompt: nonce => `Run exactly this shell command in the project workspace as one foreground command and wait for it to finish. It takes about ${LONG_SILENT_ITERATIONS} minutes and prints nothing; that is expected. Do not background it, shorten it, split it, or interrupt it:\n\n${longSilentCommand()}\n\nAfter it finishes, count the lines in silent.txt and reply with "SILENT_DONE_${nonce} <line count>".`,
    expectedRunCount: 1, daytonaTimeoutMs: 50 * 60_000, slow: true },
  { id: "tree-pause-release", label: "Pause and release a delegated task tree",
    prompt: () => `Delegate two child tasks to Riley Builder, one per file. Child A: ${slowStepsPrompt("a.txt", 5, 20)} Child B: ${slowStepsPrompt("b.txt", 5, 20)} Keep the implementation with Riley. When both children are done, confirm both files are complete and finish.`,
    expectedRunCount: 6, daytonaTimeoutMs: 40 * 60_000 },
  { id: "queue-steer", label: "Edit, discard and steer queued follow-ups",
    prompt: () => slowStepsPrompt("steps.txt", 8, 30), expectedRunCount: 2, daytonaTimeoutMs: 30 * 60_000 },
  { id: "queued-across-restart", label: "Dispatch a follow-up queued before a controller restart",
    prompt: () => slowStepsPrompt("steps.txt", 6, 20), expectedRunCount: 3, daytonaTimeoutMs: 30 * 60_000 },
];

export const everydayReliabilityTasks: readonly RunnerTaskFixture[] = definitions.map(definition => ({
  id: definition.id,
  label: definition.label,
  groups: [EVERYDAY_RELIABILITY_GROUP, ...(definition.slow ? [EVERYDAY_RELIABILITY_SLOW_GROUP] : [])],
  explicitGroup: EVERYDAY_RELIABILITY_GROUP,
  workMode: "standard",
  flow: "everyday_workflow",
  // An upper bound for cost estimates; an offered Retry or workspace deferral may add a run.
  expectedRunCount: definition.expectedRunCount,
  minimumExpectedRunCount: 1,
  automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 20 * 60_000, daytona: definition.daytonaTimeoutMs },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `${definition.label} ${nonce}`,
  buildPrompt: definition.prompt,
  buildVisibleMarker: nonce => `STUDIO_${nonce}`,
  buildMatchers: () => [], // The workflow records independent reliability checks.
}));

/** The explicit-only native Codex extra for every reliability case, plus ACPX facades for the silent command. */
export const RELIABILITY_NATIVE_PROFILE_ID = "runner-codex";
export const RELIABILITY_FACADE_PROFILE_IDS = ["runner-acpx-grok", "runner-acpx-kimi", "runner-acpx-pi"] as const;

/**
 * The TestOps Reliability plan profile: native OpenCode with DeepSeek 1017
 * through OpenRouter, the cheapest native profile with a Daytona-capable driver.
 */
export const RELIABILITY_PLAN_PROFILE_ID = "runner-opencode-deepseek-1017";

/**
 * One plan cell per case. Daytona only where the soak failure was a sandbox
 * lease failure: S49 (per-turn lease on turn 3), S52/S52b (a long silent command
 * on a remote runner) and S55 (a restart with a remote lease). The other cases
 * exercise control-plane queue, interrupt, reassignment and tree-hold paths that
 * behave the same with a local runner.
 *
 * `queue-steer` is the exception to DeepSeek: it must steer an active turn, and
 * the OpenCode server driver declares `steering: false`, so the queued-comment
 * route answers `steering_unsupported`. The plan uses the existing native Codex
 * Daytona cell for it, which supports steering.
 */
export const reliabilityPlanCells: Readonly<Record<EverydayReliabilityCaseId,
  { profile: typeof RELIABILITY_PLAN_PROFILE_ID | typeof RELIABILITY_NATIVE_PROFILE_ID; environment: "local" | "daytona" }>> = {
  "interrupt-redirect": { profile: RELIABILITY_PLAN_PROFILE_ID, environment: "local" },
  "reassign-midrun": { profile: RELIABILITY_PLAN_PROFILE_ID, environment: "local" },
  "three-turn-revise": { profile: RELIABILITY_PLAN_PROFILE_ID, environment: "daytona" },
  "long-silent-command": { profile: RELIABILITY_PLAN_PROFILE_ID, environment: "daytona" },
  "tree-pause-release": { profile: RELIABILITY_PLAN_PROFILE_ID, environment: "local" },
  "queue-steer": { profile: RELIABILITY_NATIVE_PROFILE_ID, environment: "daytona" },
  "queued-across-restart": { profile: RELIABILITY_PLAN_PROFILE_ID, environment: "daytona" },
};

/** The seven TestOps Reliability plan cells, in case order. */
export function reliabilityPlanExecutionIds(suiteId: string): string[] {
  return everydayReliabilityCaseIds.map(caseId =>
    `${suiteId}.${reliabilityPlanCells[caseId].profile}.${reliabilityPlanCells[caseId].environment}.${caseId}`);
}

/**
 * The deliberately small paid matrix: the seven plan cells, plus the
 * explicit-only extras (the native Codex Daytona cell for every other case and
 * the ACPX facades for long-silent-command). Only the plan cells belong to TestOps.
 */
export function everydayReliabilityExecutionIds(suiteId: string,
  facadeProfileIds: readonly string[] = RELIABILITY_FACADE_PROFILE_IDS): string[] {
  return [...new Set([
    ...reliabilityPlanExecutionIds(suiteId),
    ...everydayReliabilityCaseIds.map(caseId => `${suiteId}.${RELIABILITY_NATIVE_PROFILE_ID}.daytona.${caseId}`),
    ...facadeProfileIds.map(profileId => `${suiteId}.${profileId}.daytona.long-silent-command`),
  ])];
}
