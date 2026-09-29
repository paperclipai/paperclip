// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderConnection } from "./AgentProviderConnection";
import { ApiError } from "@/api/client";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  login: vi.fn(),
  personal: vi.fn(),
  organization: vi.fn(),
  loginPanel: vi.fn(),
}));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  loginResult: vi.fn(async () => ({ connectionId: "login-account", grantId: "login-grant" })),
  connectLocal: vi.fn(async () => ({ connectionId: "local-account", grantId: "local-grant" })),
  startLocalLogin: vi.fn(async () => ({ sessionId: "local-attempt", command: "CODEX_HOME='/fixture/isolated-login' codex login", expiresAt: "2026-09-11T20:00:00Z" })),
  checkLocalLogin: vi.fn(async () => ({ status: "sign_in_required" as const })),
  cancelLocalLogin: vi.fn(async () => ({})),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("@/api/agents", () => ({
  agentsApi: {
    getAdapterAuthSignal: mocks.auth,
    getClaudeOAuthTokenStatus: mocks.login,
  },
}));
vi.mock("@/api/secrets", () => ({
  secretsApi: { listMyUserSecrets: mocks.personal, list: mocks.organization },
}));
vi.mock("../AgentConfigForm", () => ({
  AdapterLoginPanel: (props: unknown) => { mocks.loginPanel(props); return <div>New subscription login</div>; },
}));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  client?.clear();
  vi.resetAllMocks();
});
async function mount(
  adapterType: "claude_local" | "codex_local" = "claude_local",
  savedLogin = false,
  canLogin = true,
  codexSubscriptions = false,
  savedApiKeys = true,
  cachedClaudeLogin = false,
  managedAccount?: Parameters<typeof AgentProviderConnection>[0]["managedAccount"],
  localEnvironment = false,
  deploymentMode: "local_trusted" | "authenticated" = "local_trusted",
  localAiLoginSupported = true,
) {
  const key =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  mocks.auth.mockResolvedValue({
    status: codexSubscriptions ? "unknown" : "present",
  });
  mocks.login.mockImplementation(async () => {
    if (savedLogin) return { secretId: "oauth", latestVersion: 1 };
    throw new ApiError("Not found", 404, null);
  });
  mocks.personal.mockResolvedValue([
    {
      definition: {
        id: "d1",
        companyId: "c1",
        key: `${key}.setup.1`,
        name: "Personal key",
        status: "active",
      },
      secret: { companyId: "c1", status: "active" },
    },
  ]);
  mocks.organization.mockResolvedValue([
    {
      id: "s1",
      companyId: "c1",
      key,
      name: "Company key",
      scope: "company",
      status: "active",
    },
    ...(codexSubscriptions
      ? [
          {
            id: "codex-home",
            companyId: "c1",
            name: "CODEX_HOME_team",
            scope: "company",
            status: "active",
          },
        ]
      : []),
  ]);
  if (!savedApiKeys) {
    mocks.personal.mockResolvedValue([]);
    mocks.organization.mockResolvedValue([]);
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedClaudeLogin) {
    client.setQueryData(["claude-oauth-token-status", "c1"], { secretId: "cached-claude", latestVersion: 1 });
    mocks.auth.mockResolvedValue({ status: "absent" });
  }
  client.setQueryData(["health"], { deploymentMode, localAiLoginSupported });
  client.setQueryDefaults(["health"], { staleTime: Infinity });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const test = vi.fn().mockResolvedValue(true);
  const connected = vi.fn();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AgentProviderConnection
          companyId="c1"
          adapterType={adapterType}
          environmentId="e1"
          canLogin={canLogin}
          localEnvironment={localEnvironment}
          onBack={() => {}}
          testConnection={test}
          onConnected={connected}
          managedAccount={managedAccount}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(mocks.personal).toHaveBeenCalled());
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  if (savedApiKeys && !managedAccount) await vi.waitFor(() => expect(host.textContent).toContain("2 saved API keys"));
  return { test, connected, key };
}
function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  )!;
  expect(button).toBeTruthy();
  flushSync(() => button.click());
}
function openProvider() {
  flushSync(() =>
    (host.querySelector('[role="radio"]') as HTMLElement).click(),
  );
}
describe("AgentProviderConnection reuse", () => {
  it.each(["claude_local", "codex_local"] as const)("does not offer a server-host command when health disables local login: %s", async adapterType => {
    const onComplete = vi.fn();
    const intent = { provider: adapterType === "claude_local" ? "anthropic" as const : "openai" as const, method: "subscription" as const, name: "Hosted account", ownership: "personal" as const, agentIds: [], allAgents: false };
    await mount(adapterType, false, false, false, false, false, { intent, onComplete }, true, "authenticated", false);
    openProvider();
    expect(host.textContent).toContain("This environment does not support browser sign-in");
    expect(host.textContent).not.toContain("Run this in a terminal");
    expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
    click("Connect");
    expect(managedApi.connectLocal).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
  it.each(["claude_local", "codex_local"] as const)("prepares and completes an isolated subscription on an authenticated self-hosted instance: %s", async adapterType => {
    const onComplete = vi.fn();
    const command = adapterType === "claude_local" ? "CLAUDE_CONFIG_DIR='/isolated/claude' claude auth login" : "CODEX_HOME='/isolated/codex' codex login --device-auth";
    managedApi.startLocalLogin.mockResolvedValue({ sessionId: "local-attempt", command, expiresAt: "2099-01-01T00:00:00Z" });
    const intent = { provider: adapterType === "claude_local" ? "anthropic" as const : "openai" as const, method: "subscription" as const, name: "Self-hosted account", ownership: "personal" as const, agentIds: [], allAgents: false };
    await mount(adapterType, false, false, false, false, false, { intent, onComplete }, true, "authenticated");
    openProvider();
    await vi.waitFor(() => expect(host.textContent).toContain(command));
    expect(host.textContent).toContain("Your existing terminal login stays separate");
    expect(host.textContent).not.toContain("Connect uses your local");
    expect(managedApi.startLocalLogin).toHaveBeenCalledWith("c1", intent);
    expect(managedApi.checkLocalLogin).toHaveBeenCalledWith("c1", { ...intent, localSessionId: "local-attempt" });
    click("Connect");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(managedApi.connectLocal).toHaveBeenCalledWith("c1", { ...intent, localSessionId: "local-attempt" });
  });
  it.each(["claude_local", "codex_local"] as const)("connects a local subscription without a sandbox and supports retry: %s", async (adapterType) => {
    const onComplete = vi.fn();
    const intent = { provider: adapterType === "claude_local" ? "anthropic" as const : "openai" as const, method: "subscription" as const, name: "My account", ownership: "personal" as const, agentIds: [], allAgents: false };
    await mount(adapterType, false, false, false, false, false, { intent, onComplete }, true);
    openProvider();
    await vi.waitFor(() => expect(host.textContent).toContain(adapterType === "claude_local" ? "claude auth login" : "codex login"));
    expect(host.textContent).toContain("machine running Paperclip");
    expect(host.textContent).not.toContain("sandbox");
    managedApi.connectLocal.mockRejectedValueOnce(new Error("Run local login and try again"));
    click("Connect");
    await vi.waitFor(() => expect(host.textContent).toContain("Run local login and try again"));
    expect(onComplete).not.toHaveBeenCalled();
    if (adapterType === "codex_local") {
      click("Start sign-in again");
      await vi.waitFor(() => expect(host.textContent).not.toContain("Run local login and try again"));
      await vi.waitFor(() => expect(managedApi.cancelLocalLogin).toHaveBeenCalledWith("c1", "local-attempt"));
      await vi.waitFor(() => expect(host.textContent).toContain("codex login"));
    }
    click("Connect");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ connectionId: "local-account", grantId: "local-grant", method: "subscription" }));
    expect(managedApi.connectLocal).toHaveBeenCalledWith("c1", adapterType === "codex_local" ? { ...intent, localSessionId: "local-attempt" } : intent);
    expect(mocks.loginPanel).not.toHaveBeenCalled();
  });
  it("leaves a completed local account saved when its host is cancelled", async () => {
    let finish!: (result: { connectionId: string; grantId: string }) => void;
    managedApi.connectLocal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const onComplete = vi.fn();
    await mount("claude_local", false, false, false, false, false, { intent: { provider: "anthropic", method: "subscription", name: "My account", ownership: "personal", agentIds: [], allAgents: false }, onComplete }, true);
    openProvider(); click("Connect"); flushSync(() => root.unmount());
    finish({ connectionId: "saved", grantId: "saved-grant" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onComplete).not.toHaveBeenCalled();
  });
  it.each(["claude_local", "codex_local"] as const)("does not import local credentials for an unsupported remote environment: %s", async (adapterType) => {
    const onComplete = vi.fn();
    const intent = { provider: adapterType === "claude_local" ? "anthropic" as const : "openai" as const, method: "subscription" as const, name: "Engineering subscription", ownership: "shared" as const, agentIds: ["nova"], allAgents: false };
    const { test } = await mount(adapterType, false, false, false, true, false, { intent, onComplete });
    openProvider();
    expect(host.textContent).toContain("This environment does not support browser sign-in");
    expect(host.textContent).not.toContain("login on this machine");
    click("Connect");
    expect(onComplete).not.toHaveBeenCalled();
    expect(managedApi.create).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
  });

  it.each(["claude_local", "codex_local"] as const)("drives onboarding's provider redirect and completion: %s", async (adapterType) => {
    const onComplete = vi.fn();
    const intent = { provider: adapterType === "claude_local" ? "anthropic" as const : "openai" as const, method: "subscription" as const, name: "My account", ownership: "personal" as const, agentIds: [], allAgents: false };
    await mount(adapterType, false, true, false, false, false, { intent, onComplete });
    openProvider();
    const panel = () => mocks.loginPanel.mock.calls.at(-1)![0];
    expect(panel().chrome).toBe("onboarding");
    expect(panel().autoStart).toBe(true);
    expect(panel().aiConnection).toEqual(intent);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      flushSync(() => panel().onPromptReady("https://provider.example/authorize"));
      click(adapterType === "claude_local" ? "Sign in to Claude" : "Sign in to OpenAI");
      expect(open).toHaveBeenCalledWith("https://provider.example/authorize", "_blank", "noreferrer,noopener");
      expect(host.textContent).toContain("Waiting for code");
      flushSync(() => panel().onCodeSubmitted());
      expect(host.textContent).toContain("Connecting");
      flushSync(() => panel().onSubmitFailed());
      expect(host.textContent).toContain("Waiting for code");
      flushSync(() => panel().onConnected("session-1"));
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ connectionId: "login-account", grantId: "login-grant", method: "subscription" }));
      expect(managedApi.loginResult).toHaveBeenCalledWith("c1", "session-1");
    } finally { open.mockRestore(); }
  });

  it("does not advance after Back while the saved login result is loading", async () => {
    let finish!: (result: { connectionId: string; grantId: string }) => void;
    managedApi.loginResult.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const onComplete = vi.fn();
    await mount("claude_local", false, true, false, false, false, { intent: { provider: "anthropic", method: "subscription", name: "My account", ownership: "personal", agentIds: [], allAgents: false }, onComplete });
    openProvider();
    flushSync(() => mocks.loginPanel.mock.calls.at(-1)![0].onConnected("session-1"));
    click("Back");
    finish({ connectionId: "saved", grantId: "grant" });
    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("starts the existing browser login when adding an account even if the environment is authenticated", async () => {
    await mount("claude_local", true, true, false, true, false, { intent: { provider: "anthropic", method: "subscription", name: "My second account", ownership: "personal", agentIds: [], allAgents: false }, onComplete: vi.fn() });
    openProvider();
    expect(host.textContent).toContain("New subscription login");
    expect(host.textContent).not.toContain("Use saved subscription");
  });

  it("defaults to subscription when no saved credentials exist", async () => {
    await mount("claude_local", false, true, false, false);
    expect(host.textContent).toContain("Use API key instead");
    click("Use API key instead");
    openProvider();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("does not use a cached Claude login for Codex", async () => {
    await mount("codex_local", false, true, false, false, true);
    openProvider();
    expect(host.textContent).toContain("New subscription login");
    expect(host.textContent).not.toContain("saved Claude subscription");
    expect(host.textContent).not.toContain("Use saved subscription");
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it("reuses a saved ChatGPT account when the sandbox auth signal is unknown", async () => {
    const { test, connected } = await mount("codex_local", false, true, true);
    openProvider();
    expect(host.textContent).not.toContain("New subscription login");
    click("Use saved subscription");
    await vi.waitFor(() =>
      expect(connected).toHaveBeenCalledWith({
        env: {
          CODEX_HOME: {
            type: "secret_ref",
            secretId: "codex-home",
            version: "latest",
          },
        },
      }),
    );
    expect(test).toHaveBeenCalledWith(connected.mock.calls[0][0]);
    flushSync(() => {
      const select = host.querySelector("select")!;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("New subscription login");
  });
  it.each(["claude_local", "codex_local"] as const)(
    "passes a personal reference without credentials for %s",
    async (adapter) => {
      const { test, connected, key } = await mount(adapter);
      openProvider();
      const select = host.querySelector("select")!;
      expect(select.value).toBe("user:d1");
      click("Use saved API key");
      await vi.waitFor(() =>
        expect(connected).toHaveBeenCalledWith({
          env: {
            [key]: {
              type: "user_secret_ref",
              key: `${key}.setup.1`,
              version: "latest",
            },
          },
        }),
      );
      expect(test).toHaveBeenCalledWith(connected.mock.calls[0][0]);
    },
  );
  it("uses an organization reference and requires a new key after switching away", async () => {
    const { connected, key } = await mount();
    openProvider();
    const select = host.querySelector("select")!;
    flushSync(() => {
      select.value = "company:s1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click("Use saved API key");
    await vi.waitFor(() =>
      expect(connected).toHaveBeenCalledWith({
        env: {
          [key]: { type: "secret_ref", secretId: "s1", version: "latest" },
        },
      }),
    );
    flushSync(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Connect"),
    )!;
    expect(button.disabled).toBe(true);
    await client.invalidateQueries();
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(host.querySelector("select")!.value).toBe("");
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });
  it("reuses saved Claude login even without a login-capable environment", async () => {
    const { test } = await mount("claude_local", true, false);
    openProvider();
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Use saved subscription"),
    );
    click("Use saved subscription");
    await vi.waitFor(() =>
      expect(test).toHaveBeenCalledWith(
        expect.objectContaining({ applyStoredClaudeLogin: true }),
      ),
    );
  });
  it("does not treat an environment credential as a stored Claude login", async () => {
    const { test } = await mount();
    click("Use subscription instead");
    openProvider();
    click("Connect");
    await vi.waitFor(() => expect(test).toHaveBeenCalledWith({ env: {} }));
  });
  it.each(["claude_local", "codex_local"] as const)("uses a managed subscription through the upstream chooser for %s", async (adapterType) => {
    const provider = adapterType === "claude_local" ? "anthropic" : "openai";
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
      id: "account", grantId: "grant", companyId: "c1", provider,
      method: "subscription", name: "My subscription", ownership: "personal",
      ownerUserId: "user-1", isDefault: true, status: "connected",
    }] } as never);
    const { connected } = await mount(adapterType, false, true, false, false);
    openProvider();
    expect(host.querySelector('select[aria-label="Saved subscription"]')?.textContent).toContain("My subscription (Your default)");
    click("Use saved subscription");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ env: {}, aiConnection: { provider, method: "subscription", mode: "responsible_user" } }));
    expect(managedApi.create).not.toHaveBeenCalled();
    flushSync(() => {
      const select = host.querySelector("select")!;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("New subscription login");
    await client.invalidateQueries();
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(host.querySelector("select")!.value).toBe("");
    expect(host.textContent).toContain("New subscription login");
  });
  it("never offers a saved Codex home in Claude's subscription chooser", async () => {
    await mount("claude_local", false, true, true);
    click("Use subscription instead");
    openProvider();
    expect(host.querySelector('select[aria-label="Saved subscription"]')).toBeNull();
    expect(host.textContent).not.toContain("ChatGPT account");
  });

});
