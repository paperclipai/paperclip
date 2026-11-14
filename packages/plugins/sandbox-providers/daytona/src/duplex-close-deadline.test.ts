import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createSandbox = vi.hoisted(() => vi.fn());
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class { create = createSandbox; get = vi.fn(); },
  DaytonaNotFoundError: class extends Error {},
  DaytonaTimeoutError: class extends Error {},
}));

import { DUPLEX_CHANNEL_CLOSE_KILL_TIMEOUT_MS, openDaytonaDuplexChannelSession } from "./duplex-command-stream.js";
import plugin, { __resetDaytonaSandboxHandleCacheForTest } from "./plugin.js";

const HOST_DUPLEX_CLOSE_TIMEOUT_MS = 10_000;

function fakePty() {
  return {
    waitForConnection: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    wait: vi.fn(() => new Promise<{ exitCode: number }>(() => {})),
    kill: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
}

async function fixture() {
  const pty = fakePty();
  const sandbox = {
    id: "fixture-sandbox", name: "paperclip-sandbox", state: "started", recoverable: false, target: "us",
    errorReason: null, autoDeleteInterval: -1, autoStopInterval: 15,
    setAutostopInterval: vi.fn(async () => {}), setAutoDeleteInterval: vi.fn(async () => {}),
    setTtl: vi.fn(async () => {}), refreshData: vi.fn(async () => {}),
    getWorkDir: vi.fn(async () => "/home/daytona"), getUserHomeDir: vi.fn(async () => "/home/daytona"),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    fs: { createFolder: vi.fn(async () => {}), uploadFile: vi.fn(async () => {}), deleteFile: vi.fn(async () => {}) },
    process: {
      executeCommand: vi.fn(async () => ({ exitCode: 0, result: "bash", artifacts: { stdout: "bash" } })),
      createPty: vi.fn(async () => pty),
    },
  };
  createSandbox.mockResolvedValue(sandbox);
  await plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "daytona", companyId: "fixture-company", environmentId: "fixture-environment", runId: "fixture-run",
    config: { apiKey: "fixture-not-a-key", image: "fixture-image", timeoutMs: 3_000, livenessTimeoutMs: 1_000, reuseLease: true },
  });
  const opened = await plugin.definition.onDuplexChannelOpen!({
    driverKey: "daytona", companyId: "fixture-company", environmentId: "fixture-environment",
    providerLeaseId: sandbox.id, command: ["fixture-bridge"], hostRouteId: "fixture-route",
  });
  return { pty, opened };
}

describe("Daytona duplex channel close deadline", () => {
  beforeEach(() => { __resetDaytonaSandboxHandleCacheForTest(); createSandbox.mockReset(); });
  afterEach(() => { vi.useRealTimers(); __resetDaytonaSandboxHandleCacheForTest(); });

  it("keeps the close kill deadline well inside the host close deadline", () => {
    expect(DUPLEX_CHANNEL_CLOSE_KILL_TIMEOUT_MS).toBeLessThanOrEqual(HOST_DUPLEX_CLOSE_TIMEOUT_MS / 2);
  });

  it("releases the session socket at the kill deadline when the remote kill never settles", async () => {
    const pty = fakePty();
    const session = await openDaytonaDuplexChannelSession({ createPty: async () => pty }, ["fixture-bridge"]);
    pty.kill.mockImplementation(() => new Promise<void>(() => {}));
    vi.useFakeTimers();

    let closed = false;
    const closing = session.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(DUPLEX_CHANNEL_CLOSE_KILL_TIMEOUT_MS - 1);
    expect(closed).toBe(false);
    expect(pty.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(pty.disconnect).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a bound close inside the host deadline when the remote kill never settles", async () => {
    const { pty, opened } = await fixture();
    pty.kill.mockImplementation(() => new Promise<void>(() => {}));
    vi.useFakeTimers();

    let ack: unknown;
    const closing = plugin.definition.onDuplexChannelClose!({ hostRouteId: opened.hostRouteId })
      .then((value) => { ack = value; });
    await vi.advanceTimersByTimeAsync(HOST_DUPLEX_CLOSE_TIMEOUT_MS - 1_000);
    expect(ack).toEqual(opened);
    await closing;
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(pty.disconnect).toHaveBeenCalledTimes(1);

    await expect(plugin.definition.onDuplexChannelClose!({ hostRouteId: opened.hostRouteId })).resolves.toEqual(opened);
    await expect(plugin.definition.onDuplexChannelOpen!({
      driverKey: "daytona", companyId: "fixture-company", environmentId: "fixture-environment",
      providerLeaseId: "fixture-sandbox", command: ["fixture-bridge"], hostRouteId: opened.hostRouteId,
    })).rejects.toThrow("already been used");
  });

  it("still waits for a kill that answers inside the deadline before it releases the socket", async () => {
    const { pty, opened } = await fixture();
    let finishKill!: () => void;
    pty.kill.mockImplementation(() => new Promise<void>((resolve) => { finishKill = resolve; }));
    vi.useFakeTimers();

    let ack: unknown;
    const closing = plugin.definition.onDuplexChannelClose!({ hostRouteId: opened.hostRouteId })
      .then((value) => { ack = value; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ack).toBeUndefined();
    expect(pty.disconnect).not.toHaveBeenCalled();

    finishKill();
    await closing;
    expect(ack).toEqual(opened);
    expect(pty.disconnect).toHaveBeenCalledTimes(1);
  });
});
