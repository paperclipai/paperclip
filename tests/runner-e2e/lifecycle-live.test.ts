import { describe, expect, it } from "vitest";
import { runnerMatrix, suiteDefinitionHash, runnerSuites } from "./catalog.js";
import { selectRunnerExecutions, parseRunnerSelectors } from "./selectors.js";
import { evaluateMatchers, type MatcherObservation } from "./matchers.js";
import {
  lifecycleLiveCases,
  lifecycleLiveTasks,
  lifecycleLiveContinuation,
  gradeLifecycleNarrative,
  gradeLifecycleRepair,
} from "./lifecycle-live-cases.js";

describe("LCA live baseline authoring and evidence", () => {
  it("registers the 40 baseline cells, two legacy repair probes, and four work-mode probes", () => {
    const selected = selectRunnerExecutions(
      parseRunnerSelectors(["--suite", "lifecycle-baseline"]),
    );
    expect(selected).toHaveLength(46);
    expect(new Set(selected.map((e) => e.profile.expectedRuntimeMode))).toEqual(
      new Set(["native", "legacy"]),
    );
    expect(
      selected.every(
        (e) =>
          e.requiredCredentials.includes("OPENAI_API_KEY") &&
          e.environment.id === "local",
      ),
    ).toBe(true);
    expect(
      selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(
        (e) => e.suite.id === "lifecycle-baseline",
      ),
    ).toBe(false);
    expect(
      selected.filter((e) => e.task.flow === "governed_tool_review"),
    ).toHaveLength(8);
    expect(selected.filter((e) => e.task.flow === "agent_chat")).toHaveLength(
      4,
    );
  });
  it("records narrative definitions in the suite fingerprint", () => {
    const suite = runnerSuites.find((s) => s.id === "lifecycle-baseline")!;
    expect(
      suiteDefinitionHash({
        ...suite,
        definitionMetadata: {
          ...suite.definitionMetadata,
          narrativeDigest: "changed",
        },
      }),
    ).not.toBe(suiteDefinitionHash(suite));
  });
  it.each(lifecycleLiveCases.filter((c) => c.continuation))(
    "LCA-03 LCA-05 LCA-12 $id uses the production continuation journey",
    (probe) => {
      const scenario = lifecycleLiveContinuation(probe.id, "nonce");
      expect(scenario.id).toBe(probe.continuation);
      expect(scenario.prompt).toContain(JSON.stringify(probe.narrative));
      expect(
        lifecycleLiveTasks.find((t) => t.id === probe.id)!.buildPrompt("nonce"),
      ).toBe(scenario.prompt);
    },
  );
  it("LCA-03 accepts an attributed narrative and rejects missing, user-authored, foreign-run or duplicate evidence", () => {
    const comment = {
      body: "No approval required.",
      authorAgentId: "agent",
      createdByRunId: "run",
    };
    const base = {
      narrative: comment.body,
      agentId: "agent",
      initial: { comments: [comment], runs: [{ id: "run" }] },
    };
    expect(gradeLifecycleNarrative(base).passed).toBe(true);
    for (const comments of [
      [],
      [{ ...comment, authorAgentId: null }],
      [{ ...comment, createdByRunId: "foreign" }],
      [comment, comment],
      [{ ...comment, body: "different" }],
    ]) {
      expect(
        gradeLifecycleNarrative({
          ...base,
          initial: { ...base.initial, comments },
        }).passed,
      ).toBe(false);
    }
    expect(
      gradeLifecycleNarrative({ narrative: comment.body, agentId: "agent" })
        .passed,
    ).toBe(false);
  });
  it.each(lifecycleLiveCases.filter((c) => !c.continuation && c.family !== "repair"))(
    "LCA-01 $id checks actual visible wording and durable terminal state",
    async (probe) => {
      const execution = runnerMatrix.find(
        (e) => e.suite.id === "lifecycle-baseline" && e.task.id === probe.id,
      )!;
      const task = execution.task;
      const matchers = task.buildMatchers("nonce", execution);
      const valid = {
        message: task.buildVisibleMarker("nonce"),
        issueStatus: task.expectedTerminalState.issue,
        runStatus: "succeeded",
        runtimeMode: execution.profile.expectedRuntimeMode,
        environment: "local",
        json: {
          issue: {
            workMode: "standard",
            executionRunId: null,
            scheduledRetry: null,
            activeRecoveryAction: null,
            monitorNextCheckAt: null,
          },
          interactions: [],
        },
      };
      const failures = async (observation: MatcherObservation) =>
        (await evaluateMatchers(matchers, observation)).filter(
          (r) => !r.passed,
        );
      expect(await failures(valid)).toEqual([]);
      expect(
        (
          await failures({
            ...valid,
            message: "The model ignored the quotation.",
          })
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (await failures({ ...valid, issueStatus: "in_progress" })).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await failures({
            ...valid,
            json: {
              ...valid.json,
              issue: { ...valid.json.issue, executionRunId: "active" },
            },
          })
        ).length,
      ).toBeGreaterThan(0);
      expect((await failures({ ...valid, json: {} })).length).toBeGreaterThan(
        0,
      );
      if (probe.family === "work-mode") {
        expect(task.workMode).toBe("standard");
        expect((await failures({ ...valid, json: { ...valid.json, issue: { ...valid.json.issue, workMode: "planning" } } })).length).toBeGreaterThan(0);
        expect((await failures({ ...valid, json: { ...valid.json, issue: { ...valid.json.issue, workMode: undefined } } })).length).toBeGreaterThan(0);
      }
      expect(
        (
          await failures({
            ...valid,
            json: { ...valid.json, interactions: [{ status: "pending" }] },
          })
        ).length,
      ).toBeGreaterThan(0);
    },
  );
});

describe("LCA-09 repair oracle calibration", () => {
  const source = { id: "source", status: "succeeded" };
  const repair = { id: "repair", status: "succeeded", contextSnapshot: { wakeReason: "issue_disposition_repair", retryOfRunId: "source", legacyDispositionEpisode: { id: "source", attempt: 1, maxAttempts: 2 } } };
  const input = { runs: [source, repair], agentId: "agent", narrative: "I am blocked.", comments: [{ body: "I am blocked.", authorAgentId: "agent", createdByRunId: "source" }] };
  it("requires the causal repair and the actual attributed perturbation", () => {
    expect(gradeLifecycleRepair(input).passed).toBe(true);
    for (const runs of [[], [source], [source, repair, repair], [source, { ...repair, contextSnapshot: {} }], [{ ...source, status: "failed" }, repair]]) {
      expect(gradeLifecycleRepair({ ...input, runs }).passed).toBe(false);
    }
    expect(gradeLifecycleRepair({ ...input, comments: [] }).passed).toBe(false);
    expect(gradeLifecycleRepair({ ...input, comments: [...input.comments, { authorUserId: "user" }] }).passed).toBe(false);
    expect(gradeLifecycleRepair({ ...input, comments: [{ ...input.comments[0], createdByRunId: "repair" }] }).passed).toBe(false);
  });
});
