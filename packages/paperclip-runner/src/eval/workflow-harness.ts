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

function activityFamily(eventType: string): string {
  return eventType.startsWith("tool.execution.")
    ? "tool_execution"
    : eventType.split(".")[0] ?? eventType;
}

function deterministicObservation(
  evalCase: RunnerWorkflowEvalCase,
  candidateId: string,
  provider: RunnerWorkflowProvider,
): RunnerWorkflowObservation {
  const applicable = evalCase.providers.includes(provider);
  const expectedCalls = evalCase.assertions.requiredOperationIds ?? [];
  const providerEvents = providerFixtureEvents(provider, evalCase.id);
  const providerEventTypes: string[] = providerEvents.map((event) => event.eventType);
  const evidenceIds = [...new Set(providerEvents.map((event) => event.itemId))];
  const observedActivityFamilies = [...new Set(providerEventTypes.map(activityFamily))];
  const requiredPrp = evalCase.assertions.requiredPrpEventTypes ?? [];
  const missingPrp = requiredPrp.filter((eventType) => !providerEventTypes.includes(eventType));
  const forbiddenPrp = (evalCase.assertions.forbiddenPrpEventTypes ?? [])
    .filter((eventType) => providerEventTypes.includes(eventType));
  const missingCalls = expectedCalls;
  const requiredActivityFamilies = evalCase.assertions.requiredActivityFamilies ?? [];
  const missingActivityFamilies = requiredActivityFamilies
    .filter((family) => !observedActivityFamilies.includes(family));
  const expectedMarkers = evalCase.assertions.orderedMarkers ?? [];
  const terminalPresent = providerEventTypes.includes("run.terminal");
  const traceCapture = providerEvents.length === 0 ? "off" : "on";
  const lifecycleChecks = [
    check(
      "required-prp-events",
      missingPrp.length === 0,
      `fixture is missing required PRP event(s): ${missingPrp.join(", ")}`,
      evidenceIds,
    ),
    check(
      "forbidden-prp-events",
      forbiddenPrp.length === 0,
      `fixture contains forbidden PRP event(s): ${forbiddenPrp.join(", ")}`,
      evidenceIds,
    ),
    check("terminal-authority", terminalPresent, "fixture contains no terminal authority evidence", evidenceIds),
    check("lifecycle-state", false, "fixture contains no issue, run, or semantic lifecycle evidence"),
    check("attempt-bound", false, "fixture contains no attempt-count evidence"),
    check("run-bound", false, "fixture contains no run-count evidence"),
    check("owned-recovery", false, "fixture contains no recovery-owner evidence"),
  ];
  const continuationChecks = [
    check(
      "causal-order",
      expectedMarkers.length > 0 && includesOrdered(providerEventTypes, expectedMarkers),
      "fixture provider events do not establish the expected conversation-marker order",
      evidenceIds,
    ),
    check("no-repeated-work", false, "fixture contains no repeated-work evidence"),
    check("single-owned-wake", false, "fixture contains no continuation-wake ownership evidence"),
  ];
  const presentationChecks = [
    check("response-source", false, "fixture contains no response-resolution evidence"),
    check("comment-count", false, "fixture contains no conversation comment evidence"),
    check("ordered-presentation", false, "fixture contains no rendered presentation order"),
    check("no-stuck-running", terminalPresent, "fixture contains no terminal presentation evidence", evidenceIds),
    check(
      "required-activity-families",
      missingActivityFamilies.length === 0,
      `fixture is missing required activity family/families: ${missingActivityFamilies.join(", ")}`,
      evidenceIds,
    ),
  ];
  const evidenceComplete = [
    ...lifecycleChecks,
    ...continuationChecks,
    ...presentationChecks,
  ].every((entry) => entry.passed)
    && missingCalls.length === 0;
  const classification = !applicable
    ? "skipped"
    : evidenceComplete
      ? "completed"
      : "candidate_failure";
  const base: EvalObservation = {
    caseId: evalCase.id,
    provenance: { source: "fixture", behavior: evalCase.id },
    controlPlaneOwned: expectedCalls.length === 0,
    expectedCalls,
    observedCalls: [],
    forbiddenCalls: [],
    finalState: {
      expected: expectedCalls.length === 0 ? "unchanged" : "mutated",
      observed: "unchanged",
    },
    authorization: {
      expected: expectedCalls.length === 0 ? "absent" : "allowed",
      observed: "absent",
    },
    trace: {
      ...(providerEvents[0] === undefined ? {} : { itemId: providerEvents[0].itemId }),
      receiptIds: [],
      terminalPresent,
    },
  };
  const failure = classification === "completed"
    ? undefined
    : classification === "skipped"
      ? {
          code: "provider_not_applicable",
          category: "qualification" as const,
          retryable: false,
          message: `${provider} is not applicable to ${evalCase.id}`,
        }
      : {
          code: "fixture_evidence_incomplete",
          category: "candidate" as const,
          retryable: false,
          message: `Sanitized provider fixture lacks workflow evidence${missingCalls.length === 0 ? "" : ` and semantic receipt(s) for ${missingCalls.join(", ")}`}`,
        };
  const observation: RunnerWorkflowObservation = {
    schema: RUNNER_WORKFLOW_OBSERVATION_SCHEMA,
    caseId: evalCase.id,
    candidateId,
    provider,
    classification,
    base,
    lifecycle: {
      checks: lifecycleChecks,
    },
    continuation: {
      wakeReasons: [],
      consumedInputIds: [],
      repeatedWorkSignals: [],
      checks: continuationChecks,
    },
    presentation: {
      orderedMarkers: providerEventTypes,
      visibleActivityFamilies: observedActivityFamilies,
      checks: presentationChecks,
    },
    traceLineage: {
      capture: traceCapture,
      frameCount: providerEvents.length,
      byteCount: Buffer.byteLength(JSON.stringify(providerEvents)),
      digestVerified: false,
      ordered: false,
      dispositions: [],
      lineage: [],
    },
    metrics: {
      attempts: 0,
      toolCount: providerEvents.filter((event) => event.eventType.startsWith("tool.")).length,
    },
    observedPrpEventTypes: [...new Set(providerEventTypes)],
    artifactDigests: [],
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
