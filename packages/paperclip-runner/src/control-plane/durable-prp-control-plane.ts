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

import {
  validatePrpEvent,
  type PrpEvent,
} from "../protocol/replay-contract.js";
import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";
import {
  type DurableRecoveryCommittedEvent,
  type DurableRecoveryCoreCommand,
  type DurableRecoveryIdentity,
} from "./prp-transport-types.js";

const protocol = "paperclip.runner";
const protocolVersion = 1;
const secureFrameSchema = "paperclip.runner.secure-frame.v1";
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const coreStateSchema = "paperclip.runner.durable.control-plane-state.v1";
const maxFrameBytes = 1024 * 1024;
const maxCommandBytes = maxFrameBytes - 4 * 1024;
const maxCommands = 500;
const maxCommittedEventWindow = 64;
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
  schema: typeof coreStateSchema;
  identity: DurableRecoveryIdentity;
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
  if (depth > MAX_CANONICAL_JSON_DEPTH || state.nodes > MAX_CANONICAL_JSON_NODES) {
    throw new Error("durable_prp_canonical_json_too_large");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("durable_prp_canonical_json_invalid");
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new Error("durable_prp_canonical_json_invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredCoreState(
  value: unknown,
  identity: DurableRecoveryIdentity,
): value is StoredCoreState {
  if (!isRecord(value)) return false;
  const commands = value.commands;
  const events = value.committedEvents;
  if (
    value.schema !== coreStateSchema ||
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
  if (
    !commands.every(
      (command, index) =>
        isRecord(command) &&
        command.schema === "paperclip.prp.command.v1" &&
        typeof command.commandId === "string" &&
        stableIdPattern.test(command.commandId) &&
        command.commandId.length <= 160 &&
        command.controllerSeq === index + 1 &&
        typeof command.type === "string" &&
        commandTypes.has(command.type) &&
        typeof command.issuedAt === "string" &&
        isRecord(command.payload) &&
        ["pending", "completed", "failed", "rejected"].includes(
          String(command.status),
        ) &&
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
    atomicPrivateWrite(this.path, `${JSON.stringify(this.#state, null, 2)}\n`);
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

class PrpWebSocketConnection {
  readonly socket: Duplex;
  pendingChallenge: PendingChallenge | null = null;
  secureChannel: SecureChannel | null = null;
  lease: ConnectionLeaseRecord | null = null;
  connectionId: string | null = null;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #onText: (text: string) => void | Promise<void>;
  #onClose: () => void;
  #processing = Promise.resolve();

  constructor(
    socket: Duplex,
    onText: (text: string) => void | Promise<void>,
    onClose: () => void,
  ) {
    this.socket = socket;
    this.#onText = onText;
    this.#onClose = onClose;
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    socket.on("close", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#onClose();
      }
    });
    socket.on("error", () => this.close());
  }

  acceptInitialData(data: Buffer<ArrayBufferLike>): void {
    if (data.length > 0) this.#consume(data);
  }

  sendJson(value: unknown): void {
    const wire =
      this.secureChannel === null
        ? value
        : encryptSecureJson(this.secureChannel, value);
    this.sendText(JSON.stringify(wire));
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

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.socket.destroy();
    this.#onClose();
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
        const text = payload.toString("utf8");
        this.#processing = this.#processing
          .then(() => this.#onText(text))
          .catch(() => this.close());
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

/** Authenticated, replay-safe PRP transport authority. Business operations are caller supplied. */
export class DurablePrpControlPlane {
  readonly #identity: DurableRecoveryIdentity;
  readonly #store: DurableCoreStore;
  #expectedRunnerVersion: string;
  #expectedRunnerDigest: string;
  #server: Server | null = null;
  #connections = new Set<PrpWebSocketConnection>();
  #pendingSemanticCalls = new Set<string>();
  #port: number | null = null;
  #onSemanticToolInput?: DurablePrpControlPlaneOptions["onSemanticToolInput"];
  #onCommittedEvent?: DurablePrpControlPlaneOptions["onCommittedEvent"];
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
    this.#onSemanticToolInput = options.onSemanticToolInput;
    this.#onCommittedEvent = options.onCommittedEvent;
    this.#connectionLeaseTtlMs = options.connectionLeaseTtlMs ?? 60_000;
  }

  get store(): DurablePrpControlPlaneStore {
    return this.#store;
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

  issueBootstrapTicket(ttlMs = 5_000): string {
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

  queueCommand(
    type: string,
    payload: Record<string, unknown> = {},
    commandId?: string,
    deliverImmediately = false,
  ): DurableRecoveryCoreCommand {
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
      schema: "paperclip.prp.command.v1",
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
    let connection!: PrpWebSocketConnection;
    connection = new PrpWebSocketConnection(
      socket,
      (text): Promise<void> => this.#handleText(connection, text),
      () => this.#connections.delete(connection),
    );
    this.#connections.add(connection);
    connection.acceptInitialData(head);
  }

  async #handleText(
    connection: PrpWebSocketConnection,
    text: string,
  ): Promise<void> {
    let envelope: Record<string, unknown>;
    try {
      const wire = JSON.parse(text) as unknown;
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
    if (
      envelope.protocol !== protocol ||
      envelope.version !== protocolVersion
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
      this.#authResponse(connection, envelope);
      return;
    }
    if (
      connection.secureChannel === null ||
      connection.lease === null ||
      connection.lease.revokedAt !== null ||
      connection.lease.expiresAtUnixMs <= Date.now()
    ) {
      connection.close();
      return;
    }
    if (kind === "event") {
      await this.#event(connection, envelope);
      return;
    }
    if (kind === "command_result") {
      this.#commandResult(connection, envelope);
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
      payload.protocolMin !== 1 ||
      payload.protocolMax !== 1 ||
      (authorization.kind === "bootstrap" &&
        (authorization.runnerVersion !== this.#expectedRunnerVersion ||
          authorization.runnerDigest !== this.#expectedRunnerDigest)) ||
      (authorization.kind === "lease" &&
        authorization.protocolVersion !== protocolVersion)
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
      if (lease.revokedAt !== null || lease.expiresAtUnixMs <= now) {
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
    connection: PrpWebSocketConnection,
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
      selectedVersion: protocolVersion,
      credentialLeaseId:
        authorization.kind === "lease" ? authorization.leaseId : null,
      credentialExpiresAt: authorization.expiresAt,
      credentialExpiresAtUnixMs: authorization.expiresAtUnixMs,
      revocationEpoch:
        authorization.kind === "lease" ? authorization.revocationEpoch : 0,
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
    };
    connection.sendJson({
      protocol,
      version: protocolVersion,
      kind: "auth_challenge",
      payload: { ...challengePayload, serverProof },
    });
  }

  #authResponse(
    connection: PrpWebSocketConnection,
    envelope: Record<string, unknown>,
  ): void {
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
    // WebSocket callbacks run synchronously on the mock core's event loop. Re-reading,
    // validating, consuming, minting, and persisting here forms one state mutation
    // boundary, so another proof cannot interleave with bootstrap consumption.
    const authorization = this.#reauthorizePendingChallenge(
      pending,
      Date.now(),
    );
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
    const clientProof = expectedClientProof.toString("hex");
    let leaseToken: string | null = null;
    let lease: ConnectionLeaseRecord;
    if (authorization.kind === "bootstrap") {
      authorization.ticket.usedAt = new Date().toISOString();
      leaseToken = `lease_${randomUUID()}`;
      const material = credentialMaterial(leaseToken);
      const expiresAtUnixMs = Date.now() + this.#connectionLeaseTtlMs;
      lease = {
        recordId: `connection_lease_record_${randomUUID()}`,
        credentialId: material.credentialId,
        authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
        leaseId: `connection_lease_${randomUUID()}`,
        identity: structuredClone(this.#identity),
        protocolVersion,
        expiresAt: new Date(expiresAtUnixMs).toISOString(),
        expiresAtUnixMs,
        revocationEpoch: 0,
        revokedAt: null,
      };
      this.#store.state.leases[material.credentialId] = lease;
      this.#store.save();
    } else {
      lease = authorization.lease;
    }
    connection.pendingChallenge = null;
    connection.lease = lease;
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

  #welcome(
    connection: PrpWebSocketConnection,
    leaseToken: string | null,
  ): void {
    const lease = connection.lease;
    if (lease === null || connection.connectionId === null) {
      connection.close();
      return;
    }

    this.#store.state.connectionCount += 1;
    this.#store.state.lastLeaseId = lease.leaseId;
    this.#store.state.lastLeaseExpiresAt = lease.expiresAt;

    const pending = this.#nextPendingCommand();
    for (const command of pending) {
      this.#store.state.commandDeliveryCounts[command.commandId] =
        (this.#store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    }
    this.#store.save();
    connection.sendJson({
      protocol,
      version: protocolVersion,
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
        selectedVersion: 1,
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
          protocolVersion,
        },
        maxFrameBytes,
        maxBatchEvents: 100,
        ackedSourceSeq: this.#store.state.ackedSourceSeq,
        pendingCommands: pending.map(this.#wireCommand),
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
    const command = this.#store.state.commands.find(
      (candidate) => candidate.status === "pending",
    );
    return command === undefined ? [] : [command];
  }

  #controlEnvelope(
    connection: PrpWebSocketConnection,
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
      version: protocolVersion,
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

  #sendNextCommand(connection: PrpWebSocketConnection): void {
    const [command] = this.#nextPendingCommand();
    if (command === undefined) return;
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
    connection: PrpWebSocketConnection,
    envelope: Record<string, unknown>,
  ): void {
    const result = envelope.payload as Record<string, unknown> | undefined;
    const commandId = result?.commandId;
    if (result === undefined || typeof commandId !== "string") {
      connection.close();
      return;
    }
    const command = this.#store.state.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command === undefined) {
      connection.close();
      return;
    }
    const status = result.status;
    if (
      status !== "completed" &&
      status !== "failed" &&
      status !== "rejected"
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
      this.#sendNextCommand(connection);
      return;
    }
    command.status = status;
    command.result = structuredClone(result);
    this.#store.save();
    this.#sendNextCommand(connection);
  }

  async #event(
    connection: PrpWebSocketConnection,
    envelope: Record<string, unknown>,
  ): Promise<void> {
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
        (semantic.content as Record<string, unknown>).digest !==
          digestPaperclipSemanticContent(semantic.input) ||
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
    if (existing !== undefined) {
      if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
        connection.close();
        return;
      }
    } else if (sourceSeq !== this.#store.state.ackedSourceSeq + 1) {
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
    } catch {
      connection.close();
      return;
    }

    if (existing !== undefined) {
      existing.deliveryCount += 1;
      this.#store.state.replayDeliveries += 1;
    } else {
      this.#store.state.committedEvents.push({
        sourceSeq,
        sourceEventId,
        eventType,
        priority,
        envelope: structuredClone(envelope),
        deliveryCount: 1,
        logicalEffectCount: 1,
      });
      if (this.#store.state.committedEvents.length > maxCommittedEventWindow) {
        this.#store.state.committedEvents.splice(
          0,
          this.#store.state.committedEvents.length - maxCommittedEventWindow,
        );
      }
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
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "PAPERCLIP_OPENCODE_COMMAND",
  "PAPERCLIP_OPENCODE_RUNTIME_DIR",
  "PAPERCLIP_RUNNER_INSTANCE_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_NORMALIZED_SESSION_ID",
  "PAPERCLIP_NATIVE_MCP_NAME",
  "PAPERCLIP_NATIVE_MCP_URL",
  "PAPERCLIP_NATIVE_MCP_TOKEN",
  "PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH",
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
  environment?: NodeJS.ProcessEnv;
  processLauncher?: (spec: RunnerProcessLaunchSpec) => RunnerProcessHandle;
}): RunnerProcessHandle {
  const connection = options.connection ?? (options.connectUrl
    ? { mode: "connect" as const, connectUrl: options.connectUrl }
    : null);
  if (connection === null) throw new Error("runner process connection is required");
  const connectionArgs = connection.mode === "connect"
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
      args.push("--idle-timeout-ms", String(options.lifecyclePolicy.idleTimeoutMs));
    }
  }

  const command = options.runnerBinaryPath ?? runnerBinary;
  const environment = runnerEnvironment(options.ticket, options.environment);
  const withRestart = (handle: RunnerProcessHandle): RunnerProcessHandle => ({
    ...handle,
    restart: (ticket) => spawnRunner({ ...options, ticket }),
  });
  if (options.processLauncher !== undefined) {
    return withRestart(options.processLauncher({ command, args, cwd: packageRoot, environment }));
  }

  const child = spawn(command, args, {
    cwd: packageRoot,
    env: environment,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-16_384);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const completion = new Promise<RunnerProcessResult>((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("exit", (code, signal) => resolveCompletion({ code, signal, stdout, stderr }));
  });
  return withRestart({ child, completion });
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
          handle.child.kill("SIGKILL");
          reject(new Error("Durable recovery runner timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
