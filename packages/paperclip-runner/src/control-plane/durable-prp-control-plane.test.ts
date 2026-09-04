import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validatePrpEvent } from "../protocol/replay-contract.js";
import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";
import {
  DurablePrpControlPlane,
  spawnRunner,
  type RunnerProcessLaunchSpec,
} from "./durable-prp-control-plane.js";
import type { DurableRecoveryIdentity } from "./prp-transport-types.js";

const identity: DurableRecoveryIdentity = {
  runnerInstanceId: "runner-test-1",
  environmentLeaseId: "environment-test-1",
  runId: "00000000-0000-4000-8000-000000000001",
  normalizedSessionId: "session-test-1",
  turnId: "turn-test-1",
  itemId: "item-test-1",
};
const expectedRunnerVersion = "0.3.0";
const expectedRunnerDigest = `sha256:${"a".repeat(64)}`;

it("pins the ACPX launch profile in runner startup arguments and restarts", () => {
  const launches: RunnerProcessLaunchSpec[] = [];
  const handle = spawnRunner({
    connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" },
    stateDirectory: "/tmp/paperclip-runner-test",
    identity,
    ticket: "bootstrap-ticket",
    maxOutboxBytes: 256 * 1024,
    p0ReserveBytes: 64 * 1024,
    runnerVersion: expectedRunnerVersion,
    runnerDigest: expectedRunnerDigest,
    acpxLaunchProfile: {
      authorityDigest: `sha256:${"d".repeat(64)}`,
      command: "/provider-pack/node",
      commandSha256: `sha256:${"b".repeat(64)}`,
      sidecarScript: "/provider-pack/acpx-sidecar.js",
      sidecarScriptSha256: `sha256:${"c".repeat(64)}`,
    },
    processLauncher: (spec) => {
      launches.push(spec);
      return {
        child: {
          pid: 42,
          exitCode: null,
          signalCode: null,
          kill: () => true,
        },
        completion: Promise.resolve({
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
        }),
      };
    },
  });

  handle.restart("replacement-ticket");
  expect(launches).toHaveLength(2);
  for (const launch of launches) {
    expect(launch.args).toContain("--acpx-launch-authority-digest");
    expect(launch.args).toContain("--acpx-sidecar-command");
    expect(launch.args).toContain(`sha256:${"d".repeat(64)}`);
    expect(launch.args).toContain("/provider-pack/node");
    expect(launch.args).toContain(`sha256:${"b".repeat(64)}`);
    expect(launch.args).toContain("/provider-pack/acpx-sidecar.js");
    expect(launch.args).toContain(`sha256:${"c".repeat(64)}`);
  }
});

it("pins the OpenCode launch profile in runner startup arguments and restarts", () => {
  const launches: RunnerProcessLaunchSpec[] = [];
  const profile = {
    command: "/provider-pack/node",
    commandSha256: `sha256:${"b".repeat(64)}`,
    proxyScript: "/provider-pack/opencode-proxy.js",
    proxyScriptSha256: `sha256:${"c".repeat(64)}`,
    executable: "/provider-pack/opencode.exe",
    executableSha256: `sha256:${"d".repeat(64)}`,
  };
  const handle = spawnRunner({
    connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" },
    stateDirectory: "/tmp/paperclip-runner-test",
    identity,
    ticket: "bootstrap-ticket",
    maxOutboxBytes: 256 * 1024,
    p0ReserveBytes: 64 * 1024,
    runnerVersion: expectedRunnerVersion,
    runnerDigest: expectedRunnerDigest,
    opencodeLaunchProfile: profile,
    processLauncher: (spec) => {
      launches.push(spec);
      return {
        child: {
          pid: 42,
          exitCode: null,
          signalCode: null,
          kill: () => true,
        },
        completion: Promise.resolve({
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
        }),
      };
    },
  });

  handle.restart("replacement-ticket");
  expect(launches).toHaveLength(2);
  for (const launch of launches) {
    expect(launch.args).toEqual(expect.arrayContaining([
      "--opencode-proxy-command",
      profile.command,
      "--opencode-proxy-command-sha256",
      profile.commandSha256,
      "--opencode-proxy-script",
      profile.proxyScript,
      "--opencode-proxy-script-sha256",
      profile.proxyScriptSha256,
      "--opencode-executable",
      profile.executable,
      "--opencode-executable-sha256",
      profile.executableSha256,
    ]));
  }
});

it("preserves an explicit OpenCode permission mode at the runner spawn boundary", () => {
  const launches: RunnerProcessLaunchSpec[] = [];
  spawnRunner({
    connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" },
    stateDirectory: "/tmp/paperclip-runner-test",
    identity,
    ticket: "bootstrap-ticket",
    maxOutboxBytes: 256 * 1024,
    p0ReserveBytes: 64 * 1024,
    runnerVersion: expectedRunnerVersion,
    runnerDigest: expectedRunnerDigest,
    environment: {
      PATH: "/bin",
      OPENROUTER_API_KEY: "provider-key",
      PAPERCLIP_OPENCODE_PERMISSION_MODE: "deny",
      PAPERCLIP_OPENCODE_RUNTIME_DIR: "/runner/opencode",
      DATABASE_URL: "must-not-reach-runnerd",
      PAPERCLIP_API_KEY: "must-not-reach-runnerd",
      NODE_OPTIONS: "--require=/untrusted/bootstrap.cjs",
    },
    processLauncher: (spec) => {
      launches.push(spec);
      return {
        child: {
          pid: 42,
          exitCode: null,
          signalCode: null,
          kill: () => true,
        },
        completion: Promise.resolve({
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
        }),
      };
    },
  });

  expect(launches).toHaveLength(1);
  expect(launches[0]!.environment).toMatchObject({
    PATH: "/bin",
    OPENROUTER_API_KEY: "provider-key",
    PAPERCLIP_OPENCODE_PERMISSION_MODE: "deny",
    PAPERCLIP_OPENCODE_RUNTIME_DIR: "/runner/opencode",
  });
  expect(launches[0]!.environment.DATABASE_URL).toBeUndefined();
  expect(launches[0]!.environment.PAPERCLIP_API_KEY).toBeUndefined();
  expect(launches[0]!.environment.NODE_OPTIONS).toBeUndefined();
  expect(launches[0]!.environment.PAPERCLIP_OPENCODE_COMMAND).toBeUndefined();
});

it("preserves file-backed AWS workload identity at the runner spawn boundary", () => {
  const launches: RunnerProcessLaunchSpec[] = [];
  spawnRunner({
    connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" },
    stateDirectory: "/tmp/paperclip-runner-test",
    identity,
    ticket: "bootstrap-ticket",
    maxOutboxBytes: 256 * 1024,
    p0ReserveBytes: 64 * 1024,
    runnerVersion: expectedRunnerVersion,
    runnerDigest: expectedRunnerDigest,
    environment: {
      AWS_PROFILE: "host-profile",
      AWS_CONFIG_FILE: "/host/home/.aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/host/home/.aws/credentials",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9001/credentials",
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/identity/container-token",
      AWS_ACCESS_KEY_ID: "must-not-reach-runnerd",
      AWS_SECRET_ACCESS_KEY: "must-not-reach-runnerd",
    },
    processLauncher: (spec) => {
      launches.push(spec);
      return {
        child: {
          pid: 42,
          exitCode: null,
          signalCode: null,
          kill: () => true,
        },
        completion: Promise.resolve({
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
        }),
      };
    },
  });

  expect(launches).toHaveLength(1);
  expect(launches[0]!.environment).toMatchObject({
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9001/credentials",
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/identity/container-token",
  });
  expect(launches[0]!.environment.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(launches[0]!.environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(launches[0]!.environment.AWS_PROFILE).toBeUndefined();
  expect(launches[0]!.environment.AWS_CONFIG_FILE).toBeUndefined();
  expect(launches[0]!.environment.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
});

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function credentialMaterial(token: string): {
  credentialId: string;
  authKey: Buffer;
} {
  const bytes = Buffer.from(token);
  const authKey = domainDigest("paperclip-runner-auth-key-v1", [bytes]);
  return {
    credentialId: `sha256:${domainDigest("paperclip-runner-credential-id-v1", [bytes]).toString("hex")}`,
    authKey,
  };
}

class ServerFrameReader {
  #buffer = Buffer.alloc(0);
  #frames: Array<Record<string, unknown> | null> = [];
  #waiters: Array<(value: Record<string, unknown> | null) => void> = [];

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    socket.once("close", () => this.#publish(null));
  }

  next(): Promise<Record<string, unknown> | null> {
    const queued = this.#frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolveFrame, rejectFrame) => {
      const timer = setTimeout(
        () => rejectFrame(new Error("Server WebSocket frame timed out.")),
        2_000,
      );
      this.#waiters.push((value) => {
        clearTimeout(timer);
        resolveFrame(value);
      });
    });
  }

  #publish(value: Record<string, unknown> | null): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#frames.push(value);
  }

  #drain(): void {
    while (this.#buffer.length >= 2) {
      let length = this.#buffer[1]! & 0x7f;
      let cursor = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        cursor = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        cursor = 10;
      }
      if (this.#buffer.length < cursor + length) return;
      const payload = this.#buffer.subarray(cursor, cursor + length);
      this.#buffer = this.#buffer.subarray(cursor + length);
      this.#publish(
        JSON.parse(payload.toString("utf8")) as Record<string, unknown>,
      );
    }
  }
}

async function upgradeSocket(url: string): Promise<{
  socket: Socket;
  reader: ServerFrameReader;
}> {
  const parsed = new URL(url);
  const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
    const candidate = connect(Number(parsed.port), parsed.hostname);
    let response = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      candidate.off("data", onData);
      const status = Number(
        response.toString("utf8").match(/^HTTP\/1\.1 (\d{3})/)?.[1],
      );
      if (status !== 101) {
        candidate.destroy();
        rejectSocket(new Error(`WebSocket upgrade returned ${String(status)}`));
      } else {
        resolveSocket(candidate);
      }
    };
    candidate.once("error", rejectSocket);
    candidate.once("connect", () => {
      candidate.write(
        [
          `GET ${parsed.pathname} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      );
    });
    candidate.on("data", onData);
  });
  return { socket, reader: new ServerFrameReader(socket) };
}

function sendMaskedJson(socket: Socket, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header: number[] = [0x81];
  if (payload.length <= 125) {
    header.push(0x80 | payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(0x80 | 126, payload.length >>> 8, payload.length & 0xff);
  } else {
    throw new Error("Test client frame exceeds the supported size.");
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = masked[index]! ^ mask[index % mask.length]!;
  }
  socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
}

interface AuthenticatedClient {
  socket: Socket;
  reader: ServerFrameReader;
  authKey: Buffer;
  sessionId: string;
  sendCounter: bigint;
  receiveCounter: bigint;
  leaseToken: string | null;
  welcome: Record<string, unknown>;
}

function authHello(
  credentialId: string,
  selectedIdentity: DurableRecoveryIdentity = identity,
): Record<string, unknown> {
  return {
    protocol: "paperclip.runner",
    version: 1,
    kind: "auth_hello",
    payload: {
      credentialId,
      clientNonce: "client-nonce-test",
      protocolMin: 1,
      protocolMax: 1,
      ...selectedIdentity,
      runnerVersion: expectedRunnerVersion,
      runnerDigest: expectedRunnerDigest,
    },
  };
}

async function authenticate(
  controlPlane: DurablePrpControlPlane,
  token: string,
  selectedIdentity: DurableRecoveryIdentity = identity,
): Promise<AuthenticatedClient | null> {
  const { socket, reader } = await upgradeSocket(controlPlane.connectUrl);
  const material = credentialMaterial(token);
  sendMaskedJson(socket, authHello(material.credentialId, selectedIdentity));
  const challenge = await reader.next();
  if (challenge === null) return null;
  const challengePayload = challenge.payload as Record<string, unknown>;
  const serverProof = challengePayload.serverProof;
  if (typeof serverProof !== "string") throw new Error("Missing server proof.");
  const canonicalPayload = { ...challengePayload };
  delete canonicalPayload.serverProof;
  const canonicalChallenge = canonicalJson(canonicalPayload);
  const expectedServerProof = domainHmac(
    material.authKey,
    "paperclip-runner-server-proof-v1",
    [Buffer.from(canonicalChallenge)],
  ).toString("hex");
  expect(serverProof).toBe(expectedServerProof);
  const clientProof = domainHmac(
    material.authKey,
    "paperclip-runner-client-proof-v1",
    [Buffer.from(canonicalChallenge), Buffer.from(serverProof)],
  ).toString("hex");
  sendMaskedJson(socket, {
    protocol: "paperclip.runner",
    version: 1,
    kind: "auth_response",
    payload: {
      credentialId: material.credentialId,
      clientNonce: challengePayload.clientNonce,
      serverNonce: challengePayload.serverNonce,
      clientProof,
    },
  });
  const binding = domainDigest("paperclip-runner-session-binding-v1", [
    Buffer.from(canonicalChallenge),
    Buffer.from(serverProof),
    Buffer.from(clientProof),
  ]);
  const client: AuthenticatedClient = {
    socket,
    reader,
    authKey: material.authKey,
    sessionId: `sha256:${binding.toString("hex")}`,
    sendCounter: 0n,
    receiveCounter: 0n,
    leaseToken: null,
    welcome: {},
  };
  const welcome = await receiveSecure(client);
  if (welcome === null) return null;
  expect(welcome.kind).toBe("welcome");
  client.welcome = welcome;
  const leaseToken = (welcome.payload as Record<string, unknown>)
    .connectionLeaseToken;
  client.leaseToken = typeof leaseToken === "string" ? leaseToken : null;
  return client;
}

function secureNonce(prefix: "P3C1" | "P3S1", counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.write(prefix, 0, "ascii");
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

function secureAad(
  client: AuthenticatedClient,
  direction: "client_to_core" | "core_to_client",
  counter: bigint,
): Buffer {
  return Buffer.from(
    `paperclip.runner.secure-frame.v1\0${client.sessionId}\0${direction}\0${counter}`,
  );
}

function sendSecure(
  client: AuthenticatedClient,
  value: Record<string, unknown>,
): void {
  const binding = Buffer.from(client.sessionId.slice("sha256:".length), "hex");
  const key = domainHmac(
    client.authKey,
    "paperclip-runner-client-to-core-key-v1",
    [binding],
  );
  const counter = client.sendCounter;
  const cipher = createCipheriv(
    "aes-256-gcm",
    key,
    secureNonce("P3C1", counter),
  );
  cipher.setAAD(secureAad(client, "client_to_core", counter));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  sendMaskedJson(client.socket, {
    schema: "paperclip.runner.secure-frame.v1",
    counter: Number(counter),
    ciphertext: encrypted.toString("hex"),
  });
  client.sendCounter += 1n;
}

async function receiveSecure(
  client: AuthenticatedClient,
): Promise<Record<string, unknown> | null> {
  const frame = await client.reader.next();
  if (frame === null) return null;
  const counter = BigInt(frame.counter as number);
  expect(counter).toBe(client.receiveCounter);
  const binding = Buffer.from(client.sessionId.slice("sha256:".length), "hex");
  const key = domainHmac(
    client.authKey,
    "paperclip-runner-core-to-client-key-v1",
    [binding],
  );
  const sealed = Buffer.from(String(frame.ciphertext), "hex");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    secureNonce("P3S1", counter),
  );
  decipher.setAAD(secureAad(client, "core_to_client", counter));
  decipher.setAuthTag(sealed.subarray(-16));
  const value = JSON.parse(
    Buffer.concat([
      decipher.update(sealed.subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8"),
  ) as Record<string, unknown>;
  client.receiveCounter += 1n;
  return value;
}

function semanticInputEvent(sourceSeq = 1): Record<string, unknown> {
  return {
    protocol: "paperclip.runner",
    version: 1,
    kind: "event",
    runnerInstanceId: identity.runnerInstanceId,
    environmentLeaseId: identity.environmentLeaseId,
    runId: identity.runId,
    normalizedSessionId: identity.normalizedSessionId,
    turnId: identity.turnId,
    itemId: identity.itemId,
    payload: {
      sourceSeq,
      sourceEventId: `semantic-event-${sourceSeq}`,
      sourceInstanceId: identity.runnerInstanceId,
      sourceKind: "runner",
      runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId,
      turnId: identity.turnId,
      itemId: identity.itemId,
      eventType: "semantic_tool.input",
      schema: "paperclip.prp.event.v1",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-25T18:00:00.000Z",
      payload: {
        semantic_tool: {
          schema: "paperclip.prp.semantic_tool.v1",
          schemaVersion: 1,
          phase: "input",
          callId: "call-1",
          operationId: "get_task_context",
          correlation: {
            runId: identity.runId,
            normalizedSessionId: identity.normalizedSessionId,
            turnId: identity.turnId,
            itemId: identity.itemId,
          },
          idempotencyKey: null,
          content: {
            digest: digestPaperclipSemanticContent({}),
            redactionDisposition: "digest_only",
            references: [],
          },
          input: {},
        },
      },
    },
  };
}

describe.sequential("DurablePrpControlPlane", () => {
  it("exchanges a one-use bootstrap for a run-bound reconnect lease", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-prp-auth-"));
    const controlPlane = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    try {
      await controlPlane.start();
      const cancel = controlPlane.queueCommand(
        "run.cancel",
        { reason: "test" },
        "command-cancel-1",
      );
      expect(
        controlPlane.queueCommand(
          "run.cancel",
          { reason: "test" },
          "command-cancel-1",
        ),
      ).toEqual(cancel);
      expect(() =>
        controlPlane.queueCommand(
          "run.cancel",
          { reason: "different" },
          "command-cancel-1",
        ),
      ).toThrow("command replay conflicts");
      expect(() => controlPlane.queueCommand("unknown.command")).toThrow(
        "command is invalid",
      );
      const ticket = controlPlane.issueBootstrapTicket();
      const first = await authenticate(controlPlane, ticket);
      expect(first?.leaseToken).toEqual(expect.any(String));
      first?.socket.destroy();

      const reused = await authenticate(controlPlane, ticket);
      expect(reused).toBeNull();

      const lease = await authenticate(controlPlane, first!.leaseToken!);
      expect(lease).not.toBeNull();
      expect(lease?.leaseToken).toBeNull();
      lease?.socket.destroy();

      const wrongRun = await authenticate(
        controlPlane,
        controlPlane.issueBootstrapTicket(),
        {
          ...identity,
          runId: "00000000-0000-4000-8000-000000000999",
        },
      );
      expect(wrongRun).toBeNull();
    } finally {
      await controlPlane.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers one semantic call from the durable event after a coordinator restart", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-prp-recovery-"));
    let firstCalls = 0;
    const first = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onSemanticToolInput: async () => {
        firstCalls += 1;
        return new Promise(() => undefined);
      },
    });
    let leaseToken: string;
    try {
      await first.start();
      const client = await authenticate(first, first.issueBootstrapTicket());
      leaseToken = client!.leaseToken!;
      const validation = validatePrpEvent(semanticInputEvent().payload);
      expect(validation, JSON.stringify(validation)).toMatchObject({
        ok: true,
      });
      sendSecure(client!, semanticInputEvent());
      const ack = await receiveSecure(client!);
      expect(ack).toMatchObject({ kind: "ack" });
      expect(firstCalls).toBe(1);
      client?.socket.destroy();
    } finally {
      await first.stop();
    }

    let recoveredCalls = 0;
    const recovered = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onSemanticToolInput: async (call) => {
        recoveredCalls += 1;
        return {
          result: { ok: true, operationId: call.operationId },
        };
      },
    });
    try {
      await recovered.start();
      const client = await authenticate(recovered, leaseToken!);
      sendSecure(client!, semanticInputEvent());
      const outcomes = [
        await receiveSecure(client!),
        await receiveSecure(client!),
      ];
      const command = outcomes.find((outcome) => outcome?.kind === "command");
      expect(outcomes.some((outcome) => outcome?.kind === "ack")).toBe(true);
      expect(command?.payload).toMatchObject({
        type: "semantic_tool.result",
        payload: {
          callId: "call-1",
          operationId: "get_task_context",
          result: { ok: true, operationId: "get_task_context" },
          isError: false,
        },
      });
      expect(recoveredCalls).toBe(1);

      const tampered = semanticInputEvent(2);
      const tamperedEvent = tampered.payload as Record<string, unknown>;
      const tamperedPayload = tamperedEvent.payload as Record<string, unknown>;
      const tamperedSemantic = tamperedPayload.semantic_tool as Record<
        string,
        unknown
      >;
      tamperedSemantic.content = {
        ...(tamperedSemantic.content as Record<string, unknown>),
        digest: `sha256:${"0".repeat(64)}`,
      };
      sendSecure(client!, tampered);
      await expect(receiveSecure(client!)).resolves.toBeNull();
      client?.socket.destroy();
    } finally {
      await recovered.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not acknowledge an event before the caller commits it", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-prp-commit-order-"));
    const first = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onSemanticToolInput: async () => ({ result: { ok: true } }),
      onCommittedEvent: async () => {
        throw new Error("database commit failed");
      },
    });
    let leaseToken: string;
    try {
      await first.start();
      const client = await authenticate(first, first.issueBootstrapTicket());
      leaseToken = client!.leaseToken!;
      sendSecure(client!, semanticInputEvent());
      await expect(receiveSecure(client!)).resolves.toBeNull();
    } finally {
      await first.stop();
    }

    let committed = 0;
    const recovered = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onSemanticToolInput: async () => ({ result: { ok: true } }),
      onCommittedEvent: async () => {
        committed += 1;
      },
    });
    try {
      await recovered.start();
      const client = await authenticate(recovered, leaseToken!);
      expect(client?.welcome.payload).toMatchObject({ ackedSourceSeq: 0 });
      sendSecure(client!, semanticInputEvent());
      await expect(receiveSecure(client!)).resolves.toMatchObject({
        kind: "ack",
        payload: { ackedSourceSeq: 1 },
      });
      expect(committed).toBe(1);
      client?.socket.destroy();
    } finally {
      await recovered.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a recovered runner attached when it reports an indeterminate command", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-prp-indeterminate-"));
    const controlPlane = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    try {
      await controlPlane.start();
      const journaled = controlPlane.queueCommand(
        "semantic_tool.result",
        { callId: "call-1" },
        "command-tool-1",
      );
      controlPlane.queueCommand(
        "turn.interrupt",
        { turnId: "turn-1" },
        "command-interrupt-1",
      );
      const client = await authenticate(
        controlPlane,
        controlPlane.issueBootstrapTicket(),
      );
      expect(client?.welcome.payload).toMatchObject({
        pendingCommands: [
          expect.objectContaining({ commandId: "command-tool-1" }),
        ],
      });

      // Exactly what runnerd replays after it is killed between journaling a
      // command and confirming its effect. Its durable contract promotes such a
      // command to `indeterminate` so that it is never executed twice.
      const indeterminateResult = {
        protocol: "paperclip.runner",
        version: 1,
        kind: "command_result",
        payload: {
          commandId: journaled.commandId,
          commandType: journaled.type,
          controllerSeq: journaled.controllerSeq,
          status: "indeterminate",
          result: {
            code: "execution_indeterminate",
            message:
              "runner recovered after journaling this command; it will not execute twice",
          },
        },
      };
      sendSecure(client!, indeterminateResult);

      // The authority has to accept that terminal status and hand out the next
      // command. Closing the connection instead strands the runner in a silent
      // reconnect loop that never re-reports its provider identity.
      await expect(receiveSecure(client!)).resolves.toMatchObject({
        kind: "command",
        payload: { commandId: "command-interrupt-1" },
      });
      expect(controlPlane.store.state.commands).toMatchObject([
        { commandId: "command-tool-1", status: "indeterminate" },
        { commandId: "command-interrupt-1", status: "pending" },
      ]);

      // The runner replays its journal on every reconnect, so the same
      // indeterminate result arrives again. It has to be absorbed as a
      // duplicate rather than treated as a conflicting result.
      sendSecure(client!, indeterminateResult);
      await expect(receiveSecure(client!)).resolves.toMatchObject({
        kind: "command",
        payload: { commandId: "command-interrupt-1" },
      });
      expect(controlPlane.store.state.duplicateCommandResults).toBe(1);

      client?.socket.destroy();
      await controlPlane.stop();

      // That result is now persisted, so a control plane restarted over the
      // same directory has to be able to read its own state back.
      const restarted = new DurablePrpControlPlane({
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
      });
      expect(restarted.store.state.commands).toMatchObject([
        { commandId: "command-tool-1", status: "indeterminate" },
        { commandId: "command-interrupt-1", status: "pending" },
      ]);
    } finally {
      await controlPlane.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
