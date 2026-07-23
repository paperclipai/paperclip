import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/environment-custom-images.js", () => ({
  environmentCustomImageService: vi.fn(() => {
    throw new Error("test must inject a custom image service");
  }),
}));

import {
  setupEnvironmentCustomImageTerminalWebSocketServer,
  type EnvironmentCustomImageSshConnector,
  type EnvironmentCustomImageSshShell,
} from "../realtime/environment-custom-image-terminal-ws.js";
import {
  EnvironmentCustomImageTerminalConnectionRegistry,
  EnvironmentCustomImageTerminalSessionStore,
} from "../services/environment-custom-image-terminal-sessions.js";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws") as {
  WebSocket: new (url: string) => {
    readyState: number;
    send(data: string): void;
    close(): void;
    on(event: "open", listener: () => void): void;
    on(event: "message", listener: (data: Buffer | string) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
  };
};

class FakeSshShell extends EventEmitter implements EnvironmentCustomImageSshShell {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  closeCalls = 0;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  close(): void {
    this.closeCalls += 1;
  }

  onData(listener: (data: string) => void): void {
    this.on("data", listener);
  }

  onClose(listener: () => void): void {
    this.on("close", listener);
  }

  onError(listener: (err: Error) => void): void {
    this.on("ssh-error", listener);
  }

  emitData(data: string) {
    this.emit("data", data);
  }

  emitSshClose() {
    this.emit("close");
  }

  emitSshError(err: Error) {
    this.emit("ssh-error", err);
  }
}

function futureDate(minutes = 60) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    companyId: "company-1",
    environmentId: "env-1",
    provider: "daytona",
    status: "waiting_for_user",
    expiresAt: futureDate(),
    metadata: { setupRpcCompanyId: "company-1" },
    ...overrides,
  };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForAssertion(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    await flushPromises();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function waitForDuration(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function listen(server: HttpServer) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not listen on a TCP port");
  return address.port;
}

async function closeServer(server: HttpServer) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function waitForOpen(ws: InstanceType<typeof WebSocket>) {
  return new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

function waitForClose(ws: InstanceType<typeof WebSocket>) {
  return new Promise<void>((resolve) => {
    ws.on("close", resolve);
  });
}

function waitForJsonMessage<T extends Record<string, unknown>>(
  ws: InstanceType<typeof WebSocket>,
  predicate: (frame: T) => boolean,
) {
  return new Promise<T>((resolve) => {
    ws.on("message", (data: Buffer | string) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      const parsed = JSON.parse(text) as T;
      if (predicate(parsed)) resolve(parsed);
    });
  });
}

function sendTerminalAuth(ws: InstanceType<typeof WebSocket>, token: string) {
  ws.send(JSON.stringify({ type: "auth", token }));
}

function terminalUrl(port: number, input: { setupSessionId?: string; terminalSessionId: string }) {
  const setupSessionId = input.setupSessionId ?? "session-1";
  return `ws://127.0.0.1:${port}/api/environment-custom-image-setup-sessions/${setupSessionId}/terminal/ws`
    + `?terminalSessionId=${encodeURIComponent(input.terminalSessionId)}`
    + "&cols=100&rows=30";
}

describe("custom image terminal websocket bridge", () => {
  let servers: HttpServer[] = [];
  let sessionStore: EnvironmentCustomImageTerminalSessionStore;
  let connectionRegistry: EnvironmentCustomImageTerminalConnectionRegistry;
  let fakeShell: FakeSshShell;
  let customImages: {
    getSessionById: ReturnType<typeof vi.fn>;
    refreshSetupSession: ReturnType<typeof vi.fn>;
  };
  let connector: EnvironmentCustomImageSshConnector & { connect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    servers = [];
    sessionStore = new EnvironmentCustomImageTerminalSessionStore();
    connectionRegistry = new EnvironmentCustomImageTerminalConnectionRegistry();
    fakeShell = new FakeSshShell();
    customImages = {
      getSessionById: vi.fn(async () => createSession()),
      refreshSetupSession: vi.fn(async () => ({
        session: createSession(),
        connectionPayload: {
          type: "ssh",
          command: "ssh fresh-token@fresh.example.test -p 2200",
          expiresAt: futureDate(30).toISOString(),
        },
      })),
    };
    connector = {
      connect: vi.fn(async () => fakeShell),
    };
  });

  afterEach(async () => {
    for (const server of servers) {
      server.emit("close");
    }
    await Promise.all(servers.map((server) => closeServer(server)));
  });

  async function startHarness() {
    const server = createServer();
    servers.push(server);
    setupEnvironmentCustomImageTerminalWebSocketServer(server, {} as never, {
      customImageService: customImages,
      sessionStore,
      connectionRegistry,
      sshConnector: connector,
    });
    const port = await listen(server);
    return { server, port };
  }

  it("rejects invalid and expired terminal credentials before refreshing provider payloads", async () => {
    const { port } = await startHarness();
    const invalid = new WebSocket(terminalUrl(port, {
      terminalSessionId: "missing",
    }));

    const invalidError = waitForJsonMessage(invalid, (frame) => frame.type === "error");
    const invalidClose = waitForClose(invalid);
    await waitForOpen(invalid);
    sendTerminalAuth(invalid, "bad-token");
    await expect(invalidError).resolves.toMatchObject({
      type: "error",
      message: "Invalid terminal session token.",
    });
    await invalidClose;
    expect(customImages.refreshSetupSession).not.toHaveBeenCalled();

    const expired = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "old", host: "old.example.test", port: 22 },
      setupExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      connectionExpiresAt: new Date(Date.now() - 60 * 1000),
      now: new Date(Date.now() - 2 * 60 * 1000),
    });
    const expiredWs = new WebSocket(terminalUrl(port, {
      terminalSessionId: expired.session.id,
    }));

    const expiredError = waitForJsonMessage(expiredWs, (frame) => frame.type === "error");
    const expiredClose = waitForClose(expiredWs);
    await waitForOpen(expiredWs);
    sendTerminalAuth(expiredWs, expired.token);
    await expect(expiredError).resolves.toMatchObject({
      type: "error",
      message: "Invalid terminal session token.",
    });
    await expiredClose;
    expect(customImages.refreshSetupSession).not.toHaveBeenCalled();
  });

  it("rejects unsupported refreshed payloads before opening an SSH bridge", async () => {
    const { port } = await startHarness();
    customImages.refreshSetupSession.mockResolvedValueOnce({
      session: createSession(),
      connectionPayload: {
        type: "browser_terminal",
        command: "ssh provider-secret@203.0.113.10",
      },
    });
    const unsupportedPayload = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "old-token", host: "old.example.test", port: 22 },
      setupExpiresAt: futureDate(),
    });

    const unsupportedWs = new WebSocket(terminalUrl(port, {
      terminalSessionId: unsupportedPayload.session.id,
    }));
    const unsupportedError = waitForJsonMessage(unsupportedWs, (frame) => frame.type === "error");
    const unsupportedClose = waitForClose(unsupportedWs);
    await waitForOpen(unsupportedWs);
    sendTerminalAuth(unsupportedWs, unsupportedPayload.token);
    await expect(unsupportedError).resolves.toMatchObject({
      type: "error",
      message: "Setup session terminal connections require an SSH connection payload.",
    });
    await unsupportedClose;
    expect(sessionStore.get({
      id: unsupportedPayload.session.id,
      token: unsupportedPayload.token,
    })).toBeNull();

    customImages.refreshSetupSession.mockResolvedValueOnce({
      session: createSession(),
      connectionPayload: {
        type: "ssh",
        command: "ssh provider-secret@203.0.113.10 -i /tmp/private-key",
      },
    });
    const unsupportedCommand = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "old-token", host: "old.example.test", port: 22 },
      setupExpiresAt: futureDate(),
    });

    const unsupportedCommandWs = new WebSocket(terminalUrl(port, {
      terminalSessionId: unsupportedCommand.session.id,
    }));
    const unsupportedCommandError = waitForJsonMessage(unsupportedCommandWs, (frame) => frame.type === "error");
    const unsupportedCommandClose = waitForClose(unsupportedCommandWs);
    await waitForOpen(unsupportedCommandWs);
    sendTerminalAuth(unsupportedCommandWs, unsupportedCommand.token);
    await expect(unsupportedCommandError).resolves.toMatchObject({
      type: "error",
      message: "Setup session SSH payload uses an unsupported command shape.",
    });
    await unsupportedCommandClose;
    expect(sessionStore.get({
      id: unsupportedCommand.session.id,
      token: unsupportedCommand.token,
    })).toBeNull();
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it("bridges websocket input, SSH output, and resize frames through a fake shell", async () => {
    const { port } = await startHarness();
    const minted = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "old-token", host: "old.example.test", port: 22 },
      setupExpiresAt: futureDate(),
    });
    const ws = new WebSocket(terminalUrl(port, {
      terminalSessionId: minted.session.id,
    }));
    const readyPromise = waitForJsonMessage(ws, (frame) => frame.type === "ready");

    await waitForOpen(ws);
    sendTerminalAuth(ws, minted.token);
    const ready = await readyPromise;
    expect(ready).toMatchObject({
      type: "ready",
      setupSessionId: "session-1",
      terminalSessionId: minted.session.id,
    });
    expect(customImages.refreshSetupSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      includeConnectionPayload: true,
    });
    expect(connector.connect).toHaveBeenCalledWith({
      ssh: { username: "fresh-token", host: "fresh.example.test", port: 2200 },
      term: "xterm-256color",
      cols: 100,
      rows: 30,
      verifyHostKeySha256: expect.any(Function),
    });

    ws.send(JSON.stringify({ type: "input", data: "echo ok\r" }));
    await waitForAssertion(() => {
      expect(fakeShell.writes).toEqual(["echo ok\r"]);
    });

    const outputPromise = waitForJsonMessage(ws, (frame) => frame.type === "output");
    fakeShell.emitData("shell output\r\n");
    await expect(outputPromise).resolves.toMatchObject({
      type: "output",
      data: "shell output\r\n",
    });

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await waitForAssertion(() => {
      expect(fakeShell.resizes).toEqual([{ cols: 120, rows: 40 }]);
    });

    const closePromise = waitForClose(ws);
    ws.close();
    await closePromise;
    await waitForAssertion(() => {
      expect(fakeShell.closeCalls).toBeGreaterThan(0);
      expect(sessionStore.get({ id: minted.session.id, token: minted.token })).toBeNull();
    });
  });

  it("keeps established terminal sessions alive past connect-token expiry and closes them at setup expiry", async () => {
    const setupExpiresAt = new Date(Date.now() + 2500);
    customImages.getSessionById.mockResolvedValue(createSession({ expiresAt: setupExpiresAt }));
    customImages.refreshSetupSession.mockResolvedValue({
      session: createSession({ expiresAt: setupExpiresAt }),
      connectionPayload: {
        type: "ssh",
        command: "ssh fresh-token@fresh.example.test -p 2200",
        expiresAt: futureDate(30).toISOString(),
      },
    });
    const { port } = await startHarness();
    const minted = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "old-token", host: "old.example.test", port: 22 },
      setupExpiresAt,
      now: new Date(Date.now() - 5 * 60 * 1000 + 750),
    });
    expect(minted.session.connectExpiresAt.getTime()).toBeLessThan(minted.session.sessionExpiresAt.getTime());

    const ws = new WebSocket(terminalUrl(port, {
      terminalSessionId: minted.session.id,
    }));
    let closed = false;
    ws.on("close", () => {
      closed = true;
    });
    const readyPromise = waitForJsonMessage(ws, (frame) => frame.type === "ready");
    const closePromise = waitForClose(ws);

    await waitForOpen(ws);
    sendTerminalAuth(ws, minted.token);
    await readyPromise;
    await waitForDuration(Math.max(0, minted.session.connectExpiresAt.getTime() - Date.now()) + 400);
    expect(closed).toBe(false);
    expect(fakeShell.closeCalls).toBe(0);

    await closePromise;
    expect(closed).toBe(true);
    expect(fakeShell.closeCalls).toBeGreaterThan(0);
  });

  it("applies the latest resize sent while the SSH shell is still opening", async () => {
    const pendingShell = deferred<EnvironmentCustomImageSshShell>();
    connector.connect.mockReturnValueOnce(pendingShell.promise);
    const { port } = await startHarness();
    const minted = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "old-token", host: "old.example.test", port: 22 },
      setupExpiresAt: futureDate(),
    });
    const ws = new WebSocket(terminalUrl(port, {
      terminalSessionId: minted.session.id,
    }));
    const readyPromise = waitForJsonMessage(ws, (frame) => frame.type === "ready");

    await waitForOpen(ws);
    sendTerminalAuth(ws, minted.token);
    await waitForAssertion(() => {
      expect(connector.connect).toHaveBeenCalled();
    });
    const unsupportedFramePromise = waitForJsonMessage(ws, (frame) => frame.type === "error");
    ws.send(JSON.stringify({ type: "resize", cols: 110, rows: 31 }));
    ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
    ws.send(JSON.stringify({ type: "unsupported-test-frame" }));
    await unsupportedFramePromise;
    expect(fakeShell.resizes).toEqual([]);

    pendingShell.resolve(fakeShell);
    await readyPromise;
    expect(fakeShell.resizes).toEqual([{ cols: 132, rows: 43 }]);

    ws.close();
    await waitForClose(ws);
  });

  it("sends a redacted fallback error when SSH bridge connection fails", async () => {
    const { port } = await startHarness();
    connector.connect.mockRejectedValueOnce(new Error("provider secret should not leak"));
    const minted = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "old-token", host: "old.example.test", port: 22 },
      setupExpiresAt: futureDate(),
    });
    const ws = new WebSocket(terminalUrl(port, {
      terminalSessionId: minted.session.id,
    }));
    const errorPromise = waitForJsonMessage(ws, (frame) => frame.type === "error");
    const closePromise = waitForClose(ws);

    await waitForOpen(ws);
    sendTerminalAuth(ws, minted.token);
    await expect(errorPromise).resolves.toMatchObject({
      type: "error",
      message: "SSH terminal connection failed.",
    });
    await closePromise;
    expect(sessionStore.get({ id: minted.session.id, token: minted.token })).toBeNull();
  });

  it("cleans up and closes the websocket when the SSH shell errors", async () => {
    const { port } = await startHarness();
    const minted = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "token", host: "example.test", port: 22 },
      setupExpiresAt: futureDate(),
    });
    const ws = new WebSocket(terminalUrl(port, {
      terminalSessionId: minted.session.id,
    }));
    const readyPromise = waitForJsonMessage(ws, (frame) => frame.type === "ready");

    await waitForOpen(ws);
    sendTerminalAuth(ws, minted.token);
    await readyPromise;
    const errorPromise = waitForJsonMessage(ws, (frame) => frame.type === "error");
    const closePromise = waitForClose(ws);
    fakeShell.emitSshError(new Error("provider secret should not leak"));
    await expect(errorPromise).resolves.toMatchObject({
      type: "error",
      message: "SSH terminal connection failed.",
    });
    await closePromise;
    expect(sessionStore.get({ id: minted.session.id, token: minted.token })).toBeNull();
    expect(fakeShell.closeCalls).toBeGreaterThan(0);
  });

  it("closes active terminal sessions on server shutdown", async () => {
    const { server, port } = await startHarness();
    const minted = sessionStore.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "token", host: "example.test", port: 22 },
      setupExpiresAt: futureDate(),
    });
    const ws = new WebSocket(terminalUrl(port, {
      terminalSessionId: minted.session.id,
    }));
    const readyPromise = waitForJsonMessage(ws, (frame) => frame.type === "ready");

    await waitForOpen(ws);
    sendTerminalAuth(ws, minted.token);
    await readyPromise;
    const closePromise = waitForClose(ws);
    server.emit("close");
    await closePromise;

    expect(sessionStore.get({ id: minted.session.id, token: minted.token })).toBeNull();
    expect(fakeShell.closeCalls).toBeGreaterThan(0);
  });
});
