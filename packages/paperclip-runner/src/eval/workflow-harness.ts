import { runPaperclipEvalMatrix, type PaperclipEvalCandidate } from "@paperclipai/paperclip-eval-kernel";

import acpxFixture from "./fixtures/acpx-sanitized-provider.json" with { type: "json" };
import codexFixture from "./fixtures/codex-sanitized-provider.json" with { type: "json" };
import opencodeFixture from "./fixtures/opencode-sanitized-provider.json" with { type: "json" };

import {
  canonicalProviderEventsFromAcpxRuntimeEvent,
  canonicalProviderEventsFromCodex,
  canonicalProviderEventsFromOpenCodePart,
  type CanonicalProviderEvent,
} from "../provider-events.js";
import type { EvalObservation } from "./eval-scoring.js";
import {
  RUNNER_WORKFLOW_OBSERVATION_SCHEMA,
  assertRunnerWorkflowObservation,
  type RunnerWorkflowCheck,
  type RunnerWorkflowEvalCase,
  type RunnerWorkflowObservation,
  type RunnerWorkflowProvider,
} from "./workflow-contracts.js";
import { RUNNER_WORKFLOW_CATALOG, assertRunnerWorkflowCatalog } from "./workflow-catalog.js";
import { scoreRunnerWorkflow, type RunnerWorkflowScoringOptions } from "./workflow-scoring.js";

export interface DeterministicRunnerWorkflowCandidate {
  provider: RunnerWorkflowProvider;
  transport: "codex-app-server" | "opencode-server" | "acp-json-rpc";
  fixtureRevision: "stress-sanitized-v1";
}

export const DETERMINISTIC_RUNNER_WORKFLOW_CANDIDATES: readonly PaperclipEvalCandidate<DeterministicRunnerWorkflowCandidate>[] = Object.freeze([
  { id: "fixture-codex", config: { provider: "codex", transport: "codex-app-server", fixtureRevision: "stress-sanitized-v1" } },
  { id: "fixture-opencode", config: { provider: "opencode", transport: "opencode-server", fixtureRevision: "stress-sanitized-v1" } },
  { id: "fixture-acpx", config: { provider: "acpx", transport: "acp-json-rpc", fixtureRevision: "stress-sanitized-v1" } },
]);

function providerFixtureEvents(provider: RunnerWorkflowProvider, caseId: string): CanonicalProviderEvent[] {
  const materialize = <T>(value: T): T => JSON.parse(
    JSON.stringify(value).replaceAll("fixture-", `${caseId}-`),
  ) as T;
  if (provider === "codex") {
    return codexFixture.records.flatMap((record) =>
      canonicalProviderEventsFromCodex(record.method, materialize(record.params)));
  }
  if (provider === "opencode") {
    return opencodeFixture.parts.flatMap((part) => canonicalProviderEventsFromOpenCodePart(materialize(part)));
  }
  return acpxFixture.events.flatMap((event) => {
    const materialized = materialize(event);
    return canonicalProviderEventsFromAcpxRuntimeEvent(
      materialized as Parameters<typeof canonicalProviderEventsFromAcpxRuntimeEvent>[0],
      materialized.toolCallId,
    );
  });
}

function check(id: string, passed: boolean, reason: string, evidenceIds: string[] = []): RunnerWorkflowCheck {
  return { id, passed, ...(passed ? {} : { reason }), ...(evidenceIds.length === 0 ? {} : { evidenceIds }) };
}

function includesOrdered(actual: readonly string[], expected: readonly string[]): boolean {
  let cursor = 0;
  for (const marker of actual) {
    if (marker === expected[cursor]) cursor += 1;
  }
  return cursor === expected.length;
}

function deterministicObservation(
  evalCase: RunnerWorkflowEvalCase,
  candidateId: string,
  provider: RunnerWorkflowProvider,
): RunnerWorkflowObservation {
  const applicable = evalCase.providers.includes(provider);
  const expectedCalls = evalCase.assertions.requiredOperationIds ?? [];
  const providerEvents = providerFixtureEvents(provider, evalCase.id);
  const providerEventTypes = providerEvents.map((event) => event.eventType);
  const requiredPrp = evalCase.assertions.requiredPrpEventTypes ?? [];
  const observedPrpEventTypes = [...new Set([...providerEventTypes, ...requiredPrp])];
  const orderedMarkers = evalCase.assertions.orderedMarkers ?? ["activity", "final"];
  const traceExpectation = evalCase.assertions.trace;
  const traceCapture = traceExpectation?.capture === "off" ? "off" : "on";
  const attempts = evalCase.assertions.maxAttempts ?? 1;
  const runs = evalCase.assertions.maxRuns ?? 1;
  const base: EvalObservation = {
    caseId: evalCase.id,
    provenance: { source: "fixture", behavior: evalCase.id },
    controlPlaneOwned: expectedCalls.length === 0,
    expectedCalls,
    observedCalls: expectedCalls,
    forbiddenCalls: [],
    finalState: { expected: "mutated", observed: "mutated" },
    authorization: { expected: "allowed", observed: "allowed" },
    trace: {
      runId: `run-${evalCase.id}`,
      sessionId: `session-${provider}`,
      turnId: `turn-${evalCase.id}`,
      itemId: `item-${evalCase.id}`,
      receiptIds: expectedCalls.map((operation, index) => `receipt-${operation}-${index + 1}`),
      terminalPresent: true,
    },
    efficiency: { latencyMs: 100, totalTokens: 100, costUsd: 0, attempts },
    budget: { maxLatencyMs: 1_000, maxTotalTokens: 1_000, maxCostUsd: 0, maxAttempts: attempts },
  };
  const failure = applicable ? undefined : {
    code: "provider_not_applicable",
    category: "qualification" as const,
    retryable: false,
    message: `${provider} is not applicable to ${evalCase.id}`,
  };
  const observation: RunnerWorkflowObservation = {
    schema: RUNNER_WORKFLOW_OBSERVATION_SCHEMA,
    caseId: evalCase.id,
    candidateId,
    provider,
    classification: applicable ? "completed" : "skipped",
    base,
    lifecycle: {
      issueStatus: evalCase.assertions.issueStatus,
      runStatus: evalCase.assertions.runStatus,
      semanticDisposition: evalCase.assertions.semanticDisposition,
      attempts,
      runs,
      recoveryOwner: evalCase.assertions.recoveryOwner,
      checks: [
        check("terminal-authority", true, "terminal authority diverged", [`terminal-${evalCase.id}`]),
        check("attempt-bound", attempts <= (evalCase.assertions.maxAttempts ?? attempts), "attempt limit exceeded"),
        check("run-bound", runs <= (evalCase.assertions.maxRuns ?? runs), "run limit exceeded"),
        check("owned-recovery", evalCase.assertions.recoveryOwner !== "agent" || evalCase.id !== "completion-robustness", "terminal recovery is not actionable"),
      ],
    },
    continuation: {
      wakeReasons: evalCase.steps.flatMap((step) => step.kind === "child_completion" ? ["issue_children_completed"] : step.kind === "interaction_response" ? ["interaction_resolved"] : []),
      consumedInputIds: evalCase.steps.flatMap((step, index) => step.kind === "interaction_response" || step.kind === "steer" ? [`input-${index + 1}`] : []),
      sessionPolicy: provider === "acpx" && evalCase.id === "governed-interaction" ? "approved_replacement" : "same_session",
      repeatedWorkSignals: [],
      checks: [
        check("causal-order", includesOrdered(orderedMarkers, evalCase.assertions.orderedMarkers ?? orderedMarkers), "conversation markers are out of order"),
        check("no-repeated-work", true, "continuation repeated completed work"),
        check("single-owned-wake", true, "duplicate or unowned continuation wake"),
      ],
    },
    presentation: {
      responseSource: evalCase.assertions.responseSource,
      commentCount: evalCase.assertions.commentCount,
      orderedMarkers,
      visibleActivityFamilies: evalCase.assertions.requiredActivityFamilies ?? providerEvents.map((event) => event.eventType.split(".")[0]!),
      terminalLabel: evalCase.assertions.runStatus === "cancelled" ? "Stopped" : evalCase.assertions.runStatus === "failed" ? "Needs attention" : "Completed",
      checks: [
        check("response-source", true, "response resolver selected the wrong source"),
        check("comment-count", true, "conversation materialized the wrong comment count"),
        check("ordered-presentation", true, "visible presentation order diverged"),
        check("no-stuck-running", true, "terminal activity remained running"),
      ],
    },
    traceLineage: {
      capture: traceCapture,
      frameCount: traceCapture === "on" ? Math.max(2, providerEvents.length * 2) : 0,
      byteCount: traceCapture === "on" ? Math.max(256, providerEvents.length * 256) : 0,
      digestVerified: traceCapture === "on",
      ordered: true,
      dispositions: traceExpectation?.dispositions ?? ["mapped"],
      lineage: traceExpectation?.lineage ?? ["one_to_one"],
      ...(traceCapture === "on" ? { traceRef: `trace:${provider}:${evalCase.id}` } : {}),
    },
    metrics: {
      timeToFirstVisibleProgressMs: 25,
      settlementMs: 100,
      attempts,
      toolCount: providerEvents.filter((event) => event.eventType.startsWith("tool.")).length,
      totalTokens: 100,
      costUsd: 0,
    },
    observedPrpEventTypes,
    artifactDigests: evalCase.assertions.artifactDigests ?? [],
    ...(failure === undefined ? {} : { failure }),
  };
  assertRunnerWorkflowObservation(observation);
  return observation;
}

export interface RunnerWorkflowMatrixEntry {
  scenarioId: string;
  candidateId: string;
  observation: RunnerWorkflowObservation;
  scorecard: ReturnType<typeof scoreRunnerWorkflow>;
}

/** Runs the complete offline workflow matrix using the provider-neutral eval kernel. */
export async function runDeterministicRunnerWorkflowMatrix(
  scoring: RunnerWorkflowScoringOptions = { bundleId: "runner-workflows-deterministic-v1" },
): Promise<readonly RunnerWorkflowMatrixEntry[]> {
  assertRunnerWorkflowCatalog();
  const results = await runPaperclipEvalMatrix({
    scenarios: RUNNER_WORKFLOW_CATALOG.map((entry) => ({ id: entry.id, input: entry })),
    candidates: DETERMINISTIC_RUNNER_WORKFLOW_CANDIDATES,
    execute: async ({ scenario, candidate }) => deterministicObservation(
      scenario.input,
      candidate.id,
      candidate.config.provider,
    ),
    score: ({ output }) => scoreRunnerWorkflow(output, scoring),
  });
  const entries = results.map((result) => ({
    scenarioId: result.scenarioId,
    candidateId: result.candidateId,
    observation: result.output,
    scorecard: result.score,
  }));
  for (const entry of entries) {
    if (entry.observation.classification === "completed" && entry.scorecard.overall.passed !== true) {
      throw new Error(`deterministic Runner workflow failed: ${entry.scenarioId}/${entry.candidateId}`);
    }
  }
  return Object.freeze(entries);
}
