import type { ControlPlanePort } from "../contracts/control-plane-port.js";
import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";
import {
  loadPhase0Fixture,
  type Phase0Fixture,
} from "../protocol/phase0-fixture.js";

export const PHASE0_OUTPUT_SCHEMA = "paperclip.runner.phase0.output.v1";

export interface Phase0TracerOutput {
  schemaVersion: typeof PHASE0_OUTPUT_SCHEMA;
  runIdentity: {
    runId: string;
    sessionId: string;
  };
  result: {
    status: "succeeded";
    summary: string;
  };
}

export async function replayPhase0Fixture(
  controlPlane: ControlPlanePort,
  fixture: Phase0Fixture,
): Promise<void> {
  await controlPlane.openRun({ identity: fixture.run, backendKind: "mock" });
  for (const event of fixture.events) {
    await controlPlane.appendEvent(event);
  }
  await controlPlane.completeRun(fixture.result);
}

export function formatPhase0Output(fixture: Phase0Fixture): string {
  const output: Phase0TracerOutput = {
    schemaVersion: PHASE0_OUTPUT_SCHEMA,
    runIdentity: {
      runId: fixture.run.runId,
      sessionId: fixture.run.sessionId,
    },
    result: {
      status: "succeeded",
      summary: fixture.result.summary,
    },
  };
  return JSON.stringify(output);
}

export async function runPhase0Tracer(
  mockCore = new MockControlPlaneAdapter(),
): Promise<string> {
  const fixture = await loadPhase0Fixture();
  await mockCore.start();
  try {
    await replayPhase0Fixture(mockCore, fixture);
    return formatPhase0Output(fixture);
  } finally {
    await mockCore.stop();
  }
}
