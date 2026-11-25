import { afterEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ start: vi.fn((_home: string, _options?: { providerPackRoot?: string }) => ({ abort: async () => undefined })) }));
vi.mock("../vendor/paperclip-runner/index.js", () => ({ resolveCodexCommand: vi.fn(), startAntigravityBrowserLogin: runner.start }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({ runSetupTokenLogin: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ runDeviceLogin: vi.fn() }));
import { startLocalBrowserLogin } from "../services/local-ai-browser-login.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("server-host Google sign-in runtime", () => {
  it("launches from the image's build-owned provider pack", () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", " /opt/paperclip-runner/provider-pack/ ");
    startLocalBrowserLogin("google", "/paperclip/instances/default/ai-local-logins/attempt");
    expect(runner.start).toHaveBeenCalledWith("/paperclip/instances/default/ai-local-logins/attempt",
      { providerPackRoot: "/opt/paperclip-runner/provider-pack" });
  });

  it("keeps packaged and account-cache resolution when no provider pack is configured", () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "");
    startLocalBrowserLogin("google", "/tmp/attempt");
    expect(runner.start).toHaveBeenCalledWith("/tmp/attempt", {});
  });
});
