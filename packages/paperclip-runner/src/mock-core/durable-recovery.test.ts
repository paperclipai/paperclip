import { spawn } from "node:child_process";
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  DurableRecoveryMockCore,
  durableRecoveryInternals,
  runDurableRecoveryRecovery,
} from "./durable-recovery.js";

async function upgradeSocket(url: string): Promise<Socket> {
  const parsed = new URL(url);
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = connect(Number(parsed.port), parsed.hostname);
    let response = Buffer.alloc(0);
    const onError = (error: Error): void => rejectSocket(error);
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      socket.off("error", onError);
      socket.off("data", onData);
      const status = Number(response.toString("utf8").match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
      if (status !== 101) {
        socket.destroy();
        rejectSocket(new Error(`WebSocket upgrade returned ${String(status)}`));
        return;
      }
      resolveSocket(socket);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.write(
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
    socket.on("data", onData);
  });
}

async function receiveServerOutcome(socket: Socket): Promise<Record<string, unknown> | null> {
  return new Promise((resolveValue, rejectValue) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onClose = (): void => {
      cleanup();
      resolveValue(null);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectValue(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      let length = buffer[1]! & 0x7f;
      let cursor = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        cursor = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        cursor = 10;
      }
      if (buffer.length < cursor + length) return;
      cleanup();
      resolveValue(
        JSON.parse(buffer.subarray(cursor, cursor + length).toString("utf8")) as Record<
          string,
          unknown
        >,
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectValue(new Error("Server frame timed out."));
    }, 2_000);
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function receiveServerJson(socket: Socket): Promise<Record<string, unknown>> {
  const value = await receiveServerOutcome(socket);
  if (value === null) throw new Error("WebSocket closed before the server frame arrived.");
  return value;
}

function sendMaskedJson(socket: Socket, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header: number[] = [0x81];
  if (payload.length <= 125) {
    header.push(0x80 | payload.length);
  } else {
    header.push(0x80 | 126, (payload.length >>> 8) & 0xff, payload.length & 0xff);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = masked[index]! ^ mask[index % mask.length]!;
  }
  socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
}

async function expectSocketClosed(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => rejectClose(new Error("WebSocket was not rejected.")), 2_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolveClose();
    });
  });
}

function authHello(
  identity: ReturnType<typeof durableRecoveryInternals.durableRecoveryIdentity>,
  credentialId: string,
): Record<string, unknown> {
  return {
    protocol: "paperclip.runner",
    version: 1,
    kind: "auth_hello",
    payload: {
      credentialId,
      clientNonce: "client_nonce_auth_regression",
      protocolMin: 1,
      protocolMax: 1,
      runnerInstanceId: identity.runnerInstanceId,
      runnerVersion: "0.3.0",
      runnerDigest: "sha256:durable-recovery-approved",
      environmentLeaseId: identity.environmentLeaseId,
      runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId,
      turnId: identity.turnId,
      itemId: identity.itemId,
    },
  };
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

interface AuthExchange {
  response: Record<string, unknown>;
  authKey: Buffer;
  canonicalChallenge: string;
  serverProof: string;
  clientProof: string;
}

function validAuthResponse(
  challenge: Record<string, unknown>,
  token: string,
): AuthExchange {
  const challengePayload = challenge.payload as Record<string, unknown>;
  const serverProof = challengePayload.serverProof;
  if (typeof serverProof !== "string") throw new Error("Challenge omitted its server proof.");
  const canonicalPayload = { ...challengePayload };
  delete canonicalPayload.serverProof;
  const canonicalChallenge = durableRecoveryInternals.canonicalJson(canonicalPayload);
  const material = durableRecoveryInternals.credentialMaterial(token);
  const expectedServerProof = domainHmac(
    material.authKey,
    "paperclip-runner-server-proof-v1",
    [Buffer.from(canonicalChallenge)],
  ).toString("hex");
  if (serverProof !== expectedServerProof) throw new Error("Challenge server proof was invalid.");
  const clientProof = domainHmac(
    material.authKey,
    "paperclip-runner-client-proof-v1",
    [Buffer.from(canonicalChallenge), Buffer.from(serverProof)],
  ).toString("hex");
  return {
    response: {
      protocol: "paperclip.runner",
      version: 1,
      kind: "auth_response",
      payload: {
        credentialId: challengePayload.credentialId,
        clientNonce: challengePayload.clientNonce,
        serverNonce: challengePayload.serverNonce,
        clientProof,
      },
    },
    authKey: material.authKey,
    canonicalChallenge,
    serverProof,
    clientProof,
  };
}

function decryptCoreFrame(
  frame: Record<string, unknown>,
  exchange: AuthExchange,
): Record<string, unknown> {
  if (
    frame.schema !== "paperclip.runner.secure-frame.v1" ||
    typeof frame.counter !== "number" ||
    typeof frame.ciphertext !== "string"
  ) {
    throw new Error("Expected an encrypted core frame.");
  }
  const counter = BigInt(frame.counter);
  const binding = domainDigest("paperclip-runner-session-binding-v1", [
    Buffer.from(exchange.canonicalChallenge),
    Buffer.from(exchange.serverProof),
    Buffer.from(exchange.clientProof),
  ]);
  const receiveKey = domainHmac(
    exchange.authKey,
    "paperclip-runner-core-to-client-key-v1",
    [binding],
  );
  const nonce = Buffer.alloc(12);
  nonce.write("P3S1", 0, "ascii");
  nonce.writeBigUInt64BE(counter, 4);
  const sessionId = `sha256:${binding.toString("hex")}`;
  const aad = Buffer.from(
    `paperclip.runner.secure-frame.v1\0${sessionId}\0core_to_client\0${counter}`,
  );
  const sealed = Buffer.from(frame.ciphertext, "hex");
  const decipher = createDecipheriv("aes-256-gcm", receiveKey, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(-16));
  return JSON.parse(
    Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString(
      "utf8",
    ),
  ) as Record<string, unknown>;
}

async function beginWireAuthentication(
  core: DurableRecoveryMockCore,
  token: string,
): Promise<{ socket: Socket; exchange: AuthExchange }> {
  const socket = await upgradeSocket(core.connectUrl);
  const credentialId = durableRecoveryInternals.credentialMaterial(token).credentialId;
  sendMaskedJson(socket, authHello(core.identity, credentialId));
  const challenge = await receiveServerJson(socket);
  expect(challenge.kind).toBe("auth_challenge");
  return { socket, exchange: validAuthResponse(challenge, token) };
}

async function authenticateWire(
  core: DurableRecoveryMockCore,
  token: string,
): Promise<{ socket: Socket; welcome: Record<string, unknown> }> {
  const { socket, exchange } = await beginWireAuthentication(core, token);
  const framePromise = receiveServerJson(socket);
  sendMaskedJson(socket, exchange.response);
  const welcome = decryptCoreFrame(await framePromise, exchange);
  expect(welcome.kind).toBe("welcome");
  return { socket, welcome };
}

async function runRunnerProcess(options: {
  connectUrl: string;
  stateDirectory: string;
  identity: ReturnType<typeof durableRecoveryInternals.durableRecoveryIdentity>;
  ticket: string;
  maxRuntimeMs: number;
}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    durableRecoveryInternals.runnerBinary,
    [
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
      "--max-outbox-bytes",
      String(64 * 1024),
      "--p0-reserve-bytes",
      String(32 * 1024),
      "--reconnect-delay-ms",
      "10",
      "--max-runtime-ms",
      String(options.maxRuntimeMs),
    ],
    {
      env: durableRecoveryInternals.runnerEnvironment(options.ticket),
      stdio: "pipe",
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Durable recovery runner process did not terminate."));
    }, options.maxRuntimeMs + 3_000);
    child.once("error", rejectExit);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolveExit(exitCode);
    });
  });
  return { code, stderr };
}

describe.sequential("Durable transport and recovery", () => {
  it("accepts a short-lived bootstrap ticket once and rejects its reuse", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "durable-recovery-ticket-test-"));
    const core = new DurableRecoveryMockCore({
      stateDirectory: root,
      identity: durableRecoveryInternals.durableRecoveryIdentity(),
      fault: "none",
    });
    try {
      await core.start();
      core.queueCommand("runner.shutdown", {});
      const ticket = core.issueBootstrapTicket();
      const stateDirectory = resolve(root, "runner");

      const first = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory,
        identity: core.identity,
        ticket,
        maxRuntimeMs: 2_000,
      });
      expect(first.code, first.stderr).toBe(0);
      expect(core.store.state.connectionCount).toBe(1);

      const reused = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory,
        identity: core.identity,
        ticket,
        maxRuntimeMs: 100,
      });
      expect(reused.code).not.toBe(0);
      expect(core.store.state.connectionCount).toBe(1);

      const expiredTicket = core.issueBootstrapTicket(-1);
      const expired = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory: resolve(root, "expired-runner"),
        identity: core.identity,
        ticket: expiredTicket,
        maxRuntimeMs: 100,
      });
      expect(expired.code).not.toBe(0);
      expect(core.store.state.connectionCount).toBe(1);
      expect(
        Object.values(core.store.state.tickets).filter((record) => record.usedAt !== null),
      ).toHaveLength(1);
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("authenticates only one of two valid proofs for the same bootstrap ticket", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "durable-recovery-concurrent-ticket-test-"));
    const core = new DurableRecoveryMockCore({
      stateDirectory: root,
      identity: durableRecoveryInternals.durableRecoveryIdentity(),
      fault: "none",
    });
    try {
      await core.start();
      const ticket = core.issueBootstrapTicket();
      const credentialId = durableRecoveryInternals.credentialMaterial(ticket).credentialId;
      const [first, second] = await Promise.all([
        beginWireAuthentication(core, ticket),
        beginWireAuthentication(core, ticket),
      ]);
      const firstOutcome = receiveServerOutcome(first.socket);
      const secondOutcome = receiveServerOutcome(second.socket);

      sendMaskedJson(first.socket, first.exchange.response);
      sendMaskedJson(second.socket, second.exchange.response);
      const outcomes = await Promise.all([firstOutcome, secondOutcome]);
      const authenticated = outcomes.flatMap((outcome, index) =>
        outcome === null
          ? []
          : [decryptCoreFrame(outcome, index === 0 ? first.exchange : second.exchange)],
      );

      expect(authenticated).toHaveLength(1);
      expect(authenticated[0]?.kind).toBe("welcome");
      expect(core.store.state.connectionCount).toBe(1);
      expect(Object.values(core.store.state.leases)).toHaveLength(1);
      expect(core.store.state.tickets[credentialId]?.usedAt).not.toBeNull();
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a valid bootstrap proof completed after ticket expiry", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "durable-recovery-expired-challenge-test-"));
    const core = new DurableRecoveryMockCore({
      stateDirectory: root,
      identity: durableRecoveryInternals.durableRecoveryIdentity(),
      fault: "none",
    });
    try {
      await core.start();
      const ticket = core.issueBootstrapTicket(500);
      const credentialId = durableRecoveryInternals.credentialMaterial(ticket).credentialId;
      const pending = await beginWireAuthentication(core, ticket);
      const expiresAtUnixMs = core.store.state.tickets[credentialId]?.expiresAtUnixMs;
      if (expiresAtUnixMs === undefined) throw new Error("Bootstrap ticket disappeared.");
      await delay(Math.max(1, expiresAtUnixMs - Date.now() + 10));
      const outcome = receiveServerOutcome(pending.socket);

      sendMaskedJson(pending.socket, pending.exchange.response);

      await expect(outcome).resolves.toBeNull();
      expect(core.store.state.connectionCount).toBe(0);
      expect(Object.values(core.store.state.leases)).toHaveLength(0);
      expect(core.store.state.tickets[credentialId]?.usedAt).toBeNull();
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires proof before consuming a ticket and rejects mismatched session identity", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "durable-recovery-identity-auth-test-"));
    const identity = durableRecoveryInternals.durableRecoveryIdentity();
    const core = new DurableRecoveryMockCore({
      stateDirectory: root,
      identity,
      fault: "none",
    });
    try {
      await core.start();

      const bootstrap = core.issueBootstrapTicket();
      const credentialId = durableRecoveryInternals.credentialMaterial(bootstrap).credentialId;
      const wrongIdentitySocket = await upgradeSocket(core.connectUrl);
      const wrongHello = authHello(identity, credentialId);
      (wrongHello.payload as Record<string, unknown>).runId = "run_wrong_identity";
      sendMaskedJson(wrongIdentitySocket, wrongHello);
      await expectSocketClosed(wrongIdentitySocket);
      expect(core.store.state.tickets[credentialId]?.usedAt).toBeNull();

      const forgedProofSocket = await upgradeSocket(core.connectUrl);
      sendMaskedJson(forgedProofSocket, authHello(identity, credentialId));
      const challenge = await receiveServerJson(forgedProofSocket);
      const challengePayload = challenge.payload as Record<string, unknown>;
      sendMaskedJson(forgedProofSocket, {
        protocol: "paperclip.runner",
        version: 1,
        kind: "auth_response",
        payload: {
          credentialId,
          clientNonce: challengePayload.clientNonce,
          serverNonce: challengePayload.serverNonce,
          clientProof: "00".repeat(32),
        },
      });
      await expectSocketClosed(forgedProofSocket);
      expect(core.store.state.tickets[credentialId]?.usedAt).toBeNull();

      const replacedRecord = await beginWireAuthentication(core, bootstrap);
      const ticket = core.store.state.tickets[credentialId];
      if (ticket === undefined) throw new Error("Bootstrap ticket disappeared.");
      core.store.state.tickets[credentialId] = {
        ...ticket,
        recordId: "bootstrap_ticket_replacement",
      };
      core.store.save();
      const replacementOutcome = receiveServerOutcome(replacedRecord.socket);
      sendMaskedJson(replacedRecord.socket, replacedRecord.exchange.response);
      await expect(replacementOutcome).resolves.toBeNull();
      expect(core.store.state.tickets[credentialId]?.usedAt).toBeNull();
      expect(core.store.state.connectionCount).toBe(0);
      expect(Object.values(core.store.state.leases)).toHaveLength(0);
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["expired", "revoked"] as const)(
    "rejects a valid proof after its challenged lease is %s",
    async (invalidatedAs) => {
      const scratch =
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
        process.env.PAPERCLIP_SCRATCH_DIR ??
        tmpdir();
      const root = mkdtempSync(resolve(scratch, `durable-recovery-${invalidatedAs}-lease-test-`));
      const core = new DurableRecoveryMockCore({
        stateDirectory: root,
        identity: durableRecoveryInternals.durableRecoveryIdentity(),
        fault: "none",
      });
      try {
        await core.start();
        const bootstrap = core.issueBootstrapTicket();
        const initial = await authenticateWire(core, bootstrap);
        const leaseToken = (initial.welcome.payload as Record<string, unknown>)
          .connectionLeaseToken;
        if (typeof leaseToken !== "string") throw new Error("Welcome omitted its lease token.");
        initial.socket.destroy();

        const pending = await beginWireAuthentication(core, leaseToken);
        const credentialId = durableRecoveryInternals.credentialMaterial(leaseToken).credentialId;
        const lease = core.store.state.leases[credentialId];
        if (lease === undefined) throw new Error("Connection lease disappeared.");
        if (invalidatedAs === "expired") {
          lease.expiresAtUnixMs = Date.now() - 1;
          lease.expiresAt = new Date(lease.expiresAtUnixMs).toISOString();
        } else {
          lease.revokedAt = new Date().toISOString();
          lease.revocationEpoch += 1;
        }
        core.store.save();
        const outcome = receiveServerOutcome(pending.socket);

        sendMaskedJson(pending.socket, pending.exchange.response);

        await expect(outcome).resolves.toBeNull();
        expect(core.store.state.connectionCount).toBe(1);
        expect(Object.values(core.store.state.leases)).toHaveLength(1);
      } finally {
        await core.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "atomically stores mock-core state without following a preplanted predictable symlink",
    () => {
      const scratch =
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
        process.env.PAPERCLIP_SCRATCH_DIR ??
        tmpdir();
      const root = mkdtempSync(resolve(scratch, "durable-recovery-core-state-symlink-"));
      const stateDirectory = resolve(root, "mock-core");
      const victim = resolve(root, "victim.txt");
      mkdirSync(stateDirectory, { mode: 0o700 });
      chmodSync(stateDirectory, 0o700);
      writeFileSync(victim, "unchanged", { mode: 0o600 });
      const planted = resolve(stateDirectory, "mock-core-state.json.next");
      symlinkSync(victim, planted);
      try {
        const core = new DurableRecoveryMockCore({
          stateDirectory,
          identity: durableRecoveryInternals.durableRecoveryIdentity(),
          fault: "none",
        });
        core.issueBootstrapTicket();
        const statePath = resolve(stateDirectory, "mock-core-state.json");

        expect(readFileSync(victim, "utf8")).toBe("unchanged");
        expect(lstatSync(planted).isSymbolicLink()).toBe(true);
        expect(lstatSync(stateDirectory).mode & 0o777).toBe(0o700);
        expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["socket-drop", "lost-ack", "malformed-input"] as const)(
    "recovers the %s reconnect path with stable identities and cursors",
    async (fault) => {
      const trace = await runDurableRecoveryRecovery({ fault });

      expect(trace.diagnostics.recovery.outcome).toBe("recovered");
      expect(trace.diagnostics.connection.connectionCount).toBeGreaterThan(1);
      expect(trace.assertions.stableIdentity).toBe(true);
      expect(trace.assertions.sourceCursorContinuous).toBe(true);
      expect(trace.assertions.noDuplicateLogicalEvents).toBe(true);
      expect(trace.assertions.p0Preserved).toBe(true);
      expect(trace.assertions.secretsRedacted).toBe(true);
      expect(trace.diagnostics.security).toMatchObject({
        bootstrapTicketPersisted: false,
        connectionLeaseTokenPersisted: false,
        secretLeakCount: 0,
      });
      if (fault === "lost-ack") {
        expect(trace.diagnostics.recovery.replayDeliveries).toBeGreaterThan(0);
        expect(
          trace.diagnostics.committedEvents.some((event) => event.deliveryCount > 1),
        ).toBe(true);
      }
      if (fault === "malformed-input") {
        expect(trace.diagnostics.recovery.malformedFrames).toBe(1);
        expect(trace.runnerState.diagnostics.join(" ")).toContain(
          "malformed WebSocket JSON",
        );
      }
    },
  );

  it("replays a processed command without repeating its logical effect", async () => {
    const trace = await runDurableRecoveryRecovery({ fault: "duplicate-command" });

    expect(trace.diagnostics.commands.duplicateDeliveries).toBeGreaterThan(0);
    expect(trace.assertions.oneLogicalEffectPerAcceptedCommand).toBe(true);
    expect(trace.runnerState.processedCommands.command_durableRecovery_001?.logicalEffectCount).toBe(1);
    expect(
      trace.diagnostics.committedEvents.filter(
        (event) => event.eventType === "workspace.ready",
      ),
    ).toHaveLength(1);
  });

  it("restores the same runner session after a real runner process restart", async () => {
    const trace = await runDurableRecoveryRecovery({ fault: "runner-restart" });

    expect(trace.diagnostics.recovery.runnerRestarts).toBe(1);
    expect(trace.diagnostics.recovery.freshBootstraps).toBe(2);
    expect(trace.diagnostics.recovery.replayDeliveries).toBeGreaterThan(0);
    expect(
      trace.diagnostics.committedEvents.some(
        (event) => event.eventType === "runner.reconciled",
      ),
    ).toBe(true);
    expect(trace.assertions.stableIdentity).toBe(true);
    expect(trace.assertions.sourceCursorContinuous).toBe(true);
  });

  it("keeps a restarted revoked runner network-silent and byte-stable with a fresh ticket", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "durable-recovery-revoked-restart-test-"));
    const runnerStateDirectory = resolve(root, "runner");
    const identity = durableRecoveryInternals.durableRecoveryIdentity();
    mkdirSync(runnerStateDirectory, { recursive: true, mode: 0o700 });
    const envelope = {
      protocol: "paperclip.runner",
      version: 1,
      envelopeId: "envelope_event_000004",
      kind: "event",
      runnerInstanceId: identity.runnerInstanceId,
      payload: {
        sourceEventId: `event_${identity.runnerInstanceId}_000004`,
        sourceSeq: 4,
        eventType: "run.terminal",
        priority: 0,
        payload: { status: "succeeded" },
      },
    };
    const byteSize = Buffer.byteLength(JSON.stringify(envelope));
    const statePath = resolve(runnerStateDirectory, "runner-state.json");
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          schema: "paperclip.runner.durable.state.v1",
          ...identity,
          lifecycle: "revoked",
          nextSourceSeq: 5,
          ackedSourceSeq: 3,
          lastControllerCommandSeq: 2,
          reconnectCount: 7,
          maxOutboxBytes: 64 * 1024,
          peakOutboxBytes: byteSize,
          outbox: [
            {
              sourceSeq: 4,
              sourceEventId: `event_${identity.runnerInstanceId}_000004`,
              priority: 0,
              eventType: "run.terminal",
              itemId: null,
              envelope,
              byteSize,
            },
          ],
          processedCommands: {},
          compactedCommandFilter: "00".repeat(4_096),
          compactedCommandCount: 0,
          diagnostics: ["connection lease revoked; preserving durable events"],
          backpressure: false,
          recoverableFailure: null,
          unrecoverableOutcome: null,
          harnessGeneration: 1,
          stopAfterFlush: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const before = readFileSync(statePath);
    const core = new DurableRecoveryMockCore({
      stateDirectory: resolve(root, "mock-core"),
      identity,
      fault: "none",
    });
    try {
      await core.start();
      const ticket = core.issueBootstrapTicket();
      const connectionsBefore = core.store.state.connectionCount;
      const result = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory: runnerStateDirectory,
        identity,
        ticket,
        maxRuntimeMs: 1_000,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(core.store.state.connectionCount).toBe(connectionsBefore);
      expect(Object.values(core.store.state.tickets).map((record) => record.usedAt)).toEqual([
        null,
      ]);
      expect(readFileSync(statePath)).toEqual(before);
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles a restarted harness without replacing session, turn, or item IDs", async () => {
    const trace = await runDurableRecoveryRecovery({ fault: "harness-restart" });
    const reconciled = trace.diagnostics.committedEvents.find(
      (event) => event.eventType === "session.reconciled",
    );

    expect(trace.diagnostics.recovery.harnessRestarts).toBe(1);
    expect(reconciled).toBeDefined();
    expect(reconciled?.envelope).toMatchObject({
      runId: "run_durableRecovery_stable",
      normalizedSessionId: "session_durableRecovery_stable",
      turnId: "turn_durableRecovery_stable",
    });
    expect(trace.assertions.stableIdentity).toBe(true);
  });

  it("uses a fresh bootstrap after lease expiry and resumes the durable cursor", async () => {
    const trace = await runDurableRecoveryRecovery({ fault: "lease-expiry" });

    expect(trace.diagnostics.recovery.runnerRestarts).toBe(1);
    expect(trace.diagnostics.recovery.freshBootstraps).toBe(2);
    expect(trace.assertions.sourceCursorContinuous).toBe(true);
    expect(trace.diagnostics.recovery.outcome).toBe("recovered");
  });

  it("bounds storage, coalesces P2, preserves P0, and rejects new turns", async () => {
    const trace = await runDurableRecoveryRecovery({ fault: "storage-pressure" });
    const deltaEvents = trace.diagnostics.committedEvents.filter(
      (event) => event.eventType === "item.delta",
    );
    const turn = trace.commands.find((command) => command.type === "turn.start");

    expect(trace.diagnostics.outbox.backpressure).toBe(true);
    expect(trace.diagnostics.outbox.peakBytes).toBeLessThanOrEqual(
      trace.diagnostics.outbox.maxBytes,
    );
    expect(deltaEvents).toHaveLength(1);
    expect(trace.diagnostics.committedEvents.some((event) => event.eventType === "runner.backpressure"))
      .toBe(true);
    expect(turn?.status).toBe("rejected");
    expect(trace.assertions.boundedStorage).toBe(true);
    expect(trace.assertions.p0Preserved).toBe(true);
  });

  it.each(["drain", "revoke"] as const)(
    "%s stops new work only after preserving the durable event cursor",
    async (fault) => {
      const trace = await runDurableRecoveryRecovery({ fault });

      expect(trace.diagnostics.recovery.outcome).toBe(fault === "drain" ? "drained" : "revoked");
      expect(trace.diagnostics.outbox.events).toBe(0);
      expect(trace.assertions.sourceCursorContinuous).toBe(true);
      expect(trace.assertions.p0Preserved).toBe(true);
      if (fault === "drain") {
        expect(trace.commands.find((command) => command.type === "turn.start")?.status)
          .toBe("rejected");
      } else {
        const afterRevoke = trace.commands.find(
          (command) => command.commandId === "command_after_revoke",
        );
        expect(trace.runnerState.lifecycle).toBe("revoked");
        expect(trace.diagnostics.recovery.replayDeliveries).toBeGreaterThan(0);
        expect(afterRevoke?.status).toBe("rejected");
        expect(afterRevoke?.result?.logicalEffectCount).toBe(0);
        expect(
          trace.diagnostics.committedEvents.filter(
            (event) => event.eventType === "turn.accepted",
          ),
        ).toHaveLength(1);
      }
    },
  );

  it("passes only the bootstrap capability and platform basics to the runner", () => {
    const environment = durableRecoveryInternals.runnerEnvironment("opaque-ticket");

    expect(environment.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("opaque-ticket");
    expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.EMAIL_AGENTMAIL_GENERAL_API_KEY).toBeUndefined();
  });
});
