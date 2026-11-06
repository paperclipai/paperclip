import { describe, expect, it } from "vitest";
import { buildMatrixJobs, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { everydayReliabilityFacadeProfileIds, runnerMatrix } from "./catalog.js";
import { scheduledSelection } from "./scheduled-operations.js";
import {
  EVERYDAY_RELIABILITY_GROUP, everydayReliabilityCaseIds, everydayReliabilityExecutionIds, everydayReliabilitySignatures,
  everydayReliabilityTasks, isEverydayReliabilityCase,
} from "./everyday-reliability-cases.js";
import {
  completeStepLines, concurrentExecutors, recoveredRunIds, gradeInterruptRedirect, gradeLongSilentCommand, gradeQueueSteer,
  gradeQueuedAcrossRestart, gradeReassignMidrun, gradeResumptionRule, gradeThreeTurnRevise, gradeTreePauseRelease,
  requiresUserMessage,
} from "./everyday-reliability.js";
import { isExpectedStoryInterruption, storyLifecycleChecks, type StoryCheck, type StoryRun } from "./everyday-observations.js";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const run = (id: string, overrides: Partial<StoryRun> = {}): StoryRun => ({
  id, companyId: "company", agentId: "lead", status: "succeeded", runtimeMode: "native", runnerInstanceId: "runner",
  nativeIssueId: "parent", startedAt: at(0), finishedAt: at(60), ...overrides,
});
/** A run woken to deliver `wake`; its prompt holds `history` (the whole conversation so far). */
const carrying = (id: string, wake: string, overrides: Partial<StoryRun> = {}, history = "") =>
  run(id, { contextSnapshot: { issueId: "parent", wakeCommentIds: [wake] },
    runnerProfileJson: { nativeExecutionInput: { task: { prompt: `${history} ${wake}` } } }, ...overrides });
const reliabilityCellCount = everydayReliabilityCaseIds.length + everydayReliabilityFacadeProfileIds.length;
const failed = (checks: StoryCheck[]) => checks.filter(check => !check.passed).map(check => check.id);

describe("reliability selection stays explicit", () => {
  const reliable = (executions: { groups: readonly string[] }[]) => executions.filter(execution => execution.groups.includes(EVERYDAY_RELIABILITY_GROUP));

  it("selects the whole reliability set only through its group", () => {
    const selected = selectRunnerExecutions(parseRunnerSelectors(["--suite", "everyday-workflows", "--group", "reliability"]));
    expect(selected.map(execution => execution.id).sort())
      .toEqual(everydayReliabilityExecutionIds("everyday-workflows", everydayReliabilityFacadeProfileIds).sort());
    expect(selected).toHaveLength(reliabilityCellCount);
    expect(selected.every(execution => execution.environment.id === "daytona")).toBe(true);
  });

  it("is excluded from --all, the plain suite, generic selectors and scheduled campaigns", () => {
    for (const args of [["--all"], ["--suite", "everyday-workflows"], ["--suite", "everyday-workflows", "--environment", "daytona"],
      ["--suite", "everyday-workflows", "--profile", "runner-codex"], ["--suite", "everyday-workflows", "--group", "native"],
      ["--profile", "runner-codex"], ["--environment", "daytona"]]) {
      expect(reliable(selectRunnerExecutions(parseRunnerSelectors(args))), args.join(" ")).toEqual([]);
    }
    expect(selectRunnerExecutions(parseRunnerSelectors(["--suite", "everyday-workflows"]))).toHaveLength(52);
    for (const cadence of ["daily", "weekly"] as const)
      expect(scheduledSelection(cadence).filter(id => id.startsWith("everyday-workflows."))).toEqual([]);
  });

  it("allows a single case or exact ID and keeps the cells discoverable in --list", () => {
    expect(selectRunnerExecutions(parseRunnerSelectors(["--suite", "everyday-workflows", "--case", "long-silent-command"]))
      .map(execution => execution.profile.id).sort()).toEqual(["runner-codex", ...everydayReliabilityFacadeProfileIds].sort());
    expect(selectRunnerExecutions(parseRunnerSelectors(["--id", "everyday-workflows.runner-codex.daytona.queue-steer"]))).toHaveLength(1);
    expect(reliable(selectRunnerExecutions(parseRunnerSelectors(["--list"])))).toHaveLength(reliabilityCellCount);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--suite", "everyday-workflows", "--group", "slow"]))
      .every(execution => execution.task.id === "long-silent-command")).toBe(true);
  });

  it("uses one native Daytona profile per case and facades only for the silent command", () => {
    const cells = runnerMatrix.filter(execution => isEverydayReliabilityCase(execution.task.id));
    expect(cells).toHaveLength(reliabilityCellCount);
    for (const caseId of everydayReliabilityCaseIds) {
      const profiles = cells.filter(execution => execution.task.id === caseId).map(execution => execution.profile.id);
      expect(profiles).toContain("runner-codex");
      expect(profiles.length).toBe(caseId === "long-silent-command" ? 1 + everydayReliabilityFacadeProfileIds.length : 1);
    }
    expect(runnerMatrix.filter(execution => execution.suite.id === "everyday-workflows"
      && ["runner-acpx-grok", "runner-acpx-kimi", "runner-acpx-pi"].includes(execution.profile.id)
      && execution.task.id !== "long-silent-command")).toEqual([]);
    const turnThree = cells.find(execution => execution.task.id === "three-turn-revise")!;
    expect(turnThree.environment.configurationKey).toBeUndefined(); // Per-turn ephemeral lease, as in S49.
    expect(cells.find(execution => execution.task.id === "long-silent-command")!.groups).toContain("slow");
  });

  it("gives the slow case its own deadline and single attempts", () => {
    const silent = everydayReliabilityTasks.find(task => task.id === "long-silent-command")!;
    expect(silent.attemptTimeoutMs.daytona).toBeGreaterThanOrEqual(45 * 60_000);
    expect(everydayReliabilityTasks.every(task => task.automaticRetryPolicy === "single_attempt")).toBe(true);
    const [job] = buildMatrixJobs(runnerMatrix.filter(execution => execution.id === "everyday-workflows.runner-codex.daytona.long-silent-command"));
    expect(job!.timeoutMinutes).toBeGreaterThan(100);
  });

  it("requires the facade credentials before provider spend and records each soak signature", () => {
    const credentials = (profile: string) => runnerMatrix.find(execution =>
      execution.id === `everyday-workflows.${profile}.daytona.long-silent-command`)!.requiredCredentials;
    const facadeCredentials: Record<string, string> = { "runner-acpx-grok": "XAI_API_KEY", "runner-acpx-kimi": "KIMI_API_KEY", "runner-acpx-pi": "OPENROUTER_API_KEY" };
    for (const profile of everydayReliabilityFacadeProfileIds)
      expect(credentials(profile)).toEqual([facadeCredentials[profile], "DAYTONA_API_KEY"]);
    expect(Object.keys(everydayReliabilitySignatures).sort()).toEqual([...everydayReliabilityCaseIds].sort());
    for (const task of everydayReliabilityTasks)
      expect(task.buildPrompt("sample")).not.toMatch(/finish_task|paperclip_finish|PATCH|mark .*done|api\/issues/i);
  });
});

describe("reliability interruption bookkeeping", () => {
  it("exempts only deliberate interrupt and reassignment stops", () => {
    expect(isExpectedStoryInterruption(run("a", { status: "cancelled", errorCode: "operator_interrupted" }), ["a"])).toBe(true);
    expect(isExpectedStoryInterruption(run("a", { status: "cancelled", errorCode: "issue_reassigned" }), ["a"])).toBe(true);
    expect(isExpectedStoryInterruption(run("a", { status: "cancelled", errorCode: "issue_reassigned" }), [])).toBe(false);
    expect(isExpectedStoryInterruption(run("a", { status: "cancelled", errorCode: "workspace_lost" }), ["a"])).toBe(false);
  });
  it("lets a reassigned owner execute on the parent only when declared", () => {
    const input = { issues: [{ id: "parent", companyId: "company", title: "t", status: "done" }], parentId: "parent", leadId: "lead",
      runs: [run("a", { agentId: "riley", contextSnapshot: { issueId: "parent" } })] };
    expect(failed(storyLifecycleChecks(input))).toContain("parent-owned-by-lead");
    expect(failed(storyLifecycleChecks({ ...input, parentAgentIds: ["lead", "riley"] }))).toEqual([]);
  });
});

describe("product rule: resume automatically or offer a Retry that works", () => {
  it("treats a failure as recovered only when a later run on the same task succeeds", () => {
    const lost = run("lost", { status: "failed", errorCode: "runner_lost", finishedAt: at(60) });
    expect(recoveredRunIds([lost, run("retry", { startedAt: at(70), finishedAt: at(120) })])).toEqual(["lost"]);
    expect(recoveredRunIds([lost])).toEqual([]);
    expect(recoveredRunIds([lost, run("other", { nativeIssueId: "child", startedAt: at(70) })])).toEqual([]);
    const lifecycle = { issues: [{ id: "parent", companyId: "company", title: "t", status: "done" }], parentId: "parent", leadId: "lead",
      runs: [lost, run("retry", { startedAt: at(70), finishedAt: at(120) })] };
    expect(failed(storyLifecycleChecks(lifecycle))).toEqual(["successful-runs"]);
    expect(failed(storyLifecycleChecks({ ...lifecycle, recoveredRuns: ["lost"] }))).toEqual([]);
  });
  it("passes automatic resumption", () => expect(failed(gradeResumptionRule({ observations: [], retryClicks: [] }))).toEqual([]));
  it("fails a send-a-message blocker, a dead Retry, a repeated Retry, and a stall", () => {
    const blocker = { at: at(1), issueId: "parent", blocker: { cause: "x", nextAction: "Saved work recovered. Send a message to continue.", canRetry: false } };
    expect(requiresUserMessage(blocker)).toBe(true);
    expect(requiresUserMessage({ ...blocker, blocker: { ...blocker.blocker, canRetry: true } })).toBe(false);
    expect(requiresUserMessage({ at: at(1), issueId: "parent", interruption: { state: "waiting_for_user", canRetry: false, userAction: null } })).toBe(true);
    expect(failed(gradeResumptionRule({ observations: [blocker], retryClicks: [] }))).toEqual(["resume.no-send-message-blocker"]);
    expect(failed(gradeResumptionRule({ observations: [], retryClicks: [{ at: at(1), issueId: "parent" }] }))).toEqual(["resume.retry-works-first-use"]);
    expect(failed(gradeResumptionRule({ observations: [], retryClicks: [
      { at: at(1), issueId: "parent", startedRunId: "r1" }, { at: at(2), issueId: "parent", startedRunId: "r2" }] }))).toEqual(["resume.retry-works-first-use"]);
    expect(failed(gradeResumptionRule({ observations: [], retryClicks: [], stalled: "Stalled" }))).toEqual(["resume.no-silent-stall"]);
  });
});

describe("scenario graders", () => {
  it("detects concurrent executors and exact step files", () => {
    expect(concurrentExecutors([run("a", { finishedAt: at(60) }), run("b", { startedAt: at(61), finishedAt: at(90) })], "parent")).toEqual([]);
    expect(concurrentExecutors([run("a", { finishedAt: at(60) }), run("b", { startedAt: at(30) })], "parent")).toEqual([["a", "b"]]);
    expect(completeStepLines("step-1\nstep-2\n", 2)).toBe(true);
    expect(completeStepLines("step-1\nstep-1\nstep-2\n", 2)).toBe(false);
    expect(completeStepLines(undefined, 2)).toBe(false);
  });

  it("interrupt-redirect: one bounded continuation, and Stop-settlement consumption", () => {
    const interrupted = run("old", { status: "cancelled", errorCode: "operator_interrupted", finishedAt: at(10) });
    const good = [interrupted, carrying("next", "comment-1", { startedAt: at(40), finishedAt: at(90) }),
      run("stopped", { status: "cancelled", errorCode: "cancelled", startedAt: at(100), finishedAt: at(130) }),
      carrying("settle", "comment-2", { startedAt: at(150), finishedAt: at(200) })];
    const input = { runs: good, comments: [], interruptedRunId: "old", interruptCommentId: "comment-1", interruptedAt: T0 + 10_000,
      stopSettle: { stoppedRunId: "stopped", commentId: "comment-2", sentAt: T0 + 120_000 } };
    expect(failed(gradeInterruptRedirect(input))).toEqual([]);
    expect(failed(gradeInterruptRedirect({ ...input, runs: [...good, carrying("dup", "comment-1", { startedAt: at(300) })] })))
      .toContain("interrupt.exactly-one-continuation");
    // Later turns keep the interrupt message in their prompt history; that is not a second delivery.
    expect(failed(gradeInterruptRedirect({ ...input, runs: [...good, run("later", { startedAt: at(300),
      runnerProfileJson: { nativeExecutionInput: { task: { prompt: "comment-1 comment-2 history" } } } })] }))).toEqual([]);
    expect(failed(gradeInterruptRedirect({ ...input, runs: [interrupted, carrying("late", "comment-1", { startedAt: at(250) }), ...good.slice(2)] })))
      .toEqual(["interrupt.continuation-bounded"]);
    expect(failed(gradeInterruptRedirect({ ...input, comments: [{ id: "nudge", createdAt: at(20) }] }))).toEqual(["interrupt.no-second-message"]);
    expect(failed(gradeInterruptRedirect({ ...input, runs: [{ ...interrupted, errorCode: "cancelled" }, ...good.slice(1)] })))
      .toEqual(["interrupt.operator-interrupt"]);
  });

  it("reassign-midrun: prompt request, old run reassigned, no overlap, saved files continued", () => {
    const steps = Array.from({ length: 8 }, (_, index) => `step-${index + 1}`).join("\n");
    const input = { issueId: "parent", oldRunId: "old", newAgentId: "riley", steps: 8, stepFile: steps as string | undefined,
      request: { status: 200, latencyMs: 800, requestedAt: T0 + 30_000 },
      runs: [run("old", { status: "cancelled", errorCode: "issue_reassigned", finishedAt: at(32) }),
        run("new", { agentId: "riley", startedAt: at(40), finishedAt: at(200) })] };
    expect(failed(gradeReassignMidrun(input))).toEqual([]);
    expect(failed(gradeReassignMidrun({ ...input, request: { status: 409, latencyMs: 20_000, requestedAt: T0 } }))).toContain("reassign.request-prompt");
    expect(failed(gradeReassignMidrun({ ...input, runs: [run("old", { status: "cancelled", errorCode: "issue_reassigned", finishedAt: at(120) }), input.runs[1]!] })))
      .toEqual(["reassign.no-concurrent-executors"]);
    expect(failed(gradeReassignMidrun({ ...input, stepFile: `${steps}\nstep-3` }))).toEqual(["reassign.continued-from-saved-files"]);
  });

  it("three-turn-revise: every turn succeeds and the table is complete", () => {
    const nonce = "N1";
    const table = `| Number | Item |\n| --- | --- |\n${["alpha", "beta", "gamma", "delta", "epsilon"].map((word, index) => `| ${index + 1} | ${word} ${nonce} |`).join("\n")}\n`;
    const turns = [run("t1"), run("t2"), run("t3")];
    expect(failed(gradeThreeTurnRevise({ turnRuns: turns, content: table, nonce }))).toEqual([]);
    expect(failed(gradeThreeTurnRevise({ turnRuns: [turns[0], turns[1], undefined], content: table, nonce }))).toEqual(["three-turn.turn-3-succeeded"]);
    expect(failed(gradeThreeTurnRevise({ turnRuns: turns, content: `${table}- alpha ${nonce}\n`, nonce }))).toEqual(["three-turn.final-table"]);
    expect(failed(gradeThreeTurnRevise({ turnRuns: turns, content: table.replace(`epsilon ${nonce}`, "missing"), nonce }))).toEqual(["three-turn.final-table"]);
  });

  it("long-silent-command: completes after the command, Stop stays available, no hang", () => {
    const content = Array.from({ length: 13 }, (_, index) => `tick-${index + 1}`).join("\n");
    const samples = [{ at: at(60), canStop: true, source: "api" as const }, { at: at(61), canStop: true, source: "browser" as const },
      { at: at(400), canStop: true, source: "api" as const }];
    const input = { run: run("silent", { startedAt: at(0), finishedAt: at(13 * 60 + 90) }), content, iterations: 13, iterationSeconds: 60,
      stopSamples: samples, reply: "SILENT_DONE_N1 13", nonce: "N1" };
    expect(failed(gradeLongSilentCommand(input))).toEqual([]);
    expect(failed(gradeLongSilentCommand({ ...input, run: run("silent", { status: "failed", errorCode: null, startedAt: at(0), finishedAt: at(13 * 60 + 60 * 30) }) })))
      .toEqual(expect.arrayContaining(["silent.completed", "silent.no-hang", "silent.named-failure"]));
    expect(failed(gradeLongSilentCommand({ ...input, run: run("silent", { startedAt: at(0), finishedAt: at(120) }) }))).toEqual(["silent.not-shortened"]);
    expect(failed(gradeLongSilentCommand({ ...input, stopSamples: [...samples, { at: at(500), canStop: false, source: "api" }] }))).toEqual(["silent.stop-available"]);
  });

  it("tree-pause-release: no start during hold and exactly one resume per interrupted task", () => {
    const input = { childIds: ["a", "b"], holdCreatedAt: T0 + 100_000, releasedAt: T0 + 200_000,
      interruptedRuns: [{ id: "ra", issueId: "a" }, { id: "rb", issueId: "b" }],
      runs: [run("ra", { nativeIssueId: "a", status: "cancelled", finishedAt: at(101) }),
        run("rb", { nativeIssueId: "b", status: "cancelled", startedAt: null, finishedAt: at(101) }),
        run("ra2", { nativeIssueId: "a", startedAt: at(210), contextSnapshot: { wakeReason: "issue_tree_resumed" } }),
        run("rb2", { nativeIssueId: "b", startedAt: at(260), contextSnapshot: { wakeReason: "issue_tree_resumed" } })] };
    expect(failed(gradeTreePauseRelease(input))).toEqual([]);
    expect(failed(gradeTreePauseRelease({ ...input, runs: [...input.runs, run("early", { nativeIssueId: "b", startedAt: at(150) })] })))
      .toEqual(["tree.no-start-during-hold"]);
    expect(failed(gradeTreePauseRelease({ ...input, runs: [...input.runs, run("rb3", { nativeIssueId: "b", startedAt: at(300), contextSnapshot: { wakeReason: "issue_tree_resumed" } })] })))
      .toEqual(["tree.one-resume-per-interrupted"]);
    expect(failed(gradeTreePauseRelease({ ...input, runs: input.runs.slice(0, 3) }))).toEqual(["tree.one-resume-per-interrupted"]);
    expect(failed(gradeTreePauseRelease({ ...input, interruptedRuns: [] }))).toContain("tree.hold-interrupted-work");
    // A run that started while the hold request was in flight was interrupted by it, not started during it.
    expect(failed(gradeTreePauseRelease({ ...input, runs: input.runs.map(entry => entry.id === "ra" ? { ...entry, startedAt: at(100.5) } : entry) }))).toEqual([]);
  });

  it("queue-steer: edit used, discard never delivered, steer consumed once in the active turn", () => {
    const active = run("active", { resultJson: { queuedSteeringAcknowledgements: { steer: { status: "acknowledged" } } } });
    const input = { activeRunId: "active", runs: [active, carrying("next", "edit", {}, "EDITED_N1 history: steer drop")],
      edited: { commentId: "edit", originalMarker: "ORIGINAL_N1", editedMarker: "EDITED_N1" },
      discarded: { commentId: "drop", marker: "DISCARDED_N1" }, steered: { commentId: "steer", marker: "STEERED_N1" },
      steerAttempts: [{ status: 409, code: "steering_temporarily_unavailable" }, { status: 200 }],
      files: { edited: "EDITED_N1", steered: "STEERED_N1" } };
    expect(failed(gradeQueueSteer(input))).toEqual([]);
    expect(failed(gradeQueueSteer({ ...input, runs: [active, carrying("next", "edit", {}, "EDITED_N1 DISCARDED_N1")] })))
      .toEqual(["queue.discard-never-delivered"]);
    expect(failed(gradeQueueSteer({ ...input, runs: [active, carrying("next", "edit", {}, "ORIGINAL_N1")], files: { ...input.files, edited: "ORIGINAL_N1" } })))
      .toEqual(["queue.edit-used"]);
    expect(failed(gradeQueueSteer({ ...input, runs: [...input.runs, carrying("replay", "steer", { startedAt: at(200) }, "EDITED_N1")] })))
      .toEqual(["queue.steer-consumed-in-active-run"]);
    expect(failed(gradeQueueSteer({ ...input, steerAttempts: [{ status: 409, code: "queued_comment_stale_target" }, { status: 200 }] })))
      .toEqual(["queue.steer-retry-bounded"]);
    expect(failed(gradeQueueSteer({ ...input, runs: [...input.runs, carrying("again", "edit", { startedAt: at(300) }, "EDITED_N1")] })))
      .toEqual(["queue.remaining-handled-once"]);
  });

  it("queued-across-restart: bounded automatic dispatch with a named wait", () => {
    const input = { commentId: "c1", restartStartedAt: T0 + 60_000, dispatchedBeforeRestart: false,
      runs: [carrying("next", "c1", { startedAt: at(120), finishedAt: at(200) })],
      waitObservations: [{ at: at(65), phase: "queued", label: "Waiting for server restart", cause: "server_restarting" }] };
    expect(failed(gradeQueuedAcrossRestart(input))).toEqual([]);
    expect(failed(gradeQueuedAcrossRestart({ ...input, waitObservations: [{ at: at(65), phase: "queued", label: "Queued", cause: null }] })))
      .toEqual(["restart.named-wait"]);
    expect(failed(gradeQueuedAcrossRestart({ ...input, runs: [] }))).toEqual(["restart.dispatched-bounded", "restart.exactly-once"]);
    expect(failed(gradeQueuedAcrossRestart({ ...input, runs: [carrying("next", "c1", { startedAt: at(60 + 7 * 60) })] })))
      .toEqual(["restart.dispatched-bounded"]);
    expect(failed(gradeQueuedAcrossRestart({ ...input, runs: [carrying("early", "c1", { startedAt: at(30) })] })))
      .toEqual(["restart.boundary-exercised"]);
    expect(failed(gradeQueuedAcrossRestart({ ...input, dispatchedBeforeRestart: true }))).toEqual(["restart.boundary-exercised"]);
  });
});
