import type { ControlPlanePort } from "../contracts/control-plane-port.js";
import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";
import {
  loadConformanceFixture,
  type ConformanceFixture,
} from "../protocol/conformance-fixture.js";

export const CONFORMANCE_OUTPUT_SCHEMA = "paperclip.runner.conformance.output.v1";

export interface ConformanceTracerOutput {
  schemaVersion: typeof CONFORMANCE_OUTPUT_SCHEMA;
  runIdentity: {
    runId: string;
    sessionId: string;
  };
  result: {
    status: "succeeded";
    summary: string;
  };
}

export async function replayConformanceFixture(
  controlPlane: ControlPlanePort,
  fixture: ConformanceFixture,
): Promise<void> {
  await controlPlane.openRun({ identity: fixture.run, backendKind: "mock" });
  for (const event of fixture.events) {
    await controlPlane.appendEvent(event);
  }
  await controlPlane.completeRun(fixture.result);
}

export function formatConformanceOutput(fixture: ConformanceFixture): string {
  const output: ConformanceTracerOutput = {
    schemaVersion: CONFORMANCE_OUTPUT_SCHEMA,
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

export async function runConformanceTracer(
  mockCore = new MockControlPlaneAdapter(),
): Promise<string> {
  const fixture = await loadConformanceFixture();
  await mockCore.start();
  try {
    await replayConformanceFixture(mockCore, fixture);
    return formatConformanceOutput(fixture);
  } finally {
    await mockCore.stop();
  }
}
