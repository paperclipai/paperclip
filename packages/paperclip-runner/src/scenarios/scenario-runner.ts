import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../tools/capability-semantic-tool-catalog.js";
import { CapabilitySemanticToolRuntime } from "../tools/capability-semantic-tool-runtime.js";
import {
  capabilityScenarioFixture,
  type CapabilityScenarioFixture,
} from "./scenario-fixtures.js";
import { capabilityScenarioPlan } from "./scenario-plan.js";
import type {
  CapabilityRunArtifact,
  CapabilityRunMode,
  CapabilityScenarioIndexEntry,
} from "../scenarios/scenario-explorer-types.js";
import {
  buildExposure,
  CAPABILITY_SECRET_PLACEHOLDER,
  CapabilityExecutionRecorder,
  snapshotOf,
} from "./scenario-execution.js";
import { capabilityStateDiff } from "./state-diff.js";
import { capabilityScenarioParity, type CapabilityEvalSuiteLookup } from "./scenario-parity.js";
import { capabilityFixtureRunCapabilities } from "./fixture-run-capabilities.js";

/**
 * Executes one scenario against the Capability mock control plane and the Phase
 * 7D semantic tool runtime, and records the result as a run artifact.
 *
 * Everything the explorer renders is produced here, in runtime code: exposure
 * comes from the authorization engine, control-plane entries come from the
 * mock core's own audit and decision records, the diff comes from immutable
 * fixture snapshots, and parity comes from the traceability expectations. The
 * browser is a read surface over this artifact and decides nothing.
 *
 * The recording machinery is shared with the Scenario chat chat session
 * (`scenario-execution.ts`) so a scenario reads the same either way.
 */

export interface CapabilityRunScenarioOptions {
  mode?: CapabilityRunMode;
  /** Capability parity output, when its report artifact has been loaded. */
  evalSuite?: CapabilityEvalSuiteLookup;
}

export async function capabilityRunScenario(
  entry: CapabilityScenarioIndexEntry,
  options: CapabilityRunScenarioOptions = {},
): Promise<CapabilityRunArtifact> {
  const mode = options.mode ?? "fake";
  const fixture = capabilityScenarioFixture(entry);
  const plan = capabilityScenarioPlan(entry, fixture);
  const runId = `run-capability-${entry.id}`;

  const adapter = new CapabilityMockControlPlaneAdapter(fixture.seed);
  await adapter.start();

  let failure: CapabilityRunArtifact["failure"] = null;

  // Snapshotted before checkout so the diff includes the control plane's own
  // seeding work, not just the agent's.
  const before = snapshotOf(adapter);
  const context = await adapter.openFixtureRun({
    identity: {
      runId,
      sessionId: `session-capability-${entry.id}`,
      companyId: fixture.seed.company!.id!,
      issueId: fixture.taskId,
      agentId: fixture.actorId,
    },
    backendKind: "mock",
    sourceInstanceId: "capability-scenario-explorer",
    wake: {
      reason: entry.wakeReason,
      payload: capabilityContinuationWakePayload(entry, fixture, mode),
    },
    capabilities: capabilityFixtureRunCapabilities(entry.scenarioClaims),
  });

  const runtime = new CapabilitySemanticToolRuntime({
    adapter,
    runId,
    scenarioGrants: entry.scenarioClaims,
    policy: entry.policy ?? undefined,
    resolveSecretValue: () => CAPABILITY_SECRET_PLACEHOLDER,
  });

  const recorder = new CapabilityExecutionRecorder({ entry, adapter, runtime });

  // Turn 0 is the control-plane session seed: checkout, wake routing, and the
  // initial exposure decision all happen before the agent takes a turn.
  recorder.openTurn(0);
  recorder.drainControlPlane();

  const visible = runtime.visibleTools();
  const exposure = buildExposure(
    visible.authorizationRecords,
    entry.scenarioClaims,
    plan.controlPlaneCapabilities,
  );

  // A single-shot scenario is one agent turn over that seeded session.
  recorder.openTurn(1);
  try {
    for (const step of plan.steps) {
      await recorder.runStep(step);
    }
  } catch (error) {
    failure = { message: error instanceof Error ? error.message : String(error) };
  }

  recorder.drainControlPlane();

  if (plan.restraint) {
    recorder.pushRestraintNote(entry.forbiddenSemantics.length);
  }

  const after = recorder.snapshot();
  await adapter.stop();

  const timeline = recorder.timeline;
  const authorizationRecords = [...runtime.authorizationRecords()].filter(
    (record) => record.phase === "invocation",
  );
  const diff = capabilityStateDiff(before, after);
  const parity = capabilityScenarioParity({
    entry,
    timeline,
    authorizationRecords,
    diff,
    exposure,
    failure,
    evalSuite: options.evalSuite,
  });

  return Object.freeze({
    schema: "paperclip.capability.run-artifact.v1",
    scenarioId: entry.id,
    mode,
    runId,
    actor: {
      id: context.actor.id,
      name: context.actor.name,
      role: context.actor.role,
      capabilityGrants: [...context.actor.capabilityGrants],
    },
    task: {
      id: context.activeTask.id,
      identifier: context.activeTask.identifier,
      title: context.activeTask.title,
      workMode: context.activeTask.workMode,
    },
    wake: { reason: context.wake.reason, payload: context.wake.payload },
    budget: { ...context.budget },
    timeline,
    exposure,
    authorizationRecords,
    diff,
    parity,
    failure,
  });
}

/**
 * The continuation scenario is woken with the interaction result the board
 * already supplied; every other scenario carries only its own identity.
 */
export function capabilityContinuationWakePayload(
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
  mode: CapabilityRunMode,
): CapabilityJsonValue {
  if (entry.id !== "ix-checkbox-result-01") return { scenarioId: entry.id, mode };
  const interaction = fixture.seed.interactions?.find(
    (candidate) => candidate.id === fixture.refs.interactionId,
  );
  return {
    scenarioId: entry.id,
    mode,
    interactionId: fixture.refs.interactionId,
    result: interaction?.result ?? null,
  };
}

export const CAPABILITY_CATALOG_SIZE = CAPABILITY_SEMANTIC_TOOL_CATALOG.length;
