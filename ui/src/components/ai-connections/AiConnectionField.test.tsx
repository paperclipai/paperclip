// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AiManagedConnectionSummary, ToolConnection } from "@paperclipai/shared";
import { AiConnectionField, aiProviderForAdapter } from "./AiConnectionField";
import { AiConnectionPoolConnector } from "./AiConnectionPoolConnector";
import type { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const mocks = vi.hoisted(() => ({ list: vi.fn(), setDefault: vi.fn(), listPools: vi.fn(), listGallery: vi.fn(), savePool: vi.fn(), inspectPool: vi.fn(), listAgents: vi.fn(), navigate: vi.fn(), setBreadcrumbs: vi.fn(), pushToast: vi.fn() }));
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: mocks.listPools, save: mocks.savePool, inspect: mocks.inspectPool } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listGallery: mocks.listGallery } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.pushToast }) }));
vi.mock("@/lib/router", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/router")>(), useNavigate: () => mocks.navigate, Link: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/pages/apps/AppDetail", () => ({ AppDetailHeader: () => null }));
let credentialProps: ComponentProps<typeof AiConnectionCredentialStep> | undefined;
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mocks }));
vi.mock("./AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: ComponentProps<typeof AiConnectionCredentialStep>) => {
    credentialProps = props;
    return <div>Provider sign-in</div>;
  },
}));
vi.mock("./AiProviderSetup", () => ({ AiProviderSetup: () => <div>Advanced provider setup</div> }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const onChange = vi.fn();
const account = (overrides: Partial<AiManagedConnectionSummary> = {}): AiManagedConnectionSummary => ({
  id: "old-connection", grantId: "old-grant", companyId: "company",
  provider: "anthropic", method: "subscription", name: "My Claude",
  ownership: "personal", ownerUserId: "owner", isDefault: true,
  status: "needs_attention", ...overrides,
});
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}
async function mount(connections: AiManagedConnectionSummary[], canManageConnections = true, preferAdvanced = false) {
  mocks.list.mockResolvedValue({ currentUserId: "owner", connections, canManageConnections });
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <AiConnectionField companyId="company" agentId="agent" agentName="Nova" adapterType="claude_local"
      preferAdvanced={preferAdvanced}
      value={{ provider: "anthropic", method: "subscription", mode: "responsible_user" }} onChange={onChange} />
  </QueryClientProvider>));
  await settle();
}
async function click(label: string) {
  if (label === "Connect another account") {
    const trigger = document.querySelector('[role="combobox"][aria-label="Connection"]')!;
    flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent?.includes("Connect an account"));
    expect(option).toBeDefined();
    flushSync(() => option!.click());
    await settle();
    return;
  }
  const button = Array.from(document.querySelectorAll("button")).find(item => item.textContent === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  flushSync(() => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  credentialProps = undefined;
  mocks.setDefault.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });

it("reconnects the unavailable personal default in place", async () => {
  await mount([account()]);
  await click("Reconnect account");
  expect(credentialProps).toMatchObject({ connectionId: "old-connection", initialMethod: "subscription", fixedMethod: true });
  credentialProps!.onComplete({ connectionId: "old-connection", grantId: "old-grant", method: "subscription" });
  await settle();
  expect(mocks.setDefault).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
});

it("identifies duplicate-named accounts before adopting the exact personal grant", async () => {
  const personal = account({ id: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002", provider: "openai", method: "api_key", name: "OpenAI", ownerName: "Avery", status: "connected", isDefault: false });
  const shared = account({ id: "00000000-0000-4000-8000-000000000003", grantId: "00000000-0000-4000-8000-000000000004", provider: "openai", method: "subscription", name: "OpenAI", accountLabel: "engineering@example.test", ownership: "shared", ownerUserId: undefined, status: "connected", isDefault: false });
  const sharedKey = account({ id: "00000000-0000-4000-8000-000000000005", grantId: "00000000-0000-4000-8000-000000000006", provider: "openai", method: "api_key", name: "OpenAI", ownerName: "Engineering", ownership: "shared", ownerUserId: undefined, status: "connected", isDefault: false });
  const unavailable = account({ id: "expired-account", grantId: "expired-grant", provider: "openai", method: "api_key", name: "Expired account", ownerName: "Avery" });
  mocks.list.mockResolvedValue({ currentUserId: "owner", connections: [shared, personal, sharedKey, unavailable], canManageConnections: true });
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <AiConnectionField companyId="company" agentId="agent" agentName="Nova" adapterType="codex_local" legacy onChange={onChange} />
  </QueryClientProvider>));
  await settle();
  await click("Choose a managed connection");
  const trigger = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await settle();
  const choices = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(choices.map(choice => choice.textContent)).toContain("OpenAI · API key · Personal · Avery");
  expect(choices.map(choice => choice.textContent)).toContain("OpenAI · ChatGPT subscription · Company shared · engineering@example.test");
  expect(choices.map(choice => choice.textContent)).toContain("OpenAI · API key · Company shared · Engineering");
  expect(choices.find(choice => choice.textContent?.includes("Expired account"))?.getAttribute("aria-disabled")).toBe("true");
  flushSync(() => choices.find(choice => choice.textContent === "OpenAI · API key · Personal · Avery")!.click());
  await settle();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("OpenAI · API key · Personal · Avery");
  expect(onChange).not.toHaveBeenCalled();
  await click("Use this binding when saved");
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ provider: "openai", method: "api_key", mode: "delegated", connectionId: personal.id, grantId: personal.grantId });
});

it("opens provider setup directly when connecting from the advanced mode", async () => {
  await mount([], true, true);
  await click("Connect another account");
  expect(document.body.textContent).toContain("Advanced provider setup");
  expect(credentialProps).toBeUndefined();
});

it("selects the returned new grant and actual method before adopting the personal default", async () => {
  await mount([account()]);
  await click("Connect another account");
  expect(document.body.textContent).toContain("default");
  expect(credentialProps).toMatchObject({ connectionId: undefined, allAgents: true });
  let resolveDefault!: () => void;
  mocks.setDefault.mockImplementation(() => new Promise<void>(resolve => { resolveDefault = resolve; }));
  credentialProps!.onComplete({ connectionId: "new-connection", grantId: "new-grant", method: "api_key" });
  await settle();
  expect(mocks.setDefault).toHaveBeenCalledWith("company", "new-grant");
  expect(onChange).not.toHaveBeenCalled();
  resolveDefault();
  await settle();
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
});

it("lets the owner limit a new personal connection to this agent", async () => {
  await mount([]);
  await click("Connect another account");
  const checkbox = document.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(checkbox).not.toBeNull();
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  flushSync(() => checkbox.click());
  expect(credentialProps).toMatchObject({ allAgents: false, agentIds: ["agent"] });
});

it("keeps default-update failures visible and retries without another provider login", async () => {
  await mount([account()]);
  await click("Connect another account");
  mocks.setDefault.mockRejectedValueOnce(new Error("Default update failed"));
  credentialProps!.onComplete({ connectionId: "new-connection", grantId: "new-grant", method: "api_key" });
  await settle();
  expect(document.body.textContent).toContain("Default update failed");
  expect(onChange).not.toHaveBeenCalled();
  await click("Retry default selection");
  await settle();
  expect(mocks.setDefault).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
});

it("does not offer reconnection for a healthy default or another owner's account", async () => {
  await mount([account({ status: "connected" }), account({ id: "someone-else", ownerUserId: "other" })]);
  expect(document.body.textContent).not.toContain("Reconnect account");
});

it("keeps an ordinary member's new connection scoped to the current agent by default", async () => {
  await mount([], false);
  expect(document.body.textContent).toContain("You have no default account");
  await click("Connect another account");
  expect(document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.disabled).toBe(true);
  expect(credentialProps).toMatchObject({ allAgents: false, agentIds: ["agent"] });
});

it("uses the server's connection-manager permission for company-wide access", async () => {
  await mount([], true);
  await click("Connect another account");
  expect(credentialProps).toMatchObject({ allAgents: true });
});

it("offers Pi account selection before choosing its required model", async () => {
  mocks.list.mockResolvedValue({ currentUserId: "owner", connections: [], canManageConnections: true });
  expect(aiProviderForAdapter("pi_local")).toBe("openrouter");
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <AiConnectionField companyId="company" agentId="agent" agentName="Pi" adapterType="pi_local" model=""
      value={{ provider: "openrouter", method: "api_key", mode: "responsible_user" }} onChange={onChange} />
  </QueryClientProvider>));
  await settle();
  expect(document.querySelector('[role="combobox"][aria-label="Connection"]')).not.toBeNull();
  expect(container.textContent).not.toContain("does not support the current harness");
  await click("Connect another account");
  expect(document.body.textContent).toContain("Advanced provider setup");
});

it.each(["openai", "anthropic", "google", "openrouter"] as const)("keeps a matching saved Pi %s API-key account selectable", async provider => {
  const saved = account({ provider, method: "api_key", name: "Pi provider account", accountLabel: "avery@example.test", status: "connected" });
  mocks.list.mockResolvedValue({ currentUserId: "owner", connections: [saved], canManageConnections: true });
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <AiConnectionField companyId="company" agentId="agent" agentName="Pi" adapterType="pi_local" model={`${provider}/provider-model`}
      value={{ provider, method: "api_key", mode: "delegated", connectionId: saved.id, grantId: saved.grantId }} onChange={onChange} />
  </QueryClientProvider>));
  await settle();
  expect(container.textContent).toContain("Pi provider account");
  expect(container.textContent).not.toContain("incompatible");
  expect(container.textContent).not.toContain("does not support");
  const trigger = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
  expect(trigger.getAttribute("title")).toBe("Pi provider account · API key · Personal · avery@example.test");
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await settle();
  const choice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent?.includes("Pi provider account"));
  expect(choice).toBeDefined();
  expect(choice?.getAttribute("aria-disabled")).not.toBe("true");
});

it("requires an explicit model for a chat pool member with no model hints", async () => {
  const gateway = account({ id: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002", provider: "openai", method: "api_key", name: "Local gateway", status: "connected", routing: { kind: "local", protocol: "chat", auth: "bearer", baseUrl: "http://127.0.0.1:1234", models: [] } });
  mocks.list.mockResolvedValue({ connections: [gateway], canManageConnections: true });
  mocks.listPools.mockResolvedValue([]);
  mocks.listGallery.mockResolvedValue({ apps: [{ name: "Pool", slug: "pool", branding: {}, aiConnectionRouter: { pluginKey: "pool" } }] });
  mocks.savePool.mockReturnValue(new Promise(() => {}));
  flushSync(() => root.render(<QueryClientProvider client={client}><AiConnectionPoolConnector pluginKey="pool" /></QueryClientProvider>));
  await settle();
  flushSync(() => container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Local gateway"]')!.click());
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
  flushSync(() => button("Continue").click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Model for connection 1"]')!;
  expect(input.value).toBe("");
  expect(container.textContent).toContain("Enter a model ID for this connection.");
  expect(button("Create pool").disabled).toBe(true);
  expect(mocks.savePool).not.toHaveBeenCalled();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, "custom/a"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(button("Create pool").disabled).toBe(false);
  const boundaryModel = "x".repeat(256);
  flushSync(() => { setter.call(input, boundaryModel); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(input.value).toBe(boundaryModel);
  expect(button("Create pool").disabled).toBe(false);
  flushSync(() => button("Create pool").click());
  expect(mocks.savePool).toHaveBeenCalledOnce();
  expect(mocks.savePool.mock.calls[0]![1].config.members[0].profile.model).toBe(boundaryModel);
});

it("prevents enabling or saving an edited pool until the chat model is valid", async () => {
  const gateway = account({ id: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002", provider: "openai", method: "api_key", name: "Local gateway", status: "connected", routing: { kind: "local", protocol: "chat", auth: "bearer", baseUrl: "http://127.0.0.1:1234", models: [] } });
  const pool = { id: "pool-id", pluginKey: "pool", name: "Pool", revision: 1, enabled: false, mode: "round_robin", thresholdPercent: 90, members: [{ id: "00000000-0000-4000-8000-000000000003", binding: { mode: "delegated", provider: "openai", method: "api_key", connectionId: gateway.id, grantId: gateway.grantId }, profile: { provider: "opencode", model: "" } }] };
  mocks.list.mockResolvedValue({ connections: [gateway], canManageConnections: true });
  mocks.listPools.mockResolvedValue([pool]);
  mocks.listGallery.mockResolvedValue({ apps: [{ name: "Pool", slug: "pool", branding: {}, aiConnectionRouter: { pluginKey: "pool" } }] });
  mocks.listAgents.mockResolvedValue([]);
  mocks.inspectPool.mockResolvedValue({});
  mocks.savePool.mockReturnValue(new Promise(() => {}));
  flushSync(() => root.render(<QueryClientProvider client={client}><AiConnectionPoolConnector pluginKey="pool" connection={{ id: pool.id } as ToolConnection} /></QueryClientProvider>));
  await settle();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Model for connection 1"]')!;
  const save = [...container.querySelectorAll("button")].find(item => item.textContent === "Save changes")!;
  const enable = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find(item => item.closest("label")?.textContent?.includes("Enable this pool"))!;
  expect(input.value).toBe("");
  expect(save.disabled).toBe(true);
  expect(enable.disabled).toBe(true);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, "x".repeat(257)); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(save.disabled).toBe(true);
  expect(enable.disabled).toBe(true);
  expect(container.textContent).toContain("Model IDs must be at most 256 characters.");
  flushSync(() => { setter.call(input, "paperclip/custom/a"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(save.disabled).toBe(false);
  expect(enable.disabled).toBe(false);
  expect(mocks.savePool).not.toHaveBeenCalled();
  const boundaryModel = "x".repeat(256);
  flushSync(() => { setter.call(input, boundaryModel); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(input.value).toBe(boundaryModel);
  expect(save.disabled).toBe(false);
  expect(enable.disabled).toBe(false);
  flushSync(() => save.click());
  expect(mocks.savePool).toHaveBeenCalledOnce();
  expect(mocks.savePool.mock.calls[0]![1]).toMatchObject({ id: pool.id, expectedRevision: pool.revision, config: { members: [{ profile: { model: boundaryModel } }] } });
});
