import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  runSetup: vi.fn(),
  runDevice: vi.fn(),
}));
vi.mock("node-pty", () => ({ spawn: mocks.spawn }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runSetupTokenLogin: mocks.runSetup,
}));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  runDeviceLogin: mocks.runDevice,
}));
vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  ensureCommandResolvable: vi.fn(async () => {}),
  resolveCommandForLogs: vi.fn(async (command: string) => `${command}.cmd`),
}));
vi.mock("../vendor/paperclip-runner/index.js", () => ({
  resolveCodexCommand: vi.fn(() => "codex"),
}));

import { startLocalBrowserLogin, type LocalBrowserLoginState } from "./local-ai-browser-login.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const events = {
  onExit: (_value: { exitCode: number }) => {},
  onData: (_value: string) => {},
};
function fakePty() {
  return {
    onData: vi.fn((callback: (text: string) => void) => { events.onData = callback; }),
    onExit: vi.fn((callback: (exit: { exitCode: number }) => void) => { events.onExit = callback; }),
    write: vi.fn(),
    kill: vi.fn(),
  };
}
async function waitForSpawn() {
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
}
function fakeRunner(
  driver: { start: (command: string, onData: (text: string) => void) => Promise<{ exitCode: number | null }>; stop: () => void },
  options: { signal?: AbortSignal },
) {
  options.signal?.addEventListener("abort", () => driver.stop(), { once: true });
  return driver.start("fixed provider command", () => {}).then(({ exitCode }) => {
    driver.stop();
    return { outcome: exitCode === 0 ? "success" : "failure" };
  });
}

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.clearAllMocks();
  vi.resetAllMocks();
});

describe("native Windows subscription login PTY", () => {
  it("launches Claude setup-token under ConPTY without spawning Unix Python", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const pty = fakePty();
    mocks.spawn.mockReturnValue(pty);
    mocks.runSetup.mockImplementation(fakeRunner);
    const login = startLocalBrowserLogin("anthropic", "C:\\private\\login-home");
    await waitForSpawn();
    const [executable, args, settings] = mocks.spawn.mock.calls[0];
    expect(executable).toBe("powershell.exe");
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("& 'C:\\private\\login-home\\claude.cmd' 'setup-token'");
    expect(settings.env.CLAUDE_CONFIG_DIR).toBe("C:\\private\\login-home");
    expect(settings.env.ANTHROPIC_API_KEY).toBe("");
    expect(settings.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    events.onExit({ exitCode: 0 });
    await vi.waitFor(() => expect(login.outcome).toBe("success"));
    expect(pty.kill).toHaveBeenCalled();
  });

  it("terminates the ConPTY process when cancelled", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const pty = fakePty();
    mocks.spawn.mockReturnValue(pty);
    mocks.runSetup.mockImplementation(fakeRunner);
    const login = startLocalBrowserLogin("anthropic", "C:\\private\\login-home");
    await waitForSpawn();
    const abortCompleted = vi.fn();
    const aborted = login.abort().then(abortCompleted);
    await Promise.resolve();
    expect(abortCompleted).not.toHaveBeenCalled();
    // The real login runner races the abort against the child exit. The fixture
    // supplies an exit after cancellation to settle its pending startup promise.
    events.onExit({ exitCode: 1 });
    await aborted;
    await vi.waitFor(() => expect(login.outcome).toBe("failure"));
    expect(abortCompleted).toHaveBeenCalledOnce();
    expect(pty.kill).toHaveBeenCalled();
  });

  it("does not spawn ConPTY when cancelled before launch", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const pty = fakePty();
    mocks.spawn.mockReturnValue(pty);
    mocks.runSetup.mockImplementation(fakeRunner);
    const login = startLocalBrowserLogin("anthropic", "C:\\private\\login-home");
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("kills newly spawned ConPTY if cancellation raced with spawn", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const pty = fakePty();
    let abortedLogin!: LocalBrowserLoginState;
    mocks.spawn.mockImplementationOnce(() => {
      abortedLogin.abort();
      return pty;
    });
    mocks.runSetup.mockImplementation(fakeRunner);
    abortedLogin = startLocalBrowserLogin("anthropic", "C:\\private\\login-home");
    await waitForSpawn();
    expect(pty.kill).toHaveBeenCalled();
  });

  it("launches Codex login --device-auth under ConPTY without spawning Unix Python", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const pty = fakePty();
    mocks.spawn.mockReturnValue(pty);
    mocks.runDevice.mockImplementation(fakeRunner);
    const login = startLocalBrowserLogin("openai", "C:\\private\\codex-home");
    await waitForSpawn();
    const [executable, args, settings] = mocks.spawn.mock.calls[0];
    expect(executable).toBe("powershell.exe");
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("& 'C:\\private\\codex-home\\codex.cmd' 'login' '--device-auth'");
    expect(settings.env.CODEX_HOME).toBe("C:\\private\\codex-home");
    events.onExit({ exitCode: 0 });
    await vi.waitFor(() => expect(login.outcome).toBe("success"));
    expect(pty.kill).toHaveBeenCalled();
  });
});
