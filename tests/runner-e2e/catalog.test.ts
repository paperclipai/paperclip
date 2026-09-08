import { describe, expect, it } from "vitest";
import {
  runnerEnvironments,
  runnerMatrix,
  openRouterBreadthExcludedExecutionIds,
  openRouterBreadthExcludedModelIds,
  openRouterBreadthProfiles,
  openRouterBreadthTasks,
  localIntegrityTasks,
  runnerProfiles,
  runnerSuites,
  runnerTasks,
  isImmutableDaytonaImage,
  validateRunnerCatalog,
} from "./catalog.js";
import {
  buildMatrixJobs,
  parseRunnerSelectors,
  RunnerSelectorError,
  selectRunnerExecutions,
} from "./selectors.js";

describe("runner E2E catalog", () => {
  it("validates the core, local-integrity, and breadth suites", () => {
    expect(runnerProfiles).toHaveLength(7);
    expect(openRouterBreadthProfiles).toHaveLength(4);
    expect(runnerEnvironments).toHaveLength(2);
    expect(runnerTasks).toHaveLength(3);
    expect(localIntegrityTasks).toHaveLength(2);
    expect(openRouterBreadthTasks).toHaveLength(3);
    expect(runnerSuites.map((suite) => suite.expectedMatrixSize)).toEqual([
      42, 14, 10,
    ]);
    expect(validateRunnerCatalog()).toHaveLength(66);
    expect(new Set(runnerMatrix.map((entry) => entry.id)).size).toBe(66);
    expect(
      runnerMatrix.filter((entry) => entry.suite.id === "core-compatibility"),
    ).toHaveLength(42);
    expect(
      runnerMatrix.filter(
        (entry) => entry.suite.id === "local-session-integrity",
      ),
    ).toHaveLength(14);
    expect(
      runnerMatrix.filter(
        (entry) => entry.suite.id === "openrouter-model-breadth",
      ),
    ).toHaveLength(10);
    expect(
      runnerMatrix.reduce(
        (total, execution) => total + execution.task.expectedRunCount,
        0,
      ),
    ).toBe(114);
    expect(
      runnerTasks.find((task) => task.id === "plan-revise-accept")
        ?.attemptTimeoutMs,
    ).toEqual({ local: 8 * 60_000, daytona: 12 * 60_000 });
  });

  it("derives the qualified local native OpenCode profiles from the ranked snapshot", () => {
    expect(openRouterBreadthExcludedModelIds).toEqual(["xiaomi/mimo-v2.5"]);
    expect(openRouterBreadthExcludedExecutionIds).toEqual([
      "openrouter-model-breadth.openrouter-deepseek-deepseek-v4-flash-0731.local.plan-approve-complete",
      "openrouter-model-breadth.openrouter-tencent-hy3.local.plan-approve-complete",
    ]);
    expect(
      openRouterBreadthExcludedExecutionIds.every(
        (excludedExecutionId) =>
          !runnerMatrix.some(
            (execution) => execution.id === excludedExecutionId,
          ),
      ),
    ).toBe(true);
    expect(
      runnerMatrix
        .filter(
          (execution) => execution.profile.id === "openrouter-tencent-hy3",
        )
        .map((execution) => execution.task.id),
    ).toEqual(["hello-complete", "question-resume-complete"]);
    expect(
      openRouterBreadthProfiles.map((profile) => profile.ranking?.rank),
    ).toEqual([1, 3, 4, 5]);
    expect(
      openRouterBreadthProfiles.every(
        (profile) =>
          profile.adapterType === "paperclip_runner" &&
          profile.provider === "opencode" &&
          profile.model.startsWith("openrouter/") &&
          profile.supportedEnvironments.join(",") === "local" &&
          profile.modelQualification.source === "openrouter_rankings_snapshot",
      ),
    ).toBe(true);
  });

  it("defines deterministic two-run question and plan state machines", () => {
    const localQuestion = localIntegrityTasks.find(
      (task) => task.id === "structured-question-resume",
    );
    const restartQuestion = localIntegrityTasks.find(
      (task) => task.id === "structured-question-restart-resume",
    );
    const question = openRouterBreadthTasks.find(
      (task) => task.id === "question-resume-complete",
    );
    const plan = openRouterBreadthTasks.find(
      (task) => task.id === "plan-approve-complete",
    );
    expect(question).toMatchObject({
      flow: "question_resume_completion",
      expectedRunCount: 2,
    });
    expect(question?.buildQuestionAnswer?.("nonce")).toMatchObject({
      optionLabel: "Cobalt",
    });
    expect(localQuestion).toMatchObject({
      flow: "question_resume_completion",
      expectedRunCount: 2,
    });
    expect(localQuestion?.buildPrompt("nonce")).toContain("ask_user_questions");
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      "do not spell, quote, repeat, announce, or include PAPERCLIP_E2E_QUESTION_DONE_nonce",
    );
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      "refer to it only as “the terminal marker.”",
    );
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      'API_ORIGIN="${PAPERCLIP_API_URL%/}"; API_ORIGIN="${API_ORIGIN%/api}"',
    );
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      '"idempotencyKey":"question-nonce"',
    );
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      'PATCH $API_ORIGIN/api/issues/$PAPERCLIP_TASK_ID with exactly {"status":"in_review"}',
    );
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      "Do not include `reviewInteractionId`",
    );
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      "retry only that PATCH and never POST the interaction again",
    );
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      "make exactly one completion write",
    );
    const legacyQuestionExitInstruction =
      "In a legacy runner, after those two writes succeed, end the current response and heartbeat immediately. Do not wait, sleep, poll, or fetch the interaction; `wake_assignee` will start a new heartbeat after the user answers.";
    expect(localQuestion?.buildPrompt("nonce")).toContain(
      legacyQuestionExitInstruction,
    );
    expect(restartQuestion).toMatchObject({
      flow: "question_resume_completion",
      expectedRunCount: 2,
      restartServerBeforeQuestionAnswer: true,
    });
    expect(restartQuestion?.buildPrompt("nonce")).toContain(
      legacyQuestionExitInstruction,
    );
    expect(plan).toMatchObject({
      flow: "plan_approval_completion",
      expectedRunCount: 2,
    });
    expect(plan?.buildPrompt("nonce")).toContain("exactly two numbered steps");
  });

  it("emits native terminal text after the terminal tool succeeds", () => {
    const message = runnerTasks.find((task) => task.id === "message-marker");
    const ask = runnerTasks.find((task) => task.id === "ask-question");
    const plan = runnerTasks.find((task) => task.id === "plan-revise-accept");
    const question = localIntegrityTasks.find(
      (task) => task.id === "structured-question-resume",
    );
    const breadthTasks = openRouterBreadthTasks.map((task) =>
      task.buildPrompt("nonce"),
    );

    for (const prompt of [
      message?.buildPrompt("nonce"),
      ask?.buildPrompt("nonce"),
      plan?.buildPrompt("nonce"),
      question?.buildPrompt("nonce"),
      ...breadthTasks,
    ]) {
      expect(prompt).toContain("then emit exactly");
      expect(prompt!.indexOf("paperclip_finish exactly once")).toBeLessThan(
        prompt!.indexOf("then emit exactly"),
      );
      expect(prompt).toContain("Wait for that tool call to succeed");
    }

    for (const taskId of [
      "question-resume-complete",
      "plan-approve-complete",
    ]) {
      const prompt = openRouterBreadthTasks
        .find((task) => task.id === taskId)
        ?.buildPrompt("nonce");
      expect(prompt).toContain(
        "do not spell, quote, repeat, announce, or include",
      );
      expect(prompt).toContain("refer to it only as “the terminal marker.”");
    }

    const breadthHello = openRouterBreadthTasks
      .find((task) => task.id === "hello-complete")
      ?.buildPrompt("nonce");
    expect(breadthHello).toContain(
      "Your first response action must be the paperclip_finish tool call",
    );
    expect(breadthHello).toContain(
      "Do not emit any assistant text, acknowledgement, or preamble before calling it",
    );

    const nativeAsk = ask?.buildPrompt("nonce");
    expect(nativeAsk).toContain("paperclip_finish must be your only tool call");
    expect(nativeAsk).toContain(
      "never call report_progress or any other tool before or after it",
    );
  });

  it("uses only declared secret references in generated payloads", () => {
    expect(
      runnerMatrix.every((entry) =>
        entry.requiredCredentials.includes(entry.profile.credential),
      ),
    ).toBe(true);
    expect(
      runnerMatrix
        .filter((entry) => entry.environment.id === "daytona")
        .every((entry) =>
          entry.requiredCredentials.includes("DAYTONA_API_KEY"),
        ),
    ).toBe(true);
  });

  it("pins legacy Codex and Claude to their classic CLI engines", () => {
    for (const profileId of ["legacy-codex", "legacy-claude"]) {
      const execution = runnerMatrix.find(
        (candidate) =>
          candidate.profile.id === profileId &&
          candidate.environment.id === "local",
      );
      expect(execution).toBeDefined();
      expect(
        execution!.profile.buildAgent({
          environmentId: "11111111-1111-4111-8111-111111111111",
          environmentFixtureId: "local",
          workspacePath: "/tmp/runner-e2e-workspace",
          secretRefs: {
            [execution!.profile.credential]: {
              type: "secret_ref",
              secretId: "22222222-2222-4222-8222-222222222222",
              version: "latest",
            },
          },
          executionId: execution!.id,
        }),
      ).toMatchObject({ adapterConfig: { engine: "cli" } });
    }
  });

  it("binds native Codex automation auth to the encrypted OpenAI secret", () => {
    const execution = runnerMatrix.find(
      (candidate) =>
        candidate.id === "core-compatibility.runner-codex.local.message-marker",
    );
    expect(execution).toBeDefined();
    const secretRef = {
      type: "secret_ref" as const,
      secretId: "22222222-2222-4222-8222-222222222222",
      version: "latest" as const,
    };
    const agent = execution!.profile.buildAgent({
      environmentId: "11111111-1111-4111-8111-111111111111",
      environmentFixtureId: "local",
      workspacePath: "/tmp/runner-e2e-workspace",
      secretRefs: { OPENAI_API_KEY: secretRef },
      executionId: execution!.id,
    });
    expect(agent.adapterConfig).toMatchObject({
      env: {
        OPENAI_API_KEY: secretRef,
        CODEX_API_KEY: secretRef,
      },
    });
  });

  it("gives legacy planning agents a direct bounded API recipe", () => {
    const task = runnerTasks.find(
      (candidate) => candidate.id === "plan-revise-accept",
    );
    const execution = runnerMatrix.find(
      (candidate) =>
        candidate.profile.id === "legacy-claude" &&
        candidate.environment.id === "local" &&
        candidate.task.id === "plan-revise-accept",
    );
    expect(task).toBeDefined();
    expect(execution).toBeDefined();
    const agent = execution!.profile.buildAgent({
      environmentId: "11111111-1111-4111-8111-111111111111",
      environmentFixtureId: "local",
      workspacePath: "/tmp/runner-e2e-workspace",
      secretRefs: {
        ANTHROPIC_API_KEY: {
          type: "secret_ref",
          secretId: "22222222-2222-4222-8222-222222222222",
          version: "latest",
        },
      },
      executionId: execution!.id,
    });
    expect(agent.adapterConfig).toMatchObject({ maxTurnsPerRun: 24 });
    expect(agent.instructionsBundle).toMatchObject({
      files: { "AGENTS.md": expect.stringContaining("/interactions") },
    });
    expect(task!.buildPrompt("nonce")).toContain("request_confirmation");
    expect(task!.buildPrompt("nonce")).toContain("baseRevisionId");
    expect(task!.buildPrompt("nonce")).toContain(
      "do not spell, quote, repeat, announce, or include PAPERCLIP_E2E_PLAN_DONE_nonce",
    );
    expect(task!.buildPrompt("nonce")).toContain(
      'summary:"PAPERCLIP_E2E_PLAN_DONE_nonce"',
    );
    expect(task!.buildPrompt("nonce")).toContain("first call get_task_context");
    expect(task!.buildPrompt("nonce")).toContain(
      "identifies the exact revised Plan revision used as the confirmation target as accepted",
    );
    expect(task!.buildPrompt("nonce")).toContain(
      "After that verification succeeds, your immediate next action must be the paperclip_finish tool call",
    );
    expect(task!.buildPrompt("nonce")).not.toContain(
      "trust that inline acceptance",
    );
    expect(task!.buildPrompt("nonce")).toContain(
      "those two tool calls form one indivisible response sequence",
    );
    expect(task!.buildPrompt("nonce")).toContain(
      "Do not emit assistant text, end the heartbeat, or stop after write_document alone",
    );
    expect(task!.buildPrompt("nonce")).toContain(
      "one atomic issue PATCH with status `done` and that exact comment",
    );
    const revisionRequest = task!.buildRevisionRequest?.("nonce");
    expect(revisionRequest).toContain("baseRevisionId");
    expect(revisionRequest).toContain(
      "request_human_input must be your immediate next action",
    );
  });

  it("requires one atomic legacy Ask completion write", () => {
    const task = runnerTasks.find(
      (candidate) => candidate.id === "ask-question",
    );
    expect(task).toBeDefined();
    const prompt = task!.buildPrompt("nonce");
    expect(prompt).toContain(
      "make exactly one public-API write containing the marker",
    );
    expect(prompt).toContain(
      'PATCH /api/issues/$PAPERCLIP_TASK_ID with {"status":"done","comment":"E2E_ASK_12_nonce"}',
    );
    expect(prompt).toContain("Do not POST to /comments");
    expect(prompt).toContain("do not PATCH the status separately");
  });

  it("accepts only complete immutable Daytona digests", () => {
    expect(
      isImmutableDaytonaImage(
        `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"a".repeat(64)}`,
      ),
    ).toBe(true);
    expect(
      isImmutableDaytonaImage(
        "ghcr.io/paperclipai/paperclip-daytona-runner@sha256:REPLACE_ME",
      ),
    ).toBe(false);
    expect(
      isImmutableDaytonaImage(
        "ghcr.io/paperclipai/paperclip-daytona-runner:e2e-latest",
      ),
    ).toBe(false);
  });
});

describe("runner E2E selectors", () => {
  it("requires an explicit billable selector", () => {
    expect(() => parseRunnerSelectors([])).toThrow(RunnerSelectorError);
  });

  it("selects dimensions with OR within a dimension and AND across dimensions", () => {
    const options = parseRunnerSelectors([
      "--profile",
      "legacy-codex",
      "--profile",
      "runner-codex",
      "--environment",
      "local",
    ]);
    expect(selectRunnerExecutions(options).map((entry) => entry.id)).toEqual([
      "core-compatibility.legacy-codex.local.message-marker",
      "core-compatibility.legacy-codex.local.plan-revise-accept",
      "core-compatibility.legacy-codex.local.ask-question",
      "core-compatibility.runner-codex.local.message-marker",
      "core-compatibility.runner-codex.local.plan-revise-accept",
      "core-compatibility.runner-codex.local.ask-question",
      "local-session-integrity.legacy-codex.local.structured-question-resume",
      "local-session-integrity.legacy-codex.local.structured-question-restart-resume",
      "local-session-integrity.runner-codex.local.structured-question-resume",
      "local-session-integrity.runner-codex.local.structured-question-restart-resume",
    ]);
  });

  it("selects a suite without exploding its environment matrix", () => {
    const selected = selectRunnerExecutions(
      parseRunnerSelectors(["--suite", "openrouter-model-breadth"]),
    );
    expect(selected).toHaveLength(10);
    expect(
      selected.every(
        (entry) =>
          entry.suite.id === "openrouter-model-breadth" &&
          entry.environment.id === "local",
      ),
    ).toBe(true);
  });

  it("combines repeated groups with AND semantics", () => {
    const options = parseRunnerSelectors([
      "--group",
      "native",
      "--group",
      "daytona",
    ]);
    const selected = selectRunnerExecutions(options);
    expect(selected).toHaveLength(12);
    expect(
      selected.every(
        (entry) =>
          entry.profile.generation === "native" &&
          entry.environment.id === "daytona",
      ),
    ).toBe(true);
  });

  it("rejects groups outside the advertised four", () => {
    const options = parseRunnerSelectors(["--group", "codex"]);
    expect(() => selectRunnerExecutions(options)).toThrow("Unknown group");
  });

  it("emits one independently schedulable job per scenario", () => {
    const jobs = buildMatrixJobs(
      selectRunnerExecutions(parseRunnerSelectors(["--all"])),
    );
    expect(jobs).toHaveLength(66);
    expect(jobs.filter((job) => job.needsDaytona)).toHaveLength(21);
    expect(jobs.filter((job) => !job.needsDaytona)).toHaveLength(45);
    expect(new Set(jobs.map((job) => job.executionId)).size).toBe(66);
    expect(
      jobs.find(
        (job) =>
          job.executionId ===
          "core-compatibility.runner-acpx-claude.local.plan-revise-accept",
      )?.timeoutMinutes,
    ).toBe(25);
    expect(
      jobs.find(
        (job) =>
          job.executionId ===
          "local-session-integrity.runner-acpx-codex.local.structured-question-restart-resume",
      )?.timeoutMinutes,
    ).toBe(32);
    expect(
      jobs.every((job) =>
        runnerMatrix.some(
          (execution) =>
            execution.id === job.executionId &&
            execution.profile.credential === job.credentialName,
        ),
      ),
    ).toBe(true);
  });

  it("validates bounded local parallelism", () => {
    expect(
      parseRunnerSelectors(["--all", "--max-parallel", "8"]).maxParallel,
    ).toBe(8);
    expect(() =>
      parseRunnerSelectors(["--all", "--max-parallel", "0"]),
    ).toThrow("positive integer");
  });
});
