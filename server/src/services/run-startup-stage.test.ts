import { afterEach, describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";

import { createRunPreparationTiming } from "./execution-preparation-timing.js";
import { decorateHeartbeatRunRuntimeStatus } from "./heartbeat/run-lifecycle.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { createNativeRunTrace } from "./native-runtime/native-run-trace.js";
import {
  beginRunStartupStages,
  clearAllRunStartupStages,
  endRunStartup,
  finishRunStartupStages,
  getRunStartupStage,
  MAX_TRACKED_RUN_STARTUPS,
  noteRunStartupSessionResumed,
  noteRunStartupStep,
  RUN_STARTUP_STAGE_TTL_MS,
  runStartupStageForStep,
} from "./run-startup-stage.js";

const companyId = "company-startup-stage";
const run = { id: "run-1", companyId, agentId: "agent-1", issueId: "issue-1" };

function recordEvents() {
  const events: LiveEvent[] = [];
  const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
    if (event.type === "heartbeat.run.startup_stage") events.push(event);
  });
  return { events, unsubscribe, stages: () => events.map(event => event.payload.stage) };
}

afterEach(() => clearAllRunStartupStages());

describe("run startup stages", () => {
  it("maps Core's timed steps to stages", () => {
    expect(runStartupStageForStep("heartbeat.prepare.agent_read")).toBe("getting_ready");
    expect(runStartupStageForStep("heartbeat.prepare.workspace_environment_acquire")).toBe("starting_environment");
    expect(runStartupStageForStep("heartbeat.prepare.workspace_environment_realize")).toBe("preparing_workspace");
    expect(runStartupStageForStep("native.controller.state_migration")).toBe("restoring_session");
    expect(runStartupStageForStep("native.controller.backend_setup")).toBe("connecting_tools");
    expect(runStartupStageForStep("runner.session.startup")).toBe("starting_agent");
    expect(runStartupStageForStep("agent.turn")).toBe("started");
    expect(runStartupStageForStep("runner.turn.submit")).toBe("started");
    expect(runStartupStageForStep("task.time_to_first_agent_activity")).toBe("started");
    expect(runStartupStageForStep("native.controller.github_access")).toBeNull();
    expect(runStartupStageForStep("workspace.checkout.git_clone")).toBeNull();
  });

  it("publishes each forward step and ignores steps that would move the run back", () => {
    const recorder = recordEvents();
    try {
      beginRunStartupStages(run);
      noteRunStartupStep(run.id, "heartbeat.prepare.workspace_environment_acquire");
      noteRunStartupStep(run.id, "heartbeat.prepare.workspace_environment_realize");
      // Host preparation after the environment keeps the later stage.
      noteRunStartupStep(run.id, "heartbeat.prepare.instructions");
      noteRunStartupStep(run.id, "native.controller.state_migration");
      noteRunStartupStep(run.id, "native.controller.backend_setup");
      noteRunStartupStep(run.id, "native.controller.github_access");
      noteRunStartupStep(run.id, "runner.session.startup");
      expect(recorder.stages()).toEqual([
        "getting_ready", "starting_environment", "preparing_workspace",
        "restoring_session", "connecting_tools", "starting_agent",
      ]);
      expect(recorder.events[0]?.payload).toMatchObject({ runId: run.id, agentId: run.agentId, issueId: run.issueId });
      expect(getRunStartupStage(run.id)).toEqual({ stage: "starting_agent", sessionResumed: false });
    } finally {
      recorder.unsubscribe();
    }
  });

  it("skips stages that a run does not need", () => {
    const recorder = recordEvents();
    try {
      beginRunStartupStages(run);
      noteRunStartupStep(run.id, "runner.session.startup");
      noteRunStartupStep(run.id, "native.controller.backend_setup");
      expect(recorder.stages()).toEqual(["getting_ready", "starting_agent"]);
    } finally {
      recorder.unsubscribe();
    }
  });

  it("ends startup when the agent turn starts", () => {
    const recorder = recordEvents();
    try {
      beginRunStartupStages(run);
      noteRunStartupStep(run.id, "agent.turn");
      noteRunStartupStep(run.id, "runner.session.startup");
      noteRunStartupStep(run.id, "agent.turn");
      expect(recorder.stages()).toEqual(["getting_ready", null]);
      expect(getRunStartupStage(run.id)).toEqual({ stage: null, sessionResumed: false });
      finishRunStartupStages(run.id);
      expect(recorder.stages()).toEqual(["getting_ready", null]);
      expect(getRunStartupStage(run.id)).toBeNull();
    } finally {
      recorder.unsubscribe();
    }
  });

  it("ignores runs that are not executing here", () => {
    const recorder = recordEvents();
    try {
      noteRunStartupStep("other-run", "runner.session.startup");
      noteRunStartupSessionResumed("other-run");
      finishRunStartupStages("other-run");
      expect(recorder.events).toEqual([]);
    } finally {
      recorder.unsubscribe();
    }
  });

  it("publishes a resumed session once", () => {
    const recorder = recordEvents();
    try {
      beginRunStartupStages(run);
      noteRunStartupStep(run.id, "runner.session.startup");
      noteRunStartupSessionResumed(run.id);
      noteRunStartupSessionResumed(run.id);
      expect(recorder.events.map(event => event.payload.sessionResumed)).toEqual([false, false, true]);
      expect(getRunStartupStage(run.id)).toEqual({ stage: "starting_agent", sessionResumed: true });
    } finally {
      recorder.unsubscribe();
    }
  });

  it("starts a new attempt over", () => {
    beginRunStartupStages(run);
    noteRunStartupStep(run.id, "runner.session.startup");
    noteRunStartupSessionResumed(run.id);
    beginRunStartupStages(run);
    expect(getRunStartupStage(run.id)).toEqual({ stage: "getting_ready", sessionResumed: false });
  });

  it("reads only the expected company and agent, and expires stale entries", () => {
    beginRunStartupStages(run);
    expect(getRunStartupStage(run.id, { companyId: "other" })).toBeNull();
    expect(getRunStartupStage(run.id, { agentId: "other" })).toBeNull();
    expect(getRunStartupStage(run.id, { companyId, agentId: run.agentId })?.stage).toBe("getting_ready");
    expect(getRunStartupStage(run.id, { now: new Date(Date.now() + RUN_STARTUP_STAGE_TTL_MS + 1) })).toBeNull();
    expect(getRunStartupStage(run.id)).toBeNull();
  });

  it("bounds the number of tracked runs", () => {
    for (let index = 0; index <= MAX_TRACKED_RUN_STARTUPS; index += 1) {
      beginRunStartupStages({ ...run, id: `run-${index}` });
    }
    expect(getRunStartupStage("run-0")).toBeNull();
    expect(getRunStartupStage(`run-${MAX_TRACKED_RUN_STARTUPS}`)?.stage).toBe("getting_ready");
  });

  it("follows the steps Core times and the native trace", async () => {
    beginRunStartupStages(run);
    await createRunPreparationTiming(run.id)("workspace_environment_acquire", () => undefined);
    expect(getRunStartupStage(run.id)?.stage).toBe("starting_environment");
    await createRunPreparationTiming(run.id, "native.controller")("backend_setup", () => undefined);
    expect(getRunStartupStage(run.id)?.stage).toBe("connecting_tools");
    const trace = createNativeRunTrace({ runId: run.id });
    trace.start("runner.session.startup");
    expect(getRunStartupStage(run.id)?.stage).toBe("starting_agent");
    trace.start("agent.turn");
    expect(getRunStartupStage(run.id)?.stage).toBeNull();
  });

  it("ends startup on recorded first agent activity when no turn span starts", async () => {
    beginRunStartupStages(run);
    const trace = createNativeRunTrace({ runId: run.id });
    trace.start("runner.session.startup");
    const now = Date.now();
    await trace.record({ name: "task.time_to_first_agent_activity", parentName: "task.provider_session",
      startedAtMs: now - 1_000, endedAtMs: now });
    expect(getRunStartupStage(run.id)?.stage).toBeNull();
  });

  it("keeps a confirmed resume for the attempt after its turn starts", () => {
    beginRunStartupStages(run);
    noteRunStartupStep(run.id, "runner.session.startup");
    noteRunStartupSessionResumed(run.id);
    endRunStartup(run.id);
    const later = new Date(Date.now() + RUN_STARTUP_STAGE_TTL_MS + 1);
    expect(getRunStartupStage(run.id, { now: later })).toEqual({ stage: null, sessionResumed: true });
    finishRunStartupStages(run.id);
    expect(getRunStartupStage(run.id)).toBeNull();
  });

  it("adds the stage to active run reads and drops it for ended runs", () => {
    beginRunStartupStages(run);
    noteRunStartupStep(run.id, "native.controller.backend_setup");
    const base = { id: run.id, companyId, agentId: run.agentId, issueId: run.issueId };
    expect(decorateHeartbeatRunRuntimeStatus({ ...base, status: "running" })).toMatchObject({
      startupStage: "connecting_tools", startupSessionResumed: false,
    });
    expect(decorateHeartbeatRunRuntimeStatus({ ...base, status: "succeeded" })).toMatchObject({
      startupStage: null, startupSessionResumed: false,
    });
    expect(getRunStartupStage(run.id)).toBeNull();
  });
});
