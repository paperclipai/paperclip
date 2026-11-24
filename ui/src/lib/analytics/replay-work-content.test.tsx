// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  companyId: "co-1" as string | null,
  session: { browserAnalytics: { replayEnabled: true } } as unknown,
  connections: vi.fn(),
  chatEndpoints: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: mocks.companyId }),
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => mocks.session } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listConnections: (id: string) => mocks.connections(id) } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: (id: string) => mocks.chatEndpoints(id) } }));
vi.mock("./product-analytics", () => ({ refreshSessionReplay: () => mocks.refresh() }));

import { REPLAY_WORK_CONTENT_ATTRIBUTE } from "./privacy";
import {
  ReplayWorkContentVisibility,
  companyAllowsReplayWorkContent,
  connectionCarriesConnectedAccountData,
} from "./replay-work-content";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function connection(overrides: { name?: string; config?: Record<string, unknown>; transportConfig?: Record<string, unknown> } = {}) {
  return { name: "Linear", config: {}, transportConfig: {}, ...overrides };
}

describe("connectionCarriesConnectedAccountData", () => {
  it("flags Google, Slack and aggregator connections", () => {
    expect(connectionCarriesConnectedAccountData(connection({ config: { sourceTemplateKey: "google-workspace" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ config: { sourceTemplateKey: "gmail" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ transportConfig: { sourceTemplateKey: "google-drive" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ config: { sourceTemplateKey: "slack" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ config: { sourceTemplateKey: "composio" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ name: "Team Slack" }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ transportConfig: { url: "https://gmail.mcp.example.com/mcp" } }))).toBe(true);
  });

  it("leaves other connections alone", () => {
    expect(connectionCarriesConnectedAccountData(connection({ config: { sourceTemplateKey: "linear" } }))).toBe(false);
    expect(connectionCarriesConnectedAccountData(connection({ name: "GitHub", transportConfig: { url: "https://api.githubcopilot.com/mcp" } }))).toBe(false);
  });
});

describe("companyAllowsReplayWorkContent", () => {
  it("needs both lists loaded and no Google or Slack source", () => {
    expect(companyAllowsReplayWorkContent(undefined, [])).toBe(false);
    expect(companyAllowsReplayWorkContent([], undefined)).toBe(false);
    expect(companyAllowsReplayWorkContent([], [])).toBe(true);
    expect(companyAllowsReplayWorkContent([connection()], [{ provider: "github" } as never])).toBe(true);
    expect(companyAllowsReplayWorkContent([connection({ config: { sourceTemplateKey: "gmail" } })], [])).toBe(false);
    expect(companyAllowsReplayWorkContent([], [{ provider: "slack" } as never])).toBe(false);
  });
});

describe("ReplayWorkContentVisibility", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ReplayWorkContentVisibility />
        </QueryClientProvider>,
      );
    });
    // Let the queries settle.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  }

  const visible = () => document.documentElement.getAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);

  beforeEach(() => {
    mocks.companyId = "co-1";
    mocks.session = { browserAnalytics: { replayEnabled: true } };
    mocks.connections.mockReset().mockResolvedValue({ connections: [] });
    mocks.chatEndpoints.mockReset().mockResolvedValue([]);
    mocks.refresh.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
  });

  it("shows work content for a company without Google or Slack, and refreshes the replay once", async () => {
    await render();
    expect(visible()).toBe("visible");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps work content masked when the company has a Google connection", async () => {
    mocks.connections.mockResolvedValue({ connections: [connection({ config: { sourceTemplateKey: "google-workspace" } })] });
    await render();
    expect(visible()).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps work content masked when Slack is a chat endpoint", async () => {
    mocks.chatEndpoints.mockResolvedValue([{ provider: "slack" }]);
    await render();
    expect(visible()).toBeNull();
  });

  it("keeps work content masked when the connection list fails (for example no permission)", async () => {
    mocks.connections.mockRejectedValue(new Error("403"));
    await render();
    expect(visible()).toBeNull();
  });

  it("makes no requests and stays masked when session replay is off", async () => {
    mocks.session = { browserAnalytics: null };
    await render();
    expect(visible()).toBeNull();
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.chatEndpoints).not.toHaveBeenCalled();
  });

  it("clears the attribute on unmount", async () => {
    await render();
    expect(visible()).toBe("visible");
    act(() => root.unmount());
    expect(visible()).toBeNull();
    root = createRoot(host);
  });
});
