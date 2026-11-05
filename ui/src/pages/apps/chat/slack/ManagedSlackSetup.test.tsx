// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { ManagedSlackSetup } from "./ManagedSlackSetup";

const api = vi.hoisted(() => ({ slackSetupOptions: vi.fn(), provisionManagedSlack: vi.fn(), authorizeSlackManager: vi.fn(), get: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));
// Stop at the navigation boundary without leaving jsdom.
const navigation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauthHandoff", () => ({ prepareOAuthNavigation: navigation, savePendingCloudHandoff: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let endpoint: ChatEndpoint;
const props = () => ({ endpoint, stage: "app" as const, disabled: false, autoStart: true, saveDetails: vi.fn().mockResolvedValue(undefined), onSaved: vi.fn(), onBusy: vi.fn(), onSaveExit: vi.fn(), onManual: vi.fn(), onContinue: vi.fn() });
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  endpoint = { id: "endpoint", companyId: "company", assignedAgentName: "Maya", setup: { slackSetupMethod: "managed" } } as ChatEndpoint;
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: [{ grantId: "grant", workspaceName: "Paperclip" }] });
  api.provisionManagedSlack.mockResolvedValue({}); api.get.mockResolvedValue(endpoint);
  api.authorizeSlackManager.mockResolvedValue({ authorizationUrl: "https://slack.com/oauth" });
  navigation.mockImplementation(() => new Promise(() => {}));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });
async function render(overrides = {}) {
  await act(async () => { root.render(<StrictMode><QueryClientProvider client={client}><ManagedSlackSetup {...props()} {...overrides} /></QueryClientProvider></StrictMode>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
}
it("starts a single managed install after Continue even across rerenders", async () => {
  await render(); await render();
  expect(api.provisionManagedSlack).toHaveBeenCalledTimes(1);
  expect(api.provisionManagedSlack).toHaveBeenCalledWith("endpoint", expect.objectContaining({ grantId: "grant" }));
  expect(api.authorizeSlackManager).not.toHaveBeenCalled();
});
it("requests explicit reinstall when reconnecting a configured app", async () => {
  endpoint.setup!.slackRegistration = { status: "configured", appId: "app", managerGrantId: "grant" } as NonNullable<ChatEndpoint["setup"]>["slackRegistration"];
  await render({ autoStart: false, reconnect: true });
  const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Continue in Slack");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(api.provisionManagedSlack).toHaveBeenCalledWith("endpoint", expect.objectContaining({ grantId: "grant", reconnect: true, requestId: expect.any(String) }));
});
it("reuses the reconnect receipt after a lost response and failed recovery read", async () => {
  endpoint.setup!.slackRegistration = { status: "configured", appId: "app", managerGrantId: "grant" } as NonNullable<ChatEndpoint["setup"]>["slackRegistration"];
  api.provisionManagedSlack.mockRejectedValue(new Error("Response lost"));
  api.get.mockRejectedValue(new Error("Recovery read unavailable"));
  await render({ autoStart: false, reconnect: true });
  const button = () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Continue in Slack")!;
  await act(async () => button().click());
  await act(async () => button().click());
  expect(api.provisionManagedSlack).toHaveBeenCalledTimes(2);
  expect(api.provisionManagedSlack.mock.calls[1]![1]).toEqual(api.provisionManagedSlack.mock.calls[0]![1]);
});
it("opens manager authorization directly when there is no saved workspace", async () => {
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: [] });
  await render();
  expect(api.authorizeSlackManager).toHaveBeenCalledTimes(1);
  expect(navigation).toHaveBeenCalledWith({ authorizationUrl: "https://slack.com/oauth" });
  expect(api.provisionManagedSlack).not.toHaveBeenCalled();
});
it.each([0, 1, 2])("offers workspace reconnection before an app exists with %i active workspaces", async (activeWorkspaces) => {
  endpoint.setup!.slackManagerError = "slack_manager_reauthorize";
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: Array.from({ length: activeWorkspaces }, (_, i) => ({ grantId: `grant-${i}`, workspaceName: `Workspace ${i}` })) });
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Reconnect your Slack workspace to continue setting up this agent.");
  const reconnect = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Reconnect Slack workspace");
  expect(reconnect).toBeDefined();
  expect(reconnect!.disabled).toBe(false);
  expect(container.textContent).not.toContain("Connect another Slack workspace");
  expect(api.authorizeSlackManager).not.toHaveBeenCalled();
  await act(async () => reconnect!.click());
  expect(api.authorizeSlackManager).toHaveBeenCalledExactlyOnceWith("endpoint");
  expect(navigation).toHaveBeenCalledWith({ authorizationUrl: "https://slack.com/oauth" });
  expect(api.provisionManagedSlack).not.toHaveBeenCalled();
});
it.each([0, 1, 2])("offers workspace reconnection after an authorization request fails with %i active workspaces", async (activeWorkspaces) => {
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: Array.from({ length: activeWorkspaces }, (_, i) => ({ grantId: `grant-${i}`, workspaceName: `Workspace ${i}` })) });
  api.authorizeSlackManager.mockRejectedValueOnce(new Error("Reconnect your Slack workspace to continue setting up this agent."));
  await render({ autoStart: activeWorkspaces === 0 });
  if (activeWorkspaces) {
    const connectAnother = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Connect another Slack workspace");
    await act(async () => connectAnother!.click());
  }
  const reconnect = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Reconnect Slack workspace");
  expect(reconnect).toBeDefined();
  expect(reconnect!.disabled).toBe(false);
  expect(api.authorizeSlackManager).toHaveBeenCalledTimes(1);
  await act(async () => reconnect!.click());
  expect(api.authorizeSlackManager).toHaveBeenCalledTimes(2);
  expect(navigation).toHaveBeenCalledWith({ authorizationUrl: "https://slack.com/oauth" });
  expect(api.provisionManagedSlack).not.toHaveBeenCalled();
});
it("keeps one workspace reconnect action when a saved app needs reauthorization", async () => {
  endpoint.setup!.slackRegistration = { status: "failed", appId: "app", managerGrantId: "grant", errorCode: "slack_manager_reauthorize" } as NonNullable<ChatEndpoint["setup"]>["slackRegistration"];
  await render();
  const reconnect = Array.from(container.querySelectorAll("button")).filter(item => item.textContent === "Reconnect Slack workspace");
  expect(reconnect).toHaveLength(1);
  await act(async () => reconnect[0]!.click());
  expect(api.authorizeSlackManager).toHaveBeenCalledExactlyOnceWith("endpoint");
  expect(api.provisionManagedSlack).not.toHaveBeenCalled();
});
it("does not start while Choose agent is visible or after Save & exit", async () => {
  await render({ autoStart: false });
  expect(api.provisionManagedSlack).not.toHaveBeenCalled();
  expect(api.authorizeSlackManager).not.toHaveBeenCalled();
});
it("waits for an explicit workspace choice when there are several", async () => {
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: [{ grantId: "one", workspaceName: "One" }, { grantId: "two", workspaceName: "Two" }] });
  await render(); expect(api.provisionManagedSlack).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Choose a Slack workspace");
});
it.each(["uncertain", "failed", "creating", "install", "credentials_saved"])("does not automatically retry a %s registration", async status => {
  endpoint.setup!.slackRegistration = { status } as NonNullable<ChatEndpoint["setup"]>["slackRegistration"];
  await render(); expect(api.provisionManagedSlack).not.toHaveBeenCalled(); expect(api.authorizeSlackManager).not.toHaveBeenCalled();
});
it("does not loop authorization after denial", async () => {
  endpoint.setup!.slackManagerError = "slack_install_declined";
  await render(); expect(api.authorizeSlackManager).not.toHaveBeenCalled(); expect(api.provisionManagedSlack).not.toHaveBeenCalled();
});
it("does not silently retry an ambiguous request after refresh of setup options", async () => {
  api.provisionManagedSlack.mockRejectedValue(new Error("Request failed"));
  await render(); await render();
  expect(api.provisionManagedSlack).toHaveBeenCalledTimes(1);
});

it.each(["popup", "fallback"])("continues after manager authorization returns through the %s", async (mode) => {
  const popup = { closed: false, opener: window, location: { href: "about:blank", assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
  popup.location.assign.mockImplementation((url: string) => { popup.location.href = url; });
  vi.spyOn(window, "open").mockReturnValue(mode === "popup" ? popup as unknown as Window : null);
  navigation.mockResolvedValue({ kind: "authorization", url: "https://slack.com/oauth" });
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: [] });
  const onSaved = vi.fn();
  await render({ onSaved });
  expect(api.authorizeSlackManager).toHaveBeenCalledTimes(1);

  if (mode === "popup") {
    // Returning focus while Slack is still open must not interrupt sign-in.
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(api.get).not.toHaveBeenCalled();
    expect(popup.close).not.toHaveBeenCalled();
    popup.location.href = `${window.location.origin}/UIP/apps/chat/connect?provider=slack&resume=endpoint`;
  }
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: [{ grantId: "grant", workspaceName: "Paperclip" }] });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(onSaved).toHaveBeenCalledWith(endpoint);
  expect(api.provisionManagedSlack).not.toHaveBeenCalled();
  const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Continue")!;
  await act(async () => button.click());
  expect(api.authorizeSlackManager).toHaveBeenCalledTimes(1);
  expect(api.provisionManagedSlack).toHaveBeenCalledWith("endpoint", expect.objectContaining({ grantId: "grant" }));
});
