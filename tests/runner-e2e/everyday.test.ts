import { describe, it, expect } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { everydayTasks, productionStoryProfile } from "./everyday-cases.js";
import {
  isStoryWorkspaceDeferral,
  storyLifecycleChecks,
  storyRepliesConsumed,
  storyParentFinishedAfterChildren,
  type StoryRun,
} from "./everyday-observations.js";

describe("manual everyday workflow catalog", () => {
  it("is discoverable and explicitly selected without changing scheduled --all", () => {
    const all = selectRunnerExecutions(parseRunnerSelectors(["--all"]));
    expect(all.some((e) => e.suite.id === "everyday-workflows")).toBe(false);
    const selected = selectRunnerExecutions(
      parseRunnerSelectors(["--suite", "everyday-workflows"]),
    );
    expect(selected).toHaveLength(35);
    expect(selected.every((e) => e.profile.generation === "native")).toBe(true);
    expect(
      selectRunnerExecutions(
        parseRunnerSelectors(["--profile", "runner-codex"]),
      ).some((e) => e.suite.id === "everyday-workflows"),
    ).toBe(false);
    const listed = selectRunnerExecutions(parseRunnerSelectors(["--list"]));
    expect(listed.some((e) => e.suite.id === "everyday-workflows")).toBe(true);
  });
  it("does not schedule arbitrary runner-crash probes as model evals", () => {
    const selected = selectRunnerExecutions(
      parseRunnerSelectors(["--suite", "everyday-workflows"]),
    );
    expect(selected.some((e) => e.task.id.startsWith("recover-runner"))).toBe(false);
    for (const id of ["recover-runner", "recover-runner-safe", "recover-runner-uncertain"])
      expect(() => selectRunnerExecutions(parseRunnerSelectors([
        "--id", `everyday-workflows.runner-codex.local.${id}`,
      ]))).toThrow();
    expect(selected.some((e) => e.task.id === "recover-controller")).toBe(true);
    expect(selected.some((e) => e.task.id === "stop-redirect")).toBe(true);
  });
  it("keeps ordinary prompts free of completion/API instructions", () => {
    for (const task of everydayTasks)
      expect(task.buildPrompt("sample")).not.toMatch(
        /finish_task|paperclip_finish|PATCH|mark .*done|idempotencyKey/i,
      );
    const profile = runnerSuites.find((s) => s.id === "everyday-workflows")!
      .profiles[0]!;
    const value = productionStoryProfile(profile).buildAgent({
      environmentId: "env",
      environmentFixtureId: "local",
      workspacePath: "/tmp/test",
      secretRefs: {
        OPENAI_API_KEY: {
          type: "secret_ref",
          secretId: "secret",
          version: "latest",
        },
      },
      executionId: "case",
    });
    expect(JSON.stringify(value.instructionsBundle)).not.toMatch(
      /fixture|mark .*done|finish_task|api\/issues/i,
    );
  });
  it("does not claim unsupported remote crash/hiring coverage", () => {
    const remote = runnerMatrix.filter(
      (e) =>
        e.suite.id === "everyday-workflows" && e.environment.id === "daytona",
    );
    expect(remote).toHaveLength(8);
    expect(new Set(remote.map((e) => e.task.id))).toEqual(
      new Set(["build-revise", "delegate-feedback", "recover-controller", "create-skill-studio"]),
    );
  });
});

describe("lifecycle oracle calibrated failures", () => {
  const parent = {
    id: "parent",
    companyId: "company",
    title: "Project",
    status: "done",
    assigneeAgentId: "lead",
  };
  const run: StoryRun = {
    id: "run",
    companyId: "company",
    agentId: "lead",
    status: "succeeded",
    runtimeMode: "native",
    runnerInstanceId: "runner",
    contextSnapshot: { issueId: "parent" },
  };
  const score = (
    runs: StoryRun[],
    issues = [parent],
    allowedInterruptedRuns: string[] = [],
  ) =>
    storyLifecycleChecks({
      issues,
      runs,
      parentId: parent.id,
      leadId: "lead",
      allowedInterruptedRuns,
    });
  it("accepts successful owned native work", () =>
    expect(score([run]).every((c) => c.passed)).toBe(true));
  it.each([
    ["legacy execution", { ...run, runtimeMode: "legacy" }, "native-runtime"],
    [
      "no runner identity",
      { ...run, runnerInstanceId: null },
      "native-runtime",
    ],
    ["worker on parent", { ...run, agentId: "worker" }, "parent-owned-by-lead"],
    ["crash without recovery", { ...run, status: "failed" }, "successful-runs"],
    ["unsettled run", { ...run, status: "running" }, "settled"],
  ] as const)("rejects %s", (_label, bad, id) =>
    expect(score([bad]).find((c) => c.id === id)?.passed).toBe(false),
  );
  it("does not exempt unrelated failures because another run was intentionally stopped", () => {
    const checks = score(
      [
        { ...run, status: "cancelled" },
        { ...run, id: "other", status: "failed" },
      ],
      [parent],
      ["run"],
    );
    expect(checks.find((c) => c.id === "successful-runs")?.passed).toBe(false);
  });
  it("excludes a proven pre-dispatch workspace deferral without hiding executed failures", () => {
    const deferred: StoryRun = {
      id: "deferred",
      companyId: "company",
      agentId: "lead",
      status: "cancelled",
      errorCode: "workspace_busy",
      resultJson: {
        executionRecovery: {
          kind: "workspace_wait",
          providerWorkStarted: false,
        },
      },
    };
    expect(score([run, deferred]).every((c) => c.passed)).toBe(true);
    expect(
      score([run, { ...deferred, processPid: 123 }]).every((c) => c.passed),
    ).toBe(false);
    expect(
      score([run, { ...deferred, resultJson: {} }]).every((c) => c.passed),
    ).toBe(false);
  });
  it("rejects a finished answer left in review", () =>
    expect(
      score([run], [{ ...parent, status: "in_review" }]).find(
        (c) => c.id === "tasks-done",
      )?.passed,
    ).toBe(false));
});

describe("reply completion boundary", () => {
  const run: StoryRun = {
    id: "old",
    companyId: "company",
    agentId: "lead",
    status: "succeeded",
    runnerProfileJson: {
      nativeExecutionInput: { task: { prompt: "Original task" } },
    },
  };
  it("does not accept Done from the first run while a later request is still queued", () => {
    expect(storyRepliesConsumed([run], ["later-comment"])).toBe(false);
    const next = {
      ...run,
      id: "new",
      runnerProfileJson: {
        nativeExecutionInput: { task: { prompt: "User reply later-comment" } },
      },
    };
    expect(
      storyRepliesConsumed(
        [run, { ...next, status: "running" }],
        ["later-comment"],
      ),
    ).toBe(false);
    expect(storyRepliesConsumed([run, next], ["later-comment"])).toBe(true);
  });
});

describe("delegation completion order", () => {
  it("rejects a parent closed before its worker finishes", () => {
    const base: StoryRun = {
      id: "lead-run",
      companyId: "company",
      agentId: "lead",
      status: "succeeded",
      nativeIssueId: "parent",
      finishedAt: "2026-09-14T12:00:00Z",
    };
    const child = {
      ...base,
      id: "worker-run",
      agentId: "worker",
      nativeIssueId: "child",
      finishedAt: "2026-09-14T12:01:00Z",
    };
    expect(
      storyParentFinishedAfterChildren([base, child], "parent", "lead", [
        "child",
      ]),
    ).toBe(false);
    expect(
      storyParentFinishedAfterChildren(
        [{ ...base, finishedAt: "2026-09-14T12:02:00Z" }, child],
        "parent",
        "lead",
        ["child"],
      ),
    ).toBe(true);
    expect(
      storyParentFinishedAfterChildren([base], "parent", "lead", ["child"]),
    ).toBe(false);
  });
});

describe("cancelled queued workspace retry", () => {
  const queued: StoryRun = {
    id: "retry",
    companyId: "company",
    agentId: "agent",
    status: "cancelled",
    runtimeMode: "legacy",
    runtimeModeResolvedAt: null,
    startedAt: null,
    retryOfRunId: "workspace-deferral",
    scheduledRetryReason: "workspace_busy",
    errorCode: "cancelled",
    lastOutputSeq: 0,
    resultJson: {
      startupCancellation: {
        requestedAt: "2026-09-14T19:10:23.057Z",
        beforeNativeSelection: false,
      },
    },
  };
  it("does not mistake an unstarted cancelled retry for provider execution", () => {
    expect(isStoryWorkspaceDeferral(queued)).toBe(true);
  });
  it.each([
    { startedAt: "2026-09-14T19:10:22Z" },
    { processPid: 42 },
    { runnerInstanceId: "runner" },
    { nativeSessionId: "session" },
    { lastOutputSeq: 1 },
    { usageJson: { outputTokens: 1 } },
    { runtimeModeResolvedAt: "2026-09-14T19:10:22Z" },
    { scheduledRetryReason: "other" },
    { resultJson: null },
  ])("retains a contradictory or unproven cancellation %j", (change) => {
    expect(isStoryWorkspaceDeferral({ ...queued, ...change })).toBe(false);
  });
});
