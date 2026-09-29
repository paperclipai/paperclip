import { EVENT_EPOCH_CAPABILITY, EVENT_EPOCH_LIMIT, isEventEpochTransition, isEventResume, eventEpochCloseId, compareCurrentEvents, type EventEpochTransition, type EventResume } from "./event-epochs.js";
import { COMMAND_EPOCH_CAPABILITY, COMMAND_EPOCH_LIMIT, isCommandEpoch, isCommandEpochTransition, compareCurrentCommands, commandEpochCloseId, type CommandEpochTransition } from "./command-epochs.js";
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { NativeSessionProtocolIntegrityError } from "../contracts/native-session-backend.js";
import { githubCredentialEnvironment } from "../github-credential-environment.js";
import {
  validatePrpEvent,
  type PrpEvent,
} from "../protocol/replay-contract.js";
import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";
import { authorityInteger, authorityJson, DurableAuthorityStoreError, INDEXED_DURABILITY_CAPABILITY, MAX_LEGACY_AUTHORITY_STATE_BYTES, type AuthorityRecord, type AuthoritySnapshot, type DurableAuthorityStore } from "./durable-authority-store.js";
import { materializeCurrentAuthority, referenceCurrentAuthority, type CurrentAuthorityEvidence } from "./current-authority-evidence.js";
import { processOwnerChanges, processOwnerEvidence } from "./process-owner-evidence.js";
import { LegacyJsonReader, type LegacyJsonCursor } from "./legacy-json-reader.js";
import { assertNoPendingLegacyMigration } from "./legacy-migration-gate.js";
import { normalizedEpochCloseId } from "./event-epochs.js";
import { acknowledgeNormalizedEvent, applyNormalizedBatch, validateNormalizedDelivery, type NormalizedDeliveryState, type NormalizedDeliveryPort } from "./normalized-delivery.js";
import {
  type DurableRecoveryCommittedEvent,
  type DurableRecoveryCoreCommand,
  type DurableRecoveryIdentity,
  type DurableWarmRunTransition,
} from "./prp-transport-types.js";

const protocol = "paperclip.runner";
const protocolMinVersion = 1;
const protocolVersion = 2;
const secureFrameSchema = "paperclip.runner.secure-frame.v1";
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const coreStateSchema = "paperclip.runner.durable.control-plane-state.v1";
const transitionCoreStateSchema =
  "paperclip.runner.durable.control-plane-state.warm-transition.v1";
const maxFrameBytes = 1024 * 1024;
// Connection-local nonce counters are renewable. Re-authentication derives new
// keys and resumes durable cursors without changing any task/provider identity.
const maxSecureChannelFrames = 1_048_576;
// Diagnostic totals are lower bounds after saturation, never authority,
// sequence namespaces, or unique identity sources.
const incrementDiagnosticCount = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const maxCommandBytes = maxFrameBytes - 4 * 1024;
const maxCommands = 500;
// A provider can emit several 100-event runner batches before the transport's
// polling turn regains the event loop. Match the transport's explicit deferred
// event bound so a valid burst is not compacted before it can be observed.
const maxCommittedEventWindow = 4_096;
// The controller admission, cleanup, and recovery readers inspect this same
// journal. Keep their bound aligned with the durable store as history grows.
export const DURABLE_PRP_CONTROL_PLANE_MAX_STATE_BYTES = MAX_LEGACY_AUTHORITY_STATE_BYTES;
const authChallengeTtlMs = 5_000;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const runnerDigestPattern = /^sha256:[0-9a-f]{64}$/;
const commandTypes = new Set([
  "run.prepare",
  "run.attach",
  "session.open",
  "turn.start",
  "turn.steer",
  "turn.interrupt",
  "turn.stop",
  "request.resolve",
  "interaction.receipt",
  "semantic_tool.result",
  "session.snapshot",
  "session.goal.get",
  "session.goal.set",
  "session.goal.clear",
  "session.close",
  "session.budget.increase",
  "session.destroy",
  "run.cancel",
  "runner.drain",
  "runner.suspend",
  "runner.shutdown",
]);

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const runnerBinary = resolve(
  packageRoot,
  `runner/target/debug/paperclip-runnerd${executableSuffix}`,
);
const fakeHarnessBinary = resolve(
  packageRoot,
  `runner/target/debug/fake-harness${executableSuffix}`,
);
const fakeHarnessScript = resolve(
  packageRoot,
  "protocol/fixtures/local-runner/scripts/happy-path.json",
);

interface BootstrapTicketRecord {
  recordId: string;
  credentialId: string;
  authKeyDigest: string;
  identity: DurableRecoveryIdentity;
  runnerVersion: string;
  runnerDigest: string;
  expiresAt: string;
  expiresAtUnixMs: number;
  usedAt: string | null;
  warmTransitionId?: string;
}

interface ConnectionLeaseRecord {
  recordId: string;
  credentialId: string;
  authKeyDigest: string;
  leaseId: string;
  identity: DurableRecoveryIdentity;
  protocolVersion: number;
  expiresAt: string;
  expiresAtUnixMs: number;
  revocationEpoch: number;
  revokedAt: string | null;
}

export interface StoredCoreState {
  schema: typeof coreStateSchema | typeof transitionCoreStateSchema;
  identity: DurableRecoveryIdentity;
  warmTransition?: {
    receipt: DurableWarmRunTransition;
    phase: "awaiting_result" | "prepared" | "activated";
    credentialId: string;
    command: DurableRecoveryCoreCommand;
    expectedResult?: Record<string, unknown>;
  };
  /** Durable outcome evidence, never a credential; recovery also requires its exact live participant. */
  completedWarmTransition?: {
    receipt: DurableWarmRunTransition;
    command: DurableRecoveryCoreCommand;
  };
  /**
   * Connection-free provider attachment payload retained across authority
   * epochs. Commands are intentionally reset when a reusable runner changes
   * run identity, so the next controller cannot rely on command history to
   * reconstruct another warm attachment.
   */
  runAttachTemplate?: Record<string, unknown> | null;
  tickets: Record<string, BootstrapTicketRecord>;
  leases: Record<string, ConnectionLeaseRecord>;
  commands: DurableRecoveryCoreCommand[];
  committedEvents: DurableRecoveryCommittedEvent[];
  ackedSourceSeq: number;
  connectionCount: number;
  commandDeliveryCounts: Record<string, number>;
  replayDeliveries: number;
  duplicateCommandResults: number;
  freshBootstraps: number;
  malformedFrames: number;
  lastLeaseId: string | null;
  lastLeaseExpiresAt: string | null;
  indexedState?: {
    schema: "paperclip.runner.current-authority.v1" | "paperclip.runner.current-authority.v2";
    recoveryEvidence?: CurrentAuthorityEvidence;
    nextControllerSeq: number;
    sourceEpoch?: string;
    lastEventEpochTransition?: EventEpochTransition;
    commandEpochsNegotiated?: true;
    controllerEpoch?: string;
    commandEpochTransition?: CommandEpochTransition;
    lastCommandEpochTransition?: CommandEpochTransition;
    providerEverStarted: boolean;
    externalEffectEverAdmitted: boolean;
    pendingSemanticInputIds: string[];
    normalizedDelivery?: NormalizedDeliveryState;
    driverReceiptSequence?: string;
    processOwnerIndexVersion?: 1;
    legacyActivation?: { fenceId: string; preparationDigest: string };
  };
}

type PendingAuthorization =
  | {
      kind: "bootstrap";
      recordId: string;
      credentialId: string;
      authKey: Buffer;
      identity: DurableRecoveryIdentity;
      runnerVersion: string;
      runnerDigest: string;
      expiresAt: string;
      expiresAtUnixMs: number;
      recordSnapshot: string;
    }
  | {
      kind: "lease";
      recordId: string;
      credentialId: string;
      authKey: Buffer;
      identity: DurableRecoveryIdentity;
      protocolVersion: number;
      expiresAt: string;
      expiresAtUnixMs: number;
      leaseId: string;
      revocationEpoch: number;
      recordSnapshot: string;
    };

type LiveAuthorization =
  | {
      kind: "bootstrap";
      authKey: Buffer;
      ticket: BootstrapTicketRecord;
    }
  | {
      kind: "lease";
      authKey: Buffer;
      lease: ConnectionLeaseRecord;
    };

interface PendingChallenge {
  durability?: string;
  outputBodies?: string;
  eventEpochs?: string;
  eventResume?: EventResume;
  eventEpochLimit?: number;
  commandEpochs?: string;
  commandResume?: { controllerEpoch: string | null; lastControllerCommandSeq: number };
  authorization: PendingAuthorization;
  deadlineUnixMs: number;
  canonicalChallenge: string;
  serverProof: string;
  clientNonce: string;
  serverNonce: string;
  selectedVersion: number;
  warmTransitionVersion?: 1;
  warmTransitionId?: string;
  requestedIdentity?: DurableRecoveryIdentity;
}

interface SecureChannel {
  sendKey: Buffer;
  receiveKey: Buffer;
  sendCounter: bigint;
  receiveCounter: bigint;
  sessionId: string;
}

export interface DurablePrpControlPlaneOptions {
  stateDirectory: string;
  identity: DurableRecoveryIdentity;
  expectedRunnerVersion: string;
  expectedRunnerDigest: string;
  /** Open via DurablePrpControlPlane.open when supplying asynchronous storage. */
  authorityStore?: DurableAuthorityStore;
  /** Complete caller-owned admission before consuming a credential or releasing commands. */
  beforeAuthenticatedConnection?: (input: {
    readonly identity: DurableRecoveryIdentity;
    readonly warmTransitionId: string | null;
  }) => Promise<void>;
  onSemanticToolInput?: (input: {
    readonly callId: string;
    readonly operationId: string;
    readonly input: unknown;
    /** Internal trace lineage for the canonical semantic_tool.input event. */
    readonly sourceEventId: string;
    readonly sourceEventType: string;
    readonly correlation: {
      readonly runId: string;
      readonly normalizedSessionId: string;
      readonly turnId: string;
      readonly itemId: string;
    };
  }) => Promise<{ readonly result: unknown; readonly isError?: boolean }>;
  /** Persist the canonical event before the runner receives its cumulative ACK. */
  onCommittedEvent?: (event: PrpEvent) => Promise<void>;
  /** Stop this exact owner after a proven, authenticated permanent integrity fault. */
  onProtocolIntegrityError?: (
    error: NativeSessionProtocolIntegrityError,
  ) => void;
  connectionLeaseTtlMs?: number;
  /** May lower the connection rekey interval; never raises the wire bound. */
  secureChannelFrameLimit?: number;
  /** Qualification may lower, never raise, the renewable command namespace. */
  eventEpochLimit?: number;
  normalizedEventEpochLimit?: number;
  commandEpochLimit?: number;
}

export interface RunnerProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunnerProcessHandle {
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode?: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  completion: Promise<RunnerProcessResult>;
  processGroupId?: number | null;
  startedAt?: string;
  /** Relaunches the same immutable process specification with a fresh ticket. */
  restart?(ticket: string): RunnerProcessHandle;
}

export type RunnerProcessConnection =
  | { mode: "connect"; connectUrl: string; caBundlePath?: string }
  | {
      mode: "listen";
      listenAddress: "0.0.0.0";
      listenPort: number;
      listenPath: string;
    };

export interface RunnerProcessLaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

function domainDigest(domain: string, parts: readonly Buffer[]): Buffer {
  const digest = createHash("sha256")
    .update(domain)
    .update(Buffer.from([0]));
  for (const part of parts) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.length));
    digest.update(length).update(part);
  }
  return digest.digest();
}

function domainHmac(
  key: Buffer,
  domain: string,
  parts: readonly Buffer[],
): Buffer {
  const digest = createHmac("sha256", key)
    .update(domain)
    .update(Buffer.from([0]));
  for (const part of parts) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.length));
    digest.update(length).update(part);
  }
  return digest.digest();
}

function credentialMaterial(token: string): {
  credentialId: string;
  authKey: Buffer;
} {
  const bytes = Buffer.from(token);
  return {
    credentialId: `sha256:${domainDigest("paperclip-runner-credential-id-v1", [bytes]).toString("hex")}`,
    authKey: domainDigest("paperclip-runner-auth-key-v1", [bytes]),
  };
}

const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_NODES = 10_000;

function canonicalJson(
  value: unknown,
  ancestors = new WeakSet<object>(),
  state = { nodes: 0 },
  depth = 0,
): string {
  state.nodes += 1;
  if (
    depth > MAX_CANONICAL_JSON_DEPTH ||
    state.nodes > MAX_CANONICAL_JSON_NODES
  ) {
    throw new Error("durable_prp_canonical_json_too_large");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("durable_prp_canonical_json_invalid");
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new Error("durable_prp_canonical_json_invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new Error("durable_prp_canonical_json_invalid");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error("durable_prp_canonical_json_invalid");
        }
        entries.push(canonicalJson(value[index], ancestors, state, depth + 1));
      }
      return `[${entries.join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors, state, depth + 1)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export const durableRecoveryInternals = Object.freeze({ canonicalJson });

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactIdentity(value: unknown): value is DurableRecoveryIdentity {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") ===
      "environmentLeaseId,itemId,normalizedSessionId,runId,runnerInstanceId,turnId" &&
    Object.values(value).every(
      (field) => typeof field === "string" && stableIdPattern.test(field),
    )
  );
}

function warmTransitionReceipt(
  identity: DurableRecoveryIdentity,
  command: DurableRecoveryCoreCommand,
  result: Record<string, unknown>,
  ackedSourceSeq: number,
  lease: Pick<
    ConnectionLeaseRecord,
    "leaseId" | "expiresAtUnixMs" | "revocationEpoch"
  >,
  runnerVersion: string,
  runnerDigest: string,
  oldSourceEpoch?: string,
): DurableWarmRunTransition {
  const boundary = command.payload.paperclipNextAuthority;
  if (
    !exactIdentity(identity) ||
    !isRecord(boundary) ||
    !exactIdentity(boundary.identity) ||
    !isRecord(boundary.connection) ||
    boundary.identity.runId === identity.runId ||
    boundary.identity.runnerInstanceId !== identity.runnerInstanceId ||
    boundary.identity.environmentLeaseId !== identity.environmentLeaseId ||
    boundary.identity.normalizedSessionId !== identity.normalizedSessionId ||
    command.type !== "run.attach" ||
    result.status !== "completed" ||
    result.commandId !== command.commandId ||
    result.commandType !== command.type ||
    result.controllerSeq !== command.controllerSeq ||
    !stableIdPattern.test(runnerVersion) ||
    !runnerDigestPattern.test(runnerDigest) ||
    !stableIdPattern.test(lease.leaseId) ||
    !Number.isSafeInteger(lease.expiresAtUnixMs) ||
    lease.expiresAtUnixMs <= 0 ||
    !Number.isSafeInteger(lease.revocationEpoch) ||
    lease.revocationEpoch < 0 ||
    !Number.isSafeInteger(ackedSourceSeq) ||
    ackedSourceSeq < 0
  ) {
    throw new Error("Warm run transition binding is invalid.");
  }
  const { status: _status, result: _result, ...wire } = command;
  const body = {
    schema: "paperclip.runner.warm-transition.v1" as const,
    oldIdentity: structuredClone(identity),
    newIdentity: structuredClone(boundary.identity),
    commandId: command.commandId,
    controllerSeq: command.controllerSeq,
    // Rust's closed Command representation serializes these optional fields.
    commandFingerprint: canonicalDigest({
      ...wire,
      deadlineAt: null,
      precondition: null,
    }),
    resultDigest: canonicalDigest(result),
    oldAckedSourceSeq: ackedSourceSeq,
    ...(oldSourceEpoch ? { oldSourceEpoch } : {}),
    connection: structuredClone(boundary.connection),
    runnerVersion,
    runnerDigest,
    leaseId: lease.leaseId,
    leaseExpiresAtUnixMs: lease.expiresAtUnixMs,
    leaseRevocationEpoch: lease.revocationEpoch,
  };
  return { ...body, transitionId: canonicalDigest(body) };
}

function validStoredWarmTransition(state: StoredCoreState): boolean {
  const transition = state.warmTransition;
  if (!transition) return state.schema === coreStateSchema;
  if (
    state.schema !== transitionCoreStateSchema ||
    !["awaiting_result", "prepared", "activated"].includes(transition.phase) ||
    !isRecord(transition.receipt) ||
    !isRecord(transition.command) ||
    (transition.phase === "awaiting_result"
      ? transition.command.status !== "pending" ||
        transition.command.result !== null ||
        !isRecord(transition.expectedResult)
      : transition.command.status !== "completed" ||
        !transition.command.result ||
        transition.expectedResult !== undefined)
  )
    return false;
  const lease = state.leases[transition.credentialId];
  if (!lease) return false;
  try {
    const expected = warmTransitionReceipt(
      transition.receipt.oldIdentity,
      transition.command,
      (transition.phase === "awaiting_result"
        ? transition.expectedResult
        : transition.command.result)!,
      transition.receipt.oldAckedSourceSeq,
      lease,
      transition.receipt.runnerVersion,
      transition.receipt.runnerDigest,
      transition.receipt.oldSourceEpoch,
    );
    return (
      runnerDigestPattern.test(expected.runnerDigest) &&
      canonicalJson(expected) === canonicalJson(transition.receipt) &&
      canonicalJson(state.identity) ===
        canonicalJson(
          transition.phase === "activated"
            ? expected.newIdentity
            : expected.oldIdentity,
        ) &&
      (transition.phase === "activated" ||
        (state.ackedSourceSeq === expected.oldAckedSourceSeq && state.indexedState?.sourceEpoch === expected.oldSourceEpoch &&
          canonicalJson(
            state.commands.find(
              (command) => command.commandId === expected.commandId,
            ),
          ) === canonicalJson(transition.command)))
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsettledSemanticInput(
  event: DurableRecoveryCommittedEvent,
  state: Pick<StoredCoreState, "identity" | "commands" | "indexedState">,
): boolean {
  if (state.indexedState) return state.indexedState.pendingSemanticInputIds.includes(event.sourceEventId);
  if (
    event.eventType !== "semantic_tool.input" &&
    event.eventType !== "mcp_app.tool_input"
  )
    return false;
  try {
    const envelope = event.envelope;
    const body =
      isRecord(envelope.payload) && isRecord(envelope.payload.payload)
        ? envelope.payload.payload
        : {};
    const semantic = isRecord(body.semantic_tool) ? body.semantic_tool : {};
    const correlation = semantic.correlation;
    const expectedCorrelation = {
      runId: state.identity.runId,
      normalizedSessionId: state.identity.normalizedSessionId,
      turnId: state.identity.turnId,
      itemId: state.identity.itemId,
    };
    if (
      typeof semantic.callId !== "string" ||
      typeof semantic.operationId !== "string" ||
      canonicalJson(correlation) !== canonicalJson(expectedCorrelation)
    )
      return true;
    const commandId = `command_tool_${createHash("sha256").update(`${state.identity.runId}\0${semantic.callId}`).digest("hex").slice(0, 32)}`;
    const command = state.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (
      !command ||
      command.type !== "semantic_tool.result" ||
      command.status !== "completed" ||
      !isRecord(command.result) ||
      command.result.status !== "completed" ||
      command.result.commandId !== commandId ||
      command.result.controllerSeq !== command.controllerSeq ||
      command.result.commandType !== command.type
    )
      return true;
    return (
      command.payload.callId !== semantic.callId ||
      command.payload.operationId !== semantic.operationId ||
      command.payload.sourceEventId !== event.sourceEventId ||
      command.payload.sourceEventType !== event.eventType ||
      canonicalJson(command.payload.correlation) !==
        canonicalJson(expectedCorrelation) ||
      canonicalJson(command.payload.input) !== canonicalJson(semantic.input)
    );
  } catch {
    // Malformed retained evidence cannot establish settled authority, and
    // must not throw past the caller's bounded process-containment path.
    return true;
  }
}

function isStoredCoreState(
  value: unknown,
  identity: DurableRecoveryIdentity,
  allowIndexed = false,
): value is StoredCoreState {
  if (!isRecord(value)) return false;
  if (value.indexedState !== undefined) {
    const current = value.indexedState;
    if (!allowIndexed || !isRecord(current) || current.schema !== "paperclip.runner.current-authority.v1" ||
      !Number.isSafeInteger(current.nextControllerSeq) || (current.nextControllerSeq as number) < 1 ||
      typeof current.providerEverStarted !== "boolean" || typeof current.externalEffectEverAdmitted !== "boolean" ||
      !Array.isArray(current.pendingSemanticInputIds) || current.pendingSemanticInputIds.length > maxCommands ||
      !current.pendingSemanticInputIds.every((id) => typeof id === "string" && stableIdPattern.test(id)) ||
      new Set(current.pendingSemanticInputIds).size !== current.pendingSemanticInputIds.length) return false;
    if (current.commandEpochsNegotiated !== undefined && current.commandEpochsNegotiated !== true) return false;
    if ((current.controllerEpoch !== undefined && !isCommandEpoch(current.controllerEpoch)) ||
      (current.commandEpochTransition !== undefined && (!isCommandEpochTransition(current.commandEpochTransition) ||
        current.commandEpochTransition.runId !== identity.runId || current.commandEpochTransition.fromEpoch !== (current.controllerEpoch ?? null) ||
        current.commandEpochTransition.finalOrdinal !== Number(current.nextControllerSeq) - 1))) return false;
    if (current.controllerEpoch === undefined ? current.lastCommandEpochTransition !== undefined :
      !isCommandEpochTransition(current.lastCommandEpochTransition) || current.lastCommandEpochTransition.nextEpoch !== current.controllerEpoch || current.lastCommandEpochTransition.runId !== identity.runId) return false;
    if (current.sourceEpoch === undefined ? current.lastEventEpochTransition !== undefined :
      !isCommandEpoch(current.sourceEpoch) || !isEventEpochTransition(current.lastEventEpochTransition) || current.lastEventEpochTransition.nextEpoch !== current.sourceEpoch || current.lastEventEpochTransition.runId !== identity.runId) return false;
    if (current.normalizedDelivery !== undefined) {
      try { validateNormalizedDelivery(current.normalizedDelivery as NormalizedDeliveryState); }
      catch { return false; }
      const delivery = current.normalizedDelivery as NormalizedDeliveryState;
      if (delivery.raw.epoch !== identity.runId || (delivery.raw.sourceEpoch === current.sourceEpoch && delivery.raw.sourceSeq > Number(value.ackedSourceSeq))
        || delivery.pending.some((event) => event.runId !== identity.runId || event.sourceInstanceId !== identity.runnerInstanceId || event.normalizedSessionId !== identity.normalizedSessionId || event.sourceKind !== "runner")) return false;
    }
  }
  const commands = value.commands;
  const events = value.committedEvents;
  if (
    (value.schema !== coreStateSchema &&
      value.schema !== transitionCoreStateSchema) ||
    canonicalJson(value.identity) !== canonicalJson(identity) ||
    !isRecord(value.tickets) ||
    !isRecord(value.leases) ||
    !Array.isArray(commands) ||
    commands.length > maxCommands + (allowIndexed ? 64 : 0) ||
    !Array.isArray(events) ||
    events.length > maxCommittedEventWindow ||
    !Number.isSafeInteger(value.ackedSourceSeq) ||
    (value.ackedSourceSeq as number) < 0 ||
    !Number.isSafeInteger(value.connectionCount) ||
    (value.connectionCount as number) < 0 ||
    !isRecord(value.commandDeliveryCounts)
  ) {
    return false;
  }
  if (!validStoredWarmTransition(value as unknown as StoredCoreState))
    return false;
  if (value.completedWarmTransition !== undefined) {
    const completed = value.completedWarmTransition;
    if (
      !isRecord(completed) ||
      !isRecord(completed.receipt) ||
      !isRecord(completed.command) ||
      completed.command.status !== "completed" ||
      !isRecord(completed.command.result)
    )
      return false;
    if (
      canonicalJson(completed.receipt.newIdentity) !==
      canonicalJson(value.identity)
    )
      return false;
    try {
      if (
        canonicalJson(
          warmTransitionReceipt(
            completed.receipt.oldIdentity as unknown as DurableRecoveryIdentity,
            completed.command as unknown as DurableRecoveryCoreCommand,
            completed.command.result,
            completed.receipt.oldAckedSourceSeq as number,
            {
              leaseId: completed.receipt.leaseId as string,
              expiresAtUnixMs: completed.receipt.leaseExpiresAtUnixMs as number,
              revocationEpoch: completed.receipt.leaseRevocationEpoch as number,
            },
            completed.receipt.runnerVersion as string,
            completed.receipt.runnerDigest as string,
            completed.receipt.oldSourceEpoch as string | undefined,
          ),
        ) !== canonicalJson(completed.receipt)
      )
        return false;
    } catch {
      return false;
    }
  }
  if (
    value.runAttachTemplate !== undefined &&
    value.runAttachTemplate !== null &&
    !isRecord(value.runAttachTemplate)
  ) {
    return false;
  }
  if (
    !commands.every(
      (command, index) =>
        isRecord(command) &&
        (command.schema === "paperclip.prp.command.v1" ||
          command.schema === "paperclip.prp.command.v2") &&
        typeof command.commandId === "string" &&
        stableIdPattern.test(command.commandId) &&
        command.commandId.length <= 160 &&
        (value.indexedState
          ? Number.isSafeInteger(command.controllerSeq) && (command.controllerSeq as number) > 0
          : command.controllerSeq === index + 1) &&
        (command.controllerEpoch === undefined || (value.indexedState && isCommandEpoch(command.controllerEpoch))) &&
        (command.status !== "pending" || command.controllerEpoch === (value.indexedState as StoredCoreState["indexedState"])?.controllerEpoch) &&
        typeof command.type === "string" &&
        commandTypes.has(command.type) &&
        typeof command.issuedAt === "string" &&
        isRecord(command.payload) &&
        [
          "pending",
          "completed",
          "failed",
          "rejected",
          "indeterminate",
        ].includes(String(command.status)) &&
        (command.result === null || isRecord(command.result)),
    )
  ) {
    return false;
  }
  if (
    !events.every(
      (event) =>
        isRecord(event) &&
        (event.sourceEpoch === undefined || (allowIndexed && isCommandEpoch(event.sourceEpoch))) &&
        Number.isSafeInteger(event.sourceSeq) &&
        (event.sourceSeq as number) > 0 &&
        typeof event.sourceEventId === "string" &&
        typeof event.eventType === "string" &&
        (event.priority === 0 ||
          event.priority === 1 ||
          event.priority === 2) &&
        isRecord(event.envelope) &&
        Number.isSafeInteger(event.deliveryCount) &&
        (event.deliveryCount as number) > 0 &&
        event.logicalEffectCount === 1,
    )
  ) {
    return false;
  }
  return [
    "replayDeliveries",
    "duplicateCommandResults",
    "freshBootstraps",
    "malformedFrames",
  ].every(
    (field) =>
      Number.isSafeInteger(value[field]) && (value[field] as number) >= 0,
  );
}

function authKeyFromDigest(digest: string): Buffer {
  const hex = digest.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (hex === undefined)
    throw new Error("Stored transport authentication key is malformed.");
  return Buffer.from(hex, "hex");
}

interface WarmTransitionInspectionInput {
  controlPlaneState: unknown;
  runnerState: unknown;
  expectedNewIdentity: DurableRecoveryIdentity;
  expectedRunnerVersion: string;
  expectedRunnerDigest: string;
  now?: number;
}

function warmTransitionRecoveryProof(input: WarmTransitionInspectionInput): {
  transition: NonNullable<StoredCoreState["warmTransition"]>;
  original: ConnectionLeaseRecord;
  requested: DurableRecoveryIdentity;
  controllerIdentity: DurableRecoveryIdentity;
} | null {
  try {
    const state = input.controlPlaneState;
    const runner = input.runnerState;
    const now = input.now ?? Date.now();
    if (
      !Number.isSafeInteger(now) ||
      !exactIdentity(input.expectedNewIdentity) ||
      !isRecord(state) ||
      !exactIdentity(state.identity) ||
      !isStoredCoreState(state, state.identity, true) ||
      !isRecord(runner) ||
      runner.schema !== "paperclip.runner.durable.state.warm-transition.v1"
    )
      return null;
    const pending = runner.warmTransition;
    if (
      !isRecord(pending) ||
      !["prepared", "activating"].includes(String(pending.phase)) ||
      !isRecord(pending.receipt) ||
      !isRecord(pending.result)
    )
      return null;
    let transition = state.warmTransition;
    if (
      !transition &&
      pending.phase === "activating" &&
      state.completedWarmTransition &&
      canonicalJson(state.completedWarmTransition.receipt) ===
        canonicalJson(pending.receipt) &&
      state.ackedSourceSeq === 0 &&
      state.committedEvents.length === 0 &&
      state.commands.every((entry) => entry.status === "pending")
    ) {
      const completed = state.completedWarmTransition;
      const participants = Object.values(state.leases).filter(
        (lease) =>
          lease.leaseId === completed.receipt.leaseId &&
          lease.revokedAt === null &&
          lease.expiresAtUnixMs > now &&
          canonicalJson(lease.identity) ===
            canonicalJson(completed.receipt.newIdentity),
      );
      if (participants.length !== 1) return null;
      transition = {
        ...structuredClone(completed),
        phase: "activated",
        credentialId: participants[0]!.credentialId,
      };
    }
    if (!transition && pending.phase === "prepared") {
      const receipt = pending.receipt;
      const command = state.commands.find(
        (entry) => entry.commandId === receipt.commandId,
      );
      const participants = Object.values(state.leases).filter(
        (lease) =>
          lease.leaseId === receipt.leaseId &&
          lease.revokedAt === null &&
          lease.expiresAtUnixMs > now &&
          canonicalJson(lease.identity) === canonicalJson(state.identity),
      );
      if (
        command?.status !== "pending" ||
        command.type !== "run.attach" ||
        participants.length !== 1 ||
        state.commands.some(
          (entry) =>
            entry.status === "pending" && entry.commandId !== command.commandId,
        )
      )
        return null;
      const original = participants[0]!;
      const expected = warmTransitionReceipt(
        state.identity,
        command,
        pending.result,
        state.ackedSourceSeq,
        original,
        input.expectedRunnerVersion,
        input.expectedRunnerDigest,
        state.indexedState?.sourceEpoch,
      );
      if (canonicalJson(expected) !== canonicalJson(receipt)) return null;
      transition = {
        receipt: expected,
        phase: "awaiting_result",
        credentialId: original.credentialId,
        command: structuredClone(command),
        expectedResult: structuredClone(pending.result),
      };
    }
    const original = transition && state.leases[transition.credentialId];
    if (
      !transition ||
      !original ||
      original.revokedAt !== null ||
      original.expiresAtUnixMs <= now ||
      original.credentialId !== transition.credentialId ||
      !stableIdPattern.test(original.credentialId) ||
      typeof original.authKeyDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(original.authKeyDigest) ||
      !Number.isInteger(original.protocolVersion) ||
      original.protocolVersion < protocolMinVersion ||
      original.protocolVersion > protocolVersion ||
      !exactIdentity(original.identity) ||
      (canonicalJson(original.identity) !==
        canonicalJson(transition.receipt.oldIdentity) &&
        !(
          transition.phase === "activated" &&
          canonicalJson(original.identity) ===
            canonicalJson(transition.receipt.newIdentity)
        )) ||
      original.expiresAt !== new Date(original.expiresAtUnixMs).toISOString() ||
      original.leaseId !== transition.receipt.leaseId ||
      original.expiresAtUnixMs !== transition.receipt.leaseExpiresAtUnixMs ||
      original.revocationEpoch !== transition.receipt.leaseRevocationEpoch ||
      transition.receipt.runnerVersion !== input.expectedRunnerVersion ||
      transition.receipt.runnerDigest !== input.expectedRunnerDigest ||
      canonicalJson(transition.receipt.newIdentity) !==
        canonicalJson(input.expectedNewIdentity) ||
      canonicalJson(pending.receipt) !== canonicalJson(transition.receipt) ||
      !Array.isArray(runner.outbox) ||
      runner.outbox.length !== 0 ||
      runner.pendingTerminalDelivery != null ||
      runner.pendingProviderCleanup != null
    )
      return null;
    const requested =
      pending.phase === "prepared"
        ? transition.receipt.oldIdentity
        : transition.receipt.newIdentity;
    const { status: _status, result: _result, ...wire } = transition.command;
    if (
      (pending.phase === "prepared" && transition.phase === "activated") ||
      (pending.phase === "activating" &&
        transition.phase === "awaiting_result") ||
      !Object.entries(requested).every(
        ([key, value]) => runner[key] === value,
      ) ||
      canonicalJson(pending.command) !==
        canonicalJson({ ...wire, deadlineAt: null, precondition: null }) ||
      canonicalJson(pending.result) !==
        canonicalJson(transition.expectedResult ?? transition.command.result) ||
      runner.sourceEpoch !== (pending.phase === "prepared" ? transition.receipt.oldSourceEpoch : undefined) ||
      runner.ackedSourceSeq !==
        (pending.phase === "prepared"
          ? transition.receipt.oldAckedSourceSeq
          : 0) ||
      runner.nextSourceSeq !==
        (pending.phase === "prepared"
          ? transition.receipt.oldAckedSourceSeq + 1
          : 1)
    )
      return null;
    return {
      transition,
      original,
      requested,
      controllerIdentity: state.identity,
    };
  } catch {
    return null;
  }
}

/** Read-only structural proof; this never grants process, DB, or bootstrap authority. */
export function inspectWarmRunTransition(
  input: WarmTransitionInspectionInput,
): {
  receipt: DurableWarmRunTransition;
  runnerIdentity: DurableRecoveryIdentity;
  controllerIdentity: DurableRecoveryIdentity;
  phase: "awaiting_result" | "prepared" | "activated";
} | null {
  const proof = warmTransitionRecoveryProof(input);
  return proof
    ? structuredClone({
        receipt: proof.transition.receipt,
        runnerIdentity: proof.requested,
        controllerIdentity: proof.controllerIdentity,
        phase: proof.transition.phase,
      })
    : null;
}

function proofMatches(expected: Buffer, supplied: unknown): boolean {
  if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied))
    return false;
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}

function createSecureChannel(
  authKey: Buffer,
  canonicalChallenge: string,
  serverProof: string,
  clientProof: string,
): SecureChannel {
  const parts = [
    Buffer.from(canonicalChallenge),
    Buffer.from(serverProof),
    Buffer.from(clientProof),
  ];
  const binding = domainDigest("paperclip-runner-session-binding-v1", parts);
  return {
    sendKey: domainHmac(authKey, "paperclip-runner-core-to-client-key-v1", [
      binding,
    ]),
    receiveKey: domainHmac(authKey, "paperclip-runner-client-to-core-key-v1", [
      binding,
    ]),
    sendCounter: 0n,
    receiveCounter: 0n,
    sessionId: `sha256:${binding.toString("hex")}`,
  };
}

function secureNonce(prefix: "P3C1" | "P3S1", counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.write(prefix, 0, "ascii");
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

function secureAad(
  channel: SecureChannel,
  direction: "client_to_core" | "core_to_client",
  counter: bigint,
): Buffer {
  return Buffer.from(
    `${secureFrameSchema}\0${channel.sessionId}\0${direction}\0${counter}`,
  );
}

function encryptSecureJson(
  channel: SecureChannel,
  value: unknown,
): Record<string, unknown> {
  const counter = channel.sendCounter;
  const cipher = createCipheriv(
    "aes-256-gcm",
    channel.sendKey,
    secureNonce("P3S1", counter),
  );
  cipher.setAAD(secureAad(channel, "core_to_client", counter));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  channel.sendCounter += 1n;
  return {
    schema: secureFrameSchema,
    counter: Number(counter),
    ciphertext: ciphertext.toString("hex"),
  };
}

function decryptSecureJson(
  channel: SecureChannel,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Secure frame must be an object.");
  }
  const frame = value as Record<string, unknown>;
  if (
    frame.schema !== secureFrameSchema ||
    typeof frame.counter !== "number" ||
    !Number.isSafeInteger(frame.counter) ||
    BigInt(frame.counter) !== channel.receiveCounter ||
    typeof frame.ciphertext !== "string" ||
    !/^[0-9a-f]+$/.test(frame.ciphertext) ||
    frame.ciphertext.length % 2 !== 0
  ) {
    throw new Error("Secure frame metadata or counter is invalid.");
  }
  const sealed = Buffer.from(frame.ciphertext, "hex");
  if (sealed.length < 16)
    throw new Error("Secure frame authentication tag is missing.");
  const ciphertext = sealed.subarray(0, -16);
  const tag = sealed.subarray(-16);
  const counter = channel.receiveCounter;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    channel.receiveKey,
    secureNonce("P3C1", counter),
  );
  decipher.setAAD(secureAad(channel, "client_to_core", counter));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  channel.receiveCounter += 1n;
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}

function initialCoreState(identity: DurableRecoveryIdentity): StoredCoreState {
  return {
    schema: coreStateSchema,
    identity,
    runAttachTemplate: null,
    tickets: {},
    leases: {},
    commands: [],
    committedEvents: [],
    ackedSourceSeq: 0,
    connectionCount: 0,
    commandDeliveryCounts: {},
    replayDeliveries: 0,
    duplicateCommandResults: 0,
    freshBootstraps: 0,
    malformedFrames: 0,
    lastLeaseId: null,
    lastLeaseExpiresAt: null,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function verifyPrivateDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Private state directory is not a real directory: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error(
        `Private state directory does not use mode 0700: ${path}`,
      );
    }
    if (process.geteuid !== undefined && metadata.uid !== process.geteuid()) {
      throw new Error(
        `Private state directory is not owned by the daemon user: ${path}`,
      );
    }
  }
}

function verifyPrivateRegularFile(file: Stats, path: string): void {
  if (!file.isFile()) {
    throw new Error(`Private state path is not a regular file: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((file.mode & 0o777) !== 0o600) {
      throw new Error(`Private state file does not use mode 0600: ${path}`);
    }
    if (process.geteuid !== undefined && file.uid !== process.geteuid()) {
      throw new Error(
        `Private state file is not owned by the daemon user: ${path}`,
      );
    }
  }
}

function readPrivateFile(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    verifyPrivateRegularFile(metadata, path);
    if (metadata.size > DURABLE_PRP_CONTROL_PLANE_MAX_STATE_BYTES) {
      throw new Error(`Private state file exceeds its size bound: ${path}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(
    dirname(path),
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicPrivateWrite(path: string, contents: string): void {
  const temporary = resolve(
    dirname(path),
    `.${path.split(/[\\/]/).at(-1)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    verifyPrivateRegularFile(fstatSync(descriptor), temporary);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    created = false;
    syncParentDirectory(path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}

function encodeLegacyState(state: StoredCoreState): string {
  const bytes = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > DURABLE_PRP_CONTROL_PLANE_MAX_STATE_BYTES) {
    throw new DurableAuthorityStoreError("storage_pressure", "legacy journal requires indexed migration before more history can be admitted");
  }
  return bytes;
}

class DurableCoreStore {
  readonly path: string;
  #state: StoredCoreState;
  #writeIndeterminate = false;

  constructor(directory: string, identity: DurableRecoveryIdentity) {
    assertNoPendingLegacyMigration(directory);
    try {
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          `Private state directory is not a real directory: ${directory}`,
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    verifyPrivateDirectory(directory);
    this.path = resolve(directory, "control-plane-state.json");
    const stored = readPrivateFile(this.path);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as unknown;
      if (!isStoredCoreState(parsed, identity)) {
        throw new Error(
          "Control-plane state is invalid or does not match the requested PRP identity.",
        );
      }
      this.#state = parsed;
    } else {
      this.#state = initialCoreState(identity);
      atomicPrivateWrite(this.path, encodeLegacyState(this.#state));
    }
  }

  get state(): StoredCoreState {
    return this.#state;
  }

  async save(): Promise<void> {
    this.assertWritable();
    await this.commit(this.#state);
  }

  assertWritable(): void {
    assertNoPendingLegacyMigration(dirname(this.path));
    if (this.#writeIndeterminate)
      throw new Error(
        "Durable authority commit is indeterminate; reload is required.",
      );
  }

  /** Persist a complete candidate before publishing any new authority in memory. */
  async commit(candidate: StoredCoreState): Promise<void> {
    this.assertWritable();
    try {
      atomicPrivateWrite(this.path, encodeLegacyState(candidate));
      this.#state = candidate;
    } catch (error) {
      // Rename may already have succeeded before directory fsync failed.
      // Never overwrite that possibly durable receipt using stale memory.
      this.#writeIndeterminate = true;
      throw error;
    }
  }
}

function indexedCurrentState(): NonNullable<StoredCoreState["indexedState"]> {
  return { schema: "paperclip.runner.current-authority.v1", nextControllerSeq: 1, processOwnerIndexVersion: 1, providerEverStarted: false, externalEffectEverAdmitted: false, pendingSemanticInputIds: [] };
}

/** Only current authority remains in the checkpoint. These references are
 * independent of the paged history used by transcript/event consumers. */
function compactIndexedState(state: StoredCoreState): StoredCoreState {
  const current = state.indexedState!;
  const commands = new Map<string, DurableRecoveryCoreCommand>();
  for (const command of state.commands) {
    if (command.status === "pending" || command.status === "indeterminate") commands.set(command.commandId, command);
    else if (command.type !== "semantic_tool.result") commands.set(`latest:${command.type}`, command);
    else if (["paperclip_finish", "paperclip_block"].includes(String(command.payload.operationId))) commands.set(`terminal:${command.payload.operationId}`, command);
  }
  const events = new Map<string, DurableRecoveryCommittedEvent>();
  for (const event of state.committedEvents) {
    const body = isRecord(event.envelope.payload) && isRecord(event.envelope.payload.payload) ? event.envelope.payload.payload : {};
    const semantic = isRecord(body.semantic_tool) ? body.semantic_tool : {};
    if (current.pendingSemanticInputIds.includes(event.sourceEventId)) events.set(event.sourceEventId, event);
    else if (["paperclip_finish", "paperclip_block"].includes(String(semantic.operationId))) events.set(`${event.eventType}:${semantic.operationId}`, event);
    else if (["session.started", "session.resumed", "session.reconciled", "harness.ready", "turn.accepted", "turn.started", "turn.completed", "turn.failed", "run.terminal"].includes(event.eventType)) events.set(event.eventType, event);

  }
  const retained = [...commands.values()].sort((a, b) => compareCurrentCommands(a, b, current.controllerEpoch));
  return {
    ...state, commands: retained,
    commandDeliveryCounts: Object.fromEntries(retained.map((command) => [command.commandId, state.commandDeliveryCounts[command.commandId] ?? 0])),
    committedEvents: [...events.values()].sort((a, b) => compareCurrentEvents(a, b, current.sourceEpoch)),
  };
}


export interface LegacyAuthorityImportOptions {
  sourcePath: string;
  identity: DurableRecoveryIdentity;
  authority: DurableAuthorityStore;
  /** Stable identity of the exclusive migration, retained across retries. The
   * embedding runtime must fence legacy writers and verify every process owner
   * before invoking this API; the source file's presence is not that proof. */
  fenceId: string;
  assertExclusiveFence(): Promise<void>;
  onCheckpoint?(): Promise<void>;
}
interface LegacyAuthorityImportState {
  schema: "paperclip.runner.legacy-authority-import.v1";
  identity: DurableRecoveryIdentity;
  fenceId: string;
  source: string | null;
  cursor: LegacyJsonCursor | null;
  phase: "copying" | "reconciling" | "prepared";
  commandCount: number;
  eventCount: number;
  lastSourceSeq: number;
  reconcileAfter: string;
  projection: StoredCoreState;
}

/** Prepare a lossless indexed controller import. Nothing publishes a locator
 * or starts a peer here: the cross-store activation handshake must separately
 * verify runner/provider preparation under this same ownership fence. Staged
 * rows cannot be opened by DurablePrpControlPlane as execution authority. */
export async function stageLegacyControlPlaneAuthority(options: LegacyAuthorityImportOptions): Promise<AuthoritySnapshot> {
  if (!stableIdPattern.test(options.fenceId)) throw new Error("Invalid legacy migration fence identity.");
  await options.assertExclusiveFence();
  let snapshot = await options.authority.load();
  let generation = snapshot?.generation ?? "0";
  let migration = snapshot?.state as unknown as LegacyAuthorityImportState | undefined;
  if (migration && (migration.schema !== "paperclip.runner.legacy-authority-import.v1" || migration.fenceId !== options.fenceId || authorityJson(migration.identity) !== authorityJson(options.identity))) {
    throw new Error("Legacy migration staging belongs to a different authority or fence.");
  }
  migration ??= {
    schema: "paperclip.runner.legacy-authority-import.v1", identity: options.identity, fenceId: options.fenceId,
    source: null, cursor: null, phase: "copying", commandCount: 0, eventCount: 0, lastSourceSeq: 0, reconcileAfter: "0",
    projection: { ...initialCoreState(options.identity), indexedState: indexedCurrentState() },
  };
  const reader = new LegacyJsonReader(options.sourcePath);
  const persist = async (records: AuthorityRecord[]) => {
    await options.assertExclusiveFence();
    const facts = records.filter(record => record.kind === "event").map(record => processOwnerEvidence(record.body as unknown as DurableRecoveryCommittedEvent, options.identity)).filter(fact => fact !== null);
    const work = await processOwnerChanges(options.authority, facts, { runId: options.identity.runId });
    generation = await options.authority.commit({ expectedGeneration: generation, state: migration as unknown as Record<string, unknown>, records, work });
    await options.onCheckpoint?.();
  };
  try {
    while (migration.phase === "copying") {
      await options.assertExclusiveFence();
      const page = await reader.page(migration.source, migration.cursor);
      const records: AuthorityRecord[] = [];
      for (const entry of page.entries) {
        const current = migration.projection;
        if (entry.field === "commands") {
          const command = entry.value as DurableRecoveryCoreCommand;
          const sample = { ...initialCoreState(options.identity), indexedState: indexedCurrentState(), commands: [command] };
          if (!isStoredCoreState(sample, options.identity, true) || command.controllerSeq !== migration.commandCount + 1) throw new Error("Invalid legacy command during migration.");
          migration.commandCount++;
          current.indexedState!.nextControllerSeq = command.controllerSeq + 1;
          if (["session.open", "turn.start", "run.attach"].includes(command.type)) current.indexedState!.providerEverStarted = true;
          if (command.type === "semantic_tool.result") current.indexedState!.externalEffectEverAdmitted = true;
          current.commands.push(command);
          if (command.status !== "pending") records.push({ epoch: options.identity.runId, kind: "command", id: command.commandId, sequence: String(command.controllerSeq), ...(command.controllerEpoch ? { sequenceEpoch: command.controllerEpoch } : {}), body: command as unknown as Record<string, unknown> });
        } else if (entry.field === "committedEvents") {
          const event = entry.value as DurableRecoveryCommittedEvent;
          const sample = { ...initialCoreState(options.identity), indexedState: indexedCurrentState(), committedEvents: [event] };
          if (!isStoredCoreState(sample, options.identity, true) || event.sourceSeq <= migration.lastSourceSeq) throw new Error("Invalid legacy event during migration.");
          migration.eventCount++; migration.lastSourceSeq = event.sourceSeq;
          current.indexedState!.providerEverStarted = true;
          if (["semantic_tool.input", "mcp_app.tool_input", "runtime.input.requested", "runtime_request.created"].includes(event.eventType)) current.indexedState!.externalEffectEverAdmitted = true;
          current.committedEvents.push(event);
          records.push({ epoch: options.identity.runId, kind: "event", id: event.sourceEventId, sequence: String(event.sourceSeq), body: { ...event, deliveryCount: 1 } as unknown as Record<string, unknown> });
        } else if (entry.field === "commandDeliveryCounts") {
          if (entry.key === null || !stableIdPattern.test(entry.key) || !Number.isSafeInteger(entry.value) || Number(entry.value) < 0 || Object.hasOwn(current.commandDeliveryCounts, entry.key)) throw new Error("Invalid legacy command delivery count.");
          Object.defineProperty(current.commandDeliveryCounts, entry.key, { value: entry.value, enumerable: true, configurable: true, writable: true });
        } else {
          if (entry.key !== null || entry.field === "indexedState") throw new Error("Unexpected indexed metadata in legacy migration.");
          Object.defineProperty(current, entry.field, { value: entry.value, enumerable: true, configurable: true, writable: true });
        }
        // Each completed entry becomes an immutable row before the staging
        // checkpoint advances. No imported history accumulates in this view.
        const deliveryCounts = current.commandDeliveryCounts;
        migration.projection = compactIndexedState(current);
        // Counts are at most the legacy pending/command admission bound. They
        // can precede commands in valid JSON, so filter only after the copy.
        migration.projection.commandDeliveryCounts = deliveryCounts;
        if (Object.keys(deliveryCounts).length > maxCommands) throw new Error("Legacy delivery counts exceed admission capacity.");
      }
      migration.source = page.source; migration.cursor = page.cursor;
      if (page.done) {
        // Initialization defaults are staging scaffolding, never evidence for
        // a field absent from the source. Empty collections must be explicit.
        const required = ["schema", "identity", "tickets", "leases", "commands", "committedEvents", "ackedSourceSeq", "connectionCount", "commandDeliveryCounts", "replayDeliveries", "duplicateCommandResults", "freshBootstraps", "malformedFrames"];
        if (required.some(field => !page.cursor.fields.includes(field))) throw new Error("Legacy authority is missing required source fields.");
        if (migration.lastSourceSeq > migration.projection.ackedSourceSeq || migration.commandCount > maxCommands || migration.eventCount > maxCommittedEventWindow || !isStoredCoreState(migration.projection, options.identity, true)) throw new Error("Legacy authority is invalid after import.");
        migration.projection = compactIndexedState(migration.projection);
        migration.phase = "reconciling";
      }
      await persist(records);
    }
    // JSON field order is irrelevant. Resolve semantic inputs only after all
    // completed commands have been imported, using exact indexed lookups.
    while (migration.phase === "reconciling") {
      await options.assertExclusiveFence();
      const page = await options.authority.readEvents(options.identity.runId, migration.reconcileAfter, 128, 8 * 1024 * 1024);
      for (const record of page.records) {
        const event = record.body as unknown as DurableRecoveryCommittedEvent;
        if (["semantic_tool.input", "mcp_app.tool_input"].includes(event.eventType)) {
          const payload = isRecord(event.envelope.payload) && isRecord(event.envelope.payload.payload) ? event.envelope.payload.payload : {};
          const semantic = isRecord(payload.semantic_tool) ? payload.semantic_tool : {};
          const commandId = `command_tool_${createHash("sha256").update(`${options.identity.runId}\0${String(semantic.callId)}`).digest("hex").slice(0, 32)}`;
          const command = await options.authority.getRecord(options.identity.runId, "command", commandId);
          if (unsettledSemanticInput(event, { identity: options.identity, commands: command ? [command.body as unknown as DurableRecoveryCoreCommand] : [] })) {
            migration.projection.indexedState!.pendingSemanticInputIds.push(event.sourceEventId);
            migration.projection.committedEvents.push(event);
          }
        }
      }
      migration.projection = compactIndexedState(migration.projection);
      if (!isStoredCoreState(migration.projection, options.identity, true)) throw new Error("Imported unresolved authority exceeds current admission capacity.");
      migration.reconcileAfter = page.nextAfter ?? migration.reconcileAfter;
      if (!page.records.length) migration.phase = "prepared";
      await persist([]);
    }
    if (migration.phase !== "prepared" || !migration.cursor || !migration.source) throw new Error("Invalid legacy migration phase.");
    // Re-stat the original through the worker even after restarting a prepared
    // import. The original remains untouched until cross-store activation.
    await reader.page(migration.source, migration.cursor);
    await options.assertExclusiveFence();
    snapshot = { generation, state: migration as unknown as Record<string, unknown> };
    return snapshot;
  } finally { await reader.close(); }
}

/** Internal activation projection. It carries an exact preparation receipt so
 * a commit-before-filesystem-publication restart can finish the same migration. */
export function legacyControllerActivation(snapshot: AuthoritySnapshot, identity: DurableRecoveryIdentity, fenceId: string, preparationDigest: string): StoredCoreState {
  const migration = snapshot.state as unknown as LegacyAuthorityImportState;
  if (migration.schema !== "paperclip.runner.legacy-authority-import.v1" || migration.phase !== "prepared"
      || migration.fenceId !== fenceId || authorityJson(migration.identity) !== authorityJson(identity)
      || !/^[a-f0-9]{64}$/.test(preparationDigest) || !isStoredCoreState(migration.projection, identity, true)) {
    throw new Error("Invalid prepared controller activation.");
  }
  const projection = structuredClone(migration.projection);
  projection.indexedState!.legacyActivation = { fenceId, preparationDigest };
  return projection;
}

function persistenceFailureCode(error: unknown): string {
  if (error instanceof DurableAuthorityStoreError) return error.message;
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : error;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "unknown";
  return /^[a-zA-Z0-9_]{1,80}$/.test(code) ? code : "unknown";
}

class IndexedCoreStore {
  readonly path: string;
  readonly authority: DurableAuthorityStore;
  #state: StoredCoreState;
  #durableState: StoredCoreState;
  #generation: string;
  #writeIndeterminate = false;
  #persistedCommandIds = new Set<string>();
  #persistedEventSeq: number;
  #persistedSourceEpoch?: string;
  #epoch: string;
  #locator: string | null = null;
  #failure = "unknown";

  constructor(directory: string, identity: DurableRecoveryIdentity, authority: DurableAuthorityStore, snapshot: AuthoritySnapshot | null) {
    assertNoPendingLegacyMigration(directory);
    if (!lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory, { recursive: true, mode: 0o700 });
    verifyPrivateDirectory(directory);
    this.path = resolve(directory, "control-plane-state.json");
    this.authority = authority;
    const activated = this.#validateLocator();
    if (activated && snapshot === null) {
      throw new DurableAuthorityStoreError("storage_unavailable", "activated current authority is missing; refusing to recreate it");
    }
    const state = snapshot?.state ?? { ...initialCoreState(identity), indexedState: indexedCurrentState() };
    if (!isStoredCoreState(state, identity, true) || !state.indexedState) throw new Error("Indexed current authority is invalid or does not match its identity.");
    this.#state = state;
    this.#durableState = structuredClone(state);
    this.#generation = snapshot?.generation ?? "0";
    this.#persistedEventSeq = state.ackedSourceSeq;
    this.#persistedSourceEpoch = state.indexedState?.sourceEpoch;
    this.#epoch = identity.runId;
    this.#rememberCommands();
  }

  #validateLocator(): boolean {
    const existing = readPrivateFile(this.path);
    if (existing !== null) {
      const previous = JSON.parse(existing) as { schema?: string; location?: { binding?: string } };
      if (previous.schema !== "paperclip.runner.authority-locator.v1" || previous.location?.binding !== this.authority.binding) {
        throw new Error("Indexed authority activation requires a fenced legacy migration.");
      }
      return true;
    }
    return false;
  }

  publishLocator(): void {
    const value = `${JSON.stringify({ schema: "paperclip.runner.authority-locator.v1", location: this.authority.location })}\n`;
    if (value === this.#locator) return;
    this.#validateLocator();
    atomicPrivateWrite(this.path, value);
    this.#locator = value;
  }

  #rememberCommands(): void {
    this.#persistedCommandIds = new Set(this.#state.commands.filter((command) => command.status !== "pending").map((command) => command.commandId));
  }

  get state(): StoredCoreState { return this.#state; }
  rememberPersistedState(state: Record<string, unknown>): void { this.#durableState = structuredClone(state) as unknown as StoredCoreState; }
  assertWritable(): void {
    assertNoPendingLegacyMigration(dirname(this.path));
    if (this.#writeIndeterminate) throw new Error(`Durable authority commit is indeterminate (${this.#failure}); reload is required.`);
  }
  async save(): Promise<void> { await this.commit(this.#state); }

  async backfillProcessOwners(): Promise<void> {
    this.assertWritable();
    if (this.#state.indexedState?.processOwnerIndexVersion === 1) return;
    const facts = this.#state.committedEvents.map(event => processOwnerEvidence(event, this.#state.identity)).filter(fact => fact !== null);
    const work = await processOwnerChanges(this.authority, facts, { runId: this.#state.identity.runId, sourceEpoch: this.#state.indexedState?.sourceEpoch });
    try {
      for (let offset = 0; offset < work.length; offset += 128) {
        // Retain the original bounded prototype checkpoint until every page
        // commits. A crash can repeat the backfill without losing launch facts.
        this.#generation = await this.authority.commit({ expectedGeneration: this.#generation,
          state: this.#state as unknown as Record<string, unknown>, records: [], work: work.slice(offset, offset + 128) });
      }
      await this.save();
    } catch (error) {
      this.#failure = persistenceFailureCode(error);
      this.#writeIndeterminate = true;
      throw error;
    }
  }

  async commit(candidate: StoredCoreState, additionalRecords: AuthorityRecord[] = []): Promise<void> {
    this.assertWritable();
    candidate = structuredClone(candidate);
    if (candidate.identity.runId !== this.#epoch) {
      if (this.#state.indexedState?.normalizedDelivery?.pending.length) {
        throw new DurableAuthorityStoreError("storage_pressure", "run-log delivery must settle before authority rotation");
      }
      candidate.indexedState = indexedCurrentState();
    }
    const records: AuthorityRecord[] = [...additionalRecords];
    const sameEpoch = candidate.identity.runId === this.#epoch;
    for (const command of candidate.commands) {
      if (command.status !== "pending" && !(sameEpoch && this.#persistedCommandIds.has(command.commandId))) {
        records.push({ epoch: candidate.identity.runId, kind: "command", id: command.commandId, sequence: String(command.controllerSeq), ...(command.controllerEpoch ? { sequenceEpoch: command.controllerEpoch } : {}), body: command as unknown as Record<string, unknown> });
        if (command.type === "semantic_tool.result" && command.status === "completed") {
          candidate.indexedState!.pendingSemanticInputIds = candidate.indexedState!.pendingSemanticInputIds.filter((id) => id !== command.payload.sourceEventId);
        }
      }
    }
    for (const event of candidate.committedEvents) {
      if (event.sourceEpoch === candidate.indexedState?.sourceEpoch && event.sourceSeq > (sameEpoch && event.sourceEpoch === this.#persistedSourceEpoch ? this.#persistedEventSeq : 0)) records.push({ epoch: candidate.identity.runId, kind: "event", id: event.sourceEventId, sequence: String(event.sourceSeq), ...(event.sourceEpoch ? { sequenceEpoch: event.sourceEpoch } : {}), body: { ...event, deliveryCount: 1 } as unknown as Record<string, unknown> });
    }
    const facts = candidate.committedEvents.map(event => processOwnerEvidence(event, candidate.identity)).filter(fact => fact !== null);
    candidate.indexedState!.processOwnerIndexVersion = 1;
    const work = await processOwnerChanges(this.authority, facts, { runId: candidate.identity.runId, sourceEpoch: candidate.indexedState?.sourceEpoch });
    const compact = compactIndexedState(candidate);
    const persisted = referenceCurrentAuthority(compact);
    try {
      this.#generation = await this.authority.commit({ expectedGeneration: this.#generation, state: persisted as unknown as Record<string, unknown>, records, work });
      this.#state = compact;
      this.#durableState = persisted;
      this.#epoch = compact.identity.runId;
      this.#persistedEventSeq = compact.ackedSourceSeq;
      this.#persistedSourceEpoch = compact.indexedState?.sourceEpoch;
      this.#rememberCommands();
      this.publishLocator();
    } catch (error) {
      // A resource rejection can be retried through the same live owner only
      // after a fresh read proves that its transaction did not advance. Never
      // treat an indeterminate commit or a different writer as a safe rollback.
      if (error instanceof DurableAuthorityStoreError && error.code === "storage_pressure") {
        try {
          const committed = await this.authority.load();
          if (committed?.generation === this.#generation && authorityJson(committed.state) === authorityJson(this.#durableState)) {
            this.#state = await materializeCurrentAuthority(committed.state, this.authority.getRecord.bind(this.authority)) as unknown as StoredCoreState;
            throw error;
          }
        } catch (readError) {
          if (readError === error) throw error;
          // Failure to verify keeps the normal indeterminate-write fence.
        }
      }
      this.#failure = persistenceFailureCode(error);
      this.#writeIndeterminate = true;
      throw error;
    }
  }
}

/** Reason supplied when a transport-neutral PRP peer closes. */
export interface TransportCloseReason {
  readonly code?: number;
  readonly message?: string;
  readonly error?: unknown;
}

/** A transport-neutral JSON peer used by hosted PRP integrations. */
export interface PrpWireConnection {
  sendJson(value: unknown): void;
  close(code?: number): void;
  onJson(listener: (value: unknown) => void): void;
  onClose(listener: (reason: TransportCloseReason) => void): void;
  /** Stop delivering new frames while durable admission drains. Peers without
   * flow control are disconnected at the bounded ingress budget and replay. */
  pauseRead?(): void;
  resumeRead?(): void;
}

/** Read-only authentication state for an attached PRP peer. */
export interface PrpWireAttachment {
  isAuthenticated(): boolean;
}

/** Read surface retained for live transports that project durable PRP state. */
export interface DurablePrpControlPlaneStore {
  readonly path: string;
  readonly state: StoredCoreState;
}

class RawWebSocketWireConnection implements PrpWireConnection {
  readonly socket: Duplex;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #readPaused = false;
  #onJson: (value: unknown) => void = () => undefined;
  #onClose: (reason: TransportCloseReason) => void = () => undefined;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    // An upgraded HTTP socket is half-open by default. A peer may exit during
    // handoff without a WebSocket close frame; retain no writable half-owner.
    socket.on("end", () => this.close());
    socket.on("close", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#onClose({ message: "socket_closed" });
      }
    });
    socket.on("error", (error) => {
      if (this.#closed) return;
      this.#closed = true;
      this.#onClose({ message: "socket_error", error });
    });
  }

  onJson(listener: (value: unknown) => void): void {
    this.#onJson = listener;
  }

  onClose(listener: (reason: TransportCloseReason) => void): void {
    this.#onClose = listener;
  }

  acceptInitialData(data: Buffer<ArrayBufferLike>): void {
    if (data.length > 0) this.#consume(data);
  }

  pauseRead(): void { this.#readPaused = true; this.socket.pause(); }
  resumeRead(): void {
    if (this.#closed) return;
    this.#readPaused = false;
    this.#consume(Buffer.alloc(0));
    if (!this.#readPaused && !this.#closed) this.socket.resume();
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendText(text: string): void {
    if (this.#closed) {
      return;
    }
    const payload = Buffer.from(text);
    if (this.socket.writableLength + payload.length > 4 * 1024 * 1024) { this.close(1013); return; }
    const header: number[] = [0x81];
    if (payload.length <= 125) {
      header.push(payload.length);
    } else if (payload.length <= 0xffff) {
      header.push(126, (payload.length >>> 8) & 0xff, payload.length & 0xff);
    } else {
      const length = BigInt(payload.length);
      header.push(127);
      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        header.push(Number((length >> shift) & 0xffn));
      }
    }
    this.socket.write(Buffer.concat([Buffer.from(header), payload]));
  }

  close(_code?: number): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.socket.destroy();
    this.#onClose({ message: "local_close" });
  }

  #consume(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && !this.#readPaused && this.#buffer.length >= 2) {
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let cursor = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        cursor = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const extended = this.#buffer.readBigUInt64BE(2);
        if (extended > BigInt(maxFrameBytes)) {
          this.close();
          return;
        }
        length = Number(extended);
        cursor = 10;
      }
      if (length > maxFrameBytes || !masked) {
        this.close();
        return;
      }
      if (this.#buffer.length < cursor + 4 + length) return;
      const mask = this.#buffer.subarray(cursor, cursor + 4);
      cursor += 4;
      const payload = Buffer.from(
        this.#buffer.subarray(cursor, cursor + length),
      );
      this.#buffer = this.#buffer.subarray(cursor + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      if (opcode === 0x1) {
        try {
          this.#onJson(JSON.parse(payload.toString("utf8")) as unknown);
        } catch (error) {
          this.#closed = true;
          this.socket.destroy();
          this.#onClose({ message: "invalid_json", error });
          return;
        }
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this.#sendControl(0x0a, payload);
      } else if (opcode !== 0x0a) {
        this.close();
        return;
      }
    }
  }

  #sendControl(opcode: number, payload: Buffer): void {
    if (payload.length > 125 || this.#closed) return;
    this.socket.write(
      Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]),
    );
  }
}

class AuthorityConnection {
  readonly secureFrameLimit: bigint;
  pendingChallenge: PendingChallenge | null = null;
  secureChannel: SecureChannel | null = null;
  lease: ConnectionLeaseRecord | null = null;
  connectionId: string | null = null;
  terminalLifecycleCommandId: string | null = null;
  warmTransitionVersion: 1 | null = null;
  commandEpochs = false;
  eventEpochs = false;
  eventResume: EventResume | null = null;
  eventEpochLimit = EVENT_EPOCH_LIMIT;
  identity: DurableRecoveryIdentity | null = null;
  replayOnly = false;
  activationReceipt: DurableWarmRunTransition | null = null;
  readonly wire: PrpWireConnection;
  #closed = false;
  #onClose: () => void;

  constructor(input: {
    wire: PrpWireConnection;
    onJson: (value: unknown) => void;
    onClose: () => void;
    secureFrameLimit: number;
  }) {
    this.wire = input.wire;
    this.secureFrameLimit = BigInt(input.secureFrameLimit);
    this.#onClose = input.onClose;
    this.wire.onJson(input.onJson);
    this.wire.onClose(() => this.#markClosed());
  }

  sendJson(value: unknown): void {
    if (this.#closed) return;
    if (this.secureChannel && this.secureChannel.sendCounter >= this.secureFrameLimit) {
      // The underlying authority already owns commands/events/ACK cursors.
      // A lost reply is reconciled on the next authenticated connection.
      this.close(1012);
      return;
    }
    this.wire.sendJson(
      this.secureChannel === null
        ? value
        : encryptSecureJson(this.secureChannel, value),
    );
  }

  close(code?: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.wire.close(code);
    this.#onClose();
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
  }
}

/** Authenticated, replay-safe PRP transport authority. Business operations are caller supplied. */
export class DurablePrpControlPlane {
  #mutationTail: Promise<unknown> = Promise.resolve();
  #queuedMutations = 0;
  #queuedWireFrames = 0;
  #queuedWireBytes = 0;

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#queuedMutations >= 64) return Promise.reject(new Error("storage_pressure: authority mutation queue is full"));
    this.#queuedMutations++;
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.catch(() => undefined).finally(() => { this.#queuedMutations--; });
    return result;
  }
  #identity: DurableRecoveryIdentity;
  readonly #store: DurableCoreStore | IndexedCoreStore;
  #expectedRunnerVersion: string;
  #expectedRunnerDigest: string;
  #server: Server | null = null;
  #connections = new Set<AuthorityConnection>();
  #connectionProcessing = new Map<AuthorityConnection, Promise<void>>();
  #pendingSemanticCalls = new Set<string>();
  #semanticResultPersistenceFailed = false;
  #port: number | null = null;
  #onSemanticToolInput?: DurablePrpControlPlaneOptions["onSemanticToolInput"];
  #onCommittedEvent?: DurablePrpControlPlaneOptions["onCommittedEvent"];
  #beforeAuthenticatedConnection?: DurablePrpControlPlaneOptions["beforeAuthenticatedConnection"];
  #onProtocolIntegrityError?: DurablePrpControlPlaneOptions["onProtocolIntegrityError"];
  #protocolIntegrityError: NativeSessionProtocolIntegrityError | null = null;
  #connectionLeaseTtlMs: number;
  #secureChannelFrameLimit: number;
  #eventEpochLimit: number;
  #normalizedEventEpochLimit: number;
  #commandEpochLimit: number;
  #commandEpochWaiters = new Set<(error?: Error) => void>();

  constructor(options: DurablePrpControlPlaneOptions, openedSnapshot?: AuthoritySnapshot | null) {
    if (
      !Object.values(options.identity).every(
        (value) => typeof value === "string" && stableIdPattern.test(value),
      ) ||
      !stableIdPattern.test(options.expectedRunnerVersion) ||
      !runnerDigestPattern.test(options.expectedRunnerDigest) ||
      (options.connectionLeaseTtlMs !== undefined &&
        (!Number.isInteger(options.connectionLeaseTtlMs) ||
          options.connectionLeaseTtlMs < 60_000 ||
          options.connectionLeaseTtlMs > 24 * 60 * 60 * 1_000)) ||
      (options.secureChannelFrameLimit !== undefined &&
        (!Number.isInteger(options.secureChannelFrameLimit) || options.secureChannelFrameLimit < 4 || options.secureChannelFrameLimit > maxSecureChannelFrames)) ||
      (options.commandEpochLimit !== undefined && (!Number.isSafeInteger(options.commandEpochLimit) || options.commandEpochLimit < 4 || options.commandEpochLimit > COMMAND_EPOCH_LIMIT))
    ) {
      throw new Error("Durable PRP control plane options are invalid.");
    }
    this.#identity = structuredClone(options.identity);
    if (options.authorityStore && openedSnapshot === undefined) throw new Error("Indexed authority must be opened asynchronously.");
    this.#store = options.authorityStore
      ? new IndexedCoreStore(options.stateDirectory, options.identity, options.authorityStore, openedSnapshot!)
      : new DurableCoreStore(options.stateDirectory, options.identity);
    this.#expectedRunnerVersion = options.expectedRunnerVersion;
    this.#expectedRunnerDigest = options.expectedRunnerDigest;
    const transition = this.#store.state.warmTransition;
    if (
      transition &&
      (transition.receipt.runnerVersion !== options.expectedRunnerVersion ||
        transition.receipt.runnerDigest !== options.expectedRunnerDigest)
    ) {
      throw new Error(
        "Warm run transition requires its exact approved runner artifact.",
      );
    }
    this.#onSemanticToolInput = options.onSemanticToolInput;
    this.#onCommittedEvent = options.onCommittedEvent;
    this.#beforeAuthenticatedConnection = options.beforeAuthenticatedConnection;
    this.#onProtocolIntegrityError = options.onProtocolIntegrityError;
    this.#connectionLeaseTtlMs = options.connectionLeaseTtlMs ?? 60_000;
    this.#secureChannelFrameLimit = options.secureChannelFrameLimit ?? maxSecureChannelFrames;
    if (options.eventEpochLimit !== undefined && (!Number.isSafeInteger(options.eventEpochLimit) || options.eventEpochLimit < 4 || options.eventEpochLimit > EVENT_EPOCH_LIMIT)) throw new Error("Invalid event epoch limit");
    this.#eventEpochLimit = options.eventEpochLimit ?? EVENT_EPOCH_LIMIT;
    if (options.normalizedEventEpochLimit !== undefined && (!Number.isSafeInteger(options.normalizedEventEpochLimit) || options.normalizedEventEpochLimit < 4 || options.normalizedEventEpochLimit > EVENT_EPOCH_LIMIT)) throw new Error("Invalid normalized event epoch limit");
    this.#normalizedEventEpochLimit = options.normalizedEventEpochLimit ?? EVENT_EPOCH_LIMIT;
    this.#commandEpochLimit = options.commandEpochLimit ?? COMMAND_EPOCH_LIMIT;
  }

  get store(): DurablePrpControlPlaneStore {
    return this.#store;
  }

  static async open(options: DurablePrpControlPlaneOptions): Promise<DurablePrpControlPlane> {
    const snapshot = options.authorityStore ? await options.authorityStore.load() : undefined;
    let opened = snapshot;
    if (snapshot && options.authorityStore) {
      opened = { ...snapshot, state: await materializeCurrentAuthority(snapshot.state, options.authorityStore.getRecord.bind(options.authorityStore)) };
      const current = await options.authorityStore.load();
      if (current?.generation !== snapshot.generation || authorityJson(current.state) !== authorityJson(snapshot.state)) throw new DurableAuthorityStoreError("stale_authority", "authority changed while resolving current evidence");
    }
    const core = new DurablePrpControlPlane(options, opened);
    if (snapshot && core.#store instanceof IndexedCoreStore) core.#store.rememberPersistedState(snapshot.state);
    if (options.authorityStore && snapshot === null) await core.#store.save();
    else if (core.#store instanceof IndexedCoreStore) {
      await core.#store.backfillProcessOwners();
      core.#store.publishLocator();
    }
    return core;
  }

  get indexedPersistence(): boolean { return this.#store instanceof IndexedCoreStore; }

  normalizedDelivery(): NormalizedDeliveryPort | null {
    if (!(this.#store instanceof IndexedCoreStore)) return null;
    const storage = this.#store;
    const epoch = this.#identity.runId;
    const check = () => {
      this.#store.assertWritable();
      if (this.#identity.runId !== epoch) throw new DurableAuthorityStoreError("stale_authority", "normalized consumer belongs to a retired run");
    };
    const receiptId = (collection: string, key: string) => `driver_${createHash("sha256").update(`${collection}\0${key}`).digest("hex")}`;
    return {
      epoch,
      ...(storage.authority.unorderedEffectReceipts === true ? { eventEpochs: { limit: this.#normalizedEventEpochLimit } } : {}),
      history: { get: async (collection, key) => {
        check();
        const receipt = await storage.authority.getSessionEffect(receiptId(collection, key));
        check();
        if (!receipt) return null;
        if (receipt.body.schema !== "paperclip.driver-receipt.v1" || receipt.body.collection !== collection || receipt.body.key !== key || receipt.body.value == null) throw new DurableAuthorityStoreError("invalid_authority", "driver receipt binding mismatch");
        return structuredClone(receipt.body.value);
      } },
      load: () => { check(); return structuredClone(this.#store.state.indexedState?.normalizedDelivery ?? null); },
      commit: (batch) => this.#serialize(async () => {
        check();
        const currentSource = this.#store.state.indexedState?.sourceEpoch;
        const closed = batch.raw.sourceEpoch === currentSource ? null : await this.readEventEpochTransition(batch.raw.sourceEpoch);
        if (batch.raw.epoch !== epoch || batch.raw.sourceSeq > (closed?.finalOrdinal ?? this.#store.state.ackedSourceSeq) || (batch.raw.sourceEpoch !== currentSource && !closed)) throw new DurableAuthorityStoreError("invalid_authority", "normalized consumer passed the committed raw inbox or its epoch");
        for (const event of batch.events) {
          if (event.runId !== epoch || event.normalizedSessionId !== this.#identity.normalizedSessionId || event.sourceInstanceId !== this.#identity.runnerInstanceId || event.sourceKind !== "runner") {
            throw new DurableAuthorityStoreError("invalid_authority", "normalized event binding mismatch");
          }
        }
        const candidate = structuredClone(this.#store.state);
        const previousDelivery = candidate.indexedState!.normalizedDelivery ?? null;
        const rawTransition = previousDelivery && previousDelivery.raw.sourceEpoch !== batch.raw.sourceEpoch ? await this.readEventEpochTransition(previousDelivery.raw.sourceEpoch) : null;
        const next = applyNormalizedBatch(previousDelivery, batch, rawTransition ?? undefined);
        candidate.indexedState!.normalizedDelivery = next;
        const receipts: AuthorityRecord[] = [];
        if ((batch.receipts?.length ?? 0) > 128) throw new DurableAuthorityStoreError("storage_pressure", "driver receipt batch exceeds admission capacity");
        const unordered = storage.authority.unorderedEffectReceipts === true;
        const closedEpochs = new Set<string | null>();
        for (const event of batch.events) {
          const t = event.sourceEpochTransition;
          if (!t) continue;
          if (!unordered || closedEpochs.has(t.fromEpoch) || closedEpochs.has(t.nextEpoch)) throw new DurableAuthorityStoreError("invalid_authority", "normalized epoch reused or unsupported");
          const closeId = normalizedEpochCloseId(epoch, event.sourceInstanceId, t.fromEpoch);
          if (await storage.authority.getRecord(epoch, "effect", closeId)
            || await storage.authority.getRecord(epoch, "effect", normalizedEpochCloseId(epoch, event.sourceInstanceId, t.nextEpoch))
            || await storage.authority.getRecord(epoch, "effect", `normalized-epoch-${t.transitionId}`)) throw new DurableAuthorityStoreError("receipt_conflict", "normalized epoch identity reused");
          closedEpochs.add(t.fromEpoch);
          for (const id of [closeId, `normalized-epoch-${t.transitionId}`]) receipts.push({ epoch, kind: "effect", id, sequence: "0", body: { ...t } });
        }
        let sequence = unordered ? 0n : authorityInteger(candidate.indexedState!.driverReceiptSequence ?? "0");
        for (const receipt of batch.receipts ?? []) {
          if (!["terminal", "file", "steering", "lineage"].includes(receipt.collection) || typeof receipt.key !== "string" || !receipt.key || Buffer.byteLength(receipt.key) > 4096 || receipt.value == null) throw new DurableAuthorityStoreError("invalid_authority", "invalid driver receipt");
          const id = receiptId(receipt.collection, receipt.key);
          const body = { schema: "paperclip.driver-receipt.v1", ...receipt };
          const existing = await storage.authority.getSessionEffect(id);
          if (existing) {
            if (authorityJson(existing.body) !== authorityJson(body)) throw new DurableAuthorityStoreError("receipt_conflict", "driver identity changed its accepted outcome");
          } else receipts.push({ epoch, kind: "effect", id, sequence: unordered ? "0" : String(++sequence), body });
        }
        if (unordered) delete candidate.indexedState!.driverReceiptSequence;
        else candidate.indexedState!.driverReceiptSequence = String(sequence);
        await storage.commit(candidate, receipts);
        return structuredClone(next);
      }),
      acknowledge: (event) => this.#serialize(async () => {
        check();
        const previous = this.#store.state.indexedState?.normalizedDelivery;
        if (!previous) throw new DurableAuthorityStoreError("invalid_authority", "normalized consumer has no pending delivery");
        const candidate = structuredClone(this.#store.state);
        candidate.indexedState!.normalizedDelivery = acknowledgeNormalizedEvent(previous, event);
        await this.#store.commit(candidate);
      }),
    };
  }

  /** Cleanup pages current unresolved owners under one authority generation.
   * Callers must revalidate ownership before taking any process action. */
  async readProcessOwners(after = "", limit = 128, expectedGeneration?: string) {
    if (!(this.#store instanceof IndexedCoreStore)) throw new DurableAuthorityStoreError("invalid_authority", "legacy authority has no process-owner index");
    this.#store.assertWritable();
    const snapshot = await this.#store.authority.load();
    if (!snapshot) throw new DurableAuthorityStoreError("storage_unavailable", "process-owner authority is missing");
    const generation = expectedGeneration ?? snapshot.generation;
    const page = await this.#store.authority.readWorkPage("process-owner", after, limit, generation);
    return { ...page, generation };
  }

  async readCommittedEvents(after: number, limit = 128, sourceEpoch?: string): Promise<DurableRecoveryCommittedEvent[]> {
    this.#store.assertWritable();
    if (!(this.#store instanceof IndexedCoreStore)) return this.#store.state.committedEvents.filter((event) => event.sourceSeq > after).slice(0, limit);
    const page = await this.#store.authority.readEvents(this.#identity.runId, String(after), limit, 4 * 1024 * 1024, sourceEpoch);
    return page.records.map((record) => record.body as unknown as DurableRecoveryCommittedEvent);
  }

  async readEventEpochTransition(sourceEpoch?: string): Promise<EventEpochTransition | null> {
    if (!(this.#store instanceof IndexedCoreStore)) return null;
    this.#store.assertWritable();
    const record = await this.#store.authority.getRecord(this.#identity.runId, "effect", eventEpochCloseId({runId: this.#identity.runId, fromEpoch: sourceEpoch ?? null}));
    if (!record) return null;
    if (!isEventEpochTransition(record.body) || record.body.runId !== this.#identity.runId || record.body.fromEpoch !== (sourceEpoch ?? null)) throw new DurableAuthorityStoreError("invalid_authority", "event epoch close receipt binding mismatch");
    return record.body;
  }

  async getCommand(commandId: string): Promise<DurableRecoveryCoreCommand | undefined> {
    this.#store.assertWritable();
    return (
      this.#store.state.commands.find(
        (command) => command.commandId === commandId,
      ) ??
      (this.#store.state.warmTransition?.command.commandId === commandId
        ? this.#store.state.warmTransition.command
        : undefined) ??
      (this.#store.state.completedWarmTransition?.command.commandId ===
      commandId
        ? this.#store.state.completedWarmTransition.command
        : undefined) ??
      (this.#store instanceof IndexedCoreStore
        ? (await this.#store.authority.getRecord(this.#identity.runId, "command", commandId))?.body as unknown as DurableRecoveryCoreCommand | undefined
        : undefined)
    );
  }

  get connectUrl(): string {
    if (this.#port === null) {
      throw new Error("Durable PRP control plane is not listening.");
    }
    return `ws://127.0.0.1:${this.#port}/durableRecovery/connect`;
  }

  async start(port = 0): Promise<void> {
    if (this.#server !== null) {
      throw new Error("Durable PRP control plane is already running.");
    }
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.#server = server;
    server.on("upgrade", (request, socket, head) =>
      this.handleUpgrade(request, socket, "/durableRecovery/connect", head),
    );
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Durable PRP control plane did not bind a TCP port.");
    }
    this.#port = address.port;
  }

  async stop(): Promise<void> {
    for (const done of this.#commandEpochWaiters) done(new DurableAuthorityStoreError("storage_unavailable", "controller stopped with command epoch transition pending"));
    for (const connection of this.#connections) {
      connection.close();
    }
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server !== null) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  }

  /** Join admitted wire work after ingress has stopped, including queued
   * frames on already-closed connections. This proves settlement, not a
   * successful commit or reusable checkpoint; callers still inspect those
   * durable receipts and own the wait's deadline. Ordinary stop stays bounded
   * by socket ownership rather than arbitrary external commit callbacks. */
  async drainPendingConnectionProcessing(): Promise<void> {
    const assertIngressStopped = () => {
      if (this.#server !== null || this.#connections.size !== 0)
        throw new Error("Connection processing drain requires stopped ingress.");
    };
    assertIngressStopped();
    while (this.#connectionProcessing.size > 0) {
      await Promise.allSettled([...this.#connectionProcessing.values()]);
      assertIngressStopped();
    }
  }

  /** Forces a resumable re-authentication after an immutable run attachment rotates. */
  disconnectActiveRunner(): void {
    const connections = [...this.#connections];
    this.#connections.clear();
    for (const connection of connections) connection.close();
  }

  activeRunnerConnectionCount(): number {
    return [...this.#connections].filter(
      (connection) => connection.secureChannel !== null,
    ).length;
  }

  /** A reusable close requires every admitted callback's exact durable result. */
  semanticToolResultsSettled(): boolean {
    return (
      !this.#semanticResultPersistenceFailed &&
      this.#pendingSemanticCalls.size === 0 &&
      !this.#store.state.commands.some(
        (command) =>
          command.type === "semantic_tool.result" &&
          command.status !== "completed",
      ) &&
      !this.#store.state.committedEvents.some((event) =>
        unsettledSemanticInput(event, this.#store.state),
      )
    );
  }

  /**
   * Atomically advances a settled reusable runner to a new run authority while
   * retaining its existing connection lease secret. The runner performs the
   * matching state transition only after acknowledging `run.attach`.
   */
  async rotateRunIdentity(
    identity: DurableRecoveryIdentity,
    runAttachTemplate?: Record<string, unknown>,
  ): Promise<void> {
    return this.#serialize(async () => {
    if (this.#protocolIntegrityError !== null)
      throw this.#protocolIntegrityError;
    const completed = this.#store.state.completedWarmTransition;
    if (
      completed &&
      canonicalJson(identity) === canonicalJson(this.#identity) &&
      canonicalJson(identity) === canonicalJson(completed.receipt.newIdentity)
    ) {
      const { paperclipNextAuthority: _boundary, ...template } =
        completed.command.payload;
      if (
        runAttachTemplate !== undefined &&
        canonicalJson(runAttachTemplate) !== canonicalJson(template)
      ) {
        throw new Error(
          "Completed warm transition template conflicts with its exact command.",
        );
      }
      return;
    }
    const transition = this.#store.state.warmTransition;
    if (transition) {
      if (transition.phase === "awaiting_result")
        throw new Error("Warm transition result is not yet authenticated.");
      if (
        canonicalJson(identity) !==
        canonicalJson(transition.receipt.newIdentity)
      ) {
        throw new Error(
          "Warm run transition target conflicts with its durable receipt.",
        );
      }
      // The new authenticated peer, not an attach-result observer, owns the
      // activation boundary. Keep the old credential and command replay lane.
      if (runAttachTemplate !== undefined) {
        const { paperclipNextAuthority: _boundary, ...expectedTemplate } =
          transition.command.payload;
        if (
          canonicalJson(runAttachTemplate) !== canonicalJson(expectedTemplate)
        ) {
          throw new Error(
            "Warm run transition template conflicts with its exact command.",
          );
        }
        const candidate = structuredClone(this.#store.state);
        candidate.runAttachTemplate = structuredClone(runAttachTemplate);
        await this.#store.commit(candidate);
      }
      return;
    }
    if (
      this.#store.state.commands.some(
        (command) => command.type === "run.attach",
      )
    ) {
      throw new Error(
        "Warm run identity rotation requires a durable transition receipt.",
      );
    }
    if (
      !Object.values(identity).every(
        (value) => typeof value === "string" && stableIdPattern.test(value),
      ) ||
      identity.runnerInstanceId !== this.#identity.runnerInstanceId ||
      identity.environmentLeaseId !== this.#identity.environmentLeaseId ||
      identity.normalizedSessionId !== this.#identity.normalizedSessionId ||
      identity.runId === this.#identity.runId ||
      this.#store.state.commands.some((command) => command.status === "pending")
    ) {
      throw new Error("Durable PRP run identity rotation is invalid.");
    }
    this.disconnectActiveRunner();
    const leases = Object.fromEntries(
      Object.entries(this.#store.state.leases).map(([key, lease]) => [
        key,
        { ...lease, identity: structuredClone(identity) },
      ]),
    );
    const candidate = Object.assign(initialCoreState(identity), {
      leases,
      runAttachTemplate:
        runAttachTemplate === undefined
          ? null
          : structuredClone(runAttachTemplate),
    });
    await this.#store.commit(candidate);
    this.#identity = structuredClone(identity);
      });
  }

  /**
   * Retain the connection-free provider preparation payload before the first
   * runner bootstrap. Completed command history is bounded and may be
   * compacted before a warm continuation arrives, so it cannot be the sole
   * source for a later run.attach. Repeating the same write is idempotent;
   * changing an established seed fails closed.
   */
  async persistRunAttachTemplate(runAttachTemplate: Record<string, unknown>): Promise<void> {
    return this.#serialize(async () => {
    if (!isRecord(runAttachTemplate.provider)) {
      throw new Error("Durable PRP run attachment template is invalid.");
    }
    const existing = this.#store.state.runAttachTemplate;
    if (
      existing !== undefined &&
      existing !== null &&
      canonicalJson(existing) !== canonicalJson(runAttachTemplate)
    ) {
      throw new Error("Durable PRP run attachment template conflicts.");
    }
    if (existing !== undefined && existing !== null) return;
    const candidate = structuredClone(this.#store.state);
    candidate.runAttachTemplate = structuredClone(runAttachTemplate);
    await this.#store.commit(candidate);
      });
  }

  async issueBootstrapTicket(ttlMs = 5_000): Promise<string> {
    return this.#serialize(async () => {
    this.#store.assertWritable();
    if (this.#store.state.warmTransition) {
      throw new Error(
        "Warm transition recovery requires its explicit one-use bootstrap capability.",
      );
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
      throw new Error("Durable PRP bootstrap TTL is invalid.");
    }
    const candidate = structuredClone(this.#store.state);
    this.#pruneCredentials(candidate);
    const ticket = `bootstrap_${randomUUID()}`;
    const material = credentialMaterial(ticket);
    const expiresAtUnixMs = Date.now() + ttlMs;
    candidate.tickets[material.credentialId] = {
      recordId: `bootstrap_ticket_${randomUUID()}`,
      credentialId: material.credentialId,
      authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
      identity: structuredClone(this.#identity),
      runnerVersion: this.#expectedRunnerVersion,
      runnerDigest: this.#expectedRunnerDigest,
      expiresAt: new Date(expiresAtUnixMs).toISOString(),
      expiresAtUnixMs,
      usedAt: null,
    };
    candidate.freshBootstraps = incrementDiagnosticCount(candidate.freshBootstraps);
    await this.#store.commit(candidate);
    return ticket;
      });
  }

  /** Caller-owned recovery admission is required; a receipt is not a credential. */
  async issueWarmTransitionBootstrapTicket(
    input: {
      transitionId: string;
      runnerState: Record<string, unknown>;
    },
    ttlMs = 5_000,
  ): Promise<string> {
    return this.#serialize(async () => {
    this.#store.assertWritable();
    const pending = input.runnerState.warmTransition;
    const proof = warmTransitionRecoveryProof({
      controlPlaneState: this.#store.state,
      runnerState: input.runnerState,
      expectedNewIdentity: (isRecord(pending) && isRecord(pending.receipt)
        ? pending.receipt.newIdentity
        : null) as DurableRecoveryIdentity,
      expectedRunnerVersion: this.#expectedRunnerVersion,
      expectedRunnerDigest: this.#expectedRunnerDigest,
    });
    if (
      !proof ||
      input.transitionId !== proof.transition.receipt.transitionId ||
      !Number.isInteger(ttlMs) ||
      ttlMs < 1_000 ||
      ttlMs > 60_000
    ) {
      throw new Error(
        "Warm transition bootstrap snapshot proof is not authorized.",
      );
    }
    const { transition, original, requested } = proof;
    const ticket = `bootstrap_${randomUUID()}`;
    const material = credentialMaterial(ticket);
    const expiresAtUnixMs = Math.min(
      Date.now() + ttlMs,
      original.expiresAtUnixMs,
    );
    const candidate = structuredClone(this.#store.state);
    candidate.schema = transitionCoreStateSchema;
    candidate.warmTransition = structuredClone(transition);
    candidate.tickets[material.credentialId] = {
      recordId: `bootstrap_ticket_${randomUUID()}`,
      credentialId: material.credentialId,
      authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
      identity: structuredClone(requested),
      runnerVersion: this.#expectedRunnerVersion,
      runnerDigest: this.#expectedRunnerDigest,
      expiresAt: new Date(expiresAtUnixMs).toISOString(),
      expiresAtUnixMs,
      usedAt: null,
      warmTransitionId: transition.receipt.transitionId,
    };
    candidate.freshBootstraps = incrementDiagnosticCount(candidate.freshBootstraps);
    await this.#store.commit(candidate);
    return ticket;
      });
  }

  async queueCommand(
    type: string,
    payload: Record<string, unknown> = {},
    commandId?: string,
    deliverImmediately = false,
  ): Promise<DurableRecoveryCoreCommand> {
    // Internal adapters can use optional object properties. Persist the exact
    // JSON sent on the wire, just as the legacy JSON writer did.
    payload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    for (;;) {
    const queued = await this.#serialize(async () => {
    this.#store.assertWritable();
    const transition = this.#store.state.warmTransition;
    if (transition && transition.phase !== "activated") {
      if (
        commandId === transition.command.commandId &&
        type === "run.attach" &&
        canonicalJson(payload) === canonicalJson(transition.command.payload)
      )
        return transition.command;
      throw new Error(
        "Warm run transition permits only its exact cached attachment replay.",
      );
    }
    if (
      type === "run.attach" &&
      payload.paperclipNextAuthority !== undefined &&
      ![...this.#connections].some(
        (connection) =>
          connection.secureChannel !== null &&
          connection.warmTransitionVersion === 1 &&
          !connection.replayOnly,
      )
    ) {
      throw new Error(
        "Warm run transition capability is required before attachment.",
      );
    }
    if (
      !commandTypes.has(type) ||
      (commandId !== undefined &&
        (commandId.length > 160 || !stableIdPattern.test(commandId)))
    ) {
      throw new Error("Durable PRP command is invalid.");
    }
    if (commandId !== undefined) {
      const existing = await this.getCommand(commandId);
      if (existing !== undefined) {
        if (
          existing.type !== type ||
          canonicalJson(existing.payload) !== canonicalJson(payload)
        ) {
          throw new Error(
            "Durable PRP command replay conflicts with persisted state.",
          );
        }
        if (deliverImmediately && existing.status === "pending") {
          for (const connection of this.#connections) {
            if (connection.secureChannel !== null)
              await this.#sendNextCommand(connection);
          }
        }
        return existing;
      }
    }
    const current = this.#store.state.indexedState;
    if (current && (current.commandEpochTransition || current.nextControllerSeq > this.#commandEpochLimit)) {
      if (!(this.#store instanceof IndexedCoreStore) || !this.#store.authority.commandEpochs || !this.#store.authority.unorderedEffectReceipts)
        throw new DurableAuthorityStoreError("storage_pressure", "command epoch rotation requires a capable indexed authority store");
      if (!current.commandEpochTransition) {
        if (!current.commandEpochsNegotiated && ![...this.#connections].some(c => c.secureChannel && c.commandEpochs && !c.replayOnly))
          throw new DurableAuthorityStoreError("storage_pressure", "command epoch rotation requires an authenticated capable runner");
        let nextEpoch: string | undefined;
        for (let attempt = 0; attempt < 32; attempt++) {
          const proposed = randomUUID();
          if (proposed !== current.controllerEpoch && !await this.#store.authority.getRecord(this.#identity.runId, "effect",
            commandEpochCloseId({ runId: this.#identity.runId, fromEpoch: proposed }))) { nextEpoch = proposed; break; }
        }
        if (!nextEpoch) throw new DurableAuthorityStoreError("storage_unavailable", "could not allocate a fresh command namespace");
        const candidate = structuredClone(this.#store.state);
        candidate.indexedState!.commandEpochTransition = {
          schema: "paperclip.prp.command-epoch.v1", runId: this.#identity.runId,
          transitionId: randomUUID(), fromEpoch: current.controllerEpoch ?? null,
          nextEpoch, finalOrdinal: current.nextControllerSeq - 1,
        };
        await this.#store.commit(candidate);
      }
      for (const connection of this.#connections) if (connection.secureChannel) await this.#sendNextCommand(connection);
      return null;
    }
    const controllerSeq = current?.nextControllerSeq ?? this.#store.state.commands.length + 1;
    if (!Number.isSafeInteger(controllerSeq + 1)) throw new Error("PRP sequence requires an exact-integer protocol epoch transition.");
    const command: DurableRecoveryCoreCommand = {
      schema: type.startsWith("session.goal.")
        ? "paperclip.prp.command.v2"
        : "paperclip.prp.command.v1",
      commandId:
        commandId ?? (current?.controllerEpoch ? `command_prp_${randomUUID()}` : `command_prp_${controllerSeq.toString().padStart(8, "0")}`),
      controllerSeq,
      ...(current?.controllerEpoch ? { controllerEpoch: current.controllerEpoch } : {}),
      type,
      issuedAt: new Date().toISOString(),
      payload,
      status: "pending",
      result: null,
    };
    if (
      (this.indexedPersistence
        ? this.#store.state.commands.filter((entry) => entry.status === "pending" || entry.status === "indeterminate").length
        : this.#store.state.commands.length) >= maxCommands ||
      Buffer.byteLength(JSON.stringify(command)) > maxCommandBytes
    ) {
      throw new Error("Durable PRP command journal bound exceeded.");
    }
    const candidate = structuredClone(this.#store.state);
    candidate.commands.push(command);
    if (candidate.indexedState) {
      candidate.indexedState.nextControllerSeq = controllerSeq + 1;
      if (["session.open", "turn.start", "run.attach"].includes(type)) candidate.indexedState.providerEverStarted = true;
    }
    await this.#store.commit(candidate);
    if (deliverImmediately) {
      for (const connection of this.#connections) {
        if (connection.secureChannel !== null) {
          await this.#sendNextCommand(connection);
        }
      }
    }
    return command;
      });
      if (queued) return queued;
      await this.#waitForCommandEpoch();
    }
  }

  #waitForCommandEpoch(): Promise<void> {
    if (!this.#store.state.indexedState?.commandEpochTransition) return Promise.resolve();
    if (this.#commandEpochWaiters.size >= 64) return Promise.reject(new DurableAuthorityStoreError("storage_pressure", "command epoch admission queue is full"));
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => { clearTimeout(timer); this.#commandEpochWaiters.delete(done); if (error) reject(error); else resolve(); };
      const timer = setTimeout(() => {
        this.#commandEpochWaiters.delete(done);
        reject(new DurableAuthorityStoreError("storage_pressure", "command epoch transition remains pending; retry admission"));
      }, 30_000);
      timer.unref();
      this.#commandEpochWaiters.add(done);
    });
  }

  async #commandEpochCommitted(connection: AuthorityConnection, envelope: Record<string, unknown>): Promise<void> {
    if (!connection.commandEpochs || !this.#liveConnectionIsCurrent(connection) || !(this.#store instanceof IndexedCoreStore)) { connection.close(); return; }
    const pending = this.#store.state.indexedState?.commandEpochTransition;
    const receipt = envelope.payload;
    if (!isCommandEpochTransition(receipt) || receipt.runId !== this.#identity.runId) { connection.close(); return; }
    if (!pending) {
      const committed = await this.#store.authority.getRecord(this.#identity.runId, "effect", `command-epoch-${receipt.transitionId}`);
      if (!committed || authorityJson(committed.body) !== authorityJson(receipt)) connection.close();
      return;
    }
    if (authorityJson(pending) !== authorityJson(receipt) || this.#store.state.commands.some(c => c.status === "pending")) { connection.close(); return; }
    const candidate = structuredClone(this.#store.state);
    candidate.indexedState!.controllerEpoch = pending.nextEpoch;
    candidate.indexedState!.lastCommandEpochTransition = structuredClone(pending);
    candidate.indexedState!.nextControllerSeq = 1;
    delete candidate.indexedState!.commandEpochTransition;
    const body = receipt as unknown as Record<string, unknown>;
    await this.#store.commit(candidate, [
      { epoch: this.#identity.runId, kind: "effect", id: `command-epoch-${pending.transitionId}`, sequence: "0", body },
      { epoch: this.#identity.runId, kind: "effect", id: commandEpochCloseId(pending), sequence: "0", body },
    ]);
    for (const done of this.#commandEpochWaiters) done();
  }

  async commandOutcome(commandId: string): Promise<{
    status: DurableRecoveryCoreCommand["status"];
    result: Record<string, unknown> | null;
  } | null> {
    const command = await this.getCommand(commandId);
    if (!command) return null;
    return {
      status: command.status,
      result:
        command.result && typeof command.result === "object"
          ? structuredClone(command.result as Record<string, unknown>)
          : null,
    };
  }

  /** Attach one HTTP upgrade to this run-bound authority. */
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    expectedPath = "/api/runner/v1/connect",
    head: Buffer<ArrayBufferLike> = Buffer.alloc(0),
  ): void {
    const requestPath = new URL(request.url ?? "/", "http://paperclip.invalid")
      .pathname;
    if (requestPath !== expectedPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const websocketKey = request.headers["sec-websocket-key"];
    const decodedWebSocketKey =
      typeof websocketKey === "string"
        ? Buffer.from(websocketKey, "base64")
        : Buffer.alloc(0);
    if (
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      request.headers["sec-websocket-version"] !== "13" ||
      typeof websocketKey !== "string" ||
      decodedWebSocketKey.length !== 16 ||
      decodedWebSocketKey.toString("base64") !== websocketKey
    ) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${websocketKey}${websocketGuid}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    const wire = new RawWebSocketWireConnection(socket);
    this.attachWireConnection(wire);
    wire.acceptInitialData(head);
  }

  /** Attach either an accepted inbound WebSocket or a Paperclip-opened peer. */
  attachWireConnection(wire: PrpWireConnection): PrpWireAttachment {
    let connection!: AuthorityConnection;
    let processing = Promise.resolve();
    let closed = false, paused = false, frames = 0, bytes = 0;
    connection = new AuthorityConnection({
      wire,
      secureFrameLimit: this.#secureChannelFrameLimit,
      onJson: (value) => {
        if (closed) return;
        let size: number;
        try { size = Buffer.byteLength(JSON.stringify(value)); }
        catch { wire.close(1007); return; }
        // Bound admission before adding a promise closure. The mutation queue
        // alone cannot bound frames waiting to enter that queue. These limits
        // concern currently buffered work; settled history returns all credit.
        if (size > 4 * 1024 * 1024 || frames >= 64 || bytes + size > 16 * 1024 * 1024 ||
          this.#queuedWireFrames >= 256 || this.#queuedWireBytes + size > 64 * 1024 * 1024) {
          closed = true; wire.close(1013); return;
        }
        frames++; bytes += size; this.#queuedWireFrames++; this.#queuedWireBytes += size;
        if (!paused && wire.pauseRead && wire.resumeRead && (frames >= 16 || bytes >= 4 * 1024 * 1024)) {
          paused = true; wire.pauseRead();
        }
        processing = processing
          .then(() => this.#handleJson(connection, value))
          .catch(() => connection.close())
          .finally(() => {
            frames--; bytes -= size; this.#queuedWireFrames--; this.#queuedWireBytes -= size;
            if (!closed && paused && frames <= 8 && bytes <= 2 * 1024 * 1024) {
              paused = false; wire.resumeRead!();
            }
          });
        const tail = processing;
        this.#connectionProcessing.set(connection, tail);
        const release = () => {
          if (this.#connectionProcessing.get(connection) === tail)
            this.#connectionProcessing.delete(connection);
        };
        void tail.then(release, release);
      },
      onClose: () => { closed = true; this.#connections.delete(connection); },
    });
    this.#connections.add(connection);
    return {
      isAuthenticated: () => connection.secureChannel !== null,
    };
  }

  async #handleJson(
    connection: AuthorityConnection,
    wire: unknown,
  ): Promise<void> {
    this.#store.assertWritable();
    if (connection.secureChannel && connection.secureChannel.receiveCounter >= connection.secureFrameLimit) {
      connection.close(1012);
      return;
    }
    let envelope: Record<string, unknown>;
    try {
      envelope =
        connection.secureChannel === null
          ? (wire as Record<string, unknown>)
          : decryptSecureJson(connection.secureChannel, wire);
    } catch {
      await this.#serialize(async () => {
        const candidate = structuredClone(this.#store.state);
        candidate.malformedFrames = incrementDiagnosticCount(candidate.malformedFrames);
        await this.#store.commit(candidate);
      });
      connection.close();
      return;
    }
    const envelopeVersion = envelope.version;
    const expectedVersion =
      connection.lease?.protocolVersion ??
      connection.pendingChallenge?.selectedVersion ??
      null;
    if (
      envelope.protocol !== protocol ||
      !Number.isInteger(envelopeVersion) ||
      (expectedVersion === null
        ? (envelopeVersion as number) < protocolMinVersion ||
          (envelopeVersion as number) > protocolVersion
        : envelopeVersion !== expectedVersion)
    ) {
      connection.close();
      return;
    }
    const kind = envelope.kind;
    if (connection.secureChannel === null && kind === "auth_hello") {
      this.#authHello(connection, envelope);
      return;
    }
    if (connection.secureChannel === null && kind === "auth_response") {
      await this.#authResponse(connection, envelope);
      return;
    }
    // Admit every post-handshake frame against persisted authority before
    // dispatch, including lease_renew. Renewal cannot revive a revoked or
    // expired credential or bypass changes to its persisted binding.
    if (
      connection.secureChannel === null ||
      connection.lease === null ||
      canonicalJson(this.#store.state.leases[connection.lease.credentialId]) !==
        canonicalJson(connection.lease) ||
      connection.lease.revokedAt !== null ||
      connection.lease.expiresAtUnixMs <= Date.now()
    ) {
      connection.close();
      return;
    }
    if (kind === "lease_renew") {
      await this.#serialize(() => this.#renewLease(connection, envelope));
      return;
    }
    if (kind === "event") {
      if (this.#store.state.warmTransition?.phase === "awaiting_result")
        connection.replayOnly = true;
      if (connection.replayOnly) {
        connection.close();
        return;
      }
      await this.#event(connection, envelope);
      return;
    }
    if (kind === "event_epoch_rotate") {
      await this.#serialize(() => this.#eventEpochRotate(connection, envelope));
      return;
    }
    if (kind === "command_epoch_committed") {
      await this.#serialize(() => this.#commandEpochCommitted(connection, envelope));
      return;
    }
    if (kind === "command_result") {
      if (
        this.#store.state.warmTransition &&
        this.#store.state.warmTransition.phase !== "activated"
      )
        connection.replayOnly = true;
      await this.#serialize(() => this.#commandResult(connection, envelope));
      return;
    }
    if (kind === "warm_transition_activated") {
      return this.#serialize(async () => {
      if (!connection.lease || !this.#liveConnectionIsCurrent(connection)) return;
      const transition = this.#store.state.warmTransition;
      const receipt = connection.activationReceipt;
      const completed = this.#store.state.completedWarmTransition;
      if (
        !receipt ||
        !connection.replayOnly ||
        (transition
          ? transition.phase !== "activated" ||
            connection.lease.credentialId !== transition.credentialId ||
            canonicalJson(transition.receipt) !== canonicalJson(receipt)
          : !completed ||
            canonicalJson(completed.receipt) !== canonicalJson(receipt)) ||
        connection.lease.leaseId !== receipt.leaseId ||
        connection.lease.expiresAtUnixMs !== receipt.leaseExpiresAtUnixMs ||
        connection.lease.revocationEpoch !== receipt.leaseRevocationEpoch ||
        (envelope.payload as Record<string, unknown> | undefined)
          ?.transitionId !== receipt.transitionId ||
        canonicalJson(connection.identity) !==
          canonicalJson(receipt.newIdentity)
      ) {
        connection.close();
        return;
      }
      if (transition) {
        const candidate = structuredClone(this.#store.state);
        candidate.schema = coreStateSchema;
        candidate.leases[transition.credentialId]!.identity = structuredClone(
          receipt.newIdentity,
        );
        candidate.completedWarmTransition = {
          receipt: structuredClone(receipt),
          command: structuredClone(transition.command),
        };
        delete candidate.warmTransition;
        await this.#store.commit(candidate);
        connection.lease = this.#store.state.leases[transition.credentialId]!;
      }
      connection.sendJson(
        this.#controlEnvelope(
          connection,
          `activation_ack_${receipt.transitionId}`,
          "warm_transition_activated_ack",
          { transitionId: receipt.transitionId },
        ),
      );
      connection.activationReceipt = null;
      connection.replayOnly = false;
      await this.#sendNextCommand(connection);
      });
    }
    if (kind !== "pong") {
      connection.close();
    }
  }

  #liveConnectionIsCurrent(connection: AuthorityConnection): boolean {
    if (!connection.secureChannel || !connection.lease || connection.lease.revokedAt !== null ||
      connection.lease.expiresAtUnixMs <= Date.now() || canonicalJson(this.#store.state.leases[connection.lease.credentialId]) !== canonicalJson(connection.lease)) {
      connection.close();
      return false;
    }
    return true;
  }

  async #renewLease(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#liveConnectionIsCurrent(connection)) return;
    const lease = connection.lease!;
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const expectedExpiry = payload?.connectionLeaseExpiresAtUnixMs;
    if (
      Object.entries(connection.identity!).some(
        ([key, value]) => envelope[key] !== value,
      ) ||
      envelope.connectionId !== connection.connectionId ||
      envelope.connectionLeaseId !== lease.leaseId ||
      payload?.connectionLeaseRevocationEpoch !== lease.revocationEpoch ||
      !Number.isSafeInteger(expectedExpiry) ||
      (expectedExpiry as number) <= 0 ||
      (expectedExpiry as number) > lease.expiresAtUnixMs
    ) {
      connection.close();
      return;
    }
    // A handoff receipt binds the exact expiry. Finish that boundary before
    // renewing; terminal commands likewise retain their existing authority.
    if (
      connection.replayOnly ||
      this.#store.state.warmTransition ||
      connection.terminalLifecycleCommandId !== null
    ) return;
    // Repeating a request after a lost reply replays the persisted expiry.
    // It never extends a credential twice for the same observed generation.
    if (expectedExpiry === lease.expiresAtUnixMs) {
      const candidate = structuredClone(this.#store.state);
      const renewed = candidate.leases[lease.credentialId]!;
      renewed.expiresAtUnixMs = Math.max(
        lease.expiresAtUnixMs,
        Date.now() + this.#connectionLeaseTtlMs,
      );
      renewed.expiresAt = new Date(renewed.expiresAtUnixMs).toISOString();
      candidate.lastLeaseExpiresAt = renewed.expiresAt;
      await this.#store.commit(candidate);
      connection.lease = this.#store.state.leases[lease.credentialId]!;
    }
    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `lease_renewed_${expectedExpiry}`,
        "lease_renewed",
        {
          previousExpiresAtUnixMs: expectedExpiry,
          connectionLeaseExpiresAtUnixMs: connection.lease!.expiresAtUnixMs,
          connectionLeaseRevocationEpoch: connection.lease!.revocationEpoch,
        },
      ),
    );
  }

  async #eventEpochRotate(connection: AuthorityConnection, envelope: Record<string, unknown>): Promise<void> {
    if (!connection.eventEpochs || !this.#liveConnectionIsCurrent(connection) || !(this.#store instanceof IndexedCoreStore)) { connection.close(); return; }
    const transition = envelope.payload;
    if (!isEventEpochTransition(transition) || transition.runId !== this.#identity.runId) { connection.close(); return; }
    const existing = await this.#store.authority.getRecord(this.#identity.runId, "effect", `event-epoch-${transition.transitionId}`);
    if (existing) {
      if (authorityJson(existing.body) !== authorityJson(transition)) { connection.close(); return; }
    } else {
      const current = this.#store.state;
      if (transition.fromEpoch !== (current.indexedState?.sourceEpoch ?? null) || transition.finalOrdinal !== current.ackedSourceSeq || current.warmTransition ||
        await this.readEventEpochTransition(transition.nextEpoch)) { connection.close(); return; }
      const candidate = structuredClone(current);
      candidate.indexedState!.sourceEpoch = transition.nextEpoch;
      candidate.indexedState!.lastEventEpochTransition = transition;
      candidate.ackedSourceSeq = 0;
      await this.#store.commit(candidate, [
        {epoch: this.#identity.runId, kind: "effect", id: `event-epoch-${transition.transitionId}`, sequence: "0", body: transition as unknown as Record<string, unknown>},
        {epoch: this.#identity.runId, kind: "effect", id: eventEpochCloseId(transition), sequence: "0", body: transition as unknown as Record<string, unknown>},
      ]);
    }
    connection.sendJson(this.#controlEnvelope(connection, `event_epoch_${transition.transitionId}`, "event_epoch_committed", transition as unknown as Record<string, unknown>));
  }

  #authorizeHello(
    payload: Record<string, unknown>,
  ): PendingAuthorization | null {
    if (this.indexedPersistence && (payload.durability !== INDEXED_DURABILITY_CAPABILITY || payload.outputBodies !== "history.output_bodies.v1")) return null;
    const current = this.#store.state.indexedState;
    if (payload.runId === this.#store.state.identity.runId && current) {
      if (current.sourceEpoch && payload.eventEpochs !== EVENT_EPOCH_CAPABILITY) return null;
      if (payload.eventEpochs === EVENT_EPOCH_CAPABILITY && this.#store instanceof IndexedCoreStore && this.#store.authority.eventEpochs) {
        const resume = payload.eventResume;
        if (!isEventResume(resume)) return null;
        if (resume.sourceEpoch === (current.sourceEpoch ?? null)) {
          if (resume.ackedSourceSeq > this.#store.state.ackedSourceSeq || resume.nextSourceEventSeq <= this.#store.state.ackedSourceSeq) return null;
        } else if (!resume.transition || authorityJson(resume.transition) !== authorityJson(current.lastEventEpochTransition ?? null) || this.#store.state.ackedSourceSeq !== 0) return null;
      }

      if ((current.commandEpochsNegotiated || current.controllerEpoch || current.commandEpochTransition) && payload.commandEpochs !== COMMAND_EPOCH_CAPABILITY) return null;
      if (payload.commandEpochs === COMMAND_EPOCH_CAPABILITY && this.#store instanceof IndexedCoreStore && this.#store.authority.commandEpochs) {
        if (!isRecord(payload.resume)) return null;
        const epoch = payload.resume.controllerEpoch ?? null, ordinal = payload.resume.lastControllerCommandSeq;
        if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0) return null;
        const transition = current.commandEpochTransition;
        if (transition && epoch === transition.nextEpoch) {
          if (ordinal !== 0) return null; // successor commands are not admitted before its receipt
        } else if (epoch !== (current.controllerEpoch ?? null) || Number(ordinal) > current.nextControllerSeq - 1 ||
          Number(ordinal) < current.nextControllerSeq - 1 - this.#store.state.commands.filter(c => c.status === "pending").length) return null;
      }
    }
    const credentialId = payload.credentialId;
    if (typeof credentialId !== "string") return null;
    const ticket = this.#store.state.tickets[credentialId];
    const lease = this.#store.state.leases[credentialId];
    const authorization: PendingAuthorization | null =
      ticket !== undefined &&
      typeof ticket.recordId === "string" &&
      ticket.credentialId === credentialId &&
      ticket.usedAt === null &&
      ticket.expiresAtUnixMs > Date.now()
        ? {
            kind: "bootstrap",
            recordId: ticket.recordId,
            credentialId: ticket.credentialId,
            authKey: authKeyFromDigest(ticket.authKeyDigest),
            identity: structuredClone(ticket.identity),
            runnerVersion: ticket.runnerVersion,
            runnerDigest: ticket.runnerDigest,
            expiresAt: ticket.expiresAt,
            expiresAtUnixMs: ticket.expiresAtUnixMs,
            recordSnapshot: canonicalJson(ticket),
          }
        : lease !== undefined &&
            typeof lease.recordId === "string" &&
            lease.credentialId === credentialId &&
            lease.revokedAt === null &&
            lease.expiresAtUnixMs > Date.now()
          ? {
              kind: "lease",
              recordId: lease.recordId,
              credentialId: lease.credentialId,
              authKey: authKeyFromDigest(lease.authKeyDigest),
              identity: structuredClone(lease.identity),
              protocolVersion: lease.protocolVersion,
              expiresAt: lease.expiresAt,
              expiresAtUnixMs: lease.expiresAtUnixMs,
              leaseId: lease.leaseId,
              revocationEpoch: lease.revocationEpoch,
              recordSnapshot: canonicalJson(lease),
            }
          : null;
    if (authorization === null) return null;
    const transition = this.#store.state.warmTransition;
    if (transition) {
      const receipt = transition.receipt;
      const requested = Object.fromEntries(
        Object.keys(receipt.oldIdentity).map((key) => [key, payload[key]]),
      );
      const isOld =
        canonicalJson(requested) === canonicalJson(receipt.oldIdentity);
      const isNew =
        canonicalJson(requested) === canonicalJson(receipt.newIdentity);
      const participant =
        authorization.kind === "lease"
          ? authorization.credentialId === transition.credentialId &&
            authorization.leaseId === receipt.leaseId &&
            authorization.expiresAtUnixMs === receipt.leaseExpiresAtUnixMs &&
            authorization.revocationEpoch === receipt.leaseRevocationEpoch
          : ticket?.warmTransitionId === receipt.transitionId &&
            payload.warmTransitionId === receipt.transitionId &&
            canonicalJson(authorization.identity) ===
              canonicalJson(requested) &&
            authorization.expiresAtUnixMs <= receipt.leaseExpiresAtUnixMs &&
            this.#store.state.leases[transition.credentialId]?.revokedAt ===
              null &&
            this.#store.state.leases[transition.credentialId]
              ?.expiresAtUnixMs === receipt.leaseExpiresAtUnixMs;
      if (
        !participant ||
        payload.warmTransitionVersion !== 1 ||
        (!isOld && !isNew) ||
        (isOld && transition.phase === "activated") ||
        (isNew && transition.phase === "awaiting_result") ||
        (isNew && payload.warmTransitionId !== receipt.transitionId) ||
        (isOld &&
          payload.warmTransitionId !== undefined &&
          payload.warmTransitionId !== receipt.transitionId)
      )
        return null;
      authorization.identity = requested as unknown as DurableRecoveryIdentity;
    } else if (payload.warmTransitionId !== undefined) {
      const completed = this.#store.state.completedWarmTransition;
      if (completed) {
        const receipt = completed.receipt;
        if (
          payload.warmTransitionVersion !== 1 ||
          payload.warmTransitionId !== receipt.transitionId ||
          authorization.kind !== "lease" ||
          authorization.leaseId !== receipt.leaseId ||
          authorization.expiresAtUnixMs !== receipt.leaseExpiresAtUnixMs ||
          authorization.revocationEpoch !== receipt.leaseRevocationEpoch ||
          canonicalJson(authorization.identity) !==
            canonicalJson(receipt.newIdentity)
        )
          return null;
      } else if (
        !this.#store.state.commands.some(
          (command) =>
            command.status === "pending" &&
            command.type === "run.attach" &&
            command.payload.paperclipNextAuthority !== undefined,
        )
      )
        return null;
    }
    const identity = authorization.identity;
    if (
      payload.runnerInstanceId !== identity.runnerInstanceId ||
      payload.environmentLeaseId !== identity.environmentLeaseId ||
      payload.runId !== identity.runId ||
      payload.normalizedSessionId !== identity.normalizedSessionId ||
      payload.turnId !== identity.turnId ||
      payload.itemId !== identity.itemId ||
      payload.runnerVersion !== this.#expectedRunnerVersion ||
      payload.runnerDigest !== this.#expectedRunnerDigest ||
      !Number.isInteger(payload.protocolMin) ||
      !Number.isInteger(payload.protocolMax) ||
      (payload.protocolMin as number) > protocolVersion ||
      (payload.protocolMax as number) < protocolMinVersion ||
      (payload.protocolMin as number) > (payload.protocolMax as number) ||
      (authorization.kind === "bootstrap" &&
        (authorization.runnerVersion !== this.#expectedRunnerVersion ||
          authorization.runnerDigest !== this.#expectedRunnerDigest)) ||
      (authorization.kind === "lease" &&
        (authorization.protocolVersion < (payload.protocolMin as number) ||
          authorization.protocolVersion > (payload.protocolMax as number)))
    ) {
      return null;
    }
    return authorization;
  }

  #pruneCredentials(candidate: StoredCoreState): void {
    const now = Date.now();
    for (const [credentialId, ticket] of Object.entries(
      candidate.tickets,
    )) {
      if (ticket.usedAt !== null || ticket.expiresAtUnixMs <= now) {
        delete candidate.tickets[credentialId];
      }
    }
    for (const [credentialId, lease] of Object.entries(
      candidate.leases,
    )) {
      if (
        credentialId !== candidate.warmTransition?.credentialId &&
        (lease.revokedAt !== null || lease.expiresAtUnixMs <= now)
      ) {
        delete candidate.leases[credentialId];
      }
    }
  }

  #reauthorizePendingChallenge(
    pending: PendingChallenge,
    now: number,
  ): LiveAuthorization | null {
    if (pending.deadlineUnixMs <= now) return null;
    const expected = pending.authorization;
    if (expected.kind === "bootstrap") {
      const ticket = this.#store.state.tickets[expected.credentialId];
      if (
        ticket === undefined ||
        ticket.recordId !== expected.recordId ||
        ticket.credentialId !== expected.credentialId ||
        ticket.usedAt !== null ||
        ticket.expiresAtUnixMs <= now ||
        canonicalJson(ticket) !== expected.recordSnapshot
      ) {
        return null;
      }
      return {
        kind: "bootstrap",
        authKey: authKeyFromDigest(ticket.authKeyDigest),
        ticket,
      };
    }

    const lease = this.#store.state.leases[expected.credentialId];
    if (
      lease === undefined ||
      lease.recordId !== expected.recordId ||
      lease.credentialId !== expected.credentialId ||
      lease.revokedAt !== null ||
      lease.expiresAtUnixMs <= now ||
      canonicalJson(lease) !== expected.recordSnapshot
    ) {
      return null;
    }
    return {
      kind: "lease",
      authKey: authKeyFromDigest(lease.authKeyDigest),
      lease,
    };
  }

  #authHello(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): void {
    if (connection.pendingChallenge !== null) {
      connection.close();
      return;
    }
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (payload === undefined || typeof payload.clientNonce !== "string") {
      connection.close();
      return;
    }
    const authorization = this.#authorizeHello(payload);
    if (authorization === null) {
      connection.close();
      return;
    }
    const serverNonce = randomUUID();
    const selectedVersion =
      authorization.kind === "lease"
        ? authorization.protocolVersion
        : Math.min(protocolVersion, payload.protocolMax as number);
    const challengePayload: Record<string, unknown> = {
      ...(this.indexedPersistence ? { durability: INDEXED_DURABILITY_CAPABILITY, outputBodies: "history.output_bodies.v1" } : {}),
      ...(this.#store instanceof IndexedCoreStore && this.#store.authority.commandEpochs && payload.commandEpochs === COMMAND_EPOCH_CAPABILITY ? {
        commandEpochs: COMMAND_EPOCH_CAPABILITY,
        commandResume: { controllerEpoch: (payload.resume as { controllerEpoch?: string })?.controllerEpoch ?? null,
          lastControllerCommandSeq: Number((payload.resume as { lastControllerCommandSeq?: number })?.lastControllerCommandSeq) },
      } : {}),
      ...(selectedVersion >= 2 && this.#store instanceof IndexedCoreStore && this.#store.authority.eventEpochs && payload.eventEpochs === EVENT_EPOCH_CAPABILITY && isEventResume(payload.eventResume) ? {
        eventEpochs: EVENT_EPOCH_CAPABILITY, eventResume: structuredClone(payload.eventResume), eventEpochLimit: this.#eventEpochLimit,
      } : {}),
      credentialId: authorization.credentialId,
      credentialKind: authorization.kind,
      clientNonce: payload.clientNonce,
      serverNonce,
      runnerInstanceId: payload.runnerInstanceId,
      environmentLeaseId: payload.environmentLeaseId,
      runId: payload.runId,
      normalizedSessionId: payload.normalizedSessionId,
      turnId: payload.turnId,
      itemId: payload.itemId,
      runnerVersion: payload.runnerVersion,
      runnerDigest: payload.runnerDigest,
      selectedVersion,
      credentialLeaseId:
        authorization.kind === "lease" ? authorization.leaseId : null,
      credentialExpiresAt: authorization.expiresAt,
      credentialExpiresAtUnixMs: authorization.expiresAtUnixMs,
      revocationEpoch:
        authorization.kind === "lease" ? authorization.revocationEpoch : 0,
      ...(payload.warmTransitionVersion === 1
        ? { warmTransitionVersion: 1 }
        : {}),
      ...(typeof payload.warmTransitionId === "string"
        ? { warmTransitionId: payload.warmTransitionId }
        : {}),
    };
    const canonicalChallenge = canonicalJson(challengePayload);
    const serverProof = domainHmac(
      authorization.authKey,
      "paperclip-runner-server-proof-v1",
      [Buffer.from(canonicalChallenge)],
    ).toString("hex");
    connection.pendingChallenge = {
      ...(this.indexedPersistence ? { durability: INDEXED_DURABILITY_CAPABILITY, outputBodies: "history.output_bodies.v1" } : {}),
      ...(this.#store instanceof IndexedCoreStore && this.#store.authority.commandEpochs && payload.commandEpochs === COMMAND_EPOCH_CAPABILITY ? {
        commandEpochs: COMMAND_EPOCH_CAPABILITY,
        commandResume: { controllerEpoch: (payload.resume as { controllerEpoch?: string })?.controllerEpoch ?? null,
          lastControllerCommandSeq: Number((payload.resume as { lastControllerCommandSeq?: number })?.lastControllerCommandSeq) },
      } : {}),
      ...(selectedVersion >= 2 && this.#store instanceof IndexedCoreStore && this.#store.authority.eventEpochs && payload.eventEpochs === EVENT_EPOCH_CAPABILITY && isEventResume(payload.eventResume) ? {
        eventEpochs: EVENT_EPOCH_CAPABILITY, eventResume: structuredClone(payload.eventResume), eventEpochLimit: this.#eventEpochLimit,
      } : {}),
      authorization,
      deadlineUnixMs: Math.min(
        authorization.expiresAtUnixMs,
        Date.now() + authChallengeTtlMs,
      ),
      canonicalChallenge,
      serverProof,
      clientNonce: payload.clientNonce,
      serverNonce,
      selectedVersion,
      ...(payload.warmTransitionVersion === 1
        ? { warmTransitionVersion: 1 as const }
        : {}),
      ...(typeof payload.warmTransitionId === "string"
        ? { warmTransitionId: payload.warmTransitionId }
        : {}),
      requestedIdentity: structuredClone(authorization.identity),
    };
    connection.sendJson({
      protocol,
      version: selectedVersion,
      kind: "auth_challenge",
      payload: { ...challengePayload, serverProof },
    });
  }

  async #authResponse(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): Promise<void> {
    const pending = connection.pendingChallenge;
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (
      pending === null ||
      payload === undefined ||
      payload.credentialId !== pending.authorization.credentialId ||
      payload.clientNonce !== pending.clientNonce ||
      payload.serverNonce !== pending.serverNonce
    ) {
      connection.close();
      return;
    }
    let authorization = this.#reauthorizePendingChallenge(pending, Date.now());
    if (authorization === null) {
      connection.close();
      return;
    }
    const expectedClientProof = domainHmac(
      authorization.authKey,
      "paperclip-runner-client-proof-v1",
      [
        Buffer.from(pending.canonicalChallenge),
        Buffer.from(pending.serverProof),
      ],
    );
    if (!proofMatches(expectedClientProof, payload.clientProof)) {
      connection.close();
      return;
    }
    if (this.#beforeAuthenticatedConnection) {
      await this.#beforeAuthenticatedConnection({
        identity: structuredClone(
          pending.requestedIdentity ?? pending.authorization.identity,
        ),
        warmTransitionId: pending.warmTransitionId ?? null,
      });
      // The admission callback may await durable ownership. Recheck the exact
      // challenge, credential snapshot, expiry, and live connection afterward;
      // credential consumption through welcome remains one synchronous boundary.
      if (this.#protocolIntegrityError !== null) {
        connection.close();
        return;
      }
      if (
        !this.#connections.has(connection) ||
        connection.pendingChallenge !== pending
      )
        return;
      authorization = this.#reauthorizePendingChallenge(pending, Date.now());
      if (authorization === null) {
        connection.close();
        return;
      }
    }
    return this.#serialize(async () => {
    authorization = this.#reauthorizePendingChallenge(pending, Date.now());
    if (!authorization || !this.#connections.has(connection) || connection.pendingChallenge !== pending) {
      connection.close();
      return;
    }
    const clientProof = expectedClientProof.toString("hex");
    // A held proof may span preparation or activation on another connection.
    // Reapply today's transition lane policy, not merely the old credential
    // snapshot, before it can consume a ticket or evict a participating peer.
    if (
      this.#authorizeHello({
        credentialId: pending.authorization.credentialId,
        ...(pending.durability ? { durability: pending.durability } : {}),
        ...(pending.outputBodies ? { outputBodies: pending.outputBodies } : {}),
        ...(pending.commandEpochs ? { commandEpochs: pending.commandEpochs, resume: pending.commandResume } : {}),
        ...(pending.eventEpochs ? { eventEpochs: pending.eventEpochs, eventResume: pending.eventResume } : {}),
        ...pending.requestedIdentity,
        runnerVersion: this.#expectedRunnerVersion,
        runnerDigest: this.#expectedRunnerDigest,
        protocolMin: pending.selectedVersion,
        protocolMax: pending.selectedVersion,
        ...(pending.warmTransitionVersion === 1
          ? { warmTransitionVersion: 1 }
          : {}),
        ...(pending.warmTransitionId === undefined
          ? {}
          : { warmTransitionId: pending.warmTransitionId }),
      }) === null
    ) {
      connection.close();
      return;
    }
    let leaseToken: string | null = null;
    let lease: ConnectionLeaseRecord;
    if (authorization.kind === "bootstrap") {
      const recovering = this.#store.state.warmTransition;
      const original =
        recovering && this.#store.state.leases[recovering.credentialId];
      if (
        recovering &&
        (authorization.ticket.warmTransitionId !==
          recovering.receipt.transitionId ||
          !original ||
          original.revokedAt !== null ||
          original.expiresAtUnixMs <= Date.now() ||
          original.revocationEpoch !== recovering.receipt.leaseRevocationEpoch)
      ) {
        connection.close();
        return;
      }
      leaseToken = `lease_${randomUUID()}`;
      const material = credentialMaterial(leaseToken);
      const expiresAtUnixMs =
        original?.expiresAtUnixMs ?? Date.now() + this.#connectionLeaseTtlMs;
      lease = {
        recordId: `connection_lease_record_${randomUUID()}`,
        credentialId: material.credentialId,
        authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
        leaseId: original?.leaseId ?? `connection_lease_${randomUUID()}`,
        identity: structuredClone(original?.identity ?? this.#identity),
        protocolVersion: pending.selectedVersion,
        expiresAt: new Date(expiresAtUnixMs).toISOString(),
        expiresAtUnixMs,
        revocationEpoch: original?.revocationEpoch ?? 0,
        revokedAt: null,
      };
      const candidate = structuredClone(this.#store.state);
      candidate.tickets[authorization.ticket.credentialId]!.usedAt =
        new Date().toISOString();
      candidate.leases[material.credentialId] = lease;
      if (recovering) {
        candidate.leases[recovering.credentialId]!.revokedAt =
          new Date().toISOString();
        candidate.warmTransition!.credentialId = material.credentialId;
      }
      await this.#store.commit(candidate);
    } else {
      lease = authorization.lease;
    }
    const transition = this.#store.state.warmTransition;
    const requestedIdentity = pending.requestedIdentity ?? lease.identity;
    if (
      transition &&
      canonicalJson(requestedIdentity) ===
        canonicalJson(transition.receipt.newIdentity)
    ) {
      if (
        pending.warmTransitionId !== transition.receipt.transitionId ||
        pending.warmTransitionVersion !== 1 ||
        lease.credentialId !== transition.credentialId
      ) {
        connection.close();
        return;
      }
      if (transition.phase === "prepared") {
        const candidate = initialCoreState(transition.receipt.newIdentity);
        candidate.schema = transitionCoreStateSchema;
        candidate.warmTransition = {
          ...structuredClone(transition),
          phase: "activated",
        };
        candidate.leases = { [lease.credentialId]: structuredClone(lease) };
        candidate.runAttachTemplate = this.#store.state.runAttachTemplate;
        await this.#store.commit(candidate);
        this.#identity = structuredClone(candidate.identity);
        lease = this.#store.state.leases[lease.credentialId]!;
      }
    }
    connection.pendingChallenge = null;
    connection.lease = lease;
    connection.identity = structuredClone(requestedIdentity);
    connection.warmTransitionVersion = pending.warmTransitionVersion ?? null;
    connection.commandEpochs = pending.commandEpochs === COMMAND_EPOCH_CAPABILITY;
    connection.eventEpochs = pending.eventEpochs === EVENT_EPOCH_CAPABILITY;
    connection.eventResume = pending.eventResume ?? null;
    connection.eventEpochLimit = pending.eventEpochLimit ?? EVENT_EPOCH_LIMIT;
    connection.activationReceipt =
      this.#store.state.warmTransition?.phase === "activated"
        ? structuredClone(this.#store.state.warmTransition.receipt)
        : pending.warmTransitionId !== undefined &&
            pending.warmTransitionId ===
              this.#store.state.completedWarmTransition?.receipt.transitionId
          ? structuredClone(this.#store.state.completedWarmTransition!.receipt)
          : null;
    connection.replayOnly =
      this.#store.state.warmTransition !== undefined &&
      this.#store.state.warmTransition.phase !== "activated";
    if (connection.activationReceipt) connection.replayOnly = true;
    connection.connectionId = `connection_${randomUUID()}`;
    connection.secureChannel = createSecureChannel(
      authorization.authKey,
      pending.canonicalChallenge,
      pending.serverProof,
      clientProof,
    );
    for (const active of this.#connections) {
      if (active !== connection && active.secureChannel !== null)
        active.close();
    }
    await this.#welcome(connection, leaseToken);
    });
  }

  async #welcome(connection: AuthorityConnection, leaseToken: string | null): Promise<void> {
    const lease = connection.lease;
    if (lease === null || connection.connectionId === null) {
      connection.close();
      return;
    }

    const candidate = structuredClone(this.#store.state);
    if (connection.commandEpochs && candidate.indexedState) candidate.indexedState.commandEpochsNegotiated = true;
    candidate.connectionCount = incrementDiagnosticCount(candidate.connectionCount);
    candidate.lastLeaseId = lease.leaseId;
    candidate.lastLeaseExpiresAt = lease.expiresAt;

    const pending = connection.replayOnly ? [] : this.#nextPendingCommand();
    const [pendingCommand] = pending;
    connection.terminalLifecycleCommandId =
      pendingCommand && this.#isTerminalLifecycleCommand(pendingCommand)
        ? pendingCommand.commandId
        : null;
    for (const command of pending) {
      candidate.commandDeliveryCounts[command.commandId] =
        incrementDiagnosticCount(candidate.commandDeliveryCounts[command.commandId] ?? 0);
    }
    await this.#store.commit(candidate);
    connection.sendJson({
      protocol,
      version: lease.protocolVersion,
      envelopeId: `welcome_${randomUUID()}`,
      kind: "welcome",
      runnerInstanceId: this.#identity.runnerInstanceId,
      environmentLeaseId: this.#identity.environmentLeaseId,
      runId: this.#identity.runId,
      normalizedSessionId: this.#identity.normalizedSessionId,
      turnId: this.#identity.turnId,
      itemId: this.#identity.itemId,
      connectionId: connection.connectionId,
      connectionLeaseId: lease.leaseId,
      sentAt: new Date().toISOString(),
      payload: {
        selectedVersion: lease.protocolVersion,
        heartbeatIntervalMs: 250,
        connectionLeaseRenewalVersion: 1,
        ...(connection.commandEpochs ? { commandEpochs: COMMAND_EPOCH_CAPABILITY } : {}),
        ...(connection.eventEpochs ? { eventEpochs: EVENT_EPOCH_CAPABILITY, eventEpochLimit: connection.eventEpochLimit, sourceEpoch: connection.eventResume!.sourceEpoch } : {}),
        connectionLeaseId: lease.leaseId,
        ...(leaseToken === null ? {} : { connectionLeaseToken: leaseToken }),
        connectionLeaseExpiresAt: lease.expiresAt,
        connectionLeaseExpiresAtUnixMs: lease.expiresAtUnixMs,
        connectionLeaseRevocationEpoch: lease.revocationEpoch,
        leaseBinding: {
          runnerInstanceId: this.#identity.runnerInstanceId,
          environmentLeaseId: this.#identity.environmentLeaseId,
          runId: this.#identity.runId,
          normalizedSessionId: this.#identity.normalizedSessionId,
          protocolVersion: lease.protocolVersion,
        },
        maxFrameBytes,
        maxBatchEvents: 100,
        ackedSourceSeq: connection.eventResume && connection.eventResume.sourceEpoch !== (this.#store.state.indexedState?.sourceEpoch ?? null) ? this.#store.state.indexedState!.lastEventEpochTransition!.finalOrdinal : this.#store.state.ackedSourceSeq,
        pendingCommands: pending.map(this.#wireCommand),
        ...(connection.warmTransitionVersion === 1
          ? { warmTransitionVersion: 1 }
          : {}),
        ...(connection.activationReceipt
          ? {
              warmTransition: connection.activationReceipt,
              warmTransitionPhase: "activated",
            }
          : this.#store.state.warmTransition
            ? {
                warmTransition: this.#store.state.warmTransition.receipt,
                warmTransitionPhase: this.#store.state.warmTransition.phase,
              }
            : {}),
      },
    });
    if (this.#store.state.indexedState?.commandEpochTransition && pending.length === 0) await this.#sendNextCommand(connection);
  }

  #wireCommand(
    command: DurableRecoveryCoreCommand,
  ): Omit<DurableRecoveryCoreCommand, "status" | "result"> {
    const { status: _status, result: _result, ...wire } = command;
    return wire;
  }

  #nextPendingCommand(): DurableRecoveryCoreCommand[] {
    if (this.#store.state.warmTransition) return [];
    const command = this.#store.state.commands.find(
      (candidate) => candidate.status === "pending",
    );
    return command === undefined ? [] : [command];
  }

  #controlEnvelope(
    connection: AuthorityConnection,
    envelopeId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (connection.lease === null || connection.connectionId === null) {
      throw new Error(
        "Cannot send control data before transport authentication.",
      );
    }
    return {
      protocol,
      version: connection.lease.protocolVersion,
      envelopeId,
      kind,
      runnerInstanceId: this.#identity.runnerInstanceId,
      environmentLeaseId: this.#identity.environmentLeaseId,
      runId: this.#identity.runId,
      normalizedSessionId: this.#identity.normalizedSessionId,
      turnId: this.#identity.turnId,
      itemId: this.#identity.itemId,
      connectionId: connection.connectionId,
      connectionLeaseId: connection.lease.leaseId,
      sentAt: new Date().toISOString(),
      payload,
    };
  }

  async #sendNextCommand(connection: AuthorityConnection): Promise<void> {
    if (
      connection.terminalLifecycleCommandId !== null ||
      connection.replayOnly ||
      this.#store.state.warmTransition
    )
      return;
    const [command] = this.#nextPendingCommand();
    if (command === undefined) {
      const transition = this.#store.state.indexedState?.commandEpochTransition;
      if (transition && connection.commandEpochs) connection.sendJson(this.#controlEnvelope(connection,
        `command_epoch_${transition.transitionId}`, "command_epoch_rotate", transition as unknown as Record<string, unknown>));
      return;
    }
    if (this.#isTerminalLifecycleCommand(command)) {
      connection.terminalLifecycleCommandId = command.commandId;
    }
    const candidate = structuredClone(this.#store.state);
    candidate.commandDeliveryCounts[command.commandId] =
      incrementDiagnosticCount(candidate.commandDeliveryCounts[command.commandId] ?? 0);
    await this.#store.commit(candidate);
    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `command_${randomUUID()}`,
        "command",
        this.#wireCommand(command),
      ),
    );
  }

  async #commandResult(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#liveConnectionIsCurrent(connection)) return;
    const result = envelope.payload as Record<string, unknown> | undefined;
    const commandId = result?.commandId;
    if (result === undefined || typeof commandId !== "string") {
      connection.close();
      return;
    }
    const transition = this.#store.state.warmTransition;
    if (connection.replayOnly) {
      if (
        !transition ||
        transition.phase === "activated" ||
        connection.lease?.credentialId !== transition.credentialId ||
        commandId !== transition.command.commandId ||
        canonicalJson(result) !==
          canonicalJson(transition.expectedResult ?? transition.command.result)
      ) {
        connection.close();
        return;
      }
      if (transition.phase === "awaiting_result") {
        const candidate = structuredClone(this.#store.state);
        const completed = candidate.commands.find(
          (entry) => entry.commandId === commandId,
        )!;
        completed.status = "completed";
        completed.result = structuredClone(result);
        candidate.warmTransition = {
          receipt: structuredClone(transition.receipt),
          phase: "prepared",
          credentialId: transition.credentialId,
          command: structuredClone(completed),
        };
        await this.#store.commit(candidate);
      }
      this.#ackWarmTransition(connection, transition.receipt);
      return;
    }
    const command = await this.getCommand(commandId);
    if (command === undefined) {
      connection.close();
      return;
    }
    if (this.#isTerminalLifecycleCommand(command)) {
      connection.terminalLifecycleCommandId = command.commandId;
    }
    const status = result.status;
    // `indeterminate` is terminal too: a runner that crashed between journaling
    // a command and confirming its effect reports it on recovery and will not
    // execute it again. Rejecting it closes the connection, and since the
    // runner replays the same result on every reconnect, the session never
    // recovers.
    if (
      status !== "completed" &&
      status !== "failed" &&
      status !== "rejected" &&
      status !== "indeterminate"
    ) {
      connection.close();
      return;
    }
    if (command.status !== "pending") {
      if (canonicalJson(command.result) !== canonicalJson(result)) {
        connection.close();
        return;
      }
      const candidate = structuredClone(this.#store.state);
      candidate.duplicateCommandResults = incrementDiagnosticCount(candidate.duplicateCommandResults);
      await this.#store.commit(candidate);
      this.#ackTerminalCommandResult(connection, command);
      if (!this.#isTerminalLifecycleCommand(command)) {
        await this.#sendNextCommand(connection);
      }
      return;
    }
    if (
      command.type === "run.attach" &&
      command.payload.paperclipNextAuthority !== undefined &&
      status === "completed"
    ) {
      if (connection.warmTransitionVersion !== 1 || connection.lease === null) {
        connection.close();
        return;
      }
      const receipt = warmTransitionReceipt(
        this.#identity,
        command,
        result,
        this.#store.state.ackedSourceSeq,
        connection.lease,
        this.#expectedRunnerVersion,
        this.#expectedRunnerDigest,
        this.#store.state.indexedState?.sourceEpoch,
      );
      const candidate = structuredClone(this.#store.state);
      const completed = candidate.commands.find(
        (entry) => entry.commandId === commandId,
      )!;
      completed.status = "completed";
      completed.result = structuredClone(result);
      candidate.schema = transitionCoreStateSchema;
      candidate.warmTransition = {
        receipt,
        phase: "prepared",
        credentialId: connection.lease.credentialId,
        command: structuredClone(completed),
      };
      await this.#store.commit(candidate);
      connection.replayOnly = true;
      this.#ackWarmTransition(connection, receipt);
      return;
    }
    const candidate = structuredClone(this.#store.state);
    const settled = candidate.commands.find((entry) => entry.commandId === commandId)!;
    settled.status = status;
    settled.result = structuredClone(result);
    await this.#store.commit(candidate);
    this.#ackTerminalCommandResult(connection, settled);
    if (!this.#isTerminalLifecycleCommand(command)) {
      await this.#sendNextCommand(connection);
    }
  }

  #ackWarmTransition(
    connection: AuthorityConnection,
    receipt: DurableWarmRunTransition,
  ): void {
    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `command_result_ack_${receipt.controllerSeq}`,
        "command_result_ack",
        {
          commandId: receipt.commandId,
          commandType: "run.attach",
          controllerSeq: receipt.controllerSeq,
          status: "completed",
          warmTransition: receipt,
        },
      ),
    );
  }

  #isTerminalLifecycleCommand(command: DurableRecoveryCoreCommand): boolean {
    return (
      (command.type === "runner.suspend" || command.type === "runner.shutdown") &&
      command.controllerEpoch === this.#store.state.indexedState?.controllerEpoch
    );
  }

  #ackTerminalCommandResult(
    connection: AuthorityConnection,
    command: DurableRecoveryCoreCommand,
  ): void {
    if (!this.#isTerminalLifecycleCommand(command)) {
      return;
    }
    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `command_result_ack_${command.controllerSeq}`,
        "command_result_ack",
        {
          commandId: command.commandId,
          commandType: command.type,
          controllerSeq: command.controllerSeq,
          status: command.status,
        },
      ),
    );
  }

  #failProtocolIntegrity(
    connection: AuthorityConnection,
    error: NativeSessionProtocolIntegrityError,
  ): void {
    try {
      if (this.#protocolIntegrityError === null) {
        this.#protocolIntegrityError = error;
        this.#onProtocolIntegrityError?.(error);
      }
    } finally {
      connection.close();
    }
  }

  async #event(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): Promise<void> {
    if (this.#protocolIntegrityError !== null) {
      connection.close();
      return;
    }
    // Authentication binds the channel, but an authenticated sender can still
    // submit an envelope for another run. Such frames must not poison this
    // owner's session or turn an unrelated digest failure into its terminal fault.
    if (
      envelope.runnerInstanceId !== this.#identity.runnerInstanceId ||
      envelope.environmentLeaseId !== this.#identity.environmentLeaseId ||
      envelope.runId !== this.#identity.runId ||
      envelope.normalizedSessionId !== this.#identity.normalizedSessionId ||
      envelope.turnId !== this.#identity.turnId ||
      envelope.itemId !== this.#identity.itemId
    ) {
      connection.close();
      return;
    }
    const validated = validatePrpEvent(envelope.payload);
    if (!validated.ok) {
      connection.close();
      return;
    }
    const event = validated.event;
    const sourceSeq = event?.sourceSeq;
    const sourceEpoch = event?.sourceEpoch;
    const sourceEventId = event?.sourceEventId;
    const eventType = event?.eventType;
    const priority = event?.priority;
    if (
      (sourceEpoch !== undefined && !connection.eventEpochs) ||
      typeof sourceSeq !== "number" ||
      typeof sourceEventId !== "string" ||
      typeof eventType !== "string" ||
      (priority !== 0 && priority !== 1 && priority !== 2) ||
      event?.sourceInstanceId !== this.#identity.runnerInstanceId ||
      event.runId !== this.#identity.runId ||
      event.normalizedSessionId !== this.#identity.normalizedSessionId ||
      event.turnId !== this.#identity.turnId ||
      event.itemId !== this.#identity.itemId
    ) {
      connection.close();
      return;
    }
    const semantic = (event.payload as Record<string, unknown> | undefined)
      ?.semantic_tool as Record<string, unknown> | undefined;
    const semanticCorrelation = semantic?.correlation as
      Record<string, unknown> | undefined;
    const isSemanticInput =
      eventType === "semantic_tool.input" || eventType === "mcp_app.tool_input";
    if (
      isSemanticInput &&
      (this.#onSemanticToolInput === undefined ||
        semantic?.phase !== "input" ||
        typeof semantic.callId !== "string" ||
        typeof semantic.operationId !== "string" ||
        !Object.prototype.hasOwnProperty.call(semantic, "input") ||
        typeof semantic.content !== "object" ||
        semantic.content === null ||
        semanticCorrelation?.runId !== this.#identity.runId ||
        semanticCorrelation.normalizedSessionId !==
          this.#identity.normalizedSessionId ||
        semanticCorrelation.turnId !== this.#identity.turnId ||
        semanticCorrelation.itemId !== this.#identity.itemId)
    ) {
      connection.close();
      return;
    }
    let existing = this.#store.state.committedEvents.find(
      (candidate) => candidate.sourceEventId === sourceEventId,
    ) ?? (this.#store instanceof IndexedCoreStore
      ? (await this.#store.authority.getRecord(this.#identity.runId, "event", sourceEventId))?.body as unknown as DurableRecoveryCommittedEvent | undefined
      : undefined);
    if (
      existing === undefined
        ? sourceEpoch !== this.#store.state.indexedState?.sourceEpoch || sourceSeq !== this.#store.state.ackedSourceSeq + 1
        : sourceEpoch !== existing.sourceEpoch || sourceSeq !== existing.sourceSeq
    ) {
      connection.close();
      return;
    }
    if (
      isSemanticInput &&
      semantic !== undefined &&
      (semantic.content as Record<string, unknown>).digest !==
        digestPaperclipSemanticContent(semantic.input)
    ) {
      // Only the authenticated, schema-valid, exactly correlated input may
      // permanently fail its owner. Never commit, dispatch, or ACK these bytes.
      // Keep the same error latched across reconnects; lifecycle command results
      // remain available so the owner can still attempt a verified suspension.
      this.#failProtocolIntegrity(
        connection,
        new NativeSessionProtocolIntegrityError(
          "semantic_input_digest_mismatch",
        ),
      );
      return;
    }
    if (existing !== undefined) {
      if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
        this.#failProtocolIntegrity(
          connection,
          new NativeSessionProtocolIntegrityError(
            "source_event_replay_conflict",
          ),
        );
        return;
      }
    }

    // Keep every unpaired semantic input as a durable close/restart fence.
    // Decide capacity before the business callback: exhaustion cannot commit
    // a new external effect whose local evidence would then be discarded.
    const eventToEvict =
      existing === undefined &&
      !this.indexedPersistence &&
      this.#store.state.committedEvents.length >= maxCommittedEventWindow
        ? this.#store.state.committedEvents.findIndex(
            (candidate) =>
              !unsettledSemanticInput(candidate, this.#store.state),
          )
        : null;
    if (eventToEvict === -1) {
      connection.close();
      return;
    }
    // The caller's durable commit is the acknowledgement authority. A crash
    // after that idempotent commit but before the local cursor save is safe:
    // the runner replays the event, the caller observes a duplicate, and only
    // then do we advance the cumulative cursor. Reversing this order can make
    // an uncommitted event disappear from the runner outbox permanently.
    try {
      if (!this.indexedPersistence) await this.#onCommittedEvent?.(event);
    } catch (error) {
      if (error instanceof NativeSessionProtocolIntegrityError) {
        this.#failProtocolIntegrity(connection, error);
      } else {
        connection.close();
      }
      return;
    }
    const committed = await this.#serialize(async () => {
    // Another authenticated connection can replace this one while its commit
    // is in flight. Once that exact owner has faulted, even a prior successful
    // commit cannot reopen delivery or invoke a new business operation.
    if (this.#protocolIntegrityError !== null) {
      connection.close();
      return false;
    }

    const candidate = structuredClone(this.#store.state);
    existing = candidate.committedEvents.find((candidate) => candidate.sourceEventId === sourceEventId) ??
      (this.#store instanceof IndexedCoreStore ? (await this.#store.authority.getRecord(this.#identity.runId, "event", sourceEventId))?.body as unknown as DurableRecoveryCommittedEvent | undefined : undefined);
    if ((existing ? existing.sourceEpoch !== sourceEpoch || existing.sourceSeq !== sourceSeq || canonicalJson(existing.envelope) !== canonicalJson(envelope) : sourceEpoch !== candidate.indexedState?.sourceEpoch || sourceSeq !== candidate.ackedSourceSeq + 1) || envelope.runId !== this.#identity.runId) {
      connection.close();
      return false;
    }
    if (existing !== undefined) {
      existing.deliveryCount = incrementDiagnosticCount(existing.deliveryCount);
      candidate.replayDeliveries = incrementDiagnosticCount(candidate.replayDeliveries);
    } else {
      if (!this.indexedPersistence && candidate.committedEvents.length >= maxCommittedEventWindow) {
        // The awaited business commit may allow another authenticated owner
        // or a tool completion to advance the window. Re-evaluate, never use
        // an index sampled before that await to delete a different input.
        const currentEviction = candidate.committedEvents.findIndex(
          (event) => !unsettledSemanticInput(event, candidate),
        );
        if (currentEviction < 0) {
          connection.close();
          return false;
        }
        candidate.committedEvents.splice(currentEviction, 1);
      }
      candidate.committedEvents.push({
        ...(sourceEpoch ? { sourceEpoch } : {}),
        sourceSeq,
        sourceEventId,
        eventType,
        priority,
        envelope: structuredClone(envelope),
        deliveryCount: 1,
        logicalEffectCount: 1,
      });
      candidate.ackedSourceSeq = sourceSeq;
      if (candidate.indexedState) {
        candidate.indexedState.providerEverStarted = true;
        if (isSemanticInput || ["mcp_app.tool_input", "runtime.input.requested", "runtime_request.created"].includes(eventType)) {
          candidate.indexedState.externalEffectEverAdmitted = true;
        }
        if (isSemanticInput) candidate.indexedState.pendingSemanticInputIds.push(sourceEventId);
      }
    }
    await this.#store.commit(candidate);


      return true;
    });
    if (!committed) return;
    if (this.indexedPersistence) await this.#onCommittedEvent?.(event);
    if (this.#protocolIntegrityError !== null || envelope.runId !== this.#identity.runId) { connection.close(); return; }

    if (
      isSemanticInput &&
      this.#onSemanticToolInput &&
      semantic !== undefined &&
      typeof semantic.callId === "string" &&
      typeof semantic.operationId === "string"
    ) {
      const call = {
        callId: semantic.callId,
        operationId: semantic.operationId,
        input: semantic.input,
        sourceEventId,
        sourceEventType: eventType,
        correlation: {
          runId: this.#identity.runId,
          normalizedSessionId: this.#identity.normalizedSessionId,
          turnId: this.#identity.turnId,
          itemId:
            typeof event.itemId === "string"
              ? event.itemId
              : this.#identity.itemId,
        },
      };
      const commandId = `command_tool_${createHash("sha256")
        .update(`${this.#identity.runId}\0${call.callId}`)
        .digest("hex")
        .slice(0, 32)}`;
      const alreadyQueued = (await this.getCommand(commandId)) !== undefined;
      if (!alreadyQueued && !this.#pendingSemanticCalls.has(commandId)) {
        this.#pendingSemanticCalls.add(commandId);
        const queueResult = async (result: unknown, isError: boolean): Promise<void> => {
          try {
            await this.queueCommand(
              "semantic_tool.result",
              { ...call, result, isError },
              commandId,
              true,
            );
          } catch {
            this.#semanticResultPersistenceFailed = true;
            // A result that cannot fit the bounded durable journal cannot be
            // acknowledged as a usable tool response. Force a reconnect so
            // the caller can recover or terminate the run explicitly.
            this.disconnectActiveRunner();
          }
        };
        void this.#onSemanticToolInput(call)
          .then((outcome) =>
            queueResult(outcome.result, outcome.isError === true),
          )
          .catch(() =>
            queueResult({ code: "semantic_tool_bridge_failed" }, true),
          )
          .finally(() => this.#pendingSemanticCalls.delete(commandId));
      }
    }

    const ackedSourceSeq = sourceEpoch === this.#store.state.indexedState?.sourceEpoch ? this.#store.state.ackedSourceSeq : (await this.readEventEpochTransition(sourceEpoch))?.finalOrdinal;
    if (ackedSourceSeq === undefined) { connection.close(); return; }
    connection.sendJson(this.#controlEnvelope(connection, `ack_${randomUUID()}`, "ack", {
      ackedSourceSeq, ...(sourceEpoch ? { sourceEpoch } : {}),
    }));
  }
}

const runnerPlatformEnvironmentKeys = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "RUST_BACKTRACE",
] as const;

const runnerExplicitProviderEnvironmentKeys = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "PAPERCLIP_OPENCODE_PERMISSION_MODE",
  "PAPERCLIP_OPENCODE_RUNTIME_DIR",
  "PAPERCLIP_RUNNER_INSTANCE_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_NORMALIZED_SESSION_ID",
  "PAPERCLIP_NATIVE_MCP_NAME",
  "PAPERCLIP_NATIVE_MCP_URL",
  "PAPERCLIP_NATIVE_MCP_TOKEN",
  "PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH",
  "PAPERCLIP_RUNNER_EXTERNAL_SANDBOX",
  "PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT",
  "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST",
  "PAPERCLIP_ACPX_PROVIDER_RECOVERY_POLICY",
  "PAPERCLIP_PROVIDER_TRACE_PATH",
  "PAPERCLIP_PROVIDER_TRACE_MAX_BYTES",
] as const;

function runnerEnvironment(
  ticket: string,
  explicitSource?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const platformSource = explicitSource ?? process.env;
  const environment: NodeJS.ProcessEnv = {
    PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: ticket,
  };
  for (const key of runnerPlatformEnvironmentKeys) {
    const value = platformSource[key];
    if (value !== undefined) environment[key] = value;
  }
  // Provider credentials cross this boundary only when the caller supplies an
  // already-sanitized environment for this run. Never inherit them implicitly
  // from the server process.
  if (explicitSource !== undefined) {
    for (const key of runnerExplicitProviderEnvironmentKeys) {
      const value = explicitSource[key];
      if (value !== undefined) environment[key] = value;
    }
    Object.assign(environment, githubCredentialEnvironment(explicitSource));
  }
  return environment;
}

export function spawnRunner(options: {
  indexedDurability?: boolean;
  connectUrl?: string;
  connection?: RunnerProcessConnection;
  stateDirectory: string;
  identity: DurableRecoveryIdentity;
  ticket: string;
  maxOutboxBytes: number;
  p0ReserveBytes: number;
  maxRuntimeMs?: number;
  maxLifetimeMs?: number;
  reconnectGraceMs?: number;
  lifecyclePolicy?:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  runnerBinaryPath?: string;
  runnerVersion: string;
  runnerDigest: string;
  acpxLaunchProfile?: {
    authorityDigest: string;
    command: string;
    commandSha256: string;
    sidecarScript: string;
    sidecarScriptSha256: string;
  };
  opencodeLaunchProfile?: {
    command: string;
    commandSha256: string;
    proxyScript: string;
    proxyScriptSha256: string;
    executable: string;
    executableSha256: string;
  };
  environment?: NodeJS.ProcessEnv;
  processLauncher?: (spec: RunnerProcessLaunchSpec) => RunnerProcessHandle;
  diagnosticsDirectory?: string;
}): RunnerProcessHandle {
  const connection =
    options.connection ??
    (options.connectUrl
      ? { mode: "connect" as const, connectUrl: options.connectUrl }
      : null);
  if (connection === null)
    throw new Error("runner process connection is required");
  const connectionArgs =
    connection.mode === "connect"
      ? [
          "--connect-url",
          connection.connectUrl,
          ...(connection.caBundlePath === undefined
            ? []
            : ["--ca-bundle-path", connection.caBundlePath]),
        ]
      : [
          "--listen-address",
          connection.listenAddress,
          "--listen-port",
          String(connection.listenPort),
          "--listen-path",
          connection.listenPath,
        ];
  const args = [
    ...(options.indexedDurability ? ["--indexed-state"] : []),
    ...connectionArgs,
    "--state-dir",
    options.stateDirectory,
    "--runner-id",
    options.identity.runnerInstanceId,
    "--environment-lease-id",
    options.identity.environmentLeaseId,
    "--run-id",
    options.identity.runId,
    "--session-id",
    options.identity.normalizedSessionId,
    "--turn-id",
    options.identity.turnId,
    "--item-id",
    options.identity.itemId,
    "--runner-version",
    options.runnerVersion,
    "--runner-digest",
    options.runnerDigest,
    ...(options.acpxLaunchProfile
      ? [
          "--acpx-launch-authority-digest",
          options.acpxLaunchProfile.authorityDigest,
          "--acpx-sidecar-command",
          options.acpxLaunchProfile.command,
          "--acpx-sidecar-command-sha256",
          options.acpxLaunchProfile.commandSha256,
          "--acpx-sidecar-script",
          options.acpxLaunchProfile.sidecarScript,
          "--acpx-sidecar-script-sha256",
          options.acpxLaunchProfile.sidecarScriptSha256,
        ]
      : []),
    ...(options.opencodeLaunchProfile
      ? [
          "--opencode-proxy-command",
          options.opencodeLaunchProfile.command,
          "--opencode-proxy-command-sha256",
          options.opencodeLaunchProfile.commandSha256,
          "--opencode-proxy-script",
          options.opencodeLaunchProfile.proxyScript,
          "--opencode-proxy-script-sha256",
          options.opencodeLaunchProfile.proxyScriptSha256,
          "--opencode-executable",
          options.opencodeLaunchProfile.executable,
          "--opencode-executable-sha256",
          options.opencodeLaunchProfile.executableSha256,
        ]
      : []),
    "--fake-harness",
    fakeHarnessBinary,
    "--fake-harness-script",
    fakeHarnessScript,
    "--max-outbox-bytes",
    String(options.maxOutboxBytes),
    "--p0-reserve-bytes",
    String(options.p0ReserveBytes),
    "--reconnect-delay-ms",
    "250",
  ];
  if (options.maxLifetimeMs !== undefined) {
    args.push("--max-lifetime-ms", String(options.maxLifetimeMs));
  } else if (options.maxRuntimeMs !== undefined) {
    args.push("--max-runtime-ms", String(options.maxRuntimeMs));
  }
  if (options.reconnectGraceMs !== undefined) {
    args.push("--reconnect-grace-ms", String(options.reconnectGraceMs));
  }
  if (options.lifecyclePolicy !== undefined) {
    args.push("--lifecycle-mode", options.lifecyclePolicy.mode);
    if (options.lifecyclePolicy.mode === "warm") {
      args.push(
        "--idle-timeout-ms",
        String(options.lifecyclePolicy.idleTimeoutMs),
      );
    }
  }
  if (options.diagnosticsDirectory !== undefined) {
    args.push("--diagnostics-directory", options.diagnosticsDirectory);
  }

  const command = options.runnerBinaryPath ?? runnerBinary;
  const environment = runnerEnvironment(options.ticket, options.environment);
  const withRestart = (handle: RunnerProcessHandle): RunnerProcessHandle => ({
    ...handle,
    restart: (ticket) => spawnRunner({ ...options, ticket }),
  });
  if (options.processLauncher !== undefined) {
    return withRestart(
      options.processLauncher({ command, args, cwd: packageRoot, environment }),
    );
  }

  const detached = process.platform !== "win32";
  const diagnosticsDirectory = options.diagnosticsDirectory;
  let stdoutPath: string | null = null;
  let stderrPath: string | null = null;
  if (diagnosticsDirectory) {
    try {
      const metadata = lstatSync(diagnosticsDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          `Private state directory is not a real directory: ${diagnosticsDirectory}`,
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") chmodSync(diagnosticsDirectory, 0o700);
    verifyPrivateDirectory(diagnosticsDirectory);
    stdoutPath = resolve(diagnosticsDirectory, "runnerd.stdout.log");
    stderrPath = resolve(diagnosticsDirectory, "runnerd.stderr.log");
    // runnerd owns every durable diagnostic write so it can redact and bound
    // the complete value before a byte reaches disk. Raw process output is
    // intentionally discarded below; these files are only the runner-owned
    // restart-survivable diagnostic channel.
    atomicPrivateWrite(stdoutPath, "");
    atomicPrivateWrite(stderrPath, "");
  }
  const child = spawn(command, args, {
    cwd: packageRoot,
    env: environment,
    detached,
    stdio: diagnosticsDirectory ? "ignore" : "pipe",
  });
  child.unref();
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-16_384);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const boundedDiagnostic = (filePath: string | null): string => {
    if (!filePath) return "";
    try {
      return (readPrivateFile(filePath) ?? "").slice(-16_384);
    } catch {
      return "";
    }
  };
  const processCompletion = new Promise<RunnerProcessResult>(
    (resolveCompletion, rejectCompletion) => {
      child.once("error", rejectCompletion);
      child.once("exit", (code, signal) =>
        resolveCompletion({
          code,
          signal,
          stdout: stdout || boundedDiagnostic(stdoutPath),
          stderr: stderr || boundedDiagnostic(stderrPath),
        }),
      );
    },
  );
  return withRestart({
    child,
    completion: processCompletion,
    processGroupId: detached ? (child.pid ?? null) : null,
    startedAt: new Date().toISOString(),
  });
}

export async function waitForProcess(
  handle: RunnerProcessHandle,
  timeoutMs = 15_000,
): Promise<RunnerProcessResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handle.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (
            process.platform !== "win32" &&
            handle.processGroupId &&
            handle.processGroupId > 0
          ) {
            try {
              process.kill(-handle.processGroupId, "SIGKILL");
            } catch {
              handle.child.kill("SIGKILL");
            }
          } else {
            handle.child.kill("SIGKILL");
          }
          reject(new Error("Durable recovery runner timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
