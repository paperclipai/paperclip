import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  runnerWorkflowEvalbookAttempt,
  writeRunnerWorkflowEvalbookAttempts,
} from "./render-runner-workflow-evalbook.mjs";

function fixture(overrides = {}) {
  const report = {
    generatedAt: "2026-09-05T16:30:00.000Z",
    bundle: {
      id: "runner-live-v2-test",
      runnerVersion: "1.2.3",
      runnerBuild: "abc123",
      promptPolicyId: "runner-live-workflow-v1",
      providerVersions: {
        "codex-luna": "codex_app_server:gpt-5.6-luna",
      },
    },
    results: [],
  };
  const result = {
    scenarioId: "verification-policy",
    candidateId: "codex-luna",
    observation: {
      classification: "completed",
      provider: "codex",
      base: {
        controlPlaneOwned: false,
        trace: { sessionId: "eval-session-1" },
      },
      lifecycle: {
        checks: [{ id: "terminal-authority", passed: true }],
      },
      continuation: { checks: [] },
      presentation: { checks: [] },
      metrics: {
        attempts: 1,
        totalTokens: 1234,
        costUsd: 0.0025,
      },
      ...overrides.observation,
    },
    scorecard: {
      dimensions: {
        semantic_outcome: {
          dimension: "semantic_outcome",
          score: 1,
          passed: true,
          reasons: [],
        },
      },
      overall: { score: 1, passed: true },
      ...overrides.scorecard,
    },
  };
  report.results.push(result);
  return { report, result };
}

test("maps a workflow result to the canonical immutable-attempt inputs", () => {
  const { report, result } = fixture();
  const attempt = runnerWorkflowEvalbookAttempt({
    report,
    result,
    caseDefinition: {
      title: "Verify before completion",
      tags: ["verification"],
    },
  });

  assert.match(attempt.attemptId, /verification-policy-codex-luna/);
  assert.equal(attempt.artifact.requestedModel, "gpt-5.6-luna");
  assert.equal(attempt.artifact.driver, "codex_app_server");
  assert.equal(attempt.artifact.usage.estimatedCostNanodollars, 2_500_000);
  assert.equal(attempt.score.disposition, "passed");
  assert.equal(attempt.config.id, "codex-luna");
  assert.equal(attempt.case.title, "Verify before completion");
  assert.match(attempt.case.prompt, /Redacted/);
});

test("preserves unscored infrastructure semantics for the grid", () => {
  const { report, result } = fixture({
    observation: {
      classification: "infrastructure_failure",
      failure: {
        code: "provider_timeout",
        category: "provider",
        retryable: true,
        message: "provider timed out",
      },
    },
    scorecard: {
      overall: { score: null, passed: null },
    },
  });
  const attempt = runnerWorkflowEvalbookAttempt({ report, result });

  assert.equal(attempt.score.disposition, "infrastructure_failure");
  assert.deepEqual(attempt.score.infrastructureErrors, ["provider timed out"]);
  assert.deepEqual(attempt.artifact.infrastructureFailure, {
    class: "provider_timeout",
    category: "provider",
    retryable: true,
  });
});

test("writes idempotent attempt records without raw provider content", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "runner-workflow-evalbook-"));
  try {
    const { report } = fixture();
    const options = {
      report,
      runsRoot: root,
      caseForId: () => ({ title: "Verify", tags: ["verification"] }),
    };
    const first = await writeRunnerWorkflowEvalbookAttempts(options);
    const second = await writeRunnerWorkflowEvalbookAttempts(options);
    assert.deepEqual(second, first);

    const artifact = JSON.parse(
      await readFile(resolve(root, first[0], "artifact.json"), "utf8"),
    );
    assert.deepEqual(artifact.snapshot.transcript, []);
    assert.deepEqual(artifact.snapshot.evidence, []);
    assert.equal(artifact.workflow.observation.provider, "codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
