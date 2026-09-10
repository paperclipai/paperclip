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
const maxCommandBytes = maxFrameBytes - 4 * 1024;
const maxCommands = 500;
// A provider can emit several 100-event runner batches before the transport's
// polling turn regains the event loop. Match the transport's explicit deferred
// event bound so a valid burst is not compacted before it can be observed.
const maxCommittedEventWindow = 4_096;
const maxStateBytes = 192 * 1024 * 1024;
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

interface StoredCoreState {
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
        (state.ackedSourceSeq === expected.oldAckedSourceSeq &&
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
  state: Pick<StoredCoreState, "identity" | "commands">,
): boolean {
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
): value is StoredCoreState {
  if (!isRecord(value)) return false;
  const commands = value.commands;
  const events = value.committedEvents;
  if (
    (value.schema !== coreStateSchema &&
      value.schema !== transitionCoreStateSchema) ||
    canonicalJson(value.identity) !== canonicalJson(identity) ||
    !isRecord(value.tickets) ||
    !isRecord(value.leases) ||
    !Array.isArray(commands) ||
    commands.length > maxCommands ||
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
        command.controllerSeq === index + 1 &&
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
      !isStoredCoreState(state, state.identity) ||
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
    if (metadata.size > maxStateBytes) {
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

class DurableCoreStore {
  readonly path: string;
  #state: StoredCoreState;
  #writeIndeterminate = false;

  constructor(directory: string, identity: DurableRecoveryIdentity) {
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
      this.save();
    }
  }

  get state(): StoredCoreState {
    return this.#state;
  }

  save(): void {
    this.assertWritable();
    atomicPrivateWrite(this.path, `${JSON.stringify(this.#state, null, 2)}\n`);
  }

  assertWritable(): void {
    if (this.#writeIndeterminate)
      throw new Error(
        "Durable authority commit is indeterminate; reload is required.",
      );
  }

  /** Persist a complete candidate before publishing any new authority in memory. */
  commit(candidate: StoredCoreState): void {
    this.assertWritable();
    try {
      atomicPrivateWrite(this.path, `${JSON.stringify(candidate, null, 2)}\n`);
      this.#state = candidate;
    } catch (error) {
      // Rename may already have succeeded before directory fsync failed.
      // Never overwrite that possibly durable receipt using stale memory.
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

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendText(text: string): void {
    if (this.#closed) {
      return;
    }
    const payload = Buffer.from(text);
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
    this.socket.destroy();
    this.#onClose({ message: "local_close" });
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 2) {
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
  pendingChallenge: PendingChallenge | null = null;
  secureChannel: SecureChannel | null = null;
  lease: ConnectionLeaseRecord | null = null;
  connectionId: string | null = null;
  terminalLifecycleCommandId: string | null = null;
  warmTransitionVersion: 1 | null = null;
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
  }) {
    this.wire = input.wire;
    this.#onClose = input.onClose;
    this.wire.onJson(input.onJson);
    this.wire.onClose(() => this.#markClosed());
  }

  sendJson(value: unknown): void {
    if (this.#closed) return;
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
  #identity: DurableRecoveryIdentity;
  readonly #store: DurableCoreStore;
  #expectedRunnerVersion: string;
  #expectedRunnerDigest: string;
  #server: Server | null = null;
  #connections = new Set<AuthorityConnection>();
  #pendingSemanticCalls = new Set<string>();
  #semanticResultPersistenceFailed = false;
  #port: number | null = null;
  #onSemanticToolInput?: DurablePrpControlPlaneOptions["onSemanticToolInput"];
  #onCommittedEvent?: DurablePrpControlPlaneOptions["onCommittedEvent"];
  #beforeAuthenticatedConnection?: DurablePrpControlPlaneOptions["beforeAuthenticatedConnection"];
  #onProtocolIntegrityError?: DurablePrpControlPlaneOptions["onProtocolIntegrityError"];
  #protocolIntegrityError: NativeSessionProtocolIntegrityError | null = null;
  #connectionLeaseTtlMs: number;

  constructor(options: DurablePrpControlPlaneOptions) {
    if (
      !Object.values(options.identity).every(
        (value) => typeof value === "string" && stableIdPattern.test(value),
      ) ||
      !stableIdPattern.test(options.expectedRunnerVersion) ||
      !runnerDigestPattern.test(options.expectedRunnerDigest) ||
      (options.connectionLeaseTtlMs !== undefined &&
        (!Number.isInteger(options.connectionLeaseTtlMs) ||
          options.connectionLeaseTtlMs < 60_000 ||
          options.connectionLeaseTtlMs > 24 * 60 * 60 * 1_000))
    ) {
      throw new Error("Durable PRP control plane options are invalid.");
    }
    this.#identity = structuredClone(options.identity);
    this.#store = new DurableCoreStore(
      options.stateDirectory,
      options.identity,
    );
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
  }

  get store(): DurablePrpControlPlaneStore {
    return this.#store;
  }

  getCommand(commandId: string): DurableRecoveryCoreCommand | undefined {
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
  rotateRunIdentity(
    identity: DurableRecoveryIdentity,
    runAttachTemplate?: Record<string, unknown>,
  ): void {
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
        this.#store.commit(candidate);
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
    Object.assign(this.#store.state, initialCoreState(identity), {
      leases,
      runAttachTemplate:
        runAttachTemplate === undefined
          ? null
          : structuredClone(runAttachTemplate),
    });
    this.#identity = structuredClone(identity);
    this.#store.save();
  }

  /**
   * Retain the connection-free provider preparation payload before the first
   * runner bootstrap. Completed command history is bounded and may be
   * compacted before a warm continuation arrives, so it cannot be the sole
   * source for a later run.attach. Repeating the same write is idempotent;
   * changing an established seed fails closed.
   */
  persistRunAttachTemplate(runAttachTemplate: Record<string, unknown>): void {
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
    this.#store.state.runAttachTemplate = structuredClone(runAttachTemplate);
    this.#store.save();
  }

  issueBootstrapTicket(ttlMs = 5_000): string {
    this.#store.assertWritable();
    if (this.#store.state.warmTransition) {
      throw new Error(
        "Warm transition recovery requires its explicit one-use bootstrap capability.",
      );
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
      throw new Error("Durable PRP bootstrap TTL is invalid.");
    }
    this.#pruneCredentials();
    const ticket = `bootstrap_${randomUUID()}`;
    const material = credentialMaterial(ticket);
    const expiresAtUnixMs = Date.now() + ttlMs;
    this.#store.state.tickets[material.credentialId] = {
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
    this.#store.state.freshBootstraps += 1;
    this.#store.save();
    return ticket;
  }

  /** Caller-owned recovery admission is required; a receipt is not a credential. */
  issueWarmTransitionBootstrapTicket(
    input: {
      transitionId: string;
      runnerState: Record<string, unknown>;
    },
    ttlMs = 5_000,
  ): string {
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
    candidate.freshBootstraps += 1;
    this.#store.commit(candidate);
    return ticket;
  }

  queueCommand(
    type: string,
    payload: Record<string, unknown> = {},
    commandId?: string,
    deliverImmediately = false,
  ): DurableRecoveryCoreCommand {
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
      const existing = this.#store.state.commands.find(
        (candidate) => candidate.commandId === commandId,
      );
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
              this.#sendNextCommand(connection);
          }
        }
        return existing;
      }
    }
    const controllerSeq = this.#store.state.commands.length + 1;
    const command: DurableRecoveryCoreCommand = {
      schema: type.startsWith("session.goal.")
        ? "paperclip.prp.command.v2"
        : "paperclip.prp.command.v1",
      commandId:
        commandId ?? `command_prp_${controllerSeq.toString().padStart(8, "0")}`,
      controllerSeq,
      type,
      issuedAt: new Date().toISOString(),
      payload,
      status: "pending",
      result: null,
    };
    if (
      this.#store.state.commands.length >= maxCommands ||
      Buffer.byteLength(JSON.stringify(command)) > maxCommandBytes
    ) {
      throw new Error("Durable PRP command journal bound exceeded.");
    }
    this.#store.state.commands.push(command);
    this.#store.save();
    if (deliverImmediately) {
      for (const connection of this.#connections) {
        if (connection.secureChannel !== null) {
          this.#sendNextCommand(connection);
        }
      }
    }
    return command;
  }

  commandOutcome(commandId: string): {
    status: DurableRecoveryCoreCommand["status"];
    result: Record<string, unknown> | null;
  } | null {
    const command = this.#store.state.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
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
    connection = new AuthorityConnection({
      wire,
      onJson: (value) => {
        processing = processing
          .then(() => this.#handleJson(connection, value))
          .catch(() => connection.close());
      },
      onClose: () => this.#connections.delete(connection),
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
    let envelope: Record<string, unknown>;
    try {
      envelope =
        connection.secureChannel === null
          ? (wire as Record<string, unknown>)
          : decryptSecureJson(connection.secureChannel, wire);
    } catch {
      this.#store.state.malformedFrames += 1;
      this.#store.save();
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
    if (kind === "command_result") {
      if (
        this.#store.state.warmTransition &&
        this.#store.state.warmTransition.phase !== "activated"
      )
        connection.replayOnly = true;
      this.#commandResult(connection, envelope);
      return;
    }
    if (kind === "warm_transition_activated") {
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
        this.#store.commit(candidate);
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
      this.#sendNextCommand(connection);
      return;
    }
    if (kind !== "pong") {
      connection.close();
    }
  }

  #authorizeHello(
    payload: Record<string, unknown>,
  ): PendingAuthorization | null {
    this.#pruneCredentials();
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

  #pruneCredentials(): void {
    const now = Date.now();
    for (const [credentialId, ticket] of Object.entries(
      this.#store.state.tickets,
    )) {
      if (ticket.usedAt !== null || ticket.expiresAtUnixMs <= now) {
        delete this.#store.state.tickets[credentialId];
      }
    }
    for (const [credentialId, lease] of Object.entries(
      this.#store.state.leases,
    )) {
      if (
        credentialId !== this.#store.state.warmTransition?.credentialId &&
        (lease.revokedAt !== null || lease.expiresAtUnixMs <= now)
      ) {
        delete this.#store.state.leases[credentialId];
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
    const clientProof = expectedClientProof.toString("hex");
    // A held proof may span preparation or activation on another connection.
    // Reapply today's transition lane policy, not merely the old credential
    // snapshot, before it can consume a ticket or evict a participating peer.
    if (
      this.#authorizeHello({
        credentialId: pending.authorization.credentialId,
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
      this.#store.commit(candidate);
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
        this.#store.commit(candidate);
        this.#identity = structuredClone(candidate.identity);
        lease = this.#store.state.leases[lease.credentialId]!;
      }
    }
    connection.pendingChallenge = null;
    connection.lease = lease;
    connection.identity = structuredClone(requestedIdentity);
    connection.warmTransitionVersion = pending.warmTransitionVersion ?? null;
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
    connection.connectionId = `connection_${this.#store.state.connectionCount + 1}`;
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
    this.#welcome(connection, leaseToken);
  }

  #welcome(connection: AuthorityConnection, leaseToken: string | null): void {
    const lease = connection.lease;
    if (lease === null || connection.connectionId === null) {
      connection.close();
      return;
    }

    this.#store.state.connectionCount += 1;
    this.#store.state.lastLeaseId = lease.leaseId;
    this.#store.state.lastLeaseExpiresAt = lease.expiresAt;

    const pending = connection.replayOnly ? [] : this.#nextPendingCommand();
    const [pendingCommand] = pending;
    connection.terminalLifecycleCommandId =
      pendingCommand && this.#isTerminalLifecycleCommand(pendingCommand)
        ? pendingCommand.commandId
        : null;
    for (const command of pending) {
      this.#store.state.commandDeliveryCounts[command.commandId] =
        (this.#store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    }
    this.#store.save();
    connection.sendJson({
      protocol,
      version: lease.protocolVersion,
      envelopeId: `welcome_${this.#store.state.connectionCount}`,
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
        ackedSourceSeq: this.#store.state.ackedSourceSeq,
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

  #sendNextCommand(connection: AuthorityConnection): void {
    if (
      connection.terminalLifecycleCommandId !== null ||
      connection.replayOnly ||
      this.#store.state.warmTransition
    )
      return;
    const [command] = this.#nextPendingCommand();
    if (command === undefined) return;
    if (this.#isTerminalLifecycleCommand(command)) {
      connection.terminalLifecycleCommandId = command.commandId;
    }
    this.#store.state.commandDeliveryCounts[command.commandId] =
      (this.#store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    this.#store.save();
    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `command_${command.commandId}_${this.#store.state.commandDeliveryCounts[command.commandId]}`,
        "command",
        this.#wireCommand(command),
      ),
    );
  }

  #commandResult(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): void {
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
        this.#store.commit(candidate);
      }
      this.#ackWarmTransition(connection, transition.receipt);
      return;
    }
    const command = this.#store.state.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
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
      this.#store.state.duplicateCommandResults += 1;
      this.#store.save();
      this.#ackTerminalCommandResult(connection, command);
      if (!this.#isTerminalLifecycleCommand(command)) {
        this.#sendNextCommand(connection);
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
      this.#store.commit(candidate);
      connection.replayOnly = true;
      this.#ackWarmTransition(connection, receipt);
      return;
    }
    command.status = status;
    command.result = structuredClone(result);
    this.#store.save();
    this.#ackTerminalCommandResult(connection, command);
    if (!this.#isTerminalLifecycleCommand(command)) {
      this.#sendNextCommand(connection);
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
      command.type === "runner.suspend" || command.type === "runner.shutdown"
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
    const sourceEventId = event?.sourceEventId;
    const eventType = event?.eventType;
    const priority = event?.priority;
    if (
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
    const existing = this.#store.state.committedEvents.find(
      (candidate) => candidate.sourceEventId === sourceEventId,
    );
    if (
      existing === undefined
        ? sourceSeq !== this.#store.state.ackedSourceSeq + 1
        : sourceSeq !== existing.sourceSeq
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
      await this.#onCommittedEvent?.(event);
    } catch (error) {
      if (error instanceof NativeSessionProtocolIntegrityError) {
        this.#failProtocolIntegrity(connection, error);
      } else {
        connection.close();
      }
      return;
    }
    // Another authenticated connection can replace this one while its commit
    // is in flight. Once that exact owner has faulted, even a prior successful
    // commit cannot reopen delivery or invoke a new business operation.
    if (this.#protocolIntegrityError !== null) {
      connection.close();
      return;
    }

    if (existing !== undefined) {
      existing.deliveryCount += 1;
      this.#store.state.replayDeliveries += 1;
    } else {
      if (this.#store.state.committedEvents.length >= maxCommittedEventWindow) {
        // The awaited business commit may allow another authenticated owner
        // or a tool completion to advance the window. Re-evaluate, never use
        // an index sampled before that await to delete a different input.
        const currentEviction = this.#store.state.committedEvents.findIndex(
          (candidate) => !unsettledSemanticInput(candidate, this.#store.state),
        );
        if (currentEviction < 0) {
          connection.close();
          return;
        }
        this.#store.state.committedEvents.splice(currentEviction, 1);
      }
      this.#store.state.committedEvents.push({
        sourceSeq,
        sourceEventId,
        eventType,
        priority,
        envelope: structuredClone(envelope),
        deliveryCount: 1,
        logicalEffectCount: 1,
      });
      this.#store.state.ackedSourceSeq = sourceSeq;
    }
    this.#store.save();

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
      const alreadyQueued = this.#store.state.commands.some(
        (command) => command.commandId === commandId,
      );
      if (!alreadyQueued && !this.#pendingSemanticCalls.has(commandId)) {
        this.#pendingSemanticCalls.add(commandId);
        const queueResult = (result: unknown, isError: boolean): void => {
          try {
            this.queueCommand(
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

    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `ack_${this.#store.state.ackedSourceSeq}`,
        "ack",
        {
          ackedSourceSeq: this.#store.state.ackedSourceSeq,
        },
      ),
    );
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
