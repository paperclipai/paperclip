import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ native: vi.fn(), legacy: vi.fn(), plugin: vi.fn() }));
vi.mock("../services/native-runtime/setup-readiness.js", () => ({ testNativeRunnerAuthentication: mocks.native }));
vi.mock("../services/native-runtime/plugin-runner-probe.js", () => ({ probePluginRunnerEnvironment: mocks.plugin }));
vi.mock("../adapters/plugin-loader.js", () => ({ buildExternalAdapters: () => [] }));
vi.mock("../services/adapter-plugin-store.js", () => ({ getDisabledAdapterTypes: () => new Set() }));
vi.mock("@paperclipai/adapter-opencode-local/server", () => ({ execute: vi.fn(), listOpenCodeSkills: vi.fn(), syncOpenCodeSkills: vi.fn(), testEnvironment: mocks.legacy, sessionCodec: {}, listOpenCodeModels: vi.fn() }));
import { requireServerAdapter } from "../adapters/registry.js";
beforeEach(() => { vi.clearAllMocks(); mocks.native.mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", checks: [] }); mocks.legacy.mockResolvedValue({ adapterType: "opencode_local", status: "pass", checks: [] }); });
it.each([["opencode", "openrouter/deepseek/deepseek-v4.1-flash-1017"], ["codex", "gpt-6.1-sol"]] as const)("routes native %s through the native probe with its selected model and target", async (provider, model) => {
  const selected = { companyId: "company-1", adapterType: "paperclip_runner", config: { provider, model }, executionTarget: { kind: "local" as const, environmentId: "selected-environment" } };
  expect((await requireServerAdapter("paperclip_runner").testEnvironment(selected)).status).toBe("pass");
  expect(mocks.native).toHaveBeenCalledExactlyOnceWith(selected, provider, model); expect(mocks.legacy).not.toHaveBeenCalled();
});
it("retains the explicit legacy OpenCode adapter", async () => {
  const selected = { companyId: "company-1", adapterType: "opencode_local", config: {} };
  await requireServerAdapter("opencode_local").testEnvironment(selected);
  expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith(selected); expect(mocks.native).not.toHaveBeenCalled();
});

it("preserves the existing lease-bound remote plugin Runner probe before the local wrapper", async () => {
  const selected = { companyId: "company-1", adapterType: "paperclip_runner", config: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" }, executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/selected", providerKey: "plugin", leaseId: "probe-lease", runnerTask: vi.fn(), runnerTaskProbe: { runId: "probe-run", sessionId: "probe-session" } } };
  mocks.plugin.mockResolvedValueOnce({ adapterType: "paperclip_runner", status: "pass", checks: [{ code: "runner_hello_probe_passed" }] });
  expect((await requireServerAdapter("paperclip_runner").testEnvironment(selected as never)).status).toBe("pass");
  expect(mocks.plugin).toHaveBeenCalledExactlyOnceWith(selected); expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});
