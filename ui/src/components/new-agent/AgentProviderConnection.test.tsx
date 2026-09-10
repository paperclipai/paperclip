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
}));
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
  AdapterLoginPanel: () => <div>New subscription login</div>,
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
          onBack={() => {}}
          testConnection={test}
          onConnected={connected}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(mocks.personal).toHaveBeenCalled());
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  if (savedApiKeys) await vi.waitFor(() => expect(host.textContent).toContain("2 saved API keys"));
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
});
