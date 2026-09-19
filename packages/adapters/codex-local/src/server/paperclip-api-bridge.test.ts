import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { withCodexPaperclipApiBridge } from "./paperclip-api-bridge.js";

const startBridge = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/paperclip-api-pipe", () => ({
  startPaperclipApiPipeBridge: startBridge,
}));

afterEach(() => { vi.resetAllMocks(); });

function context(runId = "run-A"): AdapterExecutionContext {
  return {
    runId,
    agent: { id: "agent-A", companyId: "company-A", name: "Agent", adapterType: "codex_local", adapterConfig: {} },
    runtime: {}, context: {}, onLog: vi.fn(async () => {}),
    config: {
      engine: "acp",
      permissionMode: "agent",
      env: {
        PAPERCLIP_API_URL: "http://127.0.0.1:3100",
        PAPERCLIP_API_KEY: "run-token",
        PAPERCLIP_RUN_SCRATCH_DIR: `/runtime/${runId}/scratch`,
        PAPERCLIP_GITHUB_LAUNCHER_DIR: `/runtime/${runId}/launchers`,
        UNRELATED_SETTING: "preserved",
      },
    },
  } as unknown as AdapterExecutionContext;
}

describe.skipIf(process.platform !== "linux")("local Codex Paperclip API bridge lifecycle", () => {
  it("binds a fresh pipe per execution and leaves permission/engine configuration unchanged", async () => {
    const ctx = context();
    const stop = vi.fn(async () => {});
    startBridge.mockResolvedValueOnce({ env: { PAPERCLIP_API_BROKER_PIPE: "/runtime/run-A/api-pipe" }, stop });
    const execute = vi.fn(async (passed: AdapterExecutionContext) => {
      expect(passed.config).toMatchObject({ engine: "acp", permissionMode: "agent" });
      expect(passed.config.env).toEqual({
        ...ctx.config.env as object,
        PAPERCLIP_API_BROKER_PIPE: "/runtime/run-A/api-pipe",
      });
      expect(stop).not.toHaveBeenCalled();
      return { exitCode: 0, signal: null, timedOut: false };
    });
    await expect(withCodexPaperclipApiBridge(ctx, execute)).resolves.toMatchObject({ exitCode: 0 });
    expect(startBridge).toHaveBeenCalledWith({
      directory: "/runtime/run-A/scratch",
      apiUrl: "http://127.0.0.1:3100",
      apiToken: "run-token",
      runId: "run-A",
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("closes the bridge when the executor throws", async () => {
    const stop = vi.fn(async () => {});
    startBridge.mockResolvedValueOnce({ env: { PAPERCLIP_API_BROKER_PIPE: "/runtime/run-A/api-pipe" }, stop });
    await expect(withCodexPaperclipApiBridge(context(), async () => {
      throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not make the transport mandatory for an unrelated run", async () => {
    const ctx = context();
    startBridge.mockRejectedValueOnce(new Error("sensitive-provider-error"));
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));
    await withCodexPaperclipApiBridge(ctx, execute);
    expect(execute).toHaveBeenCalledWith(ctx);
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain("sensitive-provider-error");
  });

  it("retains the existing remote callback transport", async () => {
    const ctx = context();
    ctx.executionTarget = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" };
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));
    await withCodexPaperclipApiBridge(ctx, execute);
    expect(execute).toHaveBeenCalledWith(ctx);
    expect(startBridge).not.toHaveBeenCalled();
  });
});
