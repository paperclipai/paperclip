import { readFile } from "node:fs/promises";

import {
  HARNESS_DRIVER_CONTRACT_VERSION,
  type HarnessDriver,
  type HarnessDriverDescriptor,
} from "../contracts/harness-driver.js";
import { validatePrpEvent, type PrpEvent } from "../protocol/replay-contract.js";

export const HARNESS_DRIVER_CONFORMANCE_FIXTURE_SCHEMA =
  "paperclip-runner/harness-driver-conformance-fixture/v1" as const;
export const HARNESS_DRIVER_CONFORMANCE_REPORT_SCHEMA =
  "paperclip-runner/harness-driver-conformance-report/v1" as const;

export const harnessDriverConformanceFixtureUrl = new URL(
  "../../protocol/fixtures/evals/harness-driver-conformance.json",
  import.meta.url,
);

export interface HarnessDriverConformanceFixture {
  schema: typeof HARNESS_DRIVER_CONFORMANCE_FIXTURE_SCHEMA;
  validConfig: Record<string, unknown>;
  invalidConfig: Record<string, unknown>;
  completionMessage: string;
  interruptMessage: string;
  requiredCapabilities: string[];
  unsupportedFeatures: string[];
}

export interface HarnessDriverConformanceReport {
  schema: typeof HARNESS_DRIVER_CONFORMANCE_REPORT_SCHEMA;
  contractVersion: typeof HARNESS_DRIVER_CONTRACT_VERSION;
  descriptor: HarnessDriverDescriptor;
  checks: {
    capabilityDescription: true;
    configValidation: true;
    sessionLifecycle: true;
    sessionRecovery: true;
    semanticTools: true;
    eventValidation: true;
    interruptAndCancel: true;
    usage: true;
    transcriptCompleteness: true;
    unsupportedFeatures: true;
  };
  eventCount: number;
  semanticToolCallCount: number;
  usage: Record<string, unknown>;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return [...value] as string[];
}

export function parseHarnessDriverConformanceFixture(
  value: unknown,
): HarnessDriverConformanceFixture {
  const fixture = record(value, "fixture");
  if (fixture.schema !== HARNESS_DRIVER_CONFORMANCE_FIXTURE_SCHEMA) {
    throw new Error(
      `fixture.schema must be ${HARNESS_DRIVER_CONFORMANCE_FIXTURE_SCHEMA}`,
    );
  }
  return {
    schema: HARNESS_DRIVER_CONFORMANCE_FIXTURE_SCHEMA,
    validConfig: structuredClone(record(fixture.validConfig, "fixture.validConfig")),
    invalidConfig: structuredClone(record(fixture.invalidConfig, "fixture.invalidConfig")),
    completionMessage: text(fixture.completionMessage, "fixture.completionMessage"),
    interruptMessage: text(fixture.interruptMessage, "fixture.interruptMessage"),
    requiredCapabilities: strings(fixture.requiredCapabilities, "fixture.requiredCapabilities"),
    unsupportedFeatures: strings(fixture.unsupportedFeatures, "fixture.unsupportedFeatures"),
  };
}

export async function loadHarnessDriverConformanceFixture(
  url: URL = harnessDriverConformanceFixtureUrl,
): Promise<HarnessDriverConformanceFixture> {
  return parseHarnessDriverConformanceFixture(
    JSON.parse(await readFile(url, "utf8")) as unknown,
  );
}

async function collectEvents(events: AsyncIterable<PrpEvent>): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    const validation = validatePrpEvent(event);
    if (!validation.ok) {
      throw new Error(
        `driver conformance received invalid event: ${validation.issues[0]?.message ?? "unknown issue"}`,
      );
    }
    collected.push(structuredClone(validation.event));
  }
  return collected;
}

/** Run the deterministic, provider-free harness-driver V1 contract. */
export async function runHarnessDriverConformance(input: {
  driver: HarnessDriver;
  fixture?: HarnessDriverConformanceFixture;
}): Promise<HarnessDriverConformanceReport> {
  const fixture = input.fixture ?? await loadHarnessDriverConformanceFixture();
  const descriptor = await input.driver.descriptor();
  if (!descriptor.kind || !descriptor.displayName || !descriptor.version) {
    throw new Error("driver descriptor is missing stable identity fields");
  }
  for (const capability of fixture.requiredCapabilities) {
    if (descriptor.capabilities[capability as keyof typeof descriptor.capabilities] !== true) {
      throw new Error(`driver capability ${capability} is required by conformance V1`);
    }
  }
  for (const unsupported of fixture.unsupportedFeatures) {
    if (!descriptor.capabilities.unsupported?.includes(unsupported)) {
      throw new Error(`driver must explicitly describe unsupported feature ${unsupported}`);
    }
  }

  if (input.driver.validateConfig === undefined) {
    throw new Error("driver does not expose deterministic config validation");
  }
  const valid = await input.driver.validateConfig(fixture.validConfig);
  const invalid = await input.driver.validateConfig(fixture.invalidConfig);
  if (!valid.ok || invalid.ok || invalid.issues.length === 0) {
    throw new Error("driver config validation did not accept valid and reject invalid input");
  }

  const completeSession = await input.driver.openSession({
    runId: "run_driver_conformance_complete",
    normalizedSessionId: "session_driver_conformance_complete",
    workingDirectory: "/deterministic/conformance",
  });
  await completeSession.startTurn({ message: { role: "user", text: fixture.completionMessage } });
  const completeEvents = await collectEvents(completeSession.events());
  const semanticInputs = completeEvents.filter((event) => event.eventType === "mcp_app.tool_input");
  const semanticResults = completeEvents.filter((event) => event.eventType === "mcp_app.tool_result");
  if (semanticInputs.length === 0 || semanticInputs.length !== semanticResults.length) {
    throw new Error("driver conformance requires paired semantic tool input/result events");
  }
  const snapshot = await completeSession.snapshot();
  if (snapshot.semanticResult === undefined || snapshot.semanticResult === null) {
    throw new Error("completed driver session did not persist a semantic result");
  }
  const usage = await completeSession.usage?.();
  if (usage === undefined || usage === null) {
    throw new Error("driver conformance requires a deterministic usage snapshot");
  }
  const transcript = await completeSession.transcript?.();
  if (
    transcript === undefined
    || !transcript.complete
    || transcript.eventCount !== completeEvents.length
    || transcript.events.length !== completeEvents.length
    || transcript.omissionReason !== null
  ) {
    throw new Error("driver conformance transcript is incomplete or inconsistent");
  }
  if (input.driver.recoverSession === undefined) {
    throw new Error("driver declares resume but does not expose session recovery");
  }
  const recovery = await input.driver.recoverSession(snapshot, {
    signal: new AbortController().signal,
  });
  if (
    !recovery.recovered
    || recovery.session === undefined
    || recovery.session.ids().driverSessionId !== snapshot.driverSessionId
  ) {
    throw new Error("driver did not recover the persisted conformance session identity");
  }
  const recoveredSnapshot = await recovery.session.snapshot();
  if (
    recoveredSnapshot.runId !== snapshot.runId
    || recoveredSnapshot.normalizedSessionId !== snapshot.normalizedSessionId
    || recoveredSnapshot.semanticResult?.fingerprint !== snapshot.semanticResult?.fingerprint
  ) {
    throw new Error("driver recovery did not preserve the persisted conformance state");
  }
  await recovery.session.close({ reason: "conformance_recovery_complete" });
  await completeSession.close({ reason: "conformance_complete" });

  const interruptedSession = await input.driver.openSession({
    runId: "run_driver_conformance_interrupt",
    normalizedSessionId: "session_driver_conformance_interrupt",
    workingDirectory: "/deterministic/conformance",
  });
  const { turnId } = await interruptedSession.startTurn({
    message: { role: "user", text: fixture.interruptMessage },
  });
  if (interruptedSession.interrupt === undefined) {
    throw new Error("driver conformance requires interrupt support");
  }
  await interruptedSession.interrupt({ turnId, reason: "conformance_interrupt" });
  const interruptedEvents = await collectEvents(interruptedSession.events());
  if (
    !interruptedEvents.some((event) => event.eventType === "turn.interrupted")
    || !interruptedEvents.some((event) =>
      event.eventType === "run.terminal"
      && record(event.payload, "terminal payload").runTerminalState === "cancelled")
  ) {
    throw new Error("driver interrupt did not produce an explicit cancelled terminal");
  }
  await interruptedSession.close({ reason: "conformance_cancel", force: true });

  return {
    schema: HARNESS_DRIVER_CONFORMANCE_REPORT_SCHEMA,
    contractVersion: HARNESS_DRIVER_CONTRACT_VERSION,
    descriptor: structuredClone(descriptor),
    checks: {
      capabilityDescription: true,
      configValidation: true,
      sessionLifecycle: true,
      sessionRecovery: true,
      semanticTools: true,
      eventValidation: true,
      interruptAndCancel: true,
      usage: true,
      transcriptCompleteness: true,
      unsupportedFeatures: true,
    },
    eventCount: completeEvents.length,
    semanticToolCallCount: semanticInputs.length,
    usage: structuredClone(usage),
  };
}
