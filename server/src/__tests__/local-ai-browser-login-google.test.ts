import { afterEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ warn: vi.fn(), start: vi.fn((_home: string, _options?: { onFailure?: (reason: string) => void }) => ({ abort: async () => undefined })) }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: runner.warn } }));
vi.mock("../vendor/paperclip-runner/index.js", () => ({ resolveCodexCommand: vi.fn(), startAntigravityBrowserLogin: runner.start }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({ runSetupTokenLogin: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ runDeviceLogin: vi.fn() }));
import { startLocalBrowserLogin } from "../services/local-ai-browser-login.js";

afterEach(() => { vi.clearAllMocks(); });

describe("server-host Google sign-in failure logging", () => {
  it.each([
    ["runtime_unavailable", "ANTIGRAVITY_SIGN_IN_RUNTIME_UNAVAILABLE"],
    ["start_failed", "ANTIGRAVITY_SIGN_IN_START_FAILED"],
    ["login_incomplete", "ANTIGRAVITY_SIGN_IN_LOGIN_INCOMPLETE"],
  ])("logs %s by its secret-free reason code", (reason, code) => {
    startLocalBrowserLogin("google", "/tmp/attempt");
    runner.start.mock.calls[0]![1]!.onFailure!(reason);
    expect(runner.warn).toHaveBeenCalledExactlyOnceWith({ code }, "Google Antigravity sign-in failed");
  });

  it("does not log a cancelled attempt", () => {
    startLocalBrowserLogin("google", "/tmp/attempt");
    runner.start.mock.calls[0]![1]!.onFailure!("aborted");
    expect(runner.warn).not.toHaveBeenCalled();
  });
});
