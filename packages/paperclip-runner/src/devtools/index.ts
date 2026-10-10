import type {
  CapabilityJsonValue,
  CapabilityFixtureState,
} from "../mock-core/capability-control-plane-types.js";
import type { CapabilityLiveSessionSnapshot } from "../live/live-session.js";

export interface CapabilityDevtoolsRevision {
  revision: number;
  at: string;
  turnId: string | null;
  operationId: string;
  state: CapabilityJsonValue;
}

export interface CapabilityDevtoolsProtocolRecord {
  id: string;
  at: string;
  turnId: string | null;
  boundary: string;
  event: string;
  detail: CapabilityJsonValue;
}

export interface CapabilityDevtoolsProviderTrace {
  status: "capturing" | "complete" | "incomplete" | "truncated";
  expiresAt: string;
  frames: CapabilityJsonValue[];
  interpretations: CapabilityJsonValue[];
}

export interface CapabilityDevtoolsSnapshot {
  schema: "paperclip.capability.devtools.v1";
  currentRevision: number;
  revisions: CapabilityDevtoolsRevision[];
  protocol: CapabilityDevtoolsProtocolRecord[];
  runtime: CapabilityJsonValue;
  authority: CapabilityJsonValue;
  /** Present only for an explicitly traced run; never populated by ordinary snapshots. */
  providerTrace?: CapabilityDevtoolsProviderTrace | null;
}

const SECRET =
  /(bearer\s+[a-z0-9._-]+|(?:^|[^a-z0-9])(?:sk|pcp)_[a-z0-9._-]{8,}|api[_-]?key\s*[:=]|PAPERCLIP_API_KEY|OPENAI_API_KEY)/i;
const SECRET_KEY =
  /(^|[_-])(authorization|api[_-]?key|token|secret|password)($|[_-])|^(apiKey|accessToken|refreshToken)$/i;

function safe(value: unknown, key = ""): CapabilityJsonValue {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string")
    return SECRET.test(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map((entry) => safe(entry));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      safe(entry, entryKey),
    ]),
  );
}

function parseState(serialized: string): CapabilityFixtureState {
  return JSON.parse(serialized) as CapabilityFixtureState;
}

/** Field-by-field browser projection. Raw provider payloads cross only through the opt-in trace channel. */
function publicCompanyState(serialized: string): CapabilityJsonValue {
  const state = parseState(serialized);
  return safe({
    schema: state.schema,
    revision: state.revision,
    clock: state.clock,
    counters: state.counters,
    lifecycle: state.lifecycle,
    activeRunId: state.activeRunId,
    company: state.company,
    actors: state.actors,
    tasks: state.tasks,
    outOfScopeTaskIds: state.outOfScopeTaskIds,
    comments: state.comments,
    documents: state.documents,
    interactions: state.interactions,
    approvals: state.approvals,
    artifacts: state.artifacts.map(
      ({ contentRef: _contentRef, ...artifact }) => ({
        ...artifact,
        contentRef: "[withheld]",
      }),
    ),
    workProducts: state.workProducts,
    blockers: state.blockers,
    workspaceServices: state.workspaceServices,
    budgets: state.budgets,
    runs: state.runs.map((run) => ({
      id: run.id,
      companyId: run.companyId,
      actorId: run.actorId,
      taskId: run.taskId,
      sessionId: run.sessionId,
      backendKind: run.backendKind,
      sourceInstanceId: run.sourceInstanceId,
      status: run.status,
      attempt: run.attempt,
      openedAt: run.openedAt,
      finishedAt: run.finishedAt,
      wake: run.wake,
      capabilities: run.capabilities,
      eventCount: run.events.length,
      hasResult: run.result !== null,
      hasSessionCheckpoint: run.sessionCheckpoint !== null,
    })),
    wakes: state.wakes,
    audit: state.audit,
    decisions: state.decisions,
    idempotency: state.idempotency.map(
      ({ inputCanonical: _inputCanonical, ...record }) => record,
    ),
    faults: state.faults,
  });
}

function boundary(kind: string): string {
  if (
    kind === "tool_call" ||
    kind === "tool_result" ||
    kind === "tool_discovery"
  )
    return "semantic tool";
  if (kind === "provider_event") return "provider harness";
  if (kind === "process") return "runnerd process";
  if (kind === "interaction") return "mock control plane";
  return "live session";
}

export function projectCapabilityDevtools(
  snapshot: CapabilityLiveSessionSnapshot,
): CapabilityDevtoolsSnapshot {
  const retained = snapshot.stateHistory ?? [
    {
      revision: parseState(snapshot.mockState).revision,
      at: snapshot.updatedAt,
      turnId: null,
      operationId: "session.current",
      state: snapshot.mockState,
    },
  ];
  const seed = parseState(snapshot.config.seedState);
  const history =
    retained[0]?.revision === seed.revision
      ? retained
      : [
          {
            revision: seed.revision,
            at: snapshot.createdAt,
            turnId: null,
            operationId: "fixture.seed",
            state: snapshot.config.seedState,
          },
          ...retained,
        ];
  return {
    schema: "paperclip.capability.devtools.v1",
    currentRevision: parseState(snapshot.mockState).revision,
    revisions: history.map((entry) => ({
      revision: entry.revision,
      at: entry.at,
      turnId: entry.turnId,
      operationId: entry.operationId,
      state: publicCompanyState(entry.state),
    })),
    protocol: snapshot.evidence.map((entry) => ({
      id: entry.id,
      at: entry.at,
      turnId: entry.turnId,
      boundary: boundary(entry.kind),
      event: entry.kind,
      detail: safe(entry.data),
    })),
    runtime: safe({
      status: snapshot.status,
      activeTurnId: snapshot.activeTurnId,
      providerSessionId: snapshot.providerSessionId,
      providerModel: snapshot.providerModel ?? null,
      process:
        snapshot.process === null
          ? null
          : {
              runnerPid: snapshot.process.runnerPid,
              runnerProcessGroupId: snapshot.process.runnerProcessGroupId,
              codexPid: snapshot.process.codexPid,
              runnerExited: snapshot.process.runnerExited,
              runnerExitCode: snapshot.process.runnerExitCode,
              runnerSignal: snapshot.process.runnerSignal,
              childEnvironmentKeys: snapshot.process.childEnvironmentKeys,
            },
      network: snapshot.networkEvidence,
      attempts: snapshot.attempts ?? [],
      currentAttemptId: snapshot.currentAttemptId ?? null,
      terminalTurns: snapshot.terminalTurns ?? [],
      usageLedger: snapshot.usageLedger ?? [],
      toolExposure: snapshot.config.toolExposure ?? "eager",
      loadedOperationIds: snapshot.loadedOperationIds ?? [],
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    }),
    authority: safe({
      ...snapshot.authority,
      scenario: snapshot.config.scenario,
      effectiveCapabilities: snapshot.config.capabilities,
      explicitClaims: snapshot.config.explicitClaims,
      turnTimeoutMs: snapshot.config.turnTimeoutMs,
      toolExposure: snapshot.config.toolExposure ?? "eager",
      workingDirectory: "[withheld]",
    }),
    providerTrace: null,
  };
}
