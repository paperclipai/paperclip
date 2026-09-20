import { describe, it, expect } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { everydayTasks, productionStoryProfile } from "./everyday-cases.js";
import {
  isStoryWorkspaceDeferral,
  storyUnexpectedRunFailure,
  storyUnexercisedReviewBoundary,
  storyLifecycleChecks,
  storyRepliesConsumed,
  storyHasAgentReply,
  storyHasPendingAgentReview,
  storyHasPendingAgentWake,
  storyHasPendingAgentWork,
  storyHasPendingHumanInteraction,
  storyHasStrandedBlockedLeaf,
  storyHasDurableAgentReviewContinuation,
  storyIssueHasBlockedTimeline,
  storyIssueHasBlockedTimelineBefore,
  storyIssueHasUnresolvedDependency,
  storyRunReportsDependencyBlock,
  storyParentFinishedAfterChildren,
  artifactGradeModeForPhase,
  storyParentCompletionPrecedesReview,
  storyAcceptedAgentReview,
  type StoryRun,
  type StoryIssue,
} from "./everyday-observations.js";

describe("everyday workflow grader and review timing", () => {
  it("uses base grading for review delivery and preserves late max-length cases", () => {
    expect(artifactGradeModeForPhase("reviewed-delivery")).toBe("base");
    expect(artifactGradeModeForPhase("delegated-delivery")).toBe("max-length");
    expect(artifactGradeModeForPhase("recovered-delivery")).toBe("max-length");
  });

  it("compares parent completion with review start rather than card creation", () => {
    const interactionCreatedAt = "2026-09-17T10:00:00.000Z";
    const parentFinishedAt = "2026-09-17T10:05:00.000Z";
    const reviewStartedAt = "2026-09-17T10:06:00.000Z";
    expect(interactionCreatedAt < parentFinishedAt).toBe(true);
    expect(
      storyParentCompletionPrecedesReview(
        parentFinishedAt,
        reviewStartedAt,
        false,
      ),
    ).toBe(true);
    expect(
      storyParentCompletionPrecedesReview(
        "2026-09-17T10:07:00.000Z",
        reviewStartedAt,
        false,
      ),
    ).toBe(false);
  });
});

describe("unexercised review boundary diagnostics", () => {
  const done = { id: "parent", companyId: "company", title: "task", status: "done" };
  const completed = {
    id: "run", companyId: "company", agentId: "lead", status: "succeeded",
    nativeIssueId: "parent", finishedAt: "2026-09-19T14:47:48.134Z",
  };
  const child = {
    ...done, id: "child", parentId: "parent", interactions: [{
      id: "card", issueId: "child", kind: "request_confirmation", status: "accepted",
      addresseeAgentId: "lead", resolvedByAgentId: "lead", resolvedByRunId: "review",
      createdAt: "2026-09-19T14:47:04.000Z", resolvedAt: "2026-09-19T14:47:21.876Z",
      payload: { target: { type: "custom", key: "native_completion_review", revisionId: "decision" } },
      result: { version: 1, outcome: "accepted" },
    }],
  };
  const review = {
    ...completed, id: "review", nativeIssueId: "child", startedAt: "2026-09-19T14:47:05.802Z",
    contextSnapshot: { nativeReviewInteractionId: "card", nativeReviewDecisionId: "decision" },
  };
  const diagnose = (issues: StoryIssue[] = [done, child], runs: StoryRun[] = [completed, review]) =>
    storyUnexercisedReviewBoundary(issues, runs, "parent", "lead");
  it("fails promptly with persisted proof that review preceded parent completion", () => {
    expect(diagnose()).toContain("not exercised");
  });
  it("does not preempt in-flight finalization, recovery, or unfinished work", () => {
    expect(diagnose([done, child], [{ ...completed, status: "running" }, review])).toBeUndefined();
    expect(storyUnexercisedReviewBoundary([{ ...done, scheduledRetry: {} }, child], [completed, review], "parent", "lead")).toBeUndefined();
    expect(storyUnexercisedReviewBoundary([{ ...done, activeRecoveryAction: {} }, child], [completed, review], "parent", "lead")).toBeUndefined();
    expect(diagnose([{ ...done, status: "blocked" }, child])).toBeUndefined();
    expect(diagnose([], [])).toBeUndefined();
  });
  it("waits when separately fetched snapshots lack review evidence or timestamps", () => {
    expect(diagnose([done, { ...child, interactions: [] }])).toBeUndefined();
    expect(diagnose([done, child], [completed])).toBeUndefined();
    expect(diagnose([done, child], [{ ...completed, finishedAt: "" }, review])).toBeUndefined();
    expect(diagnose([done, child], [completed, { ...review, startedAt: "" }])).toBeUndefined();
    expect(diagnose([done, child], [review])).toBeUndefined();
  });
  it("does not reject a completed workflow with the required timing", () => {
    expect(diagnose([done, child], [{ ...completed, finishedAt: review.startedAt }, review])).toBeUndefined();
  });
});

describe("multi-round agent review handoff", () => {
  const child = {
    id: "child",
    companyId: "company",
    title: "child",
    status: "done",
    interactions: [
      {
        id: "first",
        issueId: "child",
        kind: "request_confirmation",
        status: "rejected",
        addresseeAgentId: "lead",
        createdAt: "2026-09-17T19:07:19.277Z",
        payload: { target: { type: "custom", key: "native_completion_review", revisionId: "decision-1" } },
        result: { version: 1, outcome: "rejected" },
      },
      {
        id: "second",
        issueId: "child",
        kind: "request_confirmation",
        status: "accepted",
        addresseeAgentId: "lead",
        resolvedByAgentId: "lead",
        resolvedByRunId: "review-run",
        createdAt: "2026-09-17T19:08:54.510Z",
        resolvedAt: "2026-09-17T19:09:33.722Z",
        payload: { target: { type: "custom", key: "native_completion_review", revisionId: "decision-2" } },
        result: {
          version: 1,
          outcome: "accepted",
        },
      },
    ],
  };
  const runs = [{
    id: "review-run",
    companyId: "company",
    agentId: "lead",
    status: "succeeded",
    contextSnapshot: {
      nativeReviewInteractionId: "second",
      nativeReviewDecisionId: "decision-2",
    },
  }];

  it("follows a later accepted repair review for the same child and lead", () => {
    expect(storyAcceptedAgentReview(child, "first", "lead", runs)?.id).toBe("second");
  });

  it("accepts a single first review when it is already accepted", () => {
    expect(
      storyAcceptedAgentReview(
        { ...child, interactions: [child.interactions[1]] },
        "second",
        "lead",
        runs,
      )?.id,
    ).toBe("second");
  });

  it("does not pass with only a rejected review", () => {
    expect(
      storyAcceptedAgentReview(
        { ...child, interactions: [child.interactions[0]] },
        "first",
        "lead",
        runs,
      ),
    ).toBeUndefined();
  });

  it("rejects accepted cards for another child, agent, or interaction kind", () => {
    const unrelated = [
      { ...child.interactions[1], issueId: "other" },
      { ...child.interactions[1], addresseeAgentId: "other", resolvedByAgentId: "other" },
      { ...child.interactions[1], payload: { target: { type: "custom", key: "other", revisionId: "decision-2" } } },
      { ...child.interactions[1], resolvedByRunId: "wrong-run" },
    ];
    for (const interaction of unrelated)
      expect(
        storyAcceptedAgentReview({ ...child, interactions: [interaction] }, "first", "lead", runs),
      ).toBeUndefined();
  });

  it("rejects a review whose decision revision does not match the reviewer run", () => {
    const bad = {
      ...child.interactions[1],
      payload: { target: { type: "custom", key: "native_completion_review", revisionId: "wrong" } },
    };
    expect(storyAcceptedAgentReview({ ...child, interactions: [bad] }, "second", "lead", runs)).toBeUndefined();
  });
});

describe("manual everyday workflow catalog", () => {
  it("is discoverable and explicitly selected without changing scheduled --all", () => {
    const all = selectRunnerExecutions(parseRunnerSelectors(["--all"]));
    expect(all.some((e) => e.suite.id === "everyday-workflows")).toBe(false);
    const selected = selectRunnerExecutions(
      parseRunnerSelectors(["--suite", "everyday-workflows"]),
    );
    expect(selected).toHaveLength(38);
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
    for (const task of everydayTasks.filter(
      (candidate) => candidate.id !== "agent-review-handoff",
    ))
      expect(task.buildPrompt("sample")).not.toMatch(
        /finish_task|paperclip_finish|PATCH|mark .*done|idempotencyKey/i,
      );
    expect(
      everydayTasks
        .find((task) => task.id === "agent-review-handoff")!
        .buildPrompt("sample"),
    ).toContain("resolve_review");
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
  it.each(["adapter_failed", "tool_validation_error", "timed_out"])(
    "does not excuse a later %s on the same deliberately interrupted run",
    (errorCode) => {
      const checks = score(
        [{ ...run, status: "failed", errorCode }],
        [parent],
        [run.id],
      );
      expect(checks.find((c) => c.id === "successful-runs")?.passed).toBe(false);
      const failed = { ...run, status: "failed", errorCode };
      expect(storyUnexpectedRunFailure([failed], [run.id])).toBe(failed);
    },
  );
  it.each([
    ["cancelled", "cancelled"],
    ["interrupted", "server_shutdown_interrupted"],
    ["failed", "process_lost"],
  ])("accepts an injected interruption with %s / %s", (status, errorCode) => {
    const checks = score([{ ...run, status, errorCode }], [parent], [run.id]);
    expect(checks.find((c) => c.id === "successful-runs")?.passed).toBe(true);
    expect(storyUnexpectedRunFailure([{ ...run, status, errorCode }], [run.id])).toBeUndefined();
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

  it("waits for the expected agent reply after terminal state is visible", () => {
    const issue = {
      id: "parent",
      companyId: "company",
      title: "Stop and redirect",
      status: "done",
      comments: [
        {
          id: "user-reply",
          authorAgentId: null,
          body: "Change direction. Reference nonce.",
        },
      ],
    };
    expect(storyHasAgentReply(issue, "lead", "Reference nonce")).toBe(false);
    expect(
      storyHasAgentReply(
        {
          ...issue,
          comments: [
            ...issue.comments,
            {
              id: "agent-reply",
              authorAgentId: "lead",
              body: "The studio is ready. Reference nonce.",
            },
          ],
        },
        "lead",
        "Reference nonce",
      ),
    ).toBe(true);
    expect(
      storyHasAgentReply(
        {
          ...issue,
          comments: [
            ...issue.comments,
            {
              id: "other-agent-reply",
              authorAgentId: "worker",
              body: "The studio is ready. Reference nonce.",
            },
          ],
        },
        "lead",
        "Reference nonce",
      ),
    ).toBe(false);
  });

  it("keeps a blocked lead alive when its child has a durable agent wake", () => {
    const child = {
      id: "child",
      companyId: "company",
      title: "Worker delivery",
      status: "in_progress",
      interactions: [
        {
          id: "review",
          status: "pending",
          continuationPolicy: "wake_assignee",
          addresseeAgentId: "lead",
        },
      ],
      wakeDiagnostics: {
        events: [
          {
            kind: "wake_request",
            agentId: "lead",
            status: "queued",
          },
        ],
      },
    };
    expect(storyHasPendingAgentWake(child, "lead")).toBe(true);
    expect(
      storyHasPendingAgentWork(
        [
          { ...child, status: "blocked", wakeDiagnostics: { events: [] } },
          child,
        ],
        "lead",
      ),
    ).toBe(true);
    expect(
      storyHasPendingAgentWork(
        [{ ...child, status: "blocked", wakeDiagnostics: { events: [] } }],
        "lead",
      ),
    ).toBe(false);
    expect(
      storyHasStrandedBlockedLeaf(
        [{ ...child, status: "blocked", wakeDiagnostics: { events: [] } }],
        "lead",
      ),
    ).toBe(true);
    expect(
      storyHasStrandedBlockedLeaf(
        [
          { ...child, status: "blocked", wakeDiagnostics: { events: [] } },
          child,
        ],
        "lead",
      ),
    ).toBe(false);
    expect(storyHasPendingHumanInteraction(child, "lead")).toBe(false);
    expect(storyHasPendingAgentReview(child, "lead")).toBe(true);
    expect(storyHasPendingAgentWake(child, "worker")).toBe(false);
    expect(
      storyHasPendingHumanInteraction(
        {
          ...child,
          wakeDiagnostics: { events: [] },
        },
        "lead",
      ),
    ).toBe(true);
    const sameAgentCards = {
      ...child,
      interactions: [
        {
          id: "review-a",
          status: "pending",
          continuationPolicy: "wake_assignee",
          addresseeAgentId: "lead",
        },
        {
          id: "review-b",
          status: "pending",
          continuationPolicy: "wake_assignee",
          addresseeAgentId: "lead",
        },
      ],
      wakeDiagnostics: {
        events: [
          {
            kind: "wake_request",
            agentId: "lead",
            status: "queued",
            payload: { nativeReviewInteractionId: "review-a" },
          },
        ],
      },
    };
    expect(storyHasPendingAgentReview(sameAgentCards, "lead")).toBe(true);
    expect(storyHasPendingHumanInteraction(sameAgentCards, "lead")).toBe(
      true,
    );
    expect(
      storyHasPendingHumanInteraction(
        {
          ...child,
          interactions: [
            {
              id: "review",
              status: "pending",
              continuationPolicy: "wake_assignee",
              effectiveResolverPolicy: "human_only",
              addresseeAgentId: "lead",
            },
          ],
        },
        "lead",
      ),
    ).toBe(true);
    expect(
      storyHasPendingHumanInteraction(
        {
          ...child,
          interactions: [
            ...(child.interactions ?? []),
            {
              id: "human-review",
              status: "pending",
              continuationPolicy: "wake_assignee",
              resolverPolicy: "human_only",
              addresseeAgentId: null,
            },
          ],
        },
        ["lead", "hired-worker"],
      ),
    ).toBe(true);
    expect(storyHasPendingAgentWake(child, ["hired-worker", "lead"])).toBe(
      true,
    );
    expect(
      storyIssueHasBlockedTimeline({
        ...child,
        status: "done",
        activity: [
          {
            action: "issue.updated",
            details: { fromStatus: "in_progress", toStatus: "blocked" },
            createdAt: "2026-09-17T08:00:00.000Z",
          },
        ],
      }),
    ).toBe(true);
    expect(
      storyIssueHasBlockedTimelineBefore(
        {
          ...child,
          status: "done",
          activity: [
            {
              action: "issue.updated",
              details: { status: "blocked" },
              createdAt: "2026-09-17T08:00:00.000Z",
            },
          ],
        },
        "2026-09-17T08:01:00.000Z",
      ),
    ).toBe(true);
    expect(
      storyIssueHasUnresolvedDependency({
        ...child,
        status: "blocked",
        wakeDiagnostics: {
          events: [],
          blockerDiagnostics: {
            readiness: { unresolvedBlockerCount: 1 },
          },
        },
      }),
    ).toBe(true);
    expect(
      storyRunReportsDependencyBlock({
        id: "parent-run",
        companyId: "company",
        agentId: "lead",
        status: "succeeded",
        resultJson: {
          nativeResult: {
            reportedWorkDisposition: "blocked",
            blocker: { reasonCode: "dependency_unresolved" },
          },
        },
      }),
    ).toBe(true);
  });

  it("keeps polling when review acceptance is durable but the parent wake is not projected yet", () => {
    const issues = [
      {
        id: "parent", companyId: "company", title: "parent", status: "blocked",
        blockedTransitionAt: "2026-09-17T19:07:30.000Z",
      },
      {
        id: "child",
        parentId: "parent",
        companyId: "company",
        title: "child",
        status: "done",
        interactions: [{
          id: "review",
          issueId: "child",
          kind: "request_confirmation",
          status: "accepted",
          addresseeAgentId: "lead",
          resolvedByAgentId: "lead",
          resolvedByRunId: "review-run",
          resolvedAt: "2026-09-17T19:08:10.000Z",
          payload: { target: { type: "custom", key: "native_completion_review", revisionId: "decision" } },
          result: { version: 1, outcome: "accepted" },
        }],
      },
    ];
    const runs = [{
      id: "review-run",
      companyId: "company",
      agentId: "lead",
      status: "succeeded",
      finishedAt: "2026-09-17T19:08:11.000Z",
    }];
    expect(storyHasStrandedBlockedLeaf(issues, "lead")).toBe(true);
    expect(storyHasDurableAgentReviewContinuation(
      issues, "parent", "lead", runs,
    )).toBe(true);
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(storyHasDurableAgentReviewContinuation([
        { ...issues[0]!, wakeDiagnostics: { events: [{
          kind: "wake_request", agentId: "lead", reason: "issue_blockers_resolved", status,
        }] } },
        issues[1]!,
      ], "parent", "lead", runs)).toBe(false);
    }
    expect(storyHasDurableAgentReviewContinuation([
      { ...issues[0]!, blockedTransitionAt: "2026-09-17T19:09:00.000Z" }, issues[1]!,
    ], "parent", "lead", runs)).toBe(false);
  });

  it("still identifies a blocked parent as stranded without accepted review evidence", () => {
    const issues = [
      { id: "parent", companyId: "company", title: "parent", status: "blocked" },
      { id: "child", parentId: "parent", companyId: "company", title: "child", status: "done", interactions: [] },
    ];
    expect(storyHasDurableAgentReviewContinuation(issues, "parent", "lead", [])).toBe(false);
  });

  it.each(["deferred_issue_execution", "claimed"])(
    "keeps a %s agent wake actionable",
    (status) =>
      expect(
        storyHasPendingAgentWake(
          {
            id: "child",
            companyId: "company",
            title: "Worker delivery",
            status: "in_progress",
            wakeDiagnostics: {
              events: [{ kind: "wake_request", agentId: "lead", status }],
            },
          },
          "lead",
        ),
      ).toBe(true),
  );
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
