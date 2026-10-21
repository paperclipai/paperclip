// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "@/api/client";
import {
  api, envApi, settings, secrets, state, managedApi, adapterApi,
  root, container, cache, settle, click, fill, render, connect, pass,
  renderCurrentParams,
} from "./NewAgent.test-support";

describe("New agent setup", () => {
  it("creates an inactive record before connecting and finishes that same agent", async () => {
    await render("codex_local");
    expect(api.create).toHaveBeenCalledTimes(1);
    const setupId = api.create.mock.calls[0][1].setupId;
    expect(api.create.mock.calls[0][1]).toMatchObject({ name: "Atlas", runtimeConfig: { heartbeat: { enabled: false } } });
    expect(state.navigate).toHaveBeenCalledWith(expect.stringContaining(`setupAgentId=${setupId}`), { replace: true });
    expect(api.hire).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    await click("OpenAIAPI key");
    await fill("API key", "setup-test-key");
    await click("Connect");
    expect(api.update).toHaveBeenCalledWith(setupId, expect.objectContaining({ runtimeConfig: expect.objectContaining({ aiConnection: expect.anything() }) }), "company-1");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].setupAgentId).toBe(setupId);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("resumes a name-only draft at adapter selection without creating another record", async () => {
    const setupId = "00000000-0000-4000-8000-000000000091";
    state.params = new URLSearchParams({ name: "Atlas", adapterType: "process", setupAgentId: setupId });
    api.get.mockResolvedValue({ id: setupId, companyId: "company-1", name: "Atlas", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, metadata: { setupAdapterPending: true }, pauseReason: "setup", status: "paused" });
    await renderCurrentParams();
    await settle();
    expect(document.body.textContent).toContain("Choose an adapter");
    expect(api.create).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLInputElement>('input[name="new-agent-adapter"][value="codex_local"]')!.click());
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Configure agent")!.click());
    await settle();
    expect(api.update).toHaveBeenCalledWith(setupId, expect.objectContaining({ adapterType: "codex_local", metadata: { setupAdapterPending: false } }), "company-1");
    expect(state.navigate).toHaveBeenLastCalledWith(expect.stringContaining(`setupAgentId=${setupId}`), { replace: true });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("retries early creation with the same identity before offering authentication", async () => {
    api.create.mockRejectedValueOnce(new Error("Creation unavailable"));
    await render("codex_local");
    expect(container.textContent).toContain("Creation unavailable");
    expect(container.textContent).not.toContain("Complete subscription login");
    await click("Retry");
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[1][1].setupId).toBe(api.create.mock.calls[0][1].setupId);
    expect(container.textContent).toContain("Connect a model");
  });

  it("resumes a saved setup record and its configuration after navigation", async () => {
    await render("codex_local");
    await click("OpenAIAPI key");
    await fill("API key", "setup-test-key");
    await click("Connect");
    await fill("Model", "gpt-5.4");
    await click("Save & exit");
    const setupId = api.create.mock.calls[0][1].setupId;
    expect(state.navigate).toHaveBeenLastCalledWith("/agents/all");
    await act(async () => root.render(null));
    cache.clear();
    state.params = new URLSearchParams({ name: "Atlas", adapterType: "codex_local", setupAgentId: setupId });
    await renderCurrentParams();
    await settle();
    expect(container.textContent).toContain("Configure your agent");
    expect(container.textContent).not.toContain("Your agent is ready");
    expect((container.querySelector('[aria-label="Model"]') as HTMLInputElement).value).toBe("gpt-5.4");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1]).toMatchObject({ setupAgentId: setupId, adapterConfig: { model: "gpt-5.4" } });
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("retains the first agent's role when finishing its setup", async () => {
    api.list.mockResolvedValue([]);
    await render("codex_local");
    await connect("OpenAI");
    api.list.mockResolvedValue([{ id: api.create.mock.calls[0][1].setupId, role: "ceo", status: "paused" }]);
    await act(async () => { await cache.invalidateQueries({ queryKey: queryKeys.agents.list("company-1") }); });
    await settle();
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].role).toBe("ceo");
  });

  it("keeps the setup identity when finalization fails and is retried", async () => {
    await render("codex_local");
    await connect("OpenAI");
    api.hire.mockRejectedValueOnce(new Error("Hire unavailable"));
    await click("Finish setup");
    expect(container.textContent).toContain("Hire unavailable");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(2);
    expect(api.hire.mock.calls[1][1].setupAgentId).toBe(api.hire.mock.calls[0][1].setupAgentId);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("carries the existing Claude stored-login authorization into a saved setup", async () => {
    api.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "stored-oauth", latestVersion: 1 });
    await render("claude_local");
    await click("ClaudeSubscription");
    await click("Use saved subscription");
    expect(api.update.mock.calls[0][1].applyStoredClaudeLogin).toBe(true);
  });

  it("saves a typed gateway key as a secret and restores it without re-entry", async () => {
    await render("hermes_gateway");
    await fill("Hermes API base URL", "https://hermes.example.test");
    await fill("API_SERVER_KEY", "saved-gateway-key");
    await click("Save & exit");
    const setupId = api.create.mock.calls[0][1].setupId;
    expect(api.update.mock.calls.at(-1)![1].adapterConfig.apiKey).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(JSON.stringify(api.update.mock.calls)).not.toContain("saved-gateway-key");
    await act(async () => root.render(null));
    cache.clear();
    state.params = new URLSearchParams({ name: "Atlas", adapterType: "hermes_gateway", setupAgentId: setupId });
    await renderCurrentParams();
    await settle();
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.apiKey).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(secrets.create).toHaveBeenCalledTimes(1);
  });

  it("retains an unfinished legacy harness when the current target defaults to Paperclip Runner", async () => {
    await render("codex_local");
    const setupId = api.create.mock.calls[0][1].setupId;
    await act(async () => root.render(null));
    cache.clear();
    state.adapters = state.adapters.map((adapter: any) => adapter.type === "codex_local" ? { ...adapter, defaultRunner: "paperclip", supportedRunners: ["paperclip", "legacy"] } : adapter);
    state.params = new URLSearchParams({ name: "Atlas", adapterType: "codex_local", setupAgentId: setupId });
    await renderCurrentParams();
    await settle();
    await connect("OpenAI");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1]).toMatchObject({ adapterType: "codex_local", runner: "legacy" });
  });

  it.each([
    ["paperclip", "Connect", "image"], ["legacy", "Connect", "image"],
    ["paperclip", "Finish setup", "image"], ["legacy", "Finish setup", "image"],
    ["paperclip", "Connect", "snapshot"], ["paperclip", "Finish setup", "snapshot"],
  ] as const)("qualifies new managed Claude and saves measured %s defaults through %s from %s", async (measured, step, source) => {
    const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
    envApi.list.mockResolvedValue([{ id: "sandbox-1", driver: "sandbox", config: { provider: "daytona", ...(source === "snapshot" ? { snapshot: "managed-snapshot" } : { image }) } }]);
    settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    settings.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: true, enableNativeRunner: false });
    api.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-oauth", latestVersion: 1 });
    state.adapters = state.adapters.map((adapter: any) => adapter.type === "claude_local"
      ? { ...adapter, defaultRunner: "legacy", supportedRunners: ["legacy"] } : adapter);
    let qualified = false;
    const calls: string[] = [];
    adapterApi.list.mockImplementation(async context => {
      if (context?.companyId) calls.push(qualified ? "discovery-after" : "discovery-before");
      return state.adapters;
    });
    envApi.probe.mockImplementation(async () => {
      calls.push("platform"); qualified = true;
      state.adapters = state.adapters.map((adapter: any) => adapter.type === "claude_local"
        ? { ...adapter, defaultRunner: measured, supportedRunners: [measured] } : adapter);
      return { ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "owned-platform-lease" } };
    });
    api.testEnvironment.mockImplementation(async () => { calls.push("adapter"); return pass; });
    await render("claude_local");
    expect(envApi.probe).not.toHaveBeenCalled();
    if (step === "Connect") {
      await click("ClaudeSubscription");
      calls.length = 0;
      await click("Use saved subscription");
    } else {
      managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
        id: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022", companyId: "company-1",
        provider: "openrouter", method: "api_key", name: "Company OpenRouter", ownership: "shared", isDefault: false, status: "connected",
        routing: { kind: "openrouter", protocol: "messages", auth: "bearer", models: [] },
      }] } as any);
      await click("AdvancedCustom Gateway");
      const picker = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
      await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
      await settle();
      const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("Company OpenRouter")) as HTMLElement;
      await act(async () => option.click());
      await settle();
      await click("Use connection");
      expect(api.testEnvironment).not.toHaveBeenCalled();
      calls.length = 0;
    }
    await click("Finish setup");
    expect(calls).toEqual(["discovery-before", "platform", "discovery-after", "adapter"]);
    expect(envApi.probe).toHaveBeenCalledExactlyOnceWith("sandbox-1", "company-1");
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.hire).toHaveBeenCalledTimes(1);
    const tested = api.testEnvironment.mock.calls[0][2].adapterConfig;
    const saved = api.hire.mock.calls[0][1];
    expect(saved).not.toHaveProperty("runner");
    expect(saved.adapterConfig).toEqual(tested);
    if (measured === "paperclip") expect(tested).not.toHaveProperty("maxTurnsPerRun");
    else expect(tested.maxTurnsPerRun).toBe(1000);
  });

  it("drops a held managed Claude probe when the same environment changes configuration", async () => {
    const config = { provider: "daytona", image: `registry.example.test/runtime@sha256:${"a".repeat(64)}` };
    envApi.list.mockResolvedValue([{ id: "sandbox-1", driver: "sandbox", config }]);
    settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    state.adapters = state.adapters.map((adapter: any) => adapter.type === "claude_local"
      ? { ...adapter, defaultRunner: "legacy", supportedRunners: ["legacy"] } : adapter);
    api.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-oauth", latestVersion: 1 });
    let finish!: (value: object) => void;
    envApi.probe.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render("claude_local");
    await click("ClaudeSubscription");
    await click("Use saved subscription");
    expect(envApi.probe).toHaveBeenCalledTimes(1);
    await act(async () => cache.setQueryData(queryKeys.environments.list("company-1"), [{ id: "sandbox-1", driver: "sandbox", config: {
      ...config, image: `registry.example.test/runtime@sha256:${"b".repeat(64)}`,
    } }]));
    await settle();
    await act(async () => finish({ ok: true, driver: "sandbox", summary: "Measured image", details: { platformQualificationRecorded: true, leaseId: "owned-lease" } }));
    await settle();
    expect(envApi.probe).toHaveBeenCalledTimes(1);
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
  });

  it("retains the existing managed Claude platform-probe permission gate", async () => {
    envApi.list.mockResolvedValue([{ id: "sandbox-1", driver: "sandbox", config: {
      provider: "daytona", image: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
    } }]);
    settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    state.adapters = state.adapters.map((adapter: any) => adapter.type === "claude_local"
      ? { ...adapter, defaultRunner: "legacy", supportedRunners: ["legacy"] } : adapter);
    api.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-oauth", latestVersion: 1 });
    envApi.probe.mockRejectedValue(new Error("Instance admin access required"));
    await render("claude_local");
    await click("ClaudeSubscription");
    await click("Use saved subscription");
    expect(container.textContent).toContain("Instance admin access required");
    expect(envApi.probe).toHaveBeenCalledTimes(1);
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
  });

  it("waits for the current instance default instead of testing cached SSH discovery", async () => {
    let finish!: (value: object) => void;
    settings.get.mockReturnValue(new Promise<object>(resolve => { finish = resolve; }));
    const environments = [
      { id: "local-1", name: "Local", driver: "local", config: {} },
      { id: "linux-ssh", name: "SSH", driver: "ssh", config: {} },
    ];
    envApi.list.mockResolvedValue(environments);
    cache.setQueryData(queryKeys.environments.list("company-1"), environments);
    cache.setQueryData(queryKeys.instance.settings, { defaultEnvironmentId: "linux-ssh" });
    adapterApi.list.mockImplementation(async (context?: { environmentId?: string | null }) => state.adapters.map((adapter: any) => adapter.type === "claude_local"
      ? { ...adapter, supportedRunners: ["paperclip", "legacy"], defaultRunner: context?.environmentId === "local-1" ? "paperclip" : "legacy" } : adapter));
    await render("claude_local");
    await connect("Claude");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
    await act(async () => finish({ defaultEnvironmentId: "local-1" }));
    await settle();
    await connect("Claude");
    await click("Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.testEnvironment.mock.calls[0][2].environmentId).toBe("local-1");
    expect(api.hire.mock.calls[0][1].adapterConfig).not.toHaveProperty("maxTurnsPerRun");
  });

  it("keeps the API key draft while waiting for refreshed discovery", async () => {
    state.adapters = state.adapters.map((adapter: any) => adapter.type === "claude_local"
      ? { ...adapter, defaultRunner: "paperclip", supportedRunners: ["paperclip", "legacy"] } : adapter);
    await render("claude_local");
    await click("ClaudeAPI key");
    await fill("API key", "example-test-secret");
    const draft = container.querySelector('[aria-label="API key"]') as HTMLInputElement;
    let finish!: (value: object[]) => void;
    adapterApi.list.mockReturnValue(new Promise<object[]>(resolve => { finish = resolve; }));
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = cache.invalidateQueries({ queryKey: queryKeys.adapters.availability("company-1", "local-1") });
    });
    await settle();
    expect(container.querySelector('[aria-label="API key"]')).toBe(draft);
    expect(draft.value).toBe("example-test-secret");
    await click("Connect");
    expect(managedApi.create).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    await act(async () => { finish(state.adapters); await refresh; });
    await settle();
    expect(container.querySelector('[aria-label="API key"]')).toBe(draft);
    expect(draft.value).toBe("example-test-secret");
    await click("Connect");
    await click("Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.hire).toHaveBeenCalledTimes(1);
    expect(api.hire.mock.calls[0][1].adapterConfig).not.toHaveProperty("maxTurnsPerRun");
  });

  it.each(["paperclip", "legacy", undefined] as const)("uses Claude's discovered %s default for Auto setup and hire", async (defaultRunner) => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    state.adapters = (state.adapters as any[]).map(adapter => adapter.type === "claude_local"
      ? { ...adapter, supportedRunners: ["paperclip", "legacy"], defaultRunner } : adapter);
    await render("claude_local");
    await connect("Claude");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    for (const config of [api.testEnvironment.mock.calls[0][2].adapterConfig, api.hire.mock.calls[0][1].adapterConfig]) {
      if (defaultRunner === "paperclip") expect(config).not.toHaveProperty("maxTurnsPerRun");
      else expect(config.maxTurnsPerRun).toBe(1000);
      expect(config).not.toHaveProperty("resolvedRunner");
    }
    expect(api.hire.mock.calls[0][1]).not.toHaveProperty("runner");
  });

  it("finishes ordinary native Claude API setup when the key is verified without a CLI hello", async () => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    state.adapters = (state.adapters as any[]).map(adapter => adapter.type === "claude_local"
      ? { ...adapter, supportedRunners: ["paperclip", "legacy"], defaultRunner: "paperclip" } : adapter);
    api.testEnvironment.mockResolvedValue({ ...pass, adapterType: "paperclip_runner", checks: [
      { code: "acpx_runtime_ready", level: "info", message: "Runtime verified" },
      { code: "ai_connection_api_key_reverified", level: "info", message: "Key verified" },
    ] });
    await render("claude_local");
    await connect("Claude");
    await click("Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledTimes(1);
    expect(api.hire).toHaveBeenCalledTimes(1);
    expect(api.hire.mock.calls[0][1]).not.toHaveProperty("runner");
  });

  it("records an explicit legacy choice when it matches the Windows default, then preserves it on Linux", async () => {
    settings.get.mockResolvedValue({ defaultEnvironmentId: "local-1" });
    envApi.list.mockResolvedValue([
      { id: "local-1", name: "Windows", driver: "local", status: "active", config: {} },
      { id: "linux-ssh", name: "Linux", driver: "ssh", status: "active", config: {} },
    ]);
    adapterApi.list.mockImplementation(async (context?: { environmentId?: string | null }) => state.adapters.map((adapter: any) =>
      adapter.type === "codex_local" ? { ...adapter, supportedRunners: context?.environmentId === "linux-ssh" ? ["paperclip", "legacy"] : ["legacy"], defaultRunner: context?.environmentId === "linux-ssh" ? "paperclip" : "legacy" } : adapter));
    await render("codex_local");
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    const runner = container.querySelector<HTMLButtonElement>('[aria-label="Runner"]')!;
    expect(runner.textContent).toBe("Legacy runner (default)");
    await act(async () => runner.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="option"][data-value="legacy"]')!.click());
    await connect("OpenAI");
    expect(api.testEnvironment).toHaveBeenLastCalledWith("company-1", "codex_local", expect.objectContaining({ runner: "legacy" }));
    const environment = container.querySelector<HTMLSelectElement>('select[aria-label="Environment"]')!;
    await act(async () => { environment.value = "linux-ssh"; environment.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    await connect("OpenAI");
    await click("Finish setup");
    expect(api.testEnvironment).toHaveBeenLastCalledWith("company-1", "codex_local", expect.objectContaining({ environmentId: "linux-ssh", runner: "legacy" }));
    expect(api.hire.mock.calls[0][1]).toMatchObject({ adapterType: "codex_local", runner: "legacy" });
  });

  it("preserves an old native Codex setup link on an unqualified target with the experiment off", async () => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    adapterApi.list.mockImplementation(async () => state.adapters.map((adapter: any) => adapter.type === "codex_local" ? { ...adapter, supportedRunners: ["legacy"], defaultRunner: "legacy" } : adapter));
    api.testEnvironment.mockImplementation(async (_company, adapterType, payload) => {
      if (adapterType === "codex_local" && payload.runner === "paperclip") throw new Error("This target is not qualified for a new native default.");
      return { ...pass, adapterType, checks: [{ code: "paperclip_runner_codex_hello_probe_passed", level: "info", message: "Native runtime replied" }] };
    });
    await render("paperclip_runner", "codex");
    await connect("OpenAI");
    await click("Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledWith("company-1", "paperclip_runner", expect.objectContaining({ runner: "paperclip", adapterConfig: expect.objectContaining({ provider: "codex" }) }));
    expect(api.hire.mock.calls[0][1]).toMatchObject({ adapterType: "paperclip_runner", runner: "paperclip", adapterConfig: { provider: "codex" } });
  });

  it("discovers the runner for the selected target and rechecks after changing environments", async () => {
    settings.get.mockResolvedValue({ defaultEnvironmentId: "linux-ssh" });
    envApi.list.mockResolvedValue([
      { id: "local-1", name: "Windows", driver: "local", status: "active", config: {} },
      { id: "linux-ssh", name: "Linux", driver: "ssh", status: "active", config: {} },
    ]);
    adapterApi.list.mockImplementation(async (context?: { companyId: string; environmentId?: string | null }) => state.adapters.map((adapter: any) =>
      adapter.type === "codex_local" ? { ...adapter, supportedRunners: ["paperclip", "legacy"], defaultRunner: context?.environmentId === "linux-ssh" ? "paperclip" : "legacy" } : adapter));
    await render("codex_local");
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    expect(container.querySelector('[aria-label="Runner"]')?.textContent).toBe("Paperclip Runner (default)");
    expect(adapterApi.list).toHaveBeenCalledWith({ companyId: "company-1", environmentId: "linux-ssh" });
    await connect("OpenAI");
    expect(api.testEnvironment.mock.calls[0][2].environmentId).toBe("linux-ssh");
    const environment = container.querySelector<HTMLSelectElement>('select[aria-label="Environment"]')!;
    await act(async () => {
      environment.value = "local-1";
      environment.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    expect(container.querySelector('[aria-label="Runner"]')?.textContent).toBe("Legacy runner (default)");
    expect(adapterApi.list).toHaveBeenCalledWith({ companyId: "company-1", environmentId: "local-1" });
    await connect("OpenAI");
    await click("Finish setup");
    expect(api.testEnvironment).toHaveBeenCalledTimes(2);
    expect(api.testEnvironment).toHaveBeenLastCalledWith("company-1", "codex_local", expect.objectContaining({ environmentId: "local-1" }));
    expect(api.hire.mock.calls[0][1]).not.toHaveProperty("runner");
  });
  it("surfaces failed target discovery without guessing a default and permits explicit legacy recovery", async () => {
    adapterApi.list.mockImplementation(async (context?: object) => {
      if (context) throw new Error("SSH target is unavailable. Check its connection.");
      return state.adapters;
    });
    await render("codex_local");
    await settle();
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    expect(container.querySelector('[aria-label="Runner"]')?.textContent).toBe("Automatic selection unavailable");
    expect(container.textContent).toContain("SSH target is unavailable. Check its connection.");
    expect(container.textContent).not.toContain("Legacy runner (default)");
    expect(container.textContent).toContain("Retry runner discovery");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Runner"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent === "Legacy runner")!.click());
    await connect("OpenAI");
    await click("Finish setup");
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({ runner: "legacy" });
    expect(api.hire.mock.calls[0][1]).toMatchObject({ runner: "legacy" });
  });
  it.each(["Linux x64", "Mac arm64", "Mac x64"])("uses automatic Codex resolution through setup and hire without the experimental gate (%s)", async name => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    envApi.list.mockResolvedValue([{ id: "local-1", name, driver: "local", status: "active", config: {} }]);
    state.adapters = (state.adapters as any[]).map(adapter => adapter.type === "codex_local" ? { ...adapter, supportedRunners: ["paperclip", "legacy"], defaultRunner: "paperclip" } : adapter);
    await render("codex_local");
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    expect(container.querySelector('[aria-label="Runner"]')?.textContent).toBe("Paperclip Runner (default)");
    await connect("OpenAI");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterType).toBe("codex_local");
    expect(api.hire.mock.calls[0][1]).not.toHaveProperty("runner");
    expect(api.testEnvironment.mock.calls[0][1]).toBe("codex_local");
    expect(api.testEnvironment.mock.calls[0][2]).not.toHaveProperty("runner");
    expect(api.hire.mock.calls[0][1].adapterConfig.dangerouslyBypassApprovalsAndSandbox).not.toBe(true);
  });

  it("allows the explicit legacy override before authentication and rechecks it after a runner change", async () => {
    state.adapters = (state.adapters as any[]).map(adapter => adapter.type === "codex_local" ? { ...adapter, supportedRunners: ["paperclip", "legacy"], defaultRunner: "paperclip" } : adapter);
    await render("codex_local");
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Runner"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent === "Legacy runner")!.click());
    await connect("OpenAI");
    expect(api.testEnvironment.mock.calls[0][2].runner).toBe("legacy");
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Runner"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent === "Paperclip Runner (default)")!.click());
    await click("Finish setup");
    expect(api.testEnvironment).toHaveBeenLastCalledWith("company-1", "codex_local", expect.objectContaining({ runner: "paperclip" }));
    expect(api.hire.mock.calls[0][1]).toMatchObject({ adapterType: "codex_local", runner: "paperclip" });
  });
  it("keeps saved-token Copilot discovery passive while new-agent setup is idle", async () => {
    api.adapterModels.mockResolvedValue([{ id: "gpt-5.6-luna", label: "Copilot Luna" }]);
    await render("paperclip_runner", "copilot");
    await vi.waitFor(() => expect(api.adapterModels).toHaveBeenLastCalledWith("company-1", "paperclip_runner", expect.objectContaining({ environmentId: "local-1", acpxAgent: "copilot" })));
    await settle();
    const initialDiscoveries = api.adapterModels.mock.calls.length;
    await act(async () => { await cache.invalidateQueries({ type: "active" }, { cancelRefetch: false }); });
    await settle();
    expect(api.adapterModels).toHaveBeenCalledTimes(initialDiscoveries);
  });
  it("refuses an undiscovered Copilot model before hiring with a saved connection", async () => {
    api.adapterModels.mockResolvedValue([{ id: "gpt-5.6-luna", label: "GPT" }]);
    await render("paperclip_runner", "copilot");
    await fill("Model", "unavailable-copilot-model");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("select an available model");
  });
  it("preserves the authenticated Copilot model when hiring with a saved connection", async () => {
    api.adapterModels.mockResolvedValue([{ id: "gpt-5.6-luna", label: "GPT" }]);
    await render("paperclip_runner", "copilot");
    await fill("Model", "gpt-5.6-luna");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      adapterType: "paperclip_runner", adapterConfig: expect.objectContaining({ provider: "acpx", acpxAgent: "copilot", model: "gpt-5.6-luna" }),
      runtimeConfig: expect.objectContaining({ aiConnection: { provider: "github", method: "api_key", mode: "responsible_user" } }),
    }));
  });
  it("discovers models after the first Copilot token becomes the responsible user's default", async () => {
    let defaultSaved = false;
    managedApi.setDefault.mockImplementation(async () => { defaultSaved = true; return {}; });
    api.adapterModels.mockImplementation(async () => {
      if (!defaultSaved) throw new ApiError("Connect Copilot first", 422, null);
      return [{ id: "gpt-5.6-luna", label: "GPT" }];
    });
    await render("paperclip_runner", "copilot");
    const beforeConnection = api.adapterModels.mock.calls.length;
    expect(beforeConnection).toBeGreaterThan(0);
    const trigger = document.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes("Connect an account"));
    expect(option).toBeDefined();
    await act(async () => option!.click());
    await settle();
    const input = document.querySelector<HTMLInputElement>('[aria-label="API key"]')!;
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "github_pat_fixture_first");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.trim() === "Connect")!;
    expect(save).toBeTruthy();
    await act(async () => save.click());
    await settle();
    expect(managedApi.setDefault).toHaveBeenCalledWith("company-1", "managed-grant");
    expect(api.adapterModels).toHaveBeenCalledTimes(beforeConnection + 1);
    expect(api.adapterModels.mock.invocationCallOrder[beforeConnection]).toBeGreaterThan(managedApi.setDefault.mock.invocationCallOrder[0]);
    expect(api.adapterModels).toHaveBeenLastCalledWith("company-1", "paperclip_runner", expect.objectContaining({
      provider: "acpx", acpxAgent: "copilot", aiConnection: { provider: "github", method: "api_key", mode: "responsible_user" },
    }));
  });

  it("creates Dot through its independent choice without CLI or model setup, then routes to pairing", async () => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false, enableOpenAiDot: true, enablePublicMcp: true });
    await render("paperclip_runner", "openai_dot");
    expect(container.textContent).toContain("OpenAI Dot");
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(container.textContent).not.toContain("Connect a model");
    expect(container.textContent).toContain("Check prerequisites");
    expect(container.textContent).not.toContain("runtime and model can respond");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Acknowledge external provider billing");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({ adapterType: "paperclip_runner", adapterConfig: {
      provider: "openai_dot", lifecycleMode: "per_turn", allowUnmeteredProvider: true, dotWorkspaceAccess: false, dotAttachmentAccess: false,
    } }));
    expect(container.textContent).toContain("Your Dot agent has been created");
    await click("Pair Dot");
    expect(state.navigate).toHaveBeenLastCalledWith("/agents/atlas/runtime");
    expect(state.openNewIssue).not.toHaveBeenCalled();
  });

  it.each(["claude_local", "codex_local"])("can choose a sign-in environment in Configure before connecting %s", async (adapterType) => {
    settings.get.mockResolvedValue({ defaultEnvironmentId: "no-login" });
    envApi.list.mockResolvedValue([
      { id: "no-login", name: "No browser sign-in", status: "active", driver: "sandbox", config: { provider: "other" } },
      { id: "login-env", name: "Browser sign-in", status: "active", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    envApi.capabilities.mockResolvedValue({ sandboxProviders: { daytona: { supportsLoginPty: true } } });
    api.getAdapterAuthSignal.mockResolvedValue({ status: "missing" });
    await render(adapterType);
    expect(container.textContent).toContain("does not support browser sign-in");
    expect(container.querySelector('select[aria-label="Environment"]')).toBeNull();
    await click("2Configure");
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect([...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Run test")?.disabled).toBe(true);
    await click("Connect model");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
    await click("2Configure");
    const select = container.querySelector('select[aria-label="Environment"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "login-env";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(container.querySelector('select[aria-label="Environment"]')).toBeNull();
    await click("Complete subscription login");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1]).toMatchObject({ defaultEnvironmentId: "login-env", runtimeConfig: { aiConnection: { method: "subscription" } } });
  });
  it("waits for the resolved environment before allowing a credential-mode selection", async () => {
    let resolveEnvironments!: (value: object[]) => void;
    envApi.list.mockImplementationOnce(() => new Promise<object[]>(resolve => { resolveEnvironments = resolve; }));
    await render("codex_local");
    expect(container.textContent).toContain("Loading connection settings");
    expect(container.querySelector('[role="radiogroup"][aria-label="Connection type"]')).toBeNull();
    await act(async () => resolveEnvironments([{ id: "local-1", name: "Local", driver: "local", config: {} }]));
    await settle();
    await click("OpenAIAPI key");
    expect(container.querySelector('[aria-label="API key"]')).not.toBeNull();
    await settle();
    expect(container.querySelector('[aria-label="API key"]')).not.toBeNull();
  });
  it.each([false, true])("selects the Grok environment in Configure (managed-only=%s)", async (managedOnly) => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: true, enableManagedSandboxOnly: managedOnly });
    envApi.list.mockResolvedValue([
      { id: "local-1", name: "Local", status: "active", driver: "local", config: {} },
      { id: "grok-sandbox", name: "Grok sandbox", status: "active", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    secrets.listMyUserSecrets.mockResolvedValue([{
      definition: { id: "grok-key", companyId: "company-1", key: "XAI_API_KEY", name: "Grok key", status: "active" },
      secret: { companyId: "company-1", status: "active" },
    }]);
    await render("paperclip_runner", "grok");
    expect(container.querySelector('select[aria-label="Environment"]')).toBeNull();
    await click("GrokAPI key");
    await click("Use saved API key");
    const select = container.querySelector('select[aria-label="Environment"]') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect([...select.options].some((option) => option.value === "local-1")).toBe(!managedOnly);
    await act(async () => {
      select.value = "grok-sandbox";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    if (container.querySelector('[role="radiogroup"][aria-label="Connection type"]')) {
      await click("GrokAPI key");
      await click("Use saved API key");
    }
    expect(api.testEnvironment).toHaveBeenCalledWith("company-1", "paperclip_runner", expect.objectContaining({ environmentId: "grok-sandbox" }));
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].defaultEnvironmentId).toBe("grok-sandbox");
  });
  it.each([false, true])("keeps other native setup links gated when the experiment is disabled (cloud=%s)", async (cloud) => {
    cache.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: cloud } });
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    await render("paperclip_runner", "grok");
    expect(container.textContent).toContain("This adapter is unavailable");
    expect(api.hire).not.toHaveBeenCalled();
  });
  it.each([false, true])("restores native Claude setup intent and its connection flow with experiment=false (cloud=%s)", async cloud => {
    cache.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: cloud } });
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    await render("paperclip_runner", "claude");
    expect(container.textContent).not.toContain("This adapter is unavailable");
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Paperclip Runner");
    expect(container.textContent).toContain("Connect a model");
    expect(api.hire).not.toHaveBeenCalled();
  });
  it("blocks direct setup links for unsupported Cloud adapters", async () => {
    cache.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: { managed: true },
    });
    await render("pi_local");
    expect(container.textContent).toContain("This adapter is unavailable");
    expect(api.hire).not.toHaveBeenCalled();
  });
  it.each([
    ["grok_local", "subscription"], ["grok_local", "api_key"],
    ["paperclip_runner", "subscription"], ["paperclip_runner", "api_key"],
  ])("configures %s Grok on Cloud with an xAI %s connection", async (adapterType, method) => {
    cache.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: { managed: true },
    });
    envApi.list.mockResolvedValue([
      { id: "sandbox-1", name: "Paperclip Cloud", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    envApi.capabilities.mockResolvedValue({
      sandboxProviders: { daytona: { supportsLoginPty: true } },
    });
    settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    settings.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: true, enableNativeRunner: true });
    api.getAdapterAuthSignal.mockResolvedValue({ status: "missing" });
    api.testEnvironment.mockResolvedValue({ ...pass, adapterType });
    await render(adapterType, "grok");
    expect(container.textContent).toContain("Connect a model");
    expect(container.textContent).not.toContain("Connect Atlas to Grok");
    if (method === "subscription") {
      await click("GrokSubscription");
      await click("Complete subscription login");
    } else {
      await click("GrokAPI key");
      await fill("API key", "example-test-secret");
      await click("Connect");
      expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
        provider: "xai", method: "api_key", apiKey: "example-test-secret",
      }));
    }
    const model = adapterType === "paperclip_runner" ? "grok-4.7" : "grok-code-fast-1";
    await fill("Model", model);
    await click("Run test");
    const binding = { provider: "xai", method, mode: "responsible_user" };
    expect(api.testEnvironment).toHaveBeenLastCalledWith("company-1", adapterType, expect.objectContaining({
      environmentId: "sandbox-1",
      adapterConfig: expect.objectContaining({ model, ...(adapterType === "paperclip_runner" ? { provider: "acpx", acpxAgent: "grok", acpxPermissionMode: "approve-all" } : {}) }),
      aiConnection: binding,
      testCredentials: {},
    }));
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    expect(api.hire.mock.calls[0][1]).toMatchObject({
      adapterType,
      defaultEnvironmentId: "sandbox-1",
      adapterConfig: { model, ...(adapterType === "paperclip_runner" ? { provider: "acpx", acpxAgent: "grok", acpxPermissionMode: "approve-all" } : {}) },
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false } },
    });
    expect(JSON.stringify(api.testEnvironment.mock.calls)).not.toContain("example-test-secret");
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("example-test-secret");
    expect(container.textContent).toContain("Your agent is ready");
  });
  it("sends Cursor Cloud repo/ref and transient API key, then saves an organization secret", async () => {
    await render("cursor_cloud");
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(container.querySelector('[aria-label="Thinking effort"]')).toBeNull();
    await fill("GitHub repository", "https://github.com/paperclipai/paperclip");
    await fill("Branch", "master");
    await fill("CURSOR_API_KEY", "cursor-test-key");
    await click("Run test");
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({
      adapterConfig: { repoUrl: "https://github.com/paperclipai/paperclip", repoStartingRef: "master" },
      testCredentials: { CURSOR_API_KEY: "cursor-test-key" },
    });
    expect(secrets.create).not.toHaveBeenCalled();
    await click("Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).toMatchObject({ repoUrl: "https://github.com/paperclipai/paperclip", repoStartingRef: "master", env: {
      CURSOR_API_KEY: { type: "secret_ref", secretId: "org-secret-1", version: "latest" },
    } });
    expect(config).not.toHaveProperty("repository");
    expect(config).not.toHaveProperty("branch");
    expect(JSON.stringify(config)).not.toContain("cursor-test-key");
    expect(secrets.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ value: "cursor-test-key" }));
  });
  it("requires a new Cursor Cloud key even when organization and personal keys exist", async () => {
    secrets.list.mockResolvedValue([{ id: "existing", key: "CURSOR_API_KEY", name: "Cursor", status: "active" }]);
    secrets.listMyUserSecrets.mockResolvedValue([{ definition: { key: "CURSOR_API_KEY" }, secret: { id: "personal-key" } }]);
    await render("cursor_cloud");
    expect(container.textContent).not.toContain("Or use an organization secret");
    await fill("GitHub repository", "https://github.com/example/repo");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a Cursor API key");
    await fill("CURSOR_API_KEY", "new-cursor-key");
    await click("Finish setup");
    expect(secrets.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ value: "new-cursor-key" }));
    expect(api.hire.mock.calls[0][1].adapterConfig.env.CURSOR_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
  });
  it.each([
    ["cursor", "CURSOR_API_KEY"],
    ["gemini_local", "GEMINI_API_KEY"],
    ["hermes_local", "OPENROUTER_API_KEY"],
  ])("provides %s credentials to tests and stores only a secret reference", async (adapter, key) => {
    await render(adapter);
    await fill(key, "adapter-test-key");
    await click("Finish setup");
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({ [key]: "adapter-test-key" });
    expect(api.hire.mock.calls[0][1].adapterConfig.env[key]).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(container.querySelector('[aria-label="Thinking effort"]')).toBeNull();
  });
  it("defines a Kimi API model without overriding it with a CLI model alias", async () => {
    await render("kimi_local");
    await fill("KIMI_MODEL_API_KEY", "kimi-test-key");
    await click("Run test");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter the Kimi API model name");
    await fill("Kimi API model name", "kimi-for-coding");
    await fill("Kimi API base URL", "https://api.kimi.com/coding/v1");
    const persist = api.update.getMockImplementation()!;
    api.update.mockImplementationOnce(async (...args) => {
      const saved = await persist(...args);
      return { ...saved, adapterConfig: { ...saved.adapterConfig, env: Object.fromEntries(
        Object.entries(saved.adapterConfig.env).map(([key, binding]) => [key,
          (binding as { type: string }).type === "plain" ? { type: "plain", value: "***REDACTED***" } : binding]),
      ) } };
    });
    await click("Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).not.toHaveProperty("model");
    expect(config.env).toMatchObject({
      KIMI_MODEL_NAME: { type: "plain", value: "kimi-for-coding" },
      KIMI_MODEL_PROVIDER_TYPE: { type: "plain", value: "kimi" },
      KIMI_MODEL_BASE_URL: { type: "plain", value: "https://api.kimi.com/coding/v1" },
      KIMI_MODEL_API_KEY: { type: "secret_ref", secretId: "org-secret-1" },
    });
  });
  it("restores saved Kimi API settings even when the API redacts plain environment values", async () => {
    await render("kimi_local");
    await fill("KIMI_MODEL_API_KEY", "kimi-test-key");
    await fill("Kimi API model name", "kimi-for-coding");
    await act(async () => {
      const protocol = container.querySelector('[aria-label="Kimi API protocol"]') as HTMLSelectElement;
      protocol.value = "openai";
      protocol.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await fill("Kimi API base URL", "https://kimi.example.test/v1");
    await click("Save & exit");
    const setupId = api.create.mock.calls[0][1].setupId;
    const get = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (...args) => {
      const saved = await get(...args);
      return { ...saved, adapterConfig: { ...saved.adapterConfig, env: Object.fromEntries(
        Object.entries(saved.adapterConfig.env).map(([key, binding]) => [key,
          (binding as { type: string }).type === "plain" ? { type: "plain", value: "***REDACTED***" } : binding]),
      ) } };
    });
    await act(async () => root.render(null));
    cache.clear();
    state.params = new URLSearchParams({ name: "Atlas", adapterType: "kimi_local", setupAgentId: setupId });
    await renderCurrentParams();
    await settle();
    expect((container.querySelector('[aria-label="Kimi API model name"]') as HTMLInputElement).value).toBe("kimi-for-coding");
    expect((container.querySelector('[aria-label="Kimi API protocol"]') as HTMLSelectElement).value).toBe("openai");
    await click("Save & exit");
    expect(api.update.mock.calls.at(-1)![1].adapterConfig.env).toMatchObject({
      KIMI_MODEL_NAME: { type: "plain", value: "kimi-for-coding" },
      KIMI_MODEL_PROVIDER_TYPE: { type: "plain", value: "openai" },
      KIMI_MODEL_BASE_URL: { type: "plain", value: "https://kimi.example.test/v1" },
    });
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.env).toMatchObject({ KIMI_MODEL_NAME: { type: "plain", value: "kimi-for-coding" } });
    expect(secrets.create).toHaveBeenCalledTimes(1);
  });

  it("configures Hermes Gateway URL and its top-level secret reference", async () => {
    await render("hermes_gateway");
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    await fill("Hermes API base URL", "https://hermes.example.com");
    await fill("API_SERVER_KEY", "hermes-test-key");
    await click("Finish setup");
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({
      adapterConfig: { apiBaseUrl: "https://hermes.example.com" },
      testCredentials: { API_SERVER_KEY: "hermes-test-key" },
    });
    expect(api.hire.mock.calls[0][1].adapterConfig.apiKey).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("hermes-test-key");
  });
  it("uses the shared Grok connection flow and hides ignored Kimi and OpenCode effort controls", async () => {
    await render("grok_local");
    expect(container.textContent).toContain("Connect a model");
    expect(container.textContent).not.toContain("Connect Atlas to Grok");
    await render("opencode_local");
    expect(container.querySelector('[aria-label="Thinking effort"]')).toBeNull();
  });
  it("restores confirmation on refresh without hiring again", async () => {
    api.get.mockResolvedValue({
      id: "saved-agent",
      companyId: "company-1",
      name: "Atlas",
      adapterType: "pi_local",
      adapterConfig: { model: "openrouter/anthropic/claude-sonnet-4.6" },
      status: "idle",
    });
    state.params = new URLSearchParams({
      name: "Atlas",
      adapterType: "pi_local",
      createdAgentId: "saved-agent",
    });
    await renderCurrentParams();
    expect(container.textContent).toContain("Your agent is ready");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    await click("Assign Atlas a Task");
    expect(state.openNewIssue).toHaveBeenCalledWith({
      assigneeAgentId: "saved-agent",
      status: "todo",
    });
  });
  it("does not advance connection after a timed-out provider probe", async () => {
    api.testEnvironment.mockResolvedValue({
      ...pass,
      status: "warn",
      checks: [
        {
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
        },
      ],
    });
    await render("claude_local");
    await connect("Claude");
    expect(container.textContent).toContain("Claude hello probe timed out.");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
  });

  it.each(["claude_local", "codex_local"])(
    "connects %s, creates once, and assigns a task",
    async (adapter) => {
      await render(adapter);
      await connect(adapter === "claude_local" ? "Claude" : "OpenAI");
      expect(api.testEnvironment).toHaveBeenCalledWith(
        "company-1",
        adapter,
        expect.objectContaining({ environmentId: "local-1" }),
      );
      await click("Finish setup");
      expect(api.hire).toHaveBeenCalledTimes(1);
      expect(api.hire.mock.calls[0][1]).toMatchObject({
        name: "Atlas",
        adapterType: adapter,
        reportsTo: "ceo",
        runtimeConfig: { heartbeat: { enabled: false } },
      });
      expect(container.textContent).toContain("Your agent is ready");
      await click("Assign Atlas a Task");
      expect(state.openNewIssue).toHaveBeenCalledWith({
        assigneeAgentId: api.create.mock.calls[0][1].setupId,
        status: "todo",
      });
    },
  );
  it.each([
    ["claude_local", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["codex_local", "codex", "OpenAI", "OPENAI_API_KEY"],
    ["paperclip_runner", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["paperclip_runner", "codex", "OpenAI", "OPENAI_API_KEY"],
  ])("stores %s %s as a reusable connection before hiring", async (adapter, runner, provider, key) => {
    await render(adapter, runner);
    await click(provider + "API key");
    await fill("API key", "connection-key");
    await click("Connect");
    const binding = { provider: key === "ANTHROPIC_API_KEY" ? "anthropic" : "openai", method: "api_key", mode: "responsible_user" };
    expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ apiKey: "connection-key", provider: binding.provider }));
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({});
    expect(api.testEnvironment.mock.calls[0][2].aiConnection).toEqual(binding);
    expect(container.textContent).toContain("Configure your agent");
    expect(container.querySelector('[role="combobox"][aria-label="Connection"]')).toBeNull();
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].runtimeConfig.aiConnection).toEqual(binding);
    expect(managedApi.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("connection-key");
  });
  it.each([
    ["claude_local", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["codex_local", "codex", "OpenAI", "OPENAI_API_KEY"],
    ["paperclip_runner", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["paperclip_runner", "codex", "OpenAI", "OPENAI_API_KEY"],
  ])("defaults %s %s to a saved key and preserves its reference through hire", async (adapter, runner, provider, key) => {
    secrets.listMyUserSecrets.mockResolvedValue([{
      definition: { id: "existing-key", companyId: "company-1", key, name: "Existing key", status: "active" },
      secret: { companyId: "company-1", status: "active" },
    }]);
    await render(adapter, runner);
    await click(provider + "API key");
    expect((container.querySelector("select[aria-label='Saved API key']") as HTMLSelectElement).value).toBe("user:existing-key");
    await click("Use saved API key");
    const binding = { type: "user_secret_ref", key, version: "latest" };
    expect(api.testEnvironment.mock.calls[0][2].adapterConfig.env[key]).toEqual(binding);
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({});
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.env[key]).toEqual(binding);
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
    expect(secrets.createMyUserSecret).not.toHaveBeenCalled();
    expect(secrets.rotateMyUserSecret).not.toHaveBeenCalled();
  });
  it.each(["codex_local", "paperclip_runner"])("keeps a saved connection chosen in Connect when hiring %s", async (adapter) => {
    await render(adapter, "codex");
    managedApi.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [{
        id: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022", companyId: "company-1",
        provider: "openrouter", method: "api_key", name: "Company OpenRouter",
        ownership: "shared", isDefault: false, status: "connected",
        routing: { kind: "openrouter", protocol: "responses", auth: "bearer", models: [] },
      }],
    } as any);
    await click("AdvancedCustom Gateway");
    const picker = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("Company OpenRouter")) as HTMLElement;
    expect(option).toBeTruthy();
    await act(async () => option.click());
    await settle();
    await click("Use connection");
    expect(container.textContent).toContain("Configure your agent");
    expect(container.querySelector('[role="combobox"][aria-label="Connection"]')).toBeNull();
    await click("Run test");
    const binding = { provider: "openrouter", method: "api_key", mode: "shared", connectionId: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022" };
    expect(api.testEnvironment.mock.calls[0][2].aiConnection).toEqual(binding);
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].runtimeConfig.aiConnection).toEqual(binding);
  });
  it("requires the current connection choice to connect before Configure can save it", async () => {
    await render("codex_local");
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
      id: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022", companyId: "company-1",
      provider: "openrouter", method: "api_key", name: "Company OpenRouter", ownership: "shared", isDefault: false, status: "connected",
      routing: { kind: "openrouter", protocol: "responses", auth: "bearer", models: [] },
    }] } as any);
    await click("AdvancedCustom Gateway");
    const picker = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("Company OpenRouter")) as HTMLElement;
    await act(async () => option.click());
    await settle();
    await click("2Configure");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    await click("Connect model");
    await click("OpenAIAPI key");
    await fill("API key", "new-api-credential");
    await click("2Configure");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    await click("Connect model");
    await click("OpenAIAPI key");
    await fill("API key", "new-api-credential");
    await click("Connect");
    await click("Connection");
    await click("2Configure");
    expect(container.textContent).not.toContain("Finish setup");
    await click("Connect model");
    await click("OpenAIAPI key");
    await fill("API key", "new-api-credential");
    await click("Connect");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].runtimeConfig.aiConnection).toEqual({ provider: "openai", method: "api_key", mode: "responsible_user" });
  });
  it.each(["pi_local"])(
    "persists %s OpenRouter credentials only as a secret reference",
    async (adapter) => {
      await render(adapter);
      await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
      await fill("OPENROUTER_API_KEY", "example-test-secret");
      await click("Run test");
      expect(secrets.rotateMyUserSecret).not.toHaveBeenCalled();
      expect(secrets.createMyUserSecret).not.toHaveBeenCalled();
      expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({ OPENROUTER_API_KEY: "example-test-secret" });
      await click("Finish setup");
      expect(api.hire.mock.calls[0][1].adapterConfig.env.OPENROUTER_API_KEY).toEqual({
        type: "secret_ref",
        secretId: "org-secret-1",
        version: "latest",
      });
      expect(secrets.create).toHaveBeenCalledWith(
        "company-1", expect.objectContaining({ value: "example-test-secret" }),
      );
      expect(JSON.stringify(api.hire.mock.calls)).not.toContain(
        "example-test-secret",
      );
      expect(secrets.create).toHaveBeenCalledTimes(1);
    },
  );
  it("connects OpenRouter before testing and hiring OpenCode without copying credentials into the agent", async () => {
    await render("opencode_local");
    const model = "openrouter/anthropic/claude-sonnet-4.6";
    await fill("Model", model);
    const connectionSelect = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => connectionSelect.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const connectOption = [...document.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes("Connect an account"))!;
    expect(connectOption).toBeTruthy();
    await act(async () => (connectOption as HTMLElement).click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(api.hire).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    const advanced = [...dialog.querySelectorAll("summary")].find(node => node.textContent?.includes("Advanced providers"))!;
    await act(async () => advanced.click());
    const openrouter = [...dialog.querySelectorAll("button")].find(node => node.textContent?.includes("OpenRouter"))!;
    await act(async () => openrouter.click());
    await settle();
    const input = dialog.querySelector('[aria-label="API key"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "example-test-secret");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connectButton = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Connect")!;
    expect(connectButton.disabled).toBe(false);
    await act(async () => connectButton.click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(managedApi.setDefault).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      provider: "openrouter", method: "api_key", apiKey: "example-test-secret",
    }));
    const binding = { provider: "openrouter", method: "api_key", mode: "shared", connectionId: "managed-connection", grantId: "managed-grant" };

    await click("Run test");
    expect(api.testEnvironment.mock.calls[0][2]).toEqual(expect.objectContaining({
      aiConnection: binding, testCredentials: {},
      adapterConfig: expect.objectContaining({ model }),
    }));
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1]).toEqual(expect.objectContaining({
      adapterType: "opencode_local",
      runtimeConfig: expect.objectContaining({ aiConnection: binding }),
      adapterConfig: expect.objectContaining({ model }),
    }));
    expect(managedApi.create).toHaveBeenCalledTimes(1);
    expect(secrets.create).not.toHaveBeenCalled();
    expect(JSON.stringify(api.testEnvironment.mock.calls)).not.toContain("example-test-secret");
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("example-test-secret");
  });
  it.each(["codex", "claude", "opencode"])(
    "uses the correct native %s runner",
    async (runner) => {
      await render("paperclip_runner", runner);
      if (runner !== "opencode")
        await connect(runner === "claude" ? "Claude" : "OpenAI");
      else await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
      await click("Finish setup");
      const config = api.hire.mock.calls[0][1].adapterConfig;
      if (runner === "codex") {
        expect(api.hire.mock.calls[0][1]).toMatchObject({ adapterType: "paperclip_runner", runner: "paperclip" });
        expect(api.testEnvironment).toHaveBeenCalledWith("company-1", "paperclip_runner", expect.objectContaining({ runner: "paperclip" }));
      } else expect(config.provider).toBe(runner === "claude" ? "acpx" : runner);
      if (runner === "claude") {
        expect(config.acpxAgent).toBe("claude");
        expect(config.model).toMatch(/^claude-/);
      }
      if (runner === "codex") expect(config.acpxAgent).toBeUndefined();
    },
  );
  it("does not create when the test fails and permits retry", async () => {
    await render();
    await fill("Model", "openrouter/unknown/model");
    api.testEnvironment.mockResolvedValueOnce({ ...pass, status: "fail" });
    await click("Run test");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't connect");
    await click("Retry test");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
  });
  it("does not rotate a working provider credential when a new key fails its test", async () => {
    secrets.listMyUserSecrets.mockResolvedValue([{ definition: { id: "existing-definition", key: "OPENROUTER_API_KEY" }, secret: { id: "working-secret" } }]);
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "invalid-replacement");
    api.testEnvironment.mockResolvedValueOnce({ ...pass, status: "fail" });
    await click("Run test");
    expect(secrets.rotateMyUserSecret).not.toHaveBeenCalled();
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
    expect(api.testEnvironment.mock.calls[0][2].testCredentials.OPENROUTER_API_KEY).toBe("invalid-replacement");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
  });
  it("does not store a key when leaving after a successful test", async () => {
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "abandoned-key");
    await click("Run test");
    await act(async () => root.render(null));
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
  });
  it("removes the staged credential when saving setup fails", async () => {
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "new-key");
    api.update.mockRejectedValueOnce(new ApiError("Creation rejected", 422, null));
    await click("Finish setup");
    expect(secrets.remove).toHaveBeenCalledWith("org-secret-1");
    expect(container.textContent).toContain("Creation rejected");
  });
  it("preserves the creation error when credential cleanup also fails", async () => {
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "new-key");
    api.update.mockRejectedValueOnce(new ApiError("Agent quota exceeded", 422, null));
    secrets.remove.mockRejectedValueOnce(new Error("Cleanup unavailable"));
    await click("Finish setup");
    expect(container.textContent).toContain("Agent quota exceeded");
    expect(container.textContent).toContain("Could not remove an unused setup credential");
  });
  it("retains the credential on the setup record when the hire response is lost", async () => {
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "new-key");
    api.hire.mockRejectedValueOnce(new Error("Response lost"));
    await click("Finish setup");
    expect(secrets.remove).not.toHaveBeenCalled();
    expect(api.update.mock.calls.at(-1)![1].adapterConfig.env.OPENROUTER_API_KEY).toMatchObject({ type: "secret_ref" });
    await click("Finish setup");
    expect(secrets.create).toHaveBeenCalledTimes(1);
    expect(api.hire).toHaveBeenCalledTimes(2);
  });
  it.each(["Save & exit", "Finish setup"])("retains a saved key when the %s PATCH response is lost", async action => {
    await render("hermes_gateway");
    await fill("Hermes API base URL", "https://hermes.example.test");
    await fill("API_SERVER_KEY", "uncertain-save-key");
    const persist = api.update.getMockImplementation()!;
    api.update.mockImplementationOnce(async (...args) => {
      await persist(...args);
      throw new Error("Save response lost");
    });
    await click(action);
    expect(container.textContent).toContain("Save response lost");
    expect(secrets.remove).not.toHaveBeenCalled();
    const setupId = api.create.mock.calls[0][1].setupId;
    expect((await api.get(setupId)).adapterConfig.apiKey).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.apiKey).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(secrets.create).toHaveBeenCalledTimes(1);
  });
  it("requires an explicit provider/model for Pi", async () => {
    await render();
    await click("Run test");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(container.textContent).toContain("provider/model format");
  });
  it("blocks a disabled runner even when opened through a URL", async () => {
    state.adapters = [
      { type: "codex_local", loaded: true, disabled: false },
      { type: "paperclip_runner", loaded: true, disabled: true },
    ];
    await render("paperclip_runner");
    expect(container.textContent).toContain("This adapter is unavailable");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
  });
  it("keeps pending agents behind approval and disables task assignment", async () => {
    api.hire.mockResolvedValue({
      agent: { id: "new-agent", name: "Atlas", status: "pending_approval" },
    });
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await click("Finish setup");
    expect(container.textContent).toContain("Agent submitted for approval");
    await click("Assign Atlas a Task");
    expect(state.openNewIssue).not.toHaveBeenCalled();
  });
  it("uses the same managed environment for connection testing and creation", async () => {
    envApi.list.mockResolvedValue([
      { id: "sandbox-1", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    envApi.capabilities.mockResolvedValue({
      sandboxProviders: { daytona: { supportsLoginPty: true } },
    });
    settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    settings.getExperimental.mockResolvedValue({
      enableManagedSandboxOnly: true,
    });
    api.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-oauth", latestVersion: 1 });
    await render("claude_local");
    await click("ClaudeSubscription");
    await click("Use saved subscription");
    await click("Finish setup");
    expect(api.testEnvironment.mock.calls[0][2].environmentId).toBe(
      "sandbox-1",
    );
    expect(api.hire.mock.calls[0][1]).toMatchObject({
      defaultEnvironmentId: "sandbox-1",
      applyStoredClaudeLogin: true,
    });
  });
});
