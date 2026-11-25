import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startAntigravityBrowserLogin: vi.fn(() => ({ abort: async () => undefined })),
}));

vi.mock("../vendor/paperclip-runner/index.js", () => ({
  resolveCodexCommand: vi.fn(),
  startAntigravityBrowserLogin: mocks.startAntigravityBrowserLogin,
}));

import { startLocalBrowserLogin } from "./local-ai-browser-login.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("startLocalBrowserLogin (google)", () => {
  it("forwards normalized PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to startAntigravityBrowserLogin", () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/opt/paperclip-runner/provider-pack/");
    startLocalBrowserLogin("google", "/tmp/google-login-home");
    expect(mocks.startAntigravityBrowserLogin).toHaveBeenCalledExactlyOnceWith("/tmp/google-login-home", {
      providerPackageRoot: "/opt/paperclip-runner/provider-pack",
    });
  });

  it("omits providerPackageRoot when PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH is unset or non-normalized", () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "");
    startLocalBrowserLogin("google", "/tmp/google-login-home");
    expect(mocks.startAntigravityBrowserLogin).toHaveBeenLastCalledWith("/tmp/google-login-home");

    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/opt/paperclip-runner/../etc");
    startLocalBrowserLogin("google", "/tmp/google-login-home");
    expect(mocks.startAntigravityBrowserLogin).toHaveBeenLastCalledWith("/tmp/google-login-home");

    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "relative/pack");
    startLocalBrowserLogin("google", "/tmp/google-login-home");
    expect(mocks.startAntigravityBrowserLogin).toHaveBeenLastCalledWith("/tmp/google-login-home");
  });
});
