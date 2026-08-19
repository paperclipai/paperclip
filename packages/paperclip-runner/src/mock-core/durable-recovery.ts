import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  DURABLE_RECOVERY_FAULTS,
  type DurableRecoveryCommittedEvent,
  type DurableRecoveryCoreCommand,
  type DurableRecoveryDiagnostics,
  type DurableRecoveryFault,
  type DurableRecoveryIdentity,
  type DurableRecoveryRunnerState,
  type DurableRecoveryRunTrace,
} from "../contracts/durable-recovery.js";

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
const protocol = "paperclip.runner";
const protocolVersion = 1;
const secureFrameSchema = "paperclip.runner.secure-frame.v1";
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const coreStateSchema = "paperclip.runner.durable.mock-core-state.v1";
const maxFrameBytes = 1024 * 1024;
const authChallengeTtlMs = 5_000;

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

interface MockCoreOptions {
  stateDirectory: string;
  identity: DurableRecoveryIdentity;
  fault: DurableRecoveryFault;
  expectedRunnerVersion?: string;
  expectedRunnerDigest?: string;
}

interface RunnerProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunnerProcessHandle {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<RunnerProcessResult>;
}

function domainDigest(domain: string, parts: readonly Buffer[]): Buffer {
  const digest = createHash("sha256").update(domain).update(Buffer.from([0]));
  for (const part of parts) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.length));
    digest.update(length).update(part);
  }
  return digest.digest();
}

function domainHmac(key: Buffer, domain: string, parts: readonly Buffer[]): Buffer {
  const digest = createHmac("sha256", key).update(domain).update(Buffer.from([0]));
  for (const part of parts) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.length));
    digest.update(length).update(part);
  }
  return digest.digest();
}

function credentialMaterial(token: string): { credentialId: string; authKey: Buffer } {
  const bytes = Buffer.from(token);
  return {
    credentialId: `sha256:${domainDigest("paperclip-runner-credential-id-v1", [bytes]).toString("hex")}`,
    authKey: domainDigest("paperclip-runner-auth-key-v1", [bytes]),
  };
}

function tokenDigest(token: string): string {
  return `sha256:${credentialMaterial(token).authKey.toString("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeDate(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function authKeyFromDigest(digest: string): Buffer {
  const hex = digest.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (hex === undefined) throw new Error("Stored transport authentication key is malformed.");
  return Buffer.from(hex, "hex");
}

function proofMatches(expected: Buffer, supplied: unknown): boolean {
  if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied)) return false;
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
    sendKey: domainHmac(authKey, "paperclip-runner-core-to-client-key-v1", [binding]),
    receiveKey: domainHmac(authKey, "paperclip-runner-client-to-core-key-v1", [binding]),
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
  return Buffer.from(`${secureFrameSchema}\0${channel.sessionId}\0${direction}\0${counter}`);
}

function encryptSecureJson(channel: SecureChannel, value: unknown): Record<string, unknown> {
  const counter = channel.sendCounter;
  const cipher = createCipheriv("aes-256-gcm", channel.sendKey, secureNonce("P3S1", counter));
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

function decryptSecureJson(channel: SecureChannel, value: unknown): Record<string, unknown> {
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
  if (sealed.length < 16) throw new Error("Secure frame authentication tag is missing.");
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
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
      throw new Error(`Private state directory does not use mode 0700: ${path}`);
    }
    if (process.geteuid !== undefined && metadata.uid !== process.geteuid()) {
      throw new Error(`Private state directory is not owned by the daemon user: ${path}`);
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
      throw new Error(`Private state file is not owned by the daemon user: ${path}`);
    }
  }
}

function readPrivateFile(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    verifyPrivateRegularFile(fstatSync(descriptor), path);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(
    dirname(path),
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicPrivateWrite(path: string, contents: string): void {
  const temporary = resolve(dirname(path), `.${path.split(/[\\/]/).at(-1)}.${randomUUID()}.tmp`);
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
        throw new Error(`Private state directory is not a real directory: ${directory}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    verifyPrivateDirectory(directory);
    this.path = resolve(directory, "mock-core-state.json");
    const stored = readPrivateFile(this.path);
    if (stored !== null) {
      this.#state = JSON.parse(stored) as StoredCoreState;
      if (
        this.#state.schema !== coreStateSchema ||
        canonicalJson(this.#state.identity) !== canonicalJson(identity)
      ) {
        throw new Error("Mock core state does not match the requested Durable recovery identity.");
      }
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

class MockWebSocketConnection {
  readonly socket: Duplex;
  pendingChallenge: PendingChallenge | null = null;
  secureChannel: SecureChannel | null = null;
  lease: ConnectionLeaseRecord | null = null;
  connectionId: string | null = null;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #onText: (text: string) => void;
  #onClose: () => void;

  constructor(
    socket: Duplex,
    onText: (text: string) => void,
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

  sendJson(value: unknown): void {
    const wire = this.secureChannel === null ? value : encryptSecureJson(this.secureChannel, value);
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
      const payload = Buffer.from(this.#buffer.subarray(cursor, cursor + length));
      this.#buffer = this.#buffer.subarray(cursor + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      if (opcode === 0x1) {
        this.#onText(payload.toString("utf8"));
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
    this.socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
  }
}

export class DurableRecoveryMockCore {
  readonly fault: DurableRecoveryFault;
  readonly identity: DurableRecoveryIdentity;
  readonly store: DurableCoreStore;
  #expectedRunnerVersion: string;
  #expectedRunnerDigest: string;
  #server: Server | null = null;
  #connections = new Set<MockWebSocketConnection>();
  #port: number | null = null;
  #faultTriggered = false;
  #replayCursorOverrideOnce = false;
  #faultTriggerResolve!: () => void;
  #faultTrigger = new Promise<void>((resolveFault) => {
    this.#faultTriggerResolve = resolveFault;
  });

  constructor(options: MockCoreOptions) {
    if (!DURABLE_RECOVERY_FAULTS.includes(options.fault)) {
      throw new Error(`Unsupported Durable recovery fault: ${options.fault}`);
    }
    this.fault = options.fault;
    this.identity = options.identity;
    this.store = new DurableCoreStore(options.stateDirectory, options.identity);
    this.#expectedRunnerVersion = options.expectedRunnerVersion ?? "0.3.0";
    this.#expectedRunnerDigest =
      options.expectedRunnerDigest ?? "sha256:durable-recovery-approved";
  }

  get connectUrl(): string {
    if (this.#port === null) {
      throw new Error("Durable recovery mock core is not listening.");
    }
    return `ws://127.0.0.1:${this.#port}/durableRecovery/connect`;
  }

  async start(port = 0): Promise<void> {
    if (this.#server !== null) {
      throw new Error("Durable recovery mock core is already running.");
    }
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.#server = server;
    server.on("upgrade", (request, socket) => this.#upgrade(request, socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Durable recovery mock core did not bind a TCP port.");
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
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }

  issueBootstrapTicket(ttlMs = 5_000): string {
    const ticket = `bootstrap_${randomUUID()}`;
    const material = credentialMaterial(ticket);
    const expiresAtUnixMs = Date.now() + ttlMs;
    this.store.state.tickets[material.credentialId] = {
      recordId: `bootstrap_ticket_${randomUUID()}`,
      credentialId: material.credentialId,
      authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
      identity: structuredClone(this.identity),
      runnerVersion: this.#expectedRunnerVersion,
      runnerDigest: this.#expectedRunnerDigest,
      expiresAt: new Date(expiresAtUnixMs).toISOString(),
      expiresAtUnixMs,
      usedAt: null,
    };
    this.store.state.freshBootstraps += 1;
    this.store.save();
    return ticket;
  }

  queueCommand(
    type: string,
    payload: Record<string, unknown> = {},
    commandId?: string,
  ): DurableRecoveryCoreCommand {
    const controllerSeq = this.store.state.commands.length + 1;
    const command: DurableRecoveryCoreCommand = {
      schema: "paperclip.prp.command.v1",
      commandId: commandId ?? `command_durableRecovery_${controllerSeq.toString().padStart(3, "0")}`,
      controllerSeq,
      type,
      issuedAt: `2026-08-07T23:30:${controllerSeq.toString().padStart(2, "0")}.000Z`,
      payload,
      status: "pending",
      result: null,
    };
    this.store.state.commands.push(command);
    this.store.save();
    return command;
  }

  waitForFaultTrigger(): Promise<void> {
    return this.#faultTrigger;
  }

  #triggerFault(): void {
    if (!this.#faultTriggered) {
      this.#faultTriggered = true;
      this.#faultTriggerResolve();
    }
  }

  #upgrade(request: IncomingMessage, socket: Duplex): void {
    if (request.url !== "/durableRecovery/connect") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const websocketKey = request.headers["sec-websocket-key"];
    if (typeof websocketKey !== "string") {
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
    const connection = new MockWebSocketConnection(
      socket,
      (text) => this.#handleText(connection, text),
      () => this.#connections.delete(connection),
    );
    this.#connections.add(connection);
  }

  #handleText(connection: MockWebSocketConnection, text: string): void {
    let envelope: Record<string, unknown>;
    try {
      const wire = JSON.parse(text) as unknown;
      envelope =
        connection.secureChannel === null
          ? (wire as Record<string, unknown>)
          : decryptSecureJson(connection.secureChannel, wire);
    } catch {
      this.store.state.malformedFrames += 1;
      this.store.save();
      connection.close();
      return;
    }
    if (envelope.protocol !== protocol || envelope.version !== protocolVersion) {
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
    if (connection.secureChannel === null || connection.lease === null) {
      connection.close();
      return;
    }
    if (kind === "event") {
      this.#event(connection, envelope);
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

  #authorizeHello(payload: Record<string, unknown>): PendingAuthorization | null {
    const credentialId = payload.credentialId;
    if (typeof credentialId !== "string") return null;
    const ticket = this.store.state.tickets[credentialId];
    const lease = this.store.state.leases[credentialId];
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
      (authorization.kind === "lease" && authorization.protocolVersion !== protocolVersion)
    ) {
      return null;
    }
    return authorization;
  }

  #reauthorizePendingChallenge(
    pending: PendingChallenge,
    now: number,
  ): LiveAuthorization | null {
    if (pending.deadlineUnixMs <= now) return null;
    const expected = pending.authorization;
    if (expected.kind === "bootstrap") {
      const ticket = this.store.state.tickets[expected.credentialId];
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

    const lease = this.store.state.leases[expected.credentialId];
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

  #authHello(connection: MockWebSocketConnection, envelope: Record<string, unknown>): void {
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
      credentialLeaseId: authorization.kind === "lease" ? authorization.leaseId : null,
      credentialExpiresAt: authorization.expiresAt,
      credentialExpiresAtUnixMs: authorization.expiresAtUnixMs,
      revocationEpoch: authorization.kind === "lease" ? authorization.revocationEpoch : 0,
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

  #authResponse(connection: MockWebSocketConnection, envelope: Record<string, unknown>): void {
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
    const authorization = this.#reauthorizePendingChallenge(pending, Date.now());
    if (authorization === null) {
      connection.close();
      return;
    }
    const expectedClientProof = domainHmac(
      authorization.authKey,
      "paperclip-runner-client-proof-v1",
      [Buffer.from(pending.canonicalChallenge), Buffer.from(pending.serverProof)],
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
      const ttlMs = this.fault === "lease-expiry" && !this.#faultTriggered ? 50 : 30_000;
      const expiresAtUnixMs = Date.now() + ttlMs;
      lease = {
        recordId: `connection_lease_record_${randomUUID()}`,
        credentialId: material.credentialId,
        authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
        leaseId: `connection_lease_${randomUUID()}`,
        identity: structuredClone(this.identity),
        protocolVersion,
        expiresAt: new Date(expiresAtUnixMs).toISOString(),
        expiresAtUnixMs,
        revocationEpoch: 0,
        revokedAt: null,
      };
      this.store.state.leases[material.credentialId] = lease;
      this.store.save();
    } else {
      lease = authorization.lease;
    }
    connection.pendingChallenge = null;
    connection.lease = lease;
    connection.connectionId = `connection_${this.store.state.connectionCount + 1}`;
    connection.secureChannel = createSecureChannel(
      authorization.authKey,
      pending.canonicalChallenge,
      pending.serverProof,
      clientProof,
    );
    this.#welcome(connection, leaseToken);
  }

  #welcome(connection: MockWebSocketConnection, leaseToken: string | null): void {
    const lease = connection.lease;
    if (lease === null || connection.connectionId === null) {
      connection.close();
      return;
    }

    this.store.state.connectionCount += 1;
    this.store.state.lastLeaseId = lease.leaseId;
    this.store.state.lastLeaseExpiresAt = lease.expiresAt;

    const reportedAck = this.#replayCursorOverrideOnce
      ? Math.max(0, this.store.state.ackedSourceSeq - 1)
      : this.store.state.ackedSourceSeq;
    this.#replayCursorOverrideOnce = false;
    const suppressPending =
      !this.#faultTriggered &&
      ["socket-drop", "malformed-input", "lease-expiry"].includes(this.fault);
    const pending = suppressPending ? [] : this.#nextPendingCommand();
    for (const command of pending) {
      this.store.state.commandDeliveryCounts[command.commandId] =
        (this.store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    }
    this.store.save();
    connection.sendJson({
      protocol,
      version: protocolVersion,
      envelopeId: `welcome_${this.store.state.connectionCount}`,
      kind: "welcome",
      runnerInstanceId: this.identity.runnerInstanceId,
      environmentLeaseId: this.identity.environmentLeaseId,
      runId: this.identity.runId,
      normalizedSessionId: this.identity.normalizedSessionId,
      turnId: this.identity.turnId,
      itemId: this.identity.itemId,
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
          runnerInstanceId: this.identity.runnerInstanceId,
          environmentLeaseId: this.identity.environmentLeaseId,
          runId: this.identity.runId,
          normalizedSessionId: this.identity.normalizedSessionId,
          protocolVersion,
        },
        maxFrameBytes,
        maxBatchEvents: 100,
        ackedSourceSeq: reportedAck,
        pendingCommands: pending.map(this.#wireCommand),
      },
    });

    if (suppressPending) {
      this.#triggerFault();
      if (this.fault === "malformed-input") {
        this.store.state.malformedFrames += 1;
        this.store.save();
        connection.sendText('{"kind":');
      }
      if (this.fault === "lease-expiry") {
        lease.expiresAt = safeDate(-1);
        lease.expiresAtUnixMs = Date.now() - 1;
        this.store.state.lastLeaseExpiresAt = lease.expiresAt;
        this.store.save();
      }
      setTimeout(() => connection.close(), 5);
    }
  }

  #wireCommand(command: DurableRecoveryCoreCommand): Omit<DurableRecoveryCoreCommand, "status" | "result"> {
    const { status: _status, result: _result, ...wire } = command;
    return wire;
  }

  #nextPendingCommand(): DurableRecoveryCoreCommand[] {
    const command = this.store.state.commands.find((candidate) => candidate.status === "pending");
    return command === undefined ? [] : [command];
  }

  #controlEnvelope(
    connection: MockWebSocketConnection,
    envelopeId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (connection.lease === null || connection.connectionId === null) {
      throw new Error("Cannot send control data before transport authentication.");
    }
    return {
      protocol,
      version: protocolVersion,
      envelopeId,
      kind,
      runnerInstanceId: this.identity.runnerInstanceId,
      environmentLeaseId: this.identity.environmentLeaseId,
      runId: this.identity.runId,
      normalizedSessionId: this.identity.normalizedSessionId,
      turnId: this.identity.turnId,
      itemId: this.identity.itemId,
      connectionId: connection.connectionId,
      connectionLeaseId: connection.lease.leaseId,
      sentAt: new Date().toISOString(),
      payload,
    };
  }

  #sendNextCommand(connection: MockWebSocketConnection): void {
    const [command] = this.#nextPendingCommand();
    if (command === undefined) return;
    this.store.state.commandDeliveryCounts[command.commandId] =
      (this.store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    this.store.save();
    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `command_${command.commandId}_${this.store.state.commandDeliveryCounts[command.commandId]}`,
        "command",
        this.#wireCommand(command),
      ),
    );
  }

  #commandResult(
    connection: MockWebSocketConnection,
    envelope: Record<string, unknown>,
  ): void {
    const result = envelope.payload as Record<string, unknown> | undefined;
    const commandId = result?.commandId;
    if (result === undefined || typeof commandId !== "string") {
      connection.close();
      return;
    }
    const command = this.store.state.commands.find((candidate) => candidate.commandId === commandId);
    if (command === undefined) {
      connection.close();
      return;
    }
    if (this.fault === "duplicate-command" && !this.#faultTriggered) {
      this.#triggerFault();
      connection.close();
      return;
    }
    if (command.status !== "pending") {
      this.store.state.duplicateCommandResults += 1;
    }
    const status = result.status;
    command.status =
      status === "completed" || status === "failed" || status === "rejected"
        ? status
        : "failed";
    command.result = structuredClone(result);
    this.store.save();
    this.#sendNextCommand(connection);
  }

  #event(connection: MockWebSocketConnection, envelope: Record<string, unknown>): void {
    const event = envelope.payload as Record<string, unknown> | undefined;
    const sourceSeq = event?.sourceSeq;
    const sourceEventId = event?.sourceEventId;
    const eventType = event?.eventType;
    const priority = event?.priority;
    if (
      typeof sourceSeq !== "number" ||
      typeof sourceEventId !== "string" ||
      typeof eventType !== "string" ||
      (priority !== 0 && priority !== 1 && priority !== 2) ||
      event?.sourceInstanceId !== this.identity.runnerInstanceId ||
      event.runId !== this.identity.runId ||
      event.normalizedSessionId !== this.identity.normalizedSessionId ||
      event.turnId !== this.identity.turnId
    ) {
      connection.close();
      return;
    }
    const existing = this.store.state.committedEvents.find(
      (candidate) => candidate.sourceEventId === sourceEventId,
    );
    if (existing !== undefined) {
      if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
        connection.close();
        return;
      }
      existing.deliveryCount += 1;
      this.store.state.replayDeliveries += 1;
    } else {
      if (sourceSeq !== this.store.state.ackedSourceSeq + 1) {
        connection.close();
        return;
      }
      this.store.state.committedEvents.push({
        sourceSeq,
        sourceEventId,
        eventType,
        priority,
        envelope: structuredClone(envelope),
        deliveryCount: 1,
        logicalEffectCount: 1,
      });
      this.store.state.ackedSourceSeq = sourceSeq;
    }
    this.store.save();

    if (this.fault === "revoke" && eventType === "run.terminal" && !this.#faultTriggered) {
      if (connection.lease !== null) {
        connection.lease.revokedAt = new Date().toISOString();
        connection.lease.revocationEpoch += 1;
      }
      this.queueCommand(
        "turn.start",
        { turnId: this.identity.turnId, text: "must be rejected after revoke" },
        "command_after_revoke",
      );
      this.#triggerFault();
      this.store.save();
      // Revoke before ACK so the runner must flush a genuinely non-empty durable outbox.
      connection.sendJson(
        this.#controlEnvelope(connection, "revoke_durableRecovery", "revoke", {
          reason: "fault_injection_revoke",
          drain: true,
          revocationEpoch: connection.lease?.revocationEpoch,
        }),
      );
      this.#sendNextCommand(connection);
      return;
    }

    const shouldLoseAck =
      !this.#faultTriggered && (this.fault === "lost-ack" || this.fault === "runner-restart");
    if (shouldLoseAck) {
      this.#replayCursorOverrideOnce = true;
      this.#triggerFault();
      if (this.fault === "lost-ack") {
        connection.close();
      }
      return;
    }

    connection.sendJson(
      this.#controlEnvelope(connection, `ack_${this.store.state.ackedSourceSeq}`, "ack", {
        ackedSourceSeq: this.store.state.ackedSourceSeq,
      }),
    );
  }
}

function runnerEnvironment(ticket: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: ticket,
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function spawnRunner(options: {
  connectUrl: string;
  stateDirectory: string;
  identity: DurableRecoveryIdentity;
  ticket: string;
  maxOutboxBytes: number;
  p0ReserveBytes: number;
}): RunnerProcessHandle {
  const args = [
    "--connect-url",
    options.connectUrl,
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
    "0.3.0",
    "--runner-digest",
    "sha256:durable-recovery-approved",
    "--fake-harness",
    fakeHarnessBinary,
    "--fake-harness-script",
    fakeHarnessScript,
    "--max-outbox-bytes",
    String(options.maxOutboxBytes),
    "--p0-reserve-bytes",
    String(options.p0ReserveBytes),
    "--reconnect-delay-ms",
    "20",
    "--max-runtime-ms",
    "10000",
  ];
  const child = spawn(runnerBinary, args, {
    cwd: packageRoot,
    env: runnerEnvironment(options.ticket),
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
  return { child, completion };
}

async function waitForProcess(
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

function durableRecoveryIdentity(): DurableRecoveryIdentity {
  return {
    runnerInstanceId: "runner_durableRecovery_stable",
    environmentLeaseId: "environment_lease_durableRecovery_stable",
    runId: "run_durableRecovery_stable",
    normalizedSessionId: "session_durableRecovery_stable",
    turnId: "turn_durableRecovery_stable",
    itemId: "item_durableRecovery_stable",
  };
}

function queueScenario(core: DurableRecoveryMockCore, fault: DurableRecoveryFault): void {
  core.queueCommand("run.prepare", { workspace: "durable-recovery-durable-fixture" });
  core.queueCommand("session.open", { reuse: "same_session" });
  if (fault === "harness-restart") {
    core.queueCommand("fault.harness_restart", {});
  }
  if (fault === "storage-pressure") {
    core.queueCommand("fault.storage_pressure", {});
  }
  if (fault === "drain") {
    core.queueCommand("runner.drain", {});
  }
  core.queueCommand("turn.start", {
    turnId: core.identity.turnId,
    text: "Prove Durable recovery.",
  });
  if (fault !== "revoke") {
    core.queueCommand("runner.shutdown", {});
  }
}

function readRunnerState(stateDirectory: string): DurableRecoveryRunnerState {
  return JSON.parse(
    readFileSync(resolve(stateDirectory, "runner-state.json"), "utf8"),
  ) as DurableRecoveryRunnerState;
}

function assertContinuous(events: readonly DurableRecoveryCommittedEvent[]): boolean {
  return events
    .toSorted((left, right) => left.sourceSeq - right.sourceSeq)
    .every((event, index) => event.sourceSeq === index + 1);
}

function secretLeakCount(paths: readonly string[], secrets: readonly string[]): number {
  let leaks = 0;
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    for (const secret of secrets) {
      if (secret.length > 0 && source.includes(secret)) leaks += 1;
    }
  }
  return leaks;
}

function persistedCapabilityShape(path: string, fieldNames: readonly string[]): boolean {
  const source = readFileSync(path, "utf8");
  return fieldNames.some((fieldName) => source.includes(`\"${fieldName}\"`));
}

export interface RunDurableRecoveryRecoveryOptions {
  fault?: DurableRecoveryFault;
  stateDirectory?: string;
  keepState?: boolean;
}

export async function runDurableRecoveryRecovery(
  options: RunDurableRecoveryRecoveryOptions = {},
): Promise<DurableRecoveryRunTrace> {
  const fault = options.fault ?? "lost-ack";
  const identity = durableRecoveryIdentity();
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
    process.env.PAPERCLIP_SCRATCH_DIR ??
    tmpdir();
  const root =
    options.stateDirectory ??
    mkdtempSync(resolve(scratchRoot, `paperclip-runner-durable-recovery-${fault}-`));
  const runnerStateDirectory = resolve(root, "runner");
  const coreStateDirectory = resolve(root, "mock-core");
  mkdirSync(runnerStateDirectory, { recursive: true, mode: 0o700 });
  const core = new DurableRecoveryMockCore({
    stateDirectory: coreStateDirectory,
    identity,
    fault,
  });
  queueScenario(core, fault);
  await core.start();
  const tickets: string[] = [];
  let runnerRestarts = 0;
  const maxOutboxBytes = fault === "storage-pressure" ? 16 * 1024 : 64 * 1024;
  const p0ReserveBytes = fault === "storage-pressure" ? 8 * 1024 : 32 * 1024;

  const launch = (): RunnerProcessHandle => {
    const ticket = core.issueBootstrapTicket();
    tickets.push(ticket);
    return spawnRunner({
      connectUrl: core.connectUrl,
      stateDirectory: runnerStateDirectory,
      identity,
      ticket,
      maxOutboxBytes,
      p0ReserveBytes,
    });
  };

  let handle = launch();
  let result: RunnerProcessResult;
  try {
    if (fault === "runner-restart") {
      await core.waitForFaultTrigger();
      handle.child.kill("SIGKILL");
      await waitForProcess(handle);
      runnerRestarts += 1;
      handle = launch();
    } else if (fault === "lease-expiry") {
      const expired = await waitForProcess(handle);
      if (expired.code === 0) {
        throw new Error("Lease-expiry injection did not produce a recoverable restart boundary.");
      }
      runnerRestarts += 1;
      handle = launch();
    }
    result = await waitForProcess(handle);
    if (result.code !== 0) {
      throw new Error(
        `Durable recovery runner exited with code ${String(result.code)}: ${result.stderr.trim()}`,
      );
    }
  } finally {
    await core.stop();
  }

  const runnerState = readRunnerState(runnerStateDirectory);
  const coreState = core.store.state;
  const runnerStatePath = resolve(runnerStateDirectory, "runner-state.json");
  const leaks = secretLeakCount(
    [runnerStatePath, core.store.path],
    [...tickets, "must-not-persist"],
  );
  const bootstrapTicketPersisted = persistedCapabilityShape(
    runnerStatePath,
    ["bootstrapTicket", "bootstrap_ticket"],
  );
  const connectionLeaseTokenPersisted = persistedCapabilityShape(
    runnerStatePath,
    ["connectionLeaseToken", "connection_lease_token"],
  );
  const committedEvents = coreState.committedEvents.toSorted(
    (left, right) => left.sourceSeq - right.sourceSeq,
  );
  const p0Committed = committedEvents.filter((event) => event.priority === 0).length;
  const completedCommands = coreState.commands.filter(
    (command) => command.status === "completed",
  );
  const rejectedCommands = coreState.commands.filter(
    (command) => command.status === "rejected",
  );
  const logicalEffects = coreState.commands.reduce(
    (sum, command) =>
      sum +
      (typeof command.result?.logicalEffectCount === "number"
        ? command.result.logicalEffectCount
        : 0),
    0,
  );
  const duplicateDeliveries = Object.values(coreState.commandDeliveryCounts).reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const outcome: DurableRecoveryDiagnostics["recovery"]["outcome"] =
    fault === "drain"
      ? "drained"
      : fault === "revoke"
        ? "revoked"
        : runnerState.unrecoverableOutcome === null
          ? "recovered"
          : "unrecoverable";
  const diagnostics: DurableRecoveryDiagnostics = {
    schema: "paperclip.runner.durable.diagnostics.v1",
    fault,
    connection: {
      state: runnerState.lifecycle,
      connectionCount: coreState.connectionCount,
      reconnectCount: runnerState.reconnectCount,
      leaseId: coreState.lastLeaseId,
      leaseExpiresAt: coreState.lastLeaseExpiresAt,
    },
    identity,
    cursors: {
      runnerAckedSourceSeq: runnerState.ackedSourceSeq,
      runnerNextSourceSeq: runnerState.nextSourceSeq,
      coreAckedSourceSeq: coreState.ackedSourceSeq,
      highestCommittedSourceSeq: committedEvents.at(-1)?.sourceSeq ?? 0,
    },
    outbox: {
      events: runnerState.outbox.length,
      bytes: runnerState.outbox.reduce((sum, event) => sum + event.byteSize, 0),
      peakBytes: runnerState.peakOutboxBytes,
      maxBytes: maxOutboxBytes,
      backpressure: runnerState.backpressure,
      p0Committed,
      p0Lost: runnerState.ackedSourceSeq === coreState.ackedSourceSeq ? 0 : p0Committed,
    },
    commands: {
      issued: coreState.commands.length,
      completed: completedCommands.length,
      rejected: rejectedCommands.length,
      logicalEffects,
      duplicateDeliveries,
    },
    recovery: {
      replayDeliveries: coreState.replayDeliveries,
      runnerRestarts,
      harnessRestarts: Math.max(0, runnerState.harnessGeneration - 1),
      malformedFrames: coreState.malformedFrames,
      freshBootstraps: coreState.freshBootstraps,
      outcome,
      reason:
        runnerState.unrecoverableOutcome ??
        runnerState.recoverableFailure ??
        `${fault.replaceAll("-", "_")}_completed`,
    },
    security: {
      bootstrapTicketPersisted,
      connectionLeaseTokenPersisted,
      secretLeakCount: leaks,
    },
    committedEvents,
  };
  const acceptedWithTooManyEffects = coreState.commands.some((command) => {
    const effectCount = command.result?.logicalEffectCount;
    return command.status === "completed" && effectCount !== 1;
  });
  const trace: DurableRecoveryRunTrace = {
    schema: "paperclip.runner.durable.trace.v1",
    diagnostics,
    runnerState,
    commands: structuredClone(coreState.commands),
    assertions: {
      stableIdentity:
        canonicalJson(identity) ===
        canonicalJson({
          runnerInstanceId: runnerState.runnerInstanceId,
          environmentLeaseId: runnerState.environmentLeaseId,
          runId: runnerState.runId,
          normalizedSessionId: runnerState.normalizedSessionId,
          turnId: runnerState.turnId,
          itemId: runnerState.itemId,
        }),
      sourceCursorContinuous:
        assertContinuous(committedEvents) &&
        runnerState.ackedSourceSeq === coreState.ackedSourceSeq,
      oneLogicalEffectPerAcceptedCommand: !acceptedWithTooManyEffects,
      noDuplicateLogicalEvents: committedEvents.every(
        (event) => event.logicalEffectCount === 1,
      ),
      p0Preserved: diagnostics.outbox.p0Lost === 0,
      boundedStorage:
        diagnostics.outbox.bytes <= maxOutboxBytes &&
        runnerState.peakOutboxBytes <= maxOutboxBytes,
      secretsRedacted:
        leaks === 0 &&
        !bootstrapTicketPersisted &&
        !connectionLeaseTokenPersisted,
    },
  };

  if (options.keepState !== true && options.stateDirectory === undefined) {
    rmSync(root, { recursive: true, force: true });
  }
  return trace;
}

export const durableRecoveryInternals = {
  runnerBinary,
  runnerEnvironment,
  credentialMaterial,
  tokenDigest,
  canonicalJson,
  durableRecoveryIdentity,
};
