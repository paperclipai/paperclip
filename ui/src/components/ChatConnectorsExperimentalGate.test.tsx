// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatConnectorsExperimentalGate } from "./ChatConnectorsExperimentalGate";
import { AgentChannelsPanel } from "./chat/AgentChannelsPanel";
import { ExternallyConnectedTaskBanner } from "./chat/ExternallyConnectedTaskBanner";
import { queryKeys } from "@/lib/queryKeys";

const api = vi.hoisted(() => ({
  settings: vi.fn(),
  list: vi.fn(),
  binding: vi.fn(),
  get: vi.fn(),
  provider: null as string | null,
  endpointId: undefined as string | undefined,
}));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: api.settings },
}));
vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: { list: api.list, getIssueBinding: api.binding, get: api.get },
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ endpointId: api.endpointId }),
  useSearchParams: () => [new URLSearchParams(api.provider ? { provider: api.provider } : {})],
  Navigate: ({ to }: { to: string }) => <div data-redirect={to} />,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("Chat connectors visibility gate", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.settings.mockResolvedValue({ enableChatConnectors: false });
    api.list.mockResolvedValue([]);
    api.get.mockResolvedValue({ provider: "agentmail" });
    api.provider = null;
    api.endpointId = undefined;
    api.binding.mockResolvedValue(null);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });
  async function render(withClient = true) {
    const content = (
      <ChatConnectorsExperimentalGate>
        <div data-chat-setup>Chat setup</div>
      </ChatConnectorsExperimentalGate>
    );
    flushSync(() =>
      root.render(
        withClient ? (
          <QueryClientProvider client={client}>{content}</QueryClientProvider>
        ) : (
          content
        ),
      ),
    );
    await flushReact();
  }
  it.each([{}, { enableChatConnectors: false }])(
    "redirects missing or disabled settings without mounting setup (%j)",
    async (settings) => {
      api.settings.mockResolvedValue(settings);
      await render();
      expect(container.querySelector("[data-chat-setup]")).toBeNull();
      expect(
        container
          .querySelector("[data-redirect]")
          ?.getAttribute("data-redirect"),
      ).toBe("/apps");
    },
  );
  it("opens AgentMail setup with the experimental flag disabled", async () => {
    api.provider = "agentmail";
    await render();
    expect(container.querySelector("[data-chat-setup]")).not.toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });
  it.each(["agentmail", "slack"])("admits only default email management when chat is disabled (%s)", async (provider) => {
    api.endpointId = "endpoint-1";
    api.get.mockResolvedValue({ provider });
    await render();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("endpoint-1"));
    await vi.waitFor(() => expect(Boolean(container.querySelector("[data-chat-setup]"))).toBe(provider === "agentmail"));
    if (provider !== "agentmail") expect(container.querySelector("[data-redirect]")).not.toBeNull();
  });
  it("waits without exposing setup, then enables the route after explicit opt-in", async () => {
    let resolve!: (value: unknown) => void;
    api.settings.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    expect(container.innerHTML).toBe("");
    resolve({ enableChatConnectors: true });
    await flushReact();
    expect(container.querySelector("[data-chat-setup]")).not.toBeNull();
    client.setQueryData(queryKeys.instance.experimentalSettings, {
      enableChatConnectors: false,
    });
    await flushReact();
    expect(container.querySelector("[data-chat-setup]")).toBeNull();
  });
  it("fails closed after a settings error", async () => {
    api.settings.mockRejectedValue(new Error("unavailable"));
    await render();
    expect(container.querySelector("[data-chat-setup]")).toBeNull();
    expect(container.querySelector("[data-redirect]")).not.toBeNull();
  });

  it("hides previously enabled setup after a failed settings refetch", async () => {
    api.settings.mockResolvedValue({ enableChatConnectors: true });
    await render();
    expect(container.querySelector("[data-chat-setup]")).not.toBeNull();
    api.settings.mockRejectedValue(new Error("unavailable"));
    await client.refetchQueries({
      queryKey: queryKeys.instance.experimentalSettings,
    });
    await flushReact();
    expect(
      client.getQueryData(queryKeys.instance.experimentalSettings),
    ).toEqual({ enableChatConnectors: true });
    expect(container.querySelector("[data-chat-setup]")).toBeNull();
    expect(container.querySelector("[data-redirect]")).not.toBeNull();
  });
  it("defaults off without a query provider and performs no settings request", async () => {
    await render(false);
    expect(container.querySelector("[data-chat-setup]")).toBeNull();
    expect(api.settings).not.toHaveBeenCalled();
  });
  it("keeps agent email channels available but hides cached experimental chat channels and task bindings", async () => {
    client.setQueryData(queryKeys.chatEndpoints.list("company-1"), [
      { provider: "slack", id: "endpoint-1", assignedAgentId: "agent-1", status: "active" },
    ]);
    client.setQueryData(["issue-chat-binding", "company-1", "issue-1"], {
      endpointId: "endpoint-1",
      conversationId: "conversation-1",
    });
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <AgentChannelsPanel companyId="company-1" agentId="agent-1" />
          <ExternallyConnectedTaskBanner
            companyId="company-1"
            issueId="issue-1"
          />
        </QueryClientProvider>,
      ),
    );
    await flushReact();
    expect(container.textContent).toContain("Connect AgentMail from Connectors.");
    expect(container.querySelector('a[href="/apps/chat/endpoint-1/settings"]')).toBeNull();
    expect(api.list).toHaveBeenCalledWith("company-1");
    expect(api.binding).not.toHaveBeenCalled();
  });
});
