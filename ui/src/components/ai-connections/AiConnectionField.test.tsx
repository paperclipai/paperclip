// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { AiConnectionField } from "./AiConnectionField";
import type { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const mocks = vi.hoisted(() => ({ list: vi.fn(), setDefault: vi.fn() }));
let credentialProps: ComponentProps<typeof AiConnectionCredentialStep> | undefined;
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mocks }));
vi.mock("./AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: ComponentProps<typeof AiConnectionCredentialStep>) => {
    credentialProps = props;
    return <div>Provider sign-in</div>;
  },
}));
vi.mock("./AiConnectionManagement", () => ({ AiConnectionLegacyNotice: () => null }));
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

it("keeps loaded connections usable when a refetch fails during an outage", async () => {
  await mount([account()]);
  expect(document.body.textContent).toContain("Reconnect account");
  mocks.list.mockRejectedValue(new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }));
  await client.invalidateQueries();
  await settle();
  expect(document.body.textContent).toContain("Reconnect account");
  expect(document.body.textContent).not.toContain("Retry connections");
  expect(document.body.textContent).not.toContain("Paperclip is restarting.");
  expect(document.querySelector('[data-query-view="error"]')).toBeNull();
});

it("shows readable copy with a retry when connections cannot be loaded", async () => {
  mocks.list.mockRejectedValueOnce(new ApiError("Request failed: 500", 500, { error: "internal_error" }));
  await mount([account()]);
  const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map(node => node.textContent).join(" ");
  expect(alerts).toContain("An unexpected error occurred");
  expect(document.body.textContent).not.toContain("internal_error");
  expect(document.body.textContent).not.toContain("Request failed: 500");
  expect(document.body.textContent).not.toContain("Reconnect account");
  await click("Retry connections");
  await settle();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Reconnect account");
  expect(document.body.textContent).not.toContain("Retry connections");
});
