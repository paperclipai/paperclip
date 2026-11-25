import { RUN_STARTUP_STAGES, type HeartbeatRunStartupStageEvent, type RunStartupStage } from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";

/**
 * Process-local startup step of each executing run, for the board's live
 * status line. Like the runtime status store it is never persisted: a server
 * restart, the agent turn starting, or the run ending clears it.
 *
 * Stages come from the steps Core already times. One table maps step names to
 * stages, so the timing spans and the stage the board shows cannot drift apart.
 */
const STAGE_BY_STEP: ReadonlyMap<string, RunStartupStage> = new Map([
  ["heartbeat.prepare.workspace_environment_acquire", "starting_environment"],
  ["heartbeat.prepare.workspace_environment_realize", "preparing_workspace"],
  ["native.controller.state_migration", "restoring_session"],
  ["native.controller.backend_setup", "connecting_tools"],
  ["runner.session.startup", "starting_agent"],
]);

/**
 * Steps that end startup: the agent's turn has begun. The submit and
 * first-activity spans back up `agent.turn` for a run that attaches to a turn
 * already in flight, so a stale startup stage never covers agent work.
 */
const STARTUP_END_STEPS: ReadonlySet<string> = new Set([
  "agent.turn",
  "runner.turn.submit",
  "provider.time_to_first_agent_event",
  "task.time_to_first_agent_activity",
]);

const STAGE_ORDER = new Map(RUN_STARTUP_STAGES.map((stage, index) => [stage, index]));

/** Bounds a store that a crashed executor might never clear. */
export const MAX_TRACKED_RUN_STARTUPS = 512;
export const RUN_STARTUP_STAGE_TTL_MS = 60 * 60_000;

interface RunStartupEntry {
  companyId: string;
  agentId: string;
  issueId: string | null;
  /** Null once the agent's turn has started; the attempt keeps its resume flag. */
  stage: RunStartupStage | null;
  sessionResumed: boolean;
  updatedAt: Date;
}

const entriesByRunId = new Map<string, RunStartupEntry>();

export function runStartupStageForStep(stepName: string): RunStartupStage | "started" | null {
  const mapped = STAGE_BY_STEP.get(stepName);
  if (mapped) return mapped;
  if (STARTUP_END_STEPS.has(stepName)) return "started";
  // Any other host preparation step is general setup. It never moves a run
  // back, so the steps Core runs after the environment keep the later stage.
  return stepName.startsWith("heartbeat.prepare.") ? "getting_ready" : null;
}

function publish(runId: string, entry: Pick<RunStartupEntry, "companyId" | "agentId" | "issueId">,
  stage: RunStartupStage | null, sessionResumed: boolean, updatedAt: Date) {
  const payload: HeartbeatRunStartupStageEvent = {
    runId, agentId: entry.agentId, issueId: entry.issueId, stage, sessionResumed, updatedAt: updatedAt.toISOString(),
  };
  publishLiveEvent({ companyId: entry.companyId, type: "heartbeat.run.startup_stage", payload: { ...payload } });
}

/**
 * Starts tracking one execution attempt of a run. A new attempt of the same
 * run starts over, because its startup repeats every step.
 */
export function beginRunStartupStages(run: { id: string; companyId: string; agentId: string; issueId: string | null }) {
  if (!entriesByRunId.has(run.id) && entriesByRunId.size >= MAX_TRACKED_RUN_STARTUPS) {
    const oldest = entriesByRunId.keys().next().value;
    if (oldest !== undefined) entriesByRunId.delete(oldest);
  }
  entriesByRunId.delete(run.id);
  const entry: RunStartupEntry = {
    companyId: run.companyId, agentId: run.agentId, issueId: run.issueId,
    stage: "getting_ready", sessionResumed: false, updatedAt: new Date(),
  };
  entriesByRunId.set(run.id, entry);
  publish(run.id, entry, entry.stage, false, entry.updatedAt);
}

/** Records that a timed step began. Unknown runs and earlier stages are ignored. */
export function noteRunStartupStep(runId: string, stepName: string) {
  const entry = entriesByRunId.get(runId);
  if (!entry || entry.stage === null) return;
  const next = runStartupStageForStep(stepName);
  if (next === null) return;
  if (next === "started") {
    endRunStartup(runId);
    return;
  }
  if ((STAGE_ORDER.get(next) ?? -1) <= (STAGE_ORDER.get(entry.stage) ?? -1)) return;
  entry.stage = next;
  entry.updatedAt = new Date();
  publish(runId, entry, entry.stage, entry.sessionResumed, entry.updatedAt);
}

/** The provider confirmed it resumed a saved session for this run. */
export function noteRunStartupSessionResumed(runId: string) {
  const entry = entriesByRunId.get(runId);
  if (!entry || entry.sessionResumed) return;
  entry.sessionResumed = true;
  entry.updatedAt = new Date();
  publish(runId, entry, entry.stage, true, entry.updatedAt);
}

/**
 * Ends startup because the agent is working: its turn started (native), or a
 * direct adapter took over the execution. The attempt keeps its resume flag,
 * so a later read still reports a confirmed resumed session.
 */
export function endRunStartup(runId: string) {
  const entry = entriesByRunId.get(runId);
  if (!entry || entry.stage === null) return;
  entry.stage = null;
  entry.updatedAt = new Date();
  publish(runId, entry, null, entry.sessionResumed, entry.updatedAt);
}

/** Forgets the execution attempt once it ends. */
export function finishRunStartupStages(runId: string) {
  const entry = entriesByRunId.get(runId);
  if (!entry) return;
  entriesByRunId.delete(runId);
  if (entry.stage !== null) publish(runId, entry, null, entry.sessionResumed, new Date());
}

export function getRunStartupStage(
  runId: string,
  expected: { companyId?: string | null; agentId?: string | null; now?: Date } = {},
): { stage: RunStartupStage | null; sessionResumed: boolean } | null {
  const entry = entriesByRunId.get(runId);
  if (!entry) return null;
  const now = expected.now ?? new Date();
  // Only a shown stage can go stale; a started attempt keeps its resume flag
  // until the attempt ends (or the store's size bound evicts it).
  if (entry.stage !== null && now.getTime() - entry.updatedAt.getTime() > RUN_STARTUP_STAGE_TTL_MS) {
    entriesByRunId.delete(runId);
    return null;
  }
  if (expected.companyId != null && entry.companyId !== expected.companyId) return null;
  if (expected.agentId != null && entry.agentId !== expected.agentId) return null;
  return { stage: entry.stage, sessionResumed: entry.sessionResumed };
}

/** Forgets a run without publishing, e.g. once a terminal status is observed. */
export function clearRunStartupStage(runId: string) {
  entriesByRunId.delete(runId);
}

export function clearAllRunStartupStages() {
  entriesByRunId.clear();
}
