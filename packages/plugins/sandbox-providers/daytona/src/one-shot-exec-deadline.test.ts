import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSandbox = vi.hoisted(() => vi.fn());
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class { get = getSandbox; },
  DaytonaNotFoundError: class extends Error {},
  DaytonaTimeoutError: class extends Error {},
}));

import plugin, { __resetDaytonaSandboxHandleCacheForTest } from "./plugin.js";

function fixture() {
  const process = { executeCommand: vi.fn() };
  getSandbox.mockResolvedValue({ id: "fixture-sandbox", state: "started", process });
  // A bypass-session probe such as `opencode --version` takes the one-shot path.
  const execute = () => plugin.definition.onEnvironmentExecute!({
    driverKey: "daytona", companyId: "fixture-company", environmentId: "fixture-environment",
    config: { apiKey: "fixture-not-a-key", timeoutMs: 300_000 }, bypassSession: true,
    lease: { providerLeaseId: "fixture-sandbox", metadata: {} },
    command: "/pack/bin/opencode", args: ["--version"], timeoutMs: 30_000,
  });
  return { process, execute };
}

describe("Daytona one-shot exec request deadline", () => {
  beforeEach(() => {
    __resetDaytonaSandboxHandleCacheForTest();
    getSandbox.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetDaytonaSandboxHandleCacheForTest();
  });

  it("returns a timed-out result when the provider exec request outlives the command deadline", async () => {
    const { process, execute } = fixture();
    process.executeCommand.mockImplementation(() => new Promise(() => undefined));
    let settled = false;
    const pending = execute().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The host abandons the RPC at 60 s; the plugin must answer first.
    expect(await pending).toMatchObject({
      exitCode: null, timedOut: true,
      metadata: { timeoutScope: "provider_exec_request", commandExitConfirmed: false },
    });
    expect(process.executeCommand).toHaveBeenCalledOnce();
  });

  it("keeps a slow exec that answers within the request deadline", async () => {
    const { process, execute } = fixture();
    process.executeCommand.mockImplementation(() => new Promise(resolve => setTimeout(
      () => resolve({ exitCode: 0, result: "1.2.3", artifacts: { stdout: "1.2.3" } }), 34_000)));
    const pending = execute();
    await vi.advanceTimersByTimeAsync(34_000);
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, stdout: "1.2.3" });
  });
});
