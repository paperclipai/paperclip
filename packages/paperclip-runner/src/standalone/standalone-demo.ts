import {
  CONTROL_PLANE_CONFORMANCE_EVENTS,
  CONTROL_PLANE_CONFORMANCE_OPEN,
  runControlPlanePortConformance,
  type ControlPlanePortConformanceSnapshot,
} from "../conformance/control-plane-port.js";
import type {
  AppendedEventReceipt,
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  OpenControlPlaneRunInput,
  ReplayControlPlaneEventsInput,
  ReplayedControlPlaneEvents,
} from "../contracts/control-plane-port.js";
import type { NativeRunEvent, NativeRunResult } from "../contracts/types.js";
import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import {
  createSessionSnapshotFromMetadata,
  reduceSessionEvents,
  type SessionSnapshot,
} from "../reducer/session-reducer.js";

export interface StandaloneStandaloneDemoInput {
  featureFlagEnabled: boolean;
  killSwitchEnabled: boolean;
}

export type StandaloneStandaloneAdapterKind = "native_demo_adapter" | "legacy_demo_adapter";

export interface StandaloneStandaloneAdapter extends ControlPlanePort {
  readonly kind: StandaloneStandaloneAdapterKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  invocationCount(): number;
}

export interface StandaloneStandaloneAdapterFactories {
  createNativeAdapter(): StandaloneStandaloneAdapter;
  createLegacyAdapter(): StandaloneStandaloneAdapter;
}

export interface StandaloneStandaloneDemoResult {
  schema: "paperclip.runner.standalone.standalone-demo.v1";
  resolvedMode: "native" | "legacy";
  resolutionReason: "feature_flag_disabled" | "kill_switch_enabled" | "native_demo_enabled";
  adapter: "native_demo_adapter" | "legacy_demo_adapter";
  nativeAdapterInvocationCount: number;
  legacyAdapterInvocationCount: number;
  conformance: ControlPlanePortConformanceSnapshot;
  replay: {
    eventCount: number;
    highestContiguousSourceSeq: number;
    eventTypes: string[];
  };
  reducer: Pick<SessionSnapshot, "integrity" | "sessionState" | "turnState" | "runPhase"> & {
    timelineCount: number;
    runTerminalState: string | null;
  };
  finalization: {
    resultPersisted: true;
    terminalPersisted: true;
    reportedWorkDisposition: "done";
  };
}

export function resolveStandaloneStandaloneMode(input: StandaloneStandaloneDemoInput): Pick<
  StandaloneStandaloneDemoResult,
  "resolvedMode" | "resolutionReason"
> {
  if (input.killSwitchEnabled) {
    return { resolvedMode: "legacy", resolutionReason: "kill_switch_enabled" };
  }
  if (!input.featureFlagEnabled) {
    return { resolvedMode: "legacy", resolutionReason: "feature_flag_disabled" };
  }
  return { resolvedMode: "native", resolutionReason: "native_demo_enabled" };
}

class StandaloneDemoAdapter implements StandaloneStandaloneAdapter {
  readonly #adapter = new MockControlPlaneAdapter();
  #invocationCount = 0;

  constructor(readonly kind: StandaloneStandaloneAdapterKind) {}

  async start(): Promise<void> {
    this.#invocationCount += 1;
    this.#adapter.start();
  }

  async stop(): Promise<void> {
    this.#adapter.stop();
  }

  invocationCount(): number {
    return this.#invocationCount;
  }

  openRun(input: OpenControlPlaneRunInput): Promise<void> {
    return this.#adapter.openRun(input);
  }

  appendEvent(event: NativeRunEvent | PrpEvent): Promise<AppendedEventReceipt> {
    return this.#adapter.appendEvent(event);
  }

  replayEvents(input: ReplayControlPlaneEventsInput): Promise<ReplayedControlPlaneEvents> {
    return this.#adapter.replayEvents(input);
  }

  completeRun(result: NativeRunResult | CompleteControlPlaneRunInput): Promise<void> {
    return this.#adapter.completeRun(result);
  }
}

export function createNativeStandaloneStandaloneAdapter(): StandaloneStandaloneAdapter {
  return new StandaloneDemoAdapter("native_demo_adapter");
}

export function createLegacyStandaloneStandaloneAdapter(): StandaloneStandaloneAdapter {
  return new StandaloneDemoAdapter("legacy_demo_adapter");
}

const DEFAULT_ADAPTER_FACTORIES: StandaloneStandaloneAdapterFactories = {
  createNativeAdapter: createNativeStandaloneStandaloneAdapter,
  createLegacyAdapter: createLegacyStandaloneStandaloneAdapter,
};

export async function runStandaloneStandaloneDemo(
  input: StandaloneStandaloneDemoInput,
  factories: StandaloneStandaloneAdapterFactories = DEFAULT_ADAPTER_FACTORIES,
): Promise<StandaloneStandaloneDemoResult> {
  const resolution = resolveStandaloneStandaloneMode(input);
  const adapter = resolution.resolvedMode === "native"
    ? factories.createNativeAdapter()
    : factories.createLegacyAdapter();
  const conformance = await runControlPlanePortConformance({
    port: adapter,
    start: () => adapter.start(),
    stop: () => adapter.stop(),
  });
  const snapshot = reduceSessionEvents(
    createSessionSnapshotFromMetadata({
      fixtureName: `standalone-${resolution.resolvedMode}-standalone-demo`,
      identity: {
        schema: "paperclip.prp.identity.v1",
        companyId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.companyId,
        issueId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.issueId,
        runId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.runId,
        environmentLeaseId: "standalone-demo-lease",
        runnerInstanceId: "standalone-demo-runner",
        normalizedSessionId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.sessionId,
        driverSessionId: `${resolution.resolvedMode}-demo-driver`,
        providerSessionId: `${resolution.resolvedMode}-demo-provider`,
      },
      capabilities: {
        schema: "paperclip.prp.capabilities.v1",
        sessionReusePolicy: "new_per_run",
        driver: { kind: resolution.resolvedMode === "native" ? "native-demo" : "legacy-demo", version: "1" },
        steer: true,
        interrupt: true,
        resume: true,
        runtimeRequests: true,
        structuredResult: true,
        typedEvents: true,
        unsupported: [],
      },
    }),
    CONTROL_PLANE_CONFORMANCE_EVENTS,
  );

  return {
    schema: "paperclip.runner.standalone.standalone-demo.v1",
    ...resolution,
    adapter: adapter.kind,
    nativeAdapterInvocationCount: adapter.kind === "native_demo_adapter" ? adapter.invocationCount() : 0,
    legacyAdapterInvocationCount: adapter.kind === "legacy_demo_adapter" ? adapter.invocationCount() : 0,
    conformance,
    replay: {
      eventCount: CONTROL_PLANE_CONFORMANCE_EVENTS.length,
      highestContiguousSourceSeq: conformance.highestContiguousSourceSeq,
      eventTypes: CONTROL_PLANE_CONFORMANCE_EVENTS.map((event) => event.eventType),
    },
    reducer: {
      integrity: snapshot.integrity,
      sessionState: snapshot.sessionState,
      turnState: snapshot.turnState,
      runPhase: snapshot.runPhase,
      timelineCount: snapshot.timeline.length,
      runTerminalState: snapshot.terminal?.runTerminalState ?? null,
    },
    finalization: {
      resultPersisted: true,
      terminalPersisted: true,
      reportedWorkDisposition: "done",
    },
  };
}
