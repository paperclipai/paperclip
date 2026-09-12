import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NativeSessionProtocolIntegrityError } from "../contracts/native-session-backend.js";
import { createCapabilityRunnerdCodexTransport } from "../live/runnerd-codex-transport.js";
import { validatePrpEvent } from "../protocol/replay-contract.js";
import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";
import {
  DurablePrpControlPlane,
  inspectWarmRunTransition,
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

function renewalRequest(client: AuthenticatedClient, expiresAt: number): Record<string, unknown> {
  return {
    protocol: "paperclip.runner", version: client.welcome.version,
    kind: "lease_renew", ...identity,
    connectionId: client.welcome.connectionId,
    connectionLeaseId: client.welcome.connectionLeaseId,
    payload: {
      connectionLeaseExpiresAtUnixMs: expiresAt,
      connectionLeaseRevocationEpoch: (client.welcome.payload as Record<string, unknown>).connectionLeaseRevocationEpoch,
    },
  };
}

it("renews one authenticated connection for three weeks without replacing its authority", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "runner-lease-renewal-"));
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const ttl = 6 * 60 * 60 * 1_000;
  const core = new DurablePrpControlPlane({
    stateDirectory: root, identity, expectedRunnerVersion, expectedRunnerDigest,
    connectionLeaseTtlMs: ttl,
  });
  try {
    await core.start();
    const client = (await authenticate(core, core.issueBootstrapTicket()))!;
    let expiry = Number((client.welcome.payload as Record<string, unknown>).connectionLeaseExpiresAtUnixMs);
    const leaseId = client.welcome.connectionLeaseId;
    for (let hour = 0; hour < 21 * 24; hour += 3) {
      now += ttl / 2;
      const request = renewalRequest(client, expiry);
      sendSecure(client, request);
      const reply = (await receiveSecure(client))!;
      expect(reply.kind).toBe("lease_renewed");
      expect(reply.connectionLeaseId).toBe(leaseId);
      expect(reply.connectionId).toBe(client.welcome.connectionId);
      const next = Number((reply.payload as Record<string, unknown>).connectionLeaseExpiresAtUnixMs);
      expect(next).toBe(now + ttl);
      // A lost reply can be retried without another authority extension.
      now += 1;
      sendSecure(client, request);
      expect((await receiveSecure(client))!.payload).toEqual(reply.payload);
      expiry = next;
    }
    expect(core.store.state.connectionCount).toBe(1);
    expect(Object.keys(core.store.state.leases)).toHaveLength(1);
    expect(core.store.state.commands).toEqual([]);
    client.socket.destroy();
    await core.stop();
    const restored = new DurablePrpControlPlane({
      stateDirectory: root, identity, expectedRunnerVersion, expectedRunnerDigest,
      connectionLeaseTtlMs: ttl,
    });
    try {
      await restored.start();
      const resumed = (await authenticate(restored, client.leaseToken!))!;
      expect(resumed.welcome.connectionLeaseId).toBe(leaseId);
      expect((resumed.welcome.payload as Record<string, unknown>).connectionLeaseExpiresAtUnixMs).toBe(expiry);
      resumed.socket.destroy();
    } finally { await restored.stop(); }
  } finally {
    clock.mockRestore();
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["expired", "revoked", "wrong-run", "wrong-connection", "wrong-epoch", "future-expiry"])(
  "cannot renew a lease with %s authority",
  async (fault) => {
    const root = mkdtempSync(resolve(tmpdir(), "runner-lease-denial-"));
    const core = new DurablePrpControlPlane({ stateDirectory: root, identity, expectedRunnerVersion, expectedRunnerDigest });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await core.start();
      const client = (await authenticate(core, core.issueBootstrapTicket()))!;
      const expiry = Number((client.welcome.payload as Record<string, unknown>).connectionLeaseExpiresAtUnixMs);
      const request = renewalRequest(client, expiry);
      if (fault === "expired") clock = vi.spyOn(Date, "now").mockReturnValue(expiry);
      if (fault === "revoked") Object.values(core.store.state.leases)[0]!.revokedAt = new Date().toISOString();
      if (fault === "wrong-run") request.runId = "different-run";
      if (fault === "wrong-connection") request.connectionId = "different-connection";
      if (fault === "wrong-epoch") (request.payload as Record<string, unknown>).connectionLeaseRevocationEpoch = 999;
      if (fault === "future-expiry") (request.payload as Record<string, unknown>).connectionLeaseExpiresAtUnixMs = expiry + 1;
      sendSecure(client, request);
      expect(await receiveSecure(client)).toBeNull();
      expect(Object.values(core.store.state.leases)[0]!.expiresAtUnixMs).toBe(expiry);
    } finally {
      clock?.mockRestore();
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("persists the initial warm attachment seed idempotently and rejects replacement", () => {
  const root = mkdtempSync(
    resolve(tmpdir(), "runner-initial-attachment-seed-test-"),
  );
  const template = {
    provider: {
      kind: "codex",
      runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId,
    },
    authorizedTools: {},
  };
  try {
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    core.persistRunAttachTemplate(template);
    core.persistRunAttachTemplate(structuredClone(template));

    expect(
      JSON.parse(
        readFileSync(resolve(root, "control-plane-state.json"), "utf8"),
      ).runAttachTemplate,
    ).toEqual(template);
    expect(() =>
      core.persistRunAttachTemplate({
        ...template,
        provider: { ...template.provider, kind: "opencode" },
      }),
    ).toThrow("attachment template conflicts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("persists a connection-free warm attachment seed when rotating run identity", () => {
  const root = mkdtempSync(resolve(tmpdir(), "runner-attachment-seed-test-"));
  const nextIdentity: DurableRecoveryIdentity = {
    ...identity,
    runId: "00000000-0000-4000-8000-000000000002",
    turnId: "turn-test-2",
    itemId: "item-test-2",
  };
  const template = {
    provider: {
      kind: "acpx",
      runId: nextIdentity.runId,
      normalizedSessionId: nextIdentity.normalizedSessionId,
    },
    workspace: { cwd: "/workspace" },
  };
  try {
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    core.rotateRunIdentity(nextIdentity, template);

    const stored = JSON.parse(
      readFileSync(resolve(root, "control-plane-state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored.identity).toEqual(nextIdentity);
    expect(stored.commands).toEqual([]);
    expect(stored.runAttachTemplate).toEqual(template);

    expect(
      () =>
        new DurablePrpControlPlane({
          stateDirectory: root,
          identity: nextIdentity,
          expectedRunnerVersion,
          expectedRunnerDigest,
        }),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "never persists raw child stdout or stderr as durable diagnostics",
  async () => {
    const root = mkdtempSync(resolve(tmpdir(), "runner-diagnostics-test-"));
    const executable = resolve(root, "noisy-runner");
    const diagnosticsDirectory = resolve(root, "diagnostics");
    writeFileSync(
      executable,
      [
        "#!/usr/bin/env node",
        'process.stdout.write("token=raw-stdout-secret " + "o".repeat(256 * 1024));',
        'process.stderr.write("Authorization: Bearer raw-stderr-secret " + "e".repeat(256 * 1024));',
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
    try {
      const handle = spawnRunner({
        connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" },
        stateDirectory: resolve(root, "state"),
        identity,
        ticket: "bootstrap-ticket",
        maxOutboxBytes: 256 * 1024,
        p0ReserveBytes: 64 * 1024,
        runnerVersion: expectedRunnerVersion,
        runnerDigest: expectedRunnerDigest,
        runnerBinaryPath: executable,
        diagnosticsDirectory,
      });
      const result = await handle.completion;
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      for (const name of ["runnerd.stdout.log", "runnerd.stderr.log"]) {
        const filePath = resolve(diagnosticsDirectory, name);
        expect(readFileSync(filePath, "utf8")).toBe("");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
    expect(launch.args).toEqual(
      expect.arrayContaining([
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
      ]),
    );
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

it("preserves only bounded GitHub credential projection at the runner spawn boundary", () => {
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
      GH_TOKEN: "github-token",
      GITHUB_TOKEN: "github-token",
      PAPERCLIP_GIT_TOKEN: "github-token",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!trusted-helper",
      GIT_CONFIG_KEY_1: "must.not.cross",
      GIT_CONFIG_VALUE_1: "must-not-cross",
      PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
      DATABASE_URL: "must-not-cross",
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
    GH_TOKEN: "github-token",
    GITHUB_TOKEN: "github-token",
    PAPERCLIP_GIT_TOKEN: "github-token",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!trusted-helper",
    PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
  });
  expect(launches[0]!.environment.GIT_CONFIG_KEY_1).toBeUndefined();
  expect(launches[0]!.environment.GIT_CONFIG_VALUE_1).toBeUndefined();
  expect(launches[0]!.environment.DATABASE_URL).toBeUndefined();
});

it("preserves the controller-selected ACPX provider package root", () => {
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
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: "/verified/provider-pack",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST:
        "/verified/provider-pack/package.json",
      NODE_PATH: "/untrusted/modules",
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
  expect(launches[0]!.environment.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT).toBe(
    "/verified/provider-pack",
  );
  expect(
    launches[0]!.environment.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST,
  ).toBe("/verified/provider-pack/package.json");
  expect(launches[0]!.environment.NODE_PATH).toBeUndefined();
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

it("closes an owned upgraded socket when its peer ends without a WebSocket close frame", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "runner-prp-half-close-"));
  const core = new DurablePrpControlPlane({
    stateDirectory: root,
    identity,
    expectedRunnerVersion,
    expectedRunnerDigest,
  });
  let socket: Socket | undefined;
  try {
    await core.start();
    ({ socket } = await upgradeSocket(core.connectUrl));
    let closed = false;
    socket.once("close", () => {
      closed = true;
    });
    socket.end();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500 });
    expect(core.activeRunnerConnectionCount()).toBe(0);
    expect(core.store.state.commands).toHaveLength(0);
  } finally {
    socket?.destroy();
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

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
      warmTransitionVersion: 1,
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
  runnerDigest = expectedRunnerDigest,
  warmTransitionId?: string,
  withoutWarmCapability = false,
  protocolMax = 1,
): Promise<AuthenticatedClient | null> {
  const { socket, reader } = await upgradeSocket(controlPlane.connectUrl);
  const material = credentialMaterial(token);
  const hello = authHello(material.credentialId, selectedIdentity);
  (hello.payload as Record<string, unknown>).protocolMax = protocolMax;
  (hello.payload as Record<string, unknown>).runnerDigest = runnerDigest;
  if (warmTransitionId !== undefined)
    (hello.payload as Record<string, unknown>).warmTransitionId =
      warmTransitionId;
  if (withoutWarmCapability)
    delete (hello.payload as Record<string, unknown>).warmTransitionVersion;
  sendMaskedJson(socket, hello);
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
    version: challengePayload.selectedVersion,
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

it.each([
  "allow", "reject", "expire", "replace", "stop", "competing_proof",
] as const)(
  "holds authenticated command admission until durable ownership settles (%s)",
  async (outcome) => {
    const root = mkdtempSync(resolve(tmpdir(), "runner-auth-admission-test-"));
    let release!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((resolveGate, rejectGate) => {
      release = resolveGate;
      reject = rejectGate;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    let admissions = 0;
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      beforeAuthenticatedConnection: () => {
        admissions++;
        entered();
        return gate;
      },
    });
    let authenticating: Promise<AuthenticatedClient | null> | undefined;
    let competing: Promise<AuthenticatedClient | null> | undefined;
    let client: AuthenticatedClient | null = null;
    try {
      await core.start();
      const command = core.queueCommand("turn.stop", {});
      const ticket = core.issueBootstrapTicket();
      const ticketId = credentialMaterial(ticket).credentialId;
      authenticating = authenticate(core, ticket);
      await waiting;
      if (outcome === "competing_proof") {
        competing = authenticate(core, ticket);
        await vi.waitFor(() => expect(admissions).toBe(2));
      }
      expect(core.store.state.connectionCount).toBe(0);
      expect(core.store.state.commandDeliveryCounts).toEqual({});
      expect(core.store.state.tickets[ticketId]!.usedAt).toBeNull();
      expect(Object.keys(core.store.state.leases)).toHaveLength(0);
      if (outcome === "expire")
        core.store.state.tickets[ticketId]!.expiresAtUnixMs = Date.now() - 1;
      if (outcome === "replace")
        core.store.state.tickets[ticketId]!.recordId = "changed-record";
      if (outcome === "stop") await core.stop();
      if (outcome === "reject") reject(new Error("durable ownership failed"));
      else release();
      client = await authenticating;
      if (outcome === "allow" || outcome === "competing_proof") {
        expect(client).not.toBeNull();
        if (competing) expect(await competing).toBeNull();
        expect(
          (client!.welcome.payload as Record<string, unknown>).pendingCommands,
        ).toEqual([
          expect.objectContaining({
            commandId: command.commandId,
            type: "turn.stop",
          }),
        ]);
        expect(core.store.state.connectionCount).toBe(1);
        expect(core.store.state.commandDeliveryCounts[command.commandId]).toBe(
          1,
        );
      } else {
        expect(client).toBeNull();
        expect(core.store.state.connectionCount).toBe(0);
        expect(core.store.state.commandDeliveryCounts).toEqual({});
        expect(core.store.state.tickets[ticketId]!.usedAt).toBeNull();
        expect(Object.keys(core.store.state.leases)).toHaveLength(0);
      }
    } finally {
      release();
      client?.socket.destroy();
      await core.stop();
      await authenticating?.catch(() => undefined);
      await competing?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function secureAad(
  client: AuthenticatedClient,
  direction: "client_to_core" | "core_to_client",
  counter: bigint,
): Buffer {
  return Buffer.from(
    `paperclip.runner.secure-frame.v1\0${client.sessionId}\0${direction}\0${counter}`,
  );
}

it("denies held admission if the previous authenticated owner latches integrity failure", async () => {
  const root = mkdtempSync(
    resolve(tmpdir(), "runner-auth-integrity-gate-test-"),
  );
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolveEntered) => {
    entered = resolveEntered;
  });
  const integrity = vi.fn();
  const core = new DurablePrpControlPlane({
    stateDirectory: root,
    identity,
    expectedRunnerVersion,
    expectedRunnerDigest,
    onProtocolIntegrityError: integrity,
    onSemanticToolInput: async () => ({ result: {} }),
    beforeAuthenticatedConnection: async () => {
      if (!hold) return;
      entered();
      await gate;
    },
  });
  let old: AuthenticatedClient | null = null;
  let successor: AuthenticatedClient | null = null;
  let admission: Promise<AuthenticatedClient | null> | undefined;
  try {
    await core.start();
    old = await authenticate(core, core.issueBootstrapTicket());
    expect(old).not.toBeNull();
    const command = core.queueCommand("turn.stop", {});
    const ticket = core.issueBootstrapTicket();
    const ticketId = credentialMaterial(ticket).credentialId;
    hold = true;
    admission = authenticate(core, ticket);
    await waiting;
    sendSecure(old!, corruptSemanticInputDigest());
    expect(await receiveSecure(old!)).toBeNull();
    expect(integrity).toHaveBeenCalledOnce();
    release();
    successor = await admission;
    expect(successor).toBeNull();
    expect(core.store.state.connectionCount).toBe(1);
    expect(core.store.state.tickets[ticketId]!.usedAt).toBeNull();
    expect(
      core.store.state.commandDeliveryCounts[command.commandId],
    ).toBeUndefined();
  } finally {
    release();
    old?.socket.destroy();
    successor?.socket.destroy();
    await core.stop();
    await admission?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

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

function corruptSemanticInputDigest(
  event = semanticInputEvent(),
): Record<string, unknown> {
  const payload = (event.payload as Record<string, unknown>).payload as Record<
    string,
    unknown
  >;
  const semantic = payload.semantic_tool as Record<string, unknown>;
  (semantic.content as Record<string, unknown>).digest =
    `sha256:${"0".repeat(64)}`;
  return event;
}

it.each(["committed", "rejected"] as const)(
  "holds explicit maintenance retirement through a closed connection's queued processing (%s)",
  async (suffixOutcome) => {
    const root = mkdtempSync(resolve(tmpdir(), "runner-processing-drain-"));
    const releases: Array<() => void> = [];
    const gates = [0, 1].map(
      () => new Promise<void>((release) => releases.push(release)),
    );
    const onCommittedEvent = vi.fn(async (event: { sourceSeq: number }) => {
      await gates[event.sourceSeq - 1];
      if (event.sourceSeq === 2 && suffixOutcome === "rejected")
        throw new Error("retained suffix commit rejected");
    });
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onCommittedEvent,
    });
    let admittedFrames = 0;
    const attachWire = core.attachWireConnection.bind(core);
    const wireSpy = vi
      .spyOn(core, "attachWireConnection")
      .mockImplementation((wire) =>
        attachWire({
          onJson: (listener) =>
            wire.onJson((value) => {
              admittedFrames += 1;
              listener(value);
            }),
          onClose: wire.onClose.bind(wire),
          close: wire.close.bind(wire),
          sendJson: wire.sendJson.bind(wire),
        }),
      );
    let client: AuthenticatedClient | null = null;
    let retirement: Promise<void> | undefined;
    const retired = vi.fn();
    try {
      await core.start();
      client = (await authenticate(core, core.issueBootstrapTicket()))!;
      const beforeFrames = admittedFrames;
      for (const sourceSeq of [1, 2]) {
        const envelope = semanticInputEvent(sourceSeq);
        envelope.payload = {
          ...(envelope.payload as Record<string, unknown>),
          eventType: "item.delta",
          priority: 2,
          payload: { delta: `retained-${sourceSeq}` },
        };
        expect(validatePrpEvent(envelope.payload)).toMatchObject({ ok: true });
        sendSecure(client, envelope);
      }
      await vi.waitFor(() => {
        expect(admittedFrames).toBe(beforeFrames + 2);
        expect(onCommittedEvent).toHaveBeenCalledTimes(1);
      });
      // Both frames have entered the real authenticated processing chain;
      // socket shutdown does not settle either of their durable callbacks.
      await core.stop();
      expect(core.activeRunnerConnectionCount()).toBe(0);
      retirement = core
        .drainPendingConnectionProcessing()
        .then(() => retired());
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      expect(retired).not.toHaveBeenCalled();
      expect(core.store.state.ackedSourceSeq).toBe(0);

      releases[0]!();
      await vi.waitFor(() => expect(onCommittedEvent).toHaveBeenCalledTimes(2));
      expect(core.store.state.ackedSourceSeq).toBe(1);
      expect(retired).not.toHaveBeenCalled();
      releases[1]!();
      await retirement;
      expect(retired).toHaveBeenCalledOnce();
      const stored = JSON.parse(
        readFileSync(resolve(root, "control-plane-state.json"), "utf8"),
      );
      expect(stored.ackedSourceSeq).toBe(suffixOutcome === "committed" ? 2 : 1);
      expect(
        stored.committedEvents.map(
          (event: { sourceSeq: number }) => event.sourceSeq,
        ),
      ).toEqual(suffixOutcome === "committed" ? [1, 2] : [1]);
      expect(stored.commands).toEqual([]);
    } finally {
      releases.forEach((release) => release());
      client?.socket.destroy();
      await core.stop();
      await core.drainPendingConnectionProcessing();
      await vi.waitFor(() => expect(onCommittedEvent).toHaveBeenCalledTimes(2));
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      await retirement;
      wireSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "joins held authentication processing after stop without consuming its revoked admission (reopened ingress: %s)",
  async (reopenedIngress) => {
    const root = mkdtempSync(
      resolve(tmpdir(), "runner-auth-processing-drain-"),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      beforeAuthenticatedConnection: async () => {
        entered();
        await gate;
      },
    });
    let authenticating: Promise<AuthenticatedClient | null> | undefined;
    let drained: Promise<void> | undefined;
    try {
      await core.start();
      const ticket = core.issueBootstrapTicket();
      const ticketId = credentialMaterial(ticket).credentialId;
      authenticating = authenticate(core, ticket);
      await waiting;
      await core.stop();
      const settled = vi.fn();
      drained = core.drainPendingConnectionProcessing().then(() => settled());
      void drained.catch(() => undefined);
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      expect(settled).not.toHaveBeenCalled();
      if (reopenedIngress) await core.start();
      release();
      if (reopenedIngress) {
        await expect(drained).rejects.toThrow("stopped ingress");
        expect(settled).not.toHaveBeenCalled();
        await core.stop();
      } else {
        await drained;
        expect(settled).toHaveBeenCalledOnce();
      }
      await expect(authenticating).resolves.toBeNull();
      expect(core.store.state.tickets[ticketId]!.usedAt).toBeNull();
      expect(core.store.state.leases).toEqual({});
      expect(core.store.state.connectionCount).toBe(0);
      expect(core.store.state.commandDeliveryCounts).toEqual({});
      await expect(
        core.drainPendingConnectionProcessing(),
      ).resolves.toBeUndefined();
    } finally {
      release();
      await core.stop();
      await core.drainPendingConnectionProcessing();
      await authenticating?.catch(() => undefined);
      await drained?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("refuses a processing-drain absence claim while local or remote ingress remains admitted", async () => {
  const root = mkdtempSync(
    resolve(tmpdir(), "runner-processing-drain-ingress-"),
  );
  const core = new DurablePrpControlPlane({
    stateDirectory: root,
    identity,
    expectedRunnerVersion,
    expectedRunnerDigest,
  });
  try {
    await core.start();
    await expect(core.drainPendingConnectionProcessing()).rejects.toThrow(
      "stopped ingress",
    );
    await core.stop();
    let closed = () => {};
    core.attachWireConnection({
      onJson: () => {},
      onClose: (listener) => {
        closed = () => listener({ message: "closed" });
      },
      close: () => closed(),
      sendJson: () => {},
    });
    await expect(core.drainPendingConnectionProcessing()).rejects.toThrow(
      "stopped ingress",
    );
    await core.stop();
    await expect(
      core.drainPendingConnectionProcessing(),
    ).resolves.toBeUndefined();
  } finally {
    await core.stop();
    await core.drainPendingConnectionProcessing();
    rmSync(root, { recursive: true, force: true });
  }
});

describe.sequential("DurablePrpControlPlane", () => {
  it.each(["pending_first", "all_pending", "completed_first"] as const)(
    "retains unanswered semantic input across the bounded event window (%s)",
    async (mode) => {
      const root = mkdtempSync(
        resolve(tmpdir(), "paperclip-prp-semantic-window-"),
      );
      const onCommittedEvent = vi.fn(async () => undefined);
      const onSemanticToolInput = vi.fn(
        async () => new Promise<{ result: unknown }>(() => undefined),
      );
      const options = {
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
        onCommittedEvent,
        onSemanticToolInput,
      };
      const core = new DurablePrpControlPlane(options);
      const eventAt = (sourceSeq: number, semanticInput: boolean) => {
        const envelope = semanticInputEvent(sourceSeq);
        const event = envelope.payload as Record<string, unknown>;
        if (semanticInput) {
          (
            (event.payload as Record<string, unknown>).semantic_tool as Record<
              string,
              unknown
            >
          ).callId = `call-${sourceSeq}`;
        } else {
          event.eventType = "harness.diagnostic";
          event.payload = {};
        }
        return {
          sourceSeq,
          sourceEventId: String(event.sourceEventId),
          eventType: String(event.eventType),
          priority: 0 as const,
          envelope,
          deliveryCount: 1,
          logicalEffectCount: 1 as const,
        };
      };
      core.store.state.committedEvents = Array.from(
        { length: 4096 },
        (_, index) => eventAt(index + 1, index === 0 || mode === "all_pending"),
      );
      core.store.state.ackedSourceSeq = 4096;
      if (mode === "completed_first") {
        const semantic = (
          (
            core.store.state.committedEvents[0]!.envelope.payload as Record<
              string,
              unknown
            >
          ).payload as Record<string, unknown>
        ).semantic_tool as Record<string, unknown>;
        const commandId = `command_tool_${createHash("sha256").update(`${identity.runId}\0call-1`).digest("hex").slice(0, 32)}`;
        core.store.state.commands.push({
          schema: "paperclip.prp.command.v1",
          commandId,
          controllerSeq: 1,
          type: "semantic_tool.result",
          issuedAt: new Date().toISOString(),
          status: "completed",
          payload: {
            callId: "call-1",
            operationId: semantic.operationId,
            input: semantic.input,
            sourceEventId: "semantic-event-1",
            sourceEventType: "semantic_tool.input",
            correlation: semantic.correlation,
          },
          result: {
            commandId,
            controllerSeq: 1,
            commandType: "semantic_tool.result",
            status: "completed",
            result: {},
          },
        });
        expect(core.semanticToolResultsSettled()).toBe(true);
        const completed = core.store.state.commands.pop()!;
        expect(core.semanticToolResultsSettled()).toBe(false); // Missing/pruned receipt is never completion evidence.
        core.store.state.commands.push(completed);
        for (const corruption of [
          "operation",
          "run",
          "source",
          "receipt",
        ] as const) {
          const changed = structuredClone(completed);
          if (corruption === "operation")
            changed.payload.operationId = "different_operation";
          if (corruption === "run")
            changed.payload.correlation = {
              ...(changed.payload.correlation as Record<string, unknown>),
              runId: "different-run",
            };
          if (corruption === "source")
            changed.payload.sourceEventId = "different-event";
          if (corruption === "receipt")
            changed.result = {
              ...(changed.result as Record<string, unknown>),
              controllerSeq: 2,
            };
          core.store.state.commands[0] = changed;
          expect(core.semanticToolResultsSettled()).toBe(false);
        }
        core.store.state.commands[0] = completed;
      }
      writeFileSync(core.store.path, JSON.stringify(core.store.state), {
        mode: 0o600,
      });
      try {
        await core.start();
        const client = (await authenticate(core, core.issueBootstrapTicket()))!;
        const before = readFileSync(core.store.path, "utf8");
        sendSecure(client, eventAt(4097, true).envelope);
        if (mode === "all_pending") {
          await expect(receiveSecure(client)).resolves.toBeNull();
          expect(core.store.state.ackedSourceSeq).toBe(4096);
          expect(readFileSync(core.store.path, "utf8")).toBe(before);
          expect(onCommittedEvent).not.toHaveBeenCalled();
          expect(onSemanticToolInput).not.toHaveBeenCalled();
        } else {
          await expect(receiveSecure(client)).resolves.toMatchObject({
            kind: "ack",
            payload: { ackedSourceSeq: 4097 },
          });
          expect(onCommittedEvent).toHaveBeenCalledTimes(1);
          expect(
            core.store.state.committedEvents.some(
              (event) => event.sourceSeq === 1,
            ),
          ).toBe(mode === "pending_first");
          expect(core.store.state.committedEvents.at(-1)?.sourceSeq).toBe(4097);
        }
        expect(core.store.state.committedEvents).toHaveLength(4096);
        const reopened = new DurablePrpControlPlane(options);
        expect(reopened.semanticToolResultsSettled()).toBe(false);
        await reopened.stop();
      } finally {
        await core.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
  it.each([false, true])(
    "promptly fails the real transport request and notification paths on authenticated bad semantic input (throwing observer: %s)",
    async (throwingObserver) => {
      const root = mkdtempSync(
        resolve(tmpdir(), "paperclip-prp-transport-integrity-"),
      );
      let authority: DurablePrpControlPlane | undefined;
      let launched = false;
      const diagnostics: string[] = [];
      // The launcher never executes this file. Use a small artifact so cold
      // reads of the Linux Node executable do not consume the failure deadline.
      const runnerBinary = resolve(root, "synthetic-runner");
      writeFileSync(runnerBinary, "synthetic runner artifact\n", { mode: 0o600 });
      const runnerDigest = `sha256:${createHash("sha256").update(readFileSync(runnerBinary)).digest("hex")}`;
      const handler = vi.fn(async () => ({ success: true, contentItems: [] }));
      const bundle = createCapabilityRunnerdCodexTransport({
        stateDirectory: root,
        prpIdentity: identity,
        runnerBinary,
        codexCommand: process.execPath,
        codexArgs: [],
        sourceCodexHome: null,
        environment: {},
        runnerReconnectGraceMs: 900_000,
        onDiagnostic: (message) => {
          diagnostics.push(message);
          if (
            throwingObserver &&
            message.includes("native_event_replay_conflict")
          ) {
            throw new Error("diagnostic observer failed");
          }
        },
        controlPlaneRegistration: async (core) => {
          authority = core;
          await core.start();
          return { connectUrl: core.connectUrl, release: () => core.stop() };
        },
        // Only the runner process is synthetic. Authentication, encrypted frames,
        // authority validation, transport latching, and both consumers are real.
        runnerProcessLauncher: () => {
          launched = true;
          return {
            child: { exitCode: null, kill: () => true },
            completion: new Promise(() => undefined),
          };
        },
      });
      bundle.transport.setServerRequestHandler(handler);
      const requestFailure = bundle.transport
        .request("thread/start", { cwd: tmpdir() })
        .catch((error: unknown) => error);
      const notificationFailure = (async () => {
        for await (const _notification of bundle.transport.notifications()) {
          // No provider content is expected before startup completes.
        }
        return null;
      })().catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(launched).toBe(true));
        const core = authority!;
        const client = (await authenticate(
          core,
          core.issueBootstrapTicket(),
          identity,
          runnerDigest,
        ))!;
        const event = corruptSemanticInputDigest();
        const semantic = (
          (event.payload as Record<string, unknown>).payload as Record<
            string,
            unknown
          >
        ).semantic_tool as Record<string, unknown>;
        semantic.input = { summary: "DO-NOT-LEAK-integrity-test" };
        sendSecure(client, event);
        await expect(receiveSecure(client)).resolves.toBeNull();
        const requestError = await requestFailure;
        expect(requestError).toBeInstanceOf(
          NativeSessionProtocolIntegrityError,
        );
        expect(await notificationFailure).toBe(requestError);
        await expect(bundle.transport.request("initialize", {})).rejects.toBe(
          requestError,
        );
        expect(handler).not.toHaveBeenCalled();
        expect(core.store.state.ackedSourceSeq).toBe(0);
        expect(core.store.state.committedEvents).toEqual([]);
        expect(diagnostics.join("\n")).not.toContain("DO-NOT-LEAK");
        expect(
          diagnostics.filter((message) =>
            message.includes("native_event_replay_conflict"),
          ),
        ).toHaveLength(1);
      } finally {
        await bundle.detachControllerForRestart();
        await authority?.stop();
        await Promise.allSettled([requestFailure, notificationFailure]);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("latches an authenticated semantic integrity fault without ACK or dispatch and still permits suspension", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-prp-integrity-"));
    const onProtocolIntegrityError = vi.fn();
    const onCommittedEvent = vi.fn(async () => undefined);
    const onSemanticToolInput = vi.fn(async () => ({ result: { ok: true } }));
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onProtocolIntegrityError,
      onCommittedEvent,
      onSemanticToolInput,
    });
    try {
      await core.start();
      const client = (await authenticate(core, core.issueBootstrapTicket()))!;
      sendSecure(client, corruptSemanticInputDigest());
      await expect(receiveSecure(client)).resolves.toBeNull();
      expect(onProtocolIntegrityError).toHaveBeenCalledTimes(1);
      const error = onProtocolIntegrityError.mock.calls[0]![0];
      expect(error).toBeInstanceOf(NativeSessionProtocolIntegrityError);
      expect(error).toMatchObject({
        code: "native_event_replay_conflict",
        reason: "semantic_input_digest_mismatch",
        recovery: "operator_required",
      });
      expect(core.store.state.ackedSourceSeq).toBe(0);
      expect(core.store.state.committedEvents).toEqual([]);
      expect(onCommittedEvent).not.toHaveBeenCalled();
      expect(onSemanticToolInput).not.toHaveBeenCalled();

      // A reconnect cannot reclassify this owner as healthy, even if it now
      // supplies valid bytes for the failed sequence. Its callback is one-shot.
      const replay = (await authenticate(core, client.leaseToken!))!;
      sendSecure(replay, semanticInputEvent());
      await expect(receiveSecure(replay)).resolves.toBeNull();
      expect(onProtocolIntegrityError).toHaveBeenCalledTimes(1);
      expect(core.store.state.ackedSourceSeq).toBe(0);
      expect(onCommittedEvent).not.toHaveBeenCalled();
      expect(onSemanticToolInput).not.toHaveBeenCalled();
      expect(() =>
        core.rotateRunIdentity({ ...identity, runId: "other-run" }),
      ).toThrow(error);

      const suspend = core.queueCommand(
        "runner.suspend",
        {},
        "suspend-after-integrity-fault",
      );
      const cleanup = (await authenticate(core, client.leaseToken!))!;
      expect(cleanup.welcome.payload).toMatchObject({
        pendingCommands: [
          expect.objectContaining({ commandId: suspend.commandId }),
        ],
      });
      sendSecure(cleanup, {
        protocol: "paperclip.runner",
        version: 1,
        kind: "command_result",
        payload: {
          commandId: suspend.commandId,
          commandType: suspend.type,
          controllerSeq: suspend.controllerSeq,
          status: "completed",
          result: { suspended: true },
        },
      });
      await expect(receiveSecure(cleanup)).resolves.toMatchObject({
        kind: "command_result_ack",
      });
      expect(core.store.state.commands[0]?.status).toBe("completed");
      expect(core.store.state.ackedSourceSeq).toBe(0);
      cleanup.socket.destroy();
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "semantic_input_digest_mismatch",
    "source_event_replay_conflict",
  ] as const)(
    "preserves a typed integrity fault from the trusted commit boundary (%s)",
    async (reason) => {
      const root = mkdtempSync(
        resolve(tmpdir(), "paperclip-prp-typed-commit-integrity-"),
      );
      const error = new NativeSessionProtocolIntegrityError(reason);
      const onProtocolIntegrityError = vi.fn();
      const onCommittedEvent = vi.fn(async () => {
        throw error;
      });
      const onSemanticToolInput = vi.fn(async () => ({ result: { ok: true } }));
      const core = new DurablePrpControlPlane({
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
        onProtocolIntegrityError,
        onCommittedEvent,
        onSemanticToolInput,
      });
      try {
        await core.start();
        const client = (await authenticate(core, core.issueBootstrapTicket()))!;
        sendSecure(client, semanticInputEvent());
        await expect(receiveSecure(client)).resolves.toBeNull();
        expect(onProtocolIntegrityError).toHaveBeenCalledExactlyOnceWith(error);
        expect(core.store.state.ackedSourceSeq).toBe(0);
        expect(onSemanticToolInput).not.toHaveBeenCalled();
        const retry = (await authenticate(core, client.leaseToken!))!;
        sendSecure(retry, semanticInputEvent());
        await expect(receiveSecure(retry)).resolves.toBeNull();
        expect(onProtocolIntegrityError).toHaveBeenCalledExactlyOnceWith(error);
        expect(onCommittedEvent).toHaveBeenCalledTimes(1);
      } finally {
        await core.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("latches an authenticated replay conflict against exactly committed bytes", async () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "paperclip-prp-replay-integrity-"),
    );
    const onProtocolIntegrityError = vi.fn();
    const onCommittedEvent = vi.fn(async () => undefined);
    const onSemanticToolInput = vi.fn(
      async () => new Promise<{ result: unknown }>(() => undefined),
    );
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onProtocolIntegrityError,
      onCommittedEvent,
      onSemanticToolInput,
    });
    try {
      await core.start();
      const client = (await authenticate(core, core.issueBootstrapTicket()))!;
      sendSecure(client, semanticInputEvent());
      await expect(receiveSecure(client)).resolves.toMatchObject({
        kind: "ack",
        payload: { ackedSourceSeq: 1 },
      });
      const changed = semanticInputEvent();
      const semantic = (
        (changed.payload as Record<string, unknown>).payload as Record<
          string,
          unknown
        >
      ).semantic_tool as Record<string, unknown>;
      semantic.input = { changed: true };
      (semantic.content as Record<string, unknown>).digest =
        digestPaperclipSemanticContent(semantic.input);
      sendSecure(client, changed);
      await expect(receiveSecure(client)).resolves.toBeNull();
      expect(onProtocolIntegrityError).toHaveBeenCalledTimes(1);
      expect(onProtocolIntegrityError.mock.calls[0]![0]).toBeInstanceOf(
        NativeSessionProtocolIntegrityError,
      );
      expect(onProtocolIntegrityError.mock.calls[0]![0]).toMatchObject({
        reason: "source_event_replay_conflict",
      });
      expect(onCommittedEvent).toHaveBeenCalledTimes(1);
      expect(onSemanticToolInput).toHaveBeenCalledTimes(1);
      expect(core.store.state.ackedSourceSeq).toBe(1);
      expect(core.store.state.committedEvents).toHaveLength(1);
      expect(core.store.state.committedEvents[0]?.envelope).toEqual(
        semanticInputEvent(),
      );
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "unauthenticated",
    "envelope_runner",
    "envelope_environment",
    "envelope_run",
    "envelope_session",
    "envelope_turn",
    "envelope_item",
    "event_run",
    "event_runner",
    "event_session",
    "event_turn",
    "event_item",
    "source_seq_gap",
    "semantic_run",
    "semantic_session",
    "semantic_turn",
    "semantic_item",
    "malformed_semantic",
  ])(
    "rejects %s malformed input without poisoning the legitimate owner",
    async (mismatch) => {
      const root = mkdtempSync(
        resolve(tmpdir(), "paperclip-prp-unbound-integrity-"),
      );
      const onProtocolIntegrityError = vi.fn();
      const onCommittedEvent = vi.fn(async () => undefined);
      const onSemanticToolInput = vi.fn(async () => ({ result: { ok: true } }));
      const core = new DurablePrpControlPlane({
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
        onProtocolIntegrityError,
        onCommittedEvent,
        onSemanticToolInput,
      });
      try {
        await core.start();
        const event = corruptSemanticInputDigest();
        const canonical = event.payload as Record<string, unknown>;
        const semantic = (canonical.payload as Record<string, unknown>)
          .semantic_tool as Record<string, unknown>;
        if (mismatch.startsWith("envelope_")) {
          const key = {
            envelope_runner: "runnerInstanceId",
            envelope_environment: "environmentLeaseId",
            envelope_run: "runId",
            envelope_session: "normalizedSessionId",
            envelope_turn: "turnId",
            envelope_item: "itemId",
          }[mismatch]!;
          event[key] = "another-owner";
        } else if (mismatch.startsWith("event_")) {
          const key = {
            event_runner: "sourceInstanceId",
            event_run: "runId",
            event_session: "normalizedSessionId",
            event_turn: "turnId",
            event_item: "itemId",
          }[mismatch]!;
          canonical[key] = "another-owner";
        } else if (mismatch === "source_seq_gap") canonical.sourceSeq = 2;
        else if (mismatch === "malformed_semantic") delete semantic.callId;
        else if (mismatch.startsWith("semantic_")) {
          const key = {
            semantic_run: "runId",
            semantic_session: "normalizedSessionId",
            semantic_turn: "turnId",
            semantic_item: "itemId",
          }[mismatch]!;
          (semantic.correlation as Record<string, unknown>)[key] =
            "another-owner";
        }
        if (mismatch === "unauthenticated") {
          const client = await upgradeSocket(core.connectUrl);
          sendMaskedJson(client.socket, event);
          await expect(client.reader.next()).resolves.toBeNull();
        } else {
          const client = (await authenticate(
            core,
            core.issueBootstrapTicket(),
          ))!;
          sendSecure(client, event);
          await expect(receiveSecure(client)).resolves.toBeNull();
        }
        expect(onProtocolIntegrityError).not.toHaveBeenCalled();
        expect(onCommittedEvent).not.toHaveBeenCalled();
        expect(onSemanticToolInput).not.toHaveBeenCalled();
        const legitimate = (await authenticate(
          core,
          core.issueBootstrapTicket(),
        ))!;
        sendSecure(legitimate, semanticInputEvent());
        await expect(receiveSecure(legitimate)).resolves.toMatchObject({
          kind: "ack",
          payload: { ackedSourceSeq: 1 },
        });
        expect(onProtocolIntegrityError).not.toHaveBeenCalled();
        expect(onCommittedEvent).toHaveBeenCalledTimes(1);
        expect(onSemanticToolInput).toHaveBeenCalledTimes(1);
        legitimate.socket.destroy();
      } finally {
        await core.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not dispatch an earlier in-flight commit after a replacement connection proves an integrity fault", async () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "paperclip-prp-integrity-commit-race-"),
    );
    let releaseCommit!: () => void;
    const commitBarrier = new Promise<void>((resolveCommit) => {
      releaseCommit = resolveCommit;
    });
    const onCommittedEvent = vi.fn(async () => commitBarrier);
    const onProtocolIntegrityError = vi.fn();
    const onSemanticToolInput = vi.fn(async () => ({ result: { ok: true } }));
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onCommittedEvent,
      onProtocolIntegrityError,
      onSemanticToolInput,
    });
    try {
      await core.start();
      const first = (await authenticate(core, core.issueBootstrapTicket()))!;
      sendSecure(first, semanticInputEvent());
      await vi.waitFor(() => expect(onCommittedEvent).toHaveBeenCalledTimes(1));
      const replacement = (await authenticate(core, first.leaseToken!))!;
      sendSecure(replacement, corruptSemanticInputDigest());
      await expect(receiveSecure(replacement)).resolves.toBeNull();
      expect(onProtocolIntegrityError).toHaveBeenCalledTimes(1);
      releaseCommit();
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      expect(core.store.state.ackedSourceSeq).toBe(0);
      expect(core.store.state.committedEvents).toEqual([]);
      expect(onSemanticToolInput).not.toHaveBeenCalled();
    } finally {
      releaseCommit();
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not turn a missing semantic handler into an integrity fault", async () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "paperclip-prp-integrity-no-handler-"),
    );
    const onProtocolIntegrityError = vi.fn();
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
      onProtocolIntegrityError,
    });
    try {
      await core.start();
      const client = (await authenticate(core, core.issueBootstrapTicket()))!;
      sendSecure(client, corruptSemanticInputDigest());
      await expect(receiveSecure(client)).resolves.toBeNull();
      expect(onProtocolIntegrityError).not.toHaveBeenCalled();
      expect(core.store.state.ackedSourceSeq).toBe(0);
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    new Error("database temporarily unavailable"),
    Object.assign(new Error("untrusted native_event_replay_conflict prose"), {
      code: "native_event_replay_conflict",
    }),
  ])(
    "keeps a non-typed commit failure retryable on the same authenticated authority (%s)",
    async (commitFailure) => {
      const root = mkdtempSync(
        resolve(tmpdir(), "paperclip-prp-transient-commit-"),
      );
      const onProtocolIntegrityError = vi.fn();
      const onCommittedEvent = vi
        .fn()
        .mockRejectedValueOnce(commitFailure)
        .mockResolvedValue(undefined);
      const onSemanticToolInput = vi.fn(async () => ({ result: { ok: true } }));
      const core = new DurablePrpControlPlane({
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
        onProtocolIntegrityError,
        onCommittedEvent,
        onSemanticToolInput,
      });
      try {
        await core.start();
        const first = (await authenticate(core, core.issueBootstrapTicket()))!;
        sendSecure(first, semanticInputEvent());
        await expect(receiveSecure(first)).resolves.toBeNull();
        expect(core.store.state.ackedSourceSeq).toBe(0);
        expect(onSemanticToolInput).not.toHaveBeenCalled();
        const retry = (await authenticate(core, first.leaseToken!))!;
        sendSecure(retry, semanticInputEvent());
        await expect(receiveSecure(retry)).resolves.toMatchObject({
          kind: "ack",
          payload: { ackedSourceSeq: 1 },
        });
        expect(onProtocolIntegrityError).not.toHaveBeenCalled();
        expect(onCommittedEvent).toHaveBeenCalledTimes(2);
        expect(onSemanticToolInput).toHaveBeenCalledTimes(1);
        retry.socket.destroy();
      } finally {
        await core.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("requires a fresh bootstrap to replace a v1 lease with v2 on the same authority", async () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "paperclip-prp-version-bootstrap-"),
    );
    const core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    const clients: AuthenticatedClient[] = [];
    try {
      await core.start();
      const first = (await authenticate(core, core.issueBootstrapTicket()))!;
      clients.push(first);
      expect(first.welcome.version).toBe(1);
      first.socket.destroy();
      const reconnect = (await authenticate(
        core,
        first.leaseToken!,
        identity,
        expectedRunnerDigest,
        undefined,
        false,
        2,
      ))!;
      clients.push(reconnect);
      expect(reconnect.welcome.version).toBe(1);
      reconnect.socket.destroy();
      // A replacement process has no in-memory lease. Its owner issues the
      // normal one-use bootstrap for the unchanged, validated run authority.
      const freshTicket = core.issueBootstrapTicket();
      const replacement = (await authenticate(
        core,
        freshTicket,
        identity,
        expectedRunnerDigest,
        undefined,
        false,
        2,
      ))!;
      clients.push(replacement);
      expect(replacement.welcome.version).toBe(2);
      expect(core.store.state.identity).toEqual(identity);
      expect(core.store.state.commands).toEqual([]);
      expect(core.store.state.committedEvents).toEqual([]);
      expect(
        await authenticate(
          core,
          freshTicket,
          identity,
          expectedRunnerDigest,
          undefined,
          false,
          2,
        ),
      ).toBeNull();
    } finally {
      for (const client of clients) client.socket.destroy();
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
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

  it("retains an old warm attach result replay lane when its result ACK is lost after core rotation", async () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "paperclip-prp-attach-result-ack-loss-"),
    );
    const controlPlane = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    const nextIdentity = {
      ...identity,
      runId: "00000000-0000-4000-8000-000000000002",
      turnId: "turn-ack-loss-2",
      itemId: "item-ack-loss-2",
    };
    let client: AuthenticatedClient | null = null;
    let replay: AuthenticatedClient | null = null;
    try {
      await controlPlane.start();
      client = await authenticate(
        controlPlane,
        controlPlane.issueBootstrapTicket(),
      );
      expect(client).not.toBeNull();
      const command = controlPlane.queueCommand(
        "run.attach",
        {
          paperclipNextAuthority: {
            identity: nextIdentity,
            connection: {
              mode: "connect",
              connectUrl: controlPlane.connectUrl,
            },
          },
        },
        "command-attach-ack-loss",
        true,
      );
      await expect(receiveSecure(client!)).resolves.toMatchObject({
        kind: "command",
      });
      const leaseToken = client!.leaseToken!;
      const result = {
        protocol: "paperclip.runner",
        version: 1,
        kind: "command_result",
        payload: {
          commandId: command.commandId,
          commandType: command.type,
          controllerSeq: command.controllerSeq,
          status: "completed",
          result: { attached: true },
        },
      };
      sendSecure(client!, result);
      await vi.waitFor(() =>
        expect(controlPlane.store.state.commands[0]?.status).toBe("completed"),
      );
      expect(
        JSON.parse(readFileSync(controlPlane.store.path, "utf8")).commands[0]
          .result,
      ).toEqual(result.payload);
      // The result ACK remains unread on this lost connection. Observing the
      // result must not delete the old receipt or activate its new identity.
      controlPlane.rotateRunIdentity(nextIdentity);
      expect(controlPlane.store.state.identity).toEqual(identity);
      client!.socket.destroy();
      replay = await authenticate(controlPlane, leaseToken, identity);
      expect(
        replay,
        "the exact old result must remain replayable until authenticated new activation",
      ).not.toBeNull();
      sendSecure(replay!, result);
      await expect(receiveSecure(replay!)).resolves.toMatchObject({
        kind: "command_result_ack",
        payload: {
          commandId: command.commandId,
          controllerSeq: command.controllerSeq,
        },
      });
    } finally {
      client?.socket.destroy();
      replay?.socket.destroy();
      await controlPlane.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "activate",
    "activate-v2",
    "foreign-receipt",
    "foreign-key",
    "old-event",
    "bootstrap",
    "bootstrap-v2",
    "bootstrap-before-result",
    "bootstrap-lost-welcome",
    "revoked-bootstrap",
    "expired-bootstrap",
    "revoked-live-peer",
    "expired-tombstone",
    "completed-replay",
    "completed-revoked",
    "completed-expired",
    "completed-foreign-key",
  ] as const)("keeps warm handoff authority closed across %s", async (mode) => {
    const selectedProtocol = mode.endsWith("-v2") ? 2 : 1;
    const authenticateVersion: typeof authenticate = (...args) => {
      args[6] = selectedProtocol;
      return authenticate(...args);
    };
    const root = mkdtempSync(
      resolve(tmpdir(), "paperclip-prp-attach-transition-"),
    );
    let core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    const nextIdentity = {
      ...identity,
      runId: "00000000-0000-4000-8000-000000000002",
      turnId: "turn-transition-2",
      itemId: "item-transition-2",
    };
    let peer: AuthenticatedClient | null = null;
    let successor: AuthenticatedClient | null = null;
    try {
      await core.start();
      const unusedTicket = core.issueBootstrapTicket();
      peer = await authenticateVersion(core, core.issueBootstrapTicket());
      const oldToken = peer!.leaseToken!;
      const command = core.queueCommand(
        "run.attach",
        {
          paperclipNextAuthority: {
            identity: nextIdentity,
            connection: { mode: "connect", connectUrl: core.connectUrl },
          },
        },
        "command-transition",
        true,
      );
      await expect(receiveSecure(peer!)).resolves.toMatchObject({
        kind: "command",
      });
      const beforeResult = readFileSync(core.store.path, "utf8");
      const result = {
        commandId: command.commandId,
        commandType: command.type,
        controllerSeq: command.controllerSeq,
        status: "completed",
        result: { attached: true },
      };
      sendSecure(peer!, {
        protocol: "paperclip.runner",
        version: selectedProtocol,
        kind: "command_result",
        payload: result,
      });
      const ack = await receiveSecure(peer!);
      const receipt = (ack!.payload as Record<string, unknown>)
        .warmTransition as Record<string, unknown>;
      const transitionId = receipt.transitionId as string;
      expect(core.store.state.identity).toEqual(identity);
      expect(() => core.queueCommand("turn.start", {})).toThrow(
        "exact cached attachment replay",
      );
      expect(() => core.issueBootstrapTicket()).toThrow(
        "explicit one-use bootstrap",
      );
      if (mode === "revoked-live-peer") {
        core.store.state.leases[
          core.store.state.warmTransition!.credentialId
        ]!.revokedAt = new Date().toISOString();
        sendSecure(peer!, {
          protocol: "paperclip.runner",
          version: selectedProtocol,
          kind: "command_result",
          payload: result,
        });
        expect(await peer!.reader.next()).toBeNull();
        expect(core.store.state.warmTransition?.phase).toBe("prepared");
        return;
      }
      peer!.socket.destroy();
      await core.stop();
      if (mode === "bootstrap-before-result")
        writeFileSync(core.store.path, beforeResult);
      core = new DurablePrpControlPlane({
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
      });
      await core.start();
      if (mode === "foreign-receipt") {
        expect(
          await authenticateVersion(
            core,
            oldToken,
            nextIdentity,
            expectedRunnerDigest,
            "f".repeat(64),
          ),
        ).toBeNull();
      } else if (mode === "foreign-key") {
        expect(
          await authenticateVersion(
            core,
            unusedTicket,
            nextIdentity,
            expectedRunnerDigest,
            transitionId,
          ),
        ).toBeNull();
      } else if (mode === "old-event") {
        successor = await authenticateVersion(
          core,
          oldToken,
          identity,
          expectedRunnerDigest,
          transitionId,
        );
        sendSecure(successor!, {
          protocol: "paperclip.runner",
          version: selectedProtocol,
          kind: "event",
          payload: { sourceSeq: 1 },
        });
        expect(await successor!.reader.next()).toBeNull();
        expect(core.store.state.committedEvents).toEqual([]);
        expect(core.store.state.identity).toEqual(identity);
      } else if (mode.includes("bootstrap")) {
        const { status: _status, result: _result, ...wire } = command;
        const runnerState = {
          schema: "paperclip.runner.durable.state.warm-transition.v1",
          ...identity,
          ackedSourceSeq: receipt.oldAckedSourceSeq,
          nextSourceSeq: Number(receipt.oldAckedSourceSeq) + 1,
          outbox: [],
          pendingTerminalDelivery: null,
          warmTransition: {
            receipt,
            phase: "prepared",
            command: { ...wire, deadlineAt: null, precondition: null },
            result,
          },
        };
        const inspection = {
          controlPlaneState: core.store.state,
          runnerState,
          expectedNewIdentity: nextIdentity,
          expectedRunnerVersion,
          expectedRunnerDigest,
        };
        const beforeInspection = JSON.stringify([
          core.store.state,
          runnerState,
        ]);
        expect(inspectWarmRunTransition(inspection)).toMatchObject({
          receipt,
          runnerIdentity: identity,
          controllerIdentity: identity,
          phase:
            mode === "bootstrap-before-result" ? "awaiting_result" : "prepared",
        });
        expect(JSON.stringify([core.store.state, runnerState])).toBe(
          beforeInspection,
        );
        expect(
          inspectWarmRunTransition({
            ...inspection,
            expectedNewIdentity: identity,
          }),
        ).toBeNull();
        expect(
          inspectWarmRunTransition({
            ...inspection,
            expectedRunnerDigest: `sha256:${"b".repeat(64)}`,
          }),
        ).toBeNull();
        expect(
          inspectWarmRunTransition({
            ...inspection,
            now: Number(receipt.leaseExpiresAtUnixMs),
          }),
        ).toBeNull();
        expect(
          inspectWarmRunTransition({
            ...inspection,
            runnerState: { ...runnerState, outbox: [{}] },
          }),
        ).toBeNull();
        expect(
          inspectWarmRunTransition({
            ...inspection,
            runnerState: { ...runnerState, pendingProviderCleanup: {} },
          }),
        ).toBeNull();
        expect(
          inspectWarmRunTransition({
            ...inspection,
            runnerState: {
              ...runnerState,
              warmTransition: {
                ...runnerState.warmTransition,
                result: { ...result, status: "failed" },
              },
            },
          }),
        ).toBeNull();
        expect(() =>
          core.issueWarmTransitionBootstrapTicket({
            transitionId,
            runnerState: { ...runnerState, runId: nextIdentity.runId },
          }),
        ).toThrow("snapshot");
        const originalLease = structuredClone(
          Object.values(core.store.state.leases).find(
            (lease) =>
              lease.leaseId === receipt.leaseId && lease.revokedAt === null,
          )!,
        );
        if (mode === "revoked-bootstrap") {
          core.store.state.leases[originalLease.credentialId]!.revokedAt =
            new Date().toISOString();
          expect(() =>
            core.issueWarmTransitionBootstrapTicket({
              transitionId,
              runnerState,
            }),
          ).toThrow("not authorized");
        } else if (mode === "expired-bootstrap") {
          vi.spyOn(Date, "now").mockReturnValue(
            originalLease.expiresAtUnixMs + 1,
          );
          expect(() =>
            core.issueWarmTransitionBootstrapTicket({
              transitionId,
              runnerState,
            }),
          ).toThrow("not authorized");
        } else {
          let ticket = core.issueWarmTransitionBootstrapTicket({
            transitionId,
            runnerState,
          });
          if (mode === "bootstrap-before-result") {
            expect(core.store.state.warmTransition?.phase).toBe(
              "awaiting_result",
            );
            expect(core.getCommand(command.commandId)?.status).toBe("pending");
            await core.stop();
            core = new DurablePrpControlPlane({
              stateDirectory: root,
              identity,
              expectedRunnerVersion,
              expectedRunnerDigest,
            });
            await core.start();
          }
          if (mode === "bootstrap-lost-welcome") {
            const attachWire = core.attachWireConnection.bind(core);
            let dropped = false;
            const wireSpy = vi
              .spyOn(core, "attachWireConnection")
              .mockImplementation((wire) =>
                attachWire({
                  onJson: wire.onJson.bind(wire),
                  onClose: wire.onClose.bind(wire),
                  close: wire.close.bind(wire),
                  sendJson: (value) => {
                    if (
                      !dropped &&
                      (value as { schema?: string }).schema ===
                        "paperclip.runner.secure-frame.v1"
                    ) {
                      dropped = true;
                      wire.close();
                      return;
                    }
                    wire.sendJson(value);
                  },
                }),
              );
            expect(
              await authenticateVersion(
                core,
                ticket,
                identity,
                expectedRunnerDigest,
                transitionId,
              ),
            ).toBeNull();
            expect(dropped).toBe(true);
            expect(
              await authenticateVersion(
                core,
                oldToken,
                identity,
                expectedRunnerDigest,
                transitionId,
              ),
            ).toBeNull();
            expect(
              await authenticateVersion(
                core,
                ticket,
                identity,
                expectedRunnerDigest,
                transitionId,
              ),
            ).toBeNull();
            wireSpy.mockRestore();
            ticket = core.issueWarmTransitionBootstrapTicket({
              transitionId,
              runnerState,
            });
          }
          successor = await authenticateVersion(
            core,
            ticket,
            identity,
            expectedRunnerDigest,
            transitionId,
          );
          expect(successor).not.toBeNull();
          expect(
            core.store.state.leases[
              core.store.state.warmTransition!.credentialId
            ],
          ).toMatchObject({
            leaseId: originalLease.leaseId,
            expiresAtUnixMs: originalLease.expiresAtUnixMs,
            revocationEpoch: originalLease.revocationEpoch,
          });
          expect(
            await authenticateVersion(
              core,
              oldToken,
              identity,
              expectedRunnerDigest,
              transitionId,
            ),
          ).toBeNull();
          expect(
            await authenticateVersion(
              core,
              ticket,
              identity,
              expectedRunnerDigest,
              transitionId,
            ),
          ).toBeNull();
          if (mode === "bootstrap-before-result")
            expect(core.getCommand(command.commandId)?.status).toBe("pending");
          sendSecure(successor!, {
            protocol: "paperclip.runner",
            version: selectedProtocol,
            kind: "command_result",
            payload: result,
          });
          await expect(receiveSecure(successor!)).resolves.toMatchObject({
            kind: "command_result_ack",
            payload: { warmTransition: receipt },
          });
          expect(core.getCommand(command.commandId)?.status).toBe("completed");
        }
      } else {
        successor = await authenticateVersion(
          core,
          oldToken,
          nextIdentity,
          expectedRunnerDigest,
          transitionId,
        );
        expect(successor).not.toBeNull();
        expect(core.store.state.identity).toEqual(nextIdentity);
        expect(
          (successor!.welcome.payload as Record<string, unknown>)
            .pendingCommands,
        ).toEqual([]);
        expect(
          await authenticateVersion(
            core,
            oldToken,
            identity,
            expectedRunnerDigest,
            transitionId,
          ),
        ).toBeNull();
        const next = core.queueCommand(
          "session.snapshot",
          {},
          "next-snapshot",
          true,
        );
        expect(
          core.store.state.commandDeliveryCounts[next.commandId],
        ).toBeUndefined();
        sendSecure(successor!, {
          protocol: "paperclip.runner",
          version: selectedProtocol,
          kind: "warm_transition_activated",
          payload: { transitionId },
        });
        await expect(receiveSecure(successor!)).resolves.toMatchObject({
          kind: "warm_transition_activated_ack",
          payload: { transitionId },
        });
        await vi.waitFor(() =>
          expect(core.store.state.warmTransition).toBeUndefined(),
        );
        expect(core.store.state.schema).toBe(
          "paperclip.runner.durable.control-plane-state.v1",
        );
        await expect(receiveSecure(successor!)).resolves.toMatchObject({
          kind: "command",
          payload: { commandId: next.commandId },
        });
        if (mode.startsWith("completed-")) {
          successor!.socket.destroy();
          const deliveriesBefore =
            core.store.state.commandDeliveryCounts[next.commandId];
          if (mode === "completed-revoked") {
            Object.values(core.store.state.leases).find(
              (lease) => lease.leaseId === receipt.leaseId,
            )!.revokedAt = new Date().toISOString();
          }
          if (mode === "completed-expired")
            vi.spyOn(Date, "now").mockReturnValue(
              Number(receipt.leaseExpiresAtUnixMs),
            );
          successor = await authenticateVersion(
            core,
            mode === "completed-foreign-key" ? unusedTicket : oldToken,
            nextIdentity,
            expectedRunnerDigest,
            transitionId,
          );
          if (mode !== "completed-replay") {
            expect(successor).toBeNull();
            expect(core.store.state.commandDeliveryCounts[next.commandId]).toBe(
              deliveriesBefore,
            );
            return;
          }
          expect(successor).not.toBeNull();
          expect(
            (successor!.welcome.payload as Record<string, unknown>)
              .pendingCommands,
          ).toEqual([]);
          expect(core.store.state.commandDeliveryCounts[next.commandId]).toBe(
            deliveriesBefore,
          );
          sendSecure(successor!, {
            protocol: "paperclip.runner",
            version: selectedProtocol,
            kind: "warm_transition_activated",
            payload: { transitionId },
          });
          await expect(receiveSecure(successor!)).resolves.toMatchObject({
            kind: "warm_transition_activated_ack",
            payload: { transitionId },
          });
          await expect(receiveSecure(successor!)).resolves.toMatchObject({
            kind: "command",
            payload: { commandId: next.commandId },
          });
        }
        if (mode === "expired-tombstone") {
          vi.spyOn(Date, "now").mockReturnValue(
            Number(receipt.leaseExpiresAtUnixMs) + 1,
          );
          core.issueBootstrapTicket();
          expect(Object.values(core.store.state.leases)).toHaveLength(0);
          vi.restoreAllMocks();
          successor!.socket.destroy();
          await core.stop();
          core = new DurablePrpControlPlane({
            stateDirectory: root,
            identity: nextIdentity,
            expectedRunnerVersion,
            expectedRunnerDigest,
          });
          expect(core.getCommand(command.commandId)?.status).toBe("completed");
        }
      }
    } finally {
      vi.restoreAllMocks();
      peer?.socket.destroy();
      successor?.socket.destroy();
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed after a warm receipt rename when parent directory fsync fails", async () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "paperclip-prp-transition-fsync-"),
    );
    const rootInode = nodeFs.statSync(root).ino;
    let core = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    let client: AuthenticatedClient | null = null;
    let replay: AuthenticatedClient | null = null;
    let syncSpy: { mockRestore(): void } | undefined;
    try {
      await core.start();
      client = await authenticate(core, core.issueBootstrapTicket());
      const token = client!.leaseToken!;
      const command = core.queueCommand(
        "run.attach",
        {
          paperclipNextAuthority: {
            identity: {
              ...identity,
              runId: "fsync-next",
              turnId: "fsync-turn",
              itemId: "fsync-item",
            },
            connection: { mode: "connect", connectUrl: core.connectUrl },
          },
        },
        "fsync-attach",
        true,
      );
      await receiveSecure(client!);
      const result = {
        protocol: "paperclip.runner",
        version: 1,
        kind: "command_result",
        payload: {
          commandId: command.commandId,
          commandType: command.type,
          controllerSeq: command.controllerSeq,
          status: "completed",
          result: { attached: true },
        },
      };
      const sync = nodeFs.fsyncSync;
      let injected = false;
      syncSpy = vi.spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
        const metadata = nodeFs.fstatSync(fd);
        if (
          !injected &&
          metadata.isDirectory() &&
          metadata.ino === rootInode &&
          JSON.parse(readFileSync(core.store.path, "utf8")).warmTransition
            ?.phase === "prepared"
        ) {
          injected = true;
          throw new Error("fixture parent fsync failure after receipt rename");
        }
        sync(fd);
      });
      syncBuiltinESMExports();
      sendSecure(client!, result);
      expect(await client!.reader.next()).toBeNull();
      expect(injected).toBe(true);
      const disk = readFileSync(core.store.path, "utf8");
      expect(JSON.parse(disk).warmTransition.phase).toBe("prepared");
      expect(core.store.state.commands[0]?.status).toBe("pending");
      expect(() => core.queueCommand("turn.start", {})).toThrow(
        "indeterminate; reload",
      );
      expect(() => core.issueBootstrapTicket()).toThrow(
        "indeterminate; reload",
      );
      expect(readFileSync(core.store.path, "utf8")).toBe(disk);
      syncSpy.mockRestore();
      syncBuiltinESMExports();
      await core.stop();
      core = new DurablePrpControlPlane({
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
      });
      await core.start();
      replay = await authenticate(
        core,
        token,
        identity,
        expectedRunnerDigest,
        JSON.parse(disk).warmTransition.receipt.transitionId,
      );
      sendSecure(replay!, result);
      await expect(receiveSecure(replay!)).resolves.toMatchObject({
        kind: "command_result_ack",
      });
    } finally {
      syncSpy?.mockRestore();
      syncBuiltinESMExports();
      client?.socket.destroy();
      replay?.socket.destroy();
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["nonparticipant", "no-capability"] as const)(
    "rejects a held old authentication proof after warm preparation (%s)",
    async (mode) => {
      const root = mkdtempSync(
        resolve(tmpdir(), "paperclip-prp-transition-held-auth-"),
      );
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const held = new Promise<void>((resolveHeld) => {
        entered = resolveHeld;
      });
      let armed = false;
      const core = new DurablePrpControlPlane({
        stateDirectory: root,
        identity,
        expectedRunnerVersion,
        expectedRunnerDigest,
        beforeAuthenticatedConnection: async () => {
          if (armed) {
            entered();
            await gate;
          }
        },
      });
      let first: AuthenticatedClient | null = null;
      let participant: AuthenticatedClient | null = null;
      let pending: Promise<AuthenticatedClient | null> | undefined;
      try {
        await core.start();
        first = await authenticate(core, core.issueBootstrapTicket());
        const unrelatedToken = first!.leaseToken!;
        first!.socket.destroy();
        participant = await authenticate(core, core.issueBootstrapTicket());
        const command = core.queueCommand(
          "run.attach",
          {
            paperclipNextAuthority: {
              identity: {
                ...identity,
                runId: "held-next-run",
                turnId: "held-next-turn",
                itemId: "held-next-item",
              },
              connection: { mode: "connect", connectUrl: core.connectUrl },
            },
          },
          "held-proof-attach",
          true,
        );
        await receiveSecure(participant!);
        armed = true;
        pending = authenticate(
          core,
          mode === "nonparticipant" ? unrelatedToken : participant!.leaseToken!,
          identity,
          expectedRunnerDigest,
          undefined,
          mode === "no-capability",
        );
        await held;
        const result = {
          protocol: "paperclip.runner",
          version: 1,
          kind: "command_result",
          payload: {
            commandId: command.commandId,
            commandType: command.type,
            controllerSeq: command.controllerSeq,
            status: "completed",
            result: { attached: true },
          },
        };
        sendSecure(participant!, result);
        await expect(receiveSecure(participant!)).resolves.toMatchObject({
          kind: "command_result_ack",
        });
        release();
        expect(await pending).toBeNull();
        expect(core.activeRunnerConnectionCount()).toBe(1);
        sendSecure(participant!, result);
        await expect(receiveSecure(participant!)).resolves.toMatchObject({
          kind: "command_result_ack",
        });
        expect(core.store.state.identity).toEqual(identity);
      } finally {
        release();
        await pending
          ?.then((client) => client?.socket.destroy())
          .catch(() => undefined);
        first?.socket.destroy();
        participant?.socket.destroy();
        await core.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("acknowledges terminal command results after persisting them", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-prp-terminal-ack-"));
    const controlPlane = new DurablePrpControlPlane({
      stateDirectory: root,
      identity,
      expectedRunnerVersion,
      expectedRunnerDigest,
    });
    try {
      await controlPlane.start();
      const command = controlPlane.queueCommand(
        "runner.suspend",
        {},
        "command-suspend-1",
      );
      const client = await authenticate(
        controlPlane,
        controlPlane.issueBootstrapTicket(),
      );
      const nextAuthorityCommand = controlPlane.queueCommand(
        "runner.drain",
        {},
        "command-after-suspend-1",
        true,
      );
      expect(
        controlPlane.store.state.commandDeliveryCounts[command.commandId],
      ).toBe(1);
      const terminalResult = {
        protocol: "paperclip.runner",
        version: 1,
        kind: "command_result",
        payload: {
          commandId: command.commandId,
          commandType: command.type,
          controllerSeq: command.controllerSeq,
          status: "completed",
          result: { suspended: true },
        },
      };

      sendSecure(client!, terminalResult);
      await expect(receiveSecure(client!)).resolves.toMatchObject({
        kind: "command_result_ack",
        payload: {
          commandId: "command-suspend-1",
          commandType: "runner.suspend",
          controllerSeq: command.controllerSeq,
          status: "completed",
        },
      });
      expect(controlPlane.store.state.commands).toMatchObject([
        { commandId: "command-suspend-1", status: "completed" },
        { commandId: "command-after-suspend-1", status: "pending" },
      ]);
      expect(
        controlPlane.store.state.commandDeliveryCounts[
          nextAuthorityCommand.commandId
        ],
      ).toBeUndefined();

      sendSecure(client!, terminalResult);
      await expect(receiveSecure(client!)).resolves.toMatchObject({
        kind: "command_result_ack",
        payload: { commandId: "command-suspend-1" },
      });
      expect(controlPlane.store.state.duplicateCommandResults).toBe(1);
      expect(
        controlPlane.store.state.commandDeliveryCounts[
          nextAuthorityCommand.commandId
        ],
      ).toBeUndefined();
      const leaseToken = client!.leaseToken!;
      client?.socket.destroy();
      const successor = await authenticate(controlPlane, leaseToken);
      expect(successor?.welcome.payload).toMatchObject({
        pendingCommands: [
          expect.objectContaining({
            commandId: nextAuthorityCommand.commandId,
          }),
        ],
      });
      successor?.socket.destroy();
    } finally {
      await controlPlane.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
