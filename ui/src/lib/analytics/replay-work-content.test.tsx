// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  companyId: "co-1" as string | null,
  companyPrefix: "ACME" as string | null,
  pathname: "/ACME/issues/ACME-1",
  session: { browserAnalytics: { replayEnabled: true, replayWorkContentEnabled: true } } as unknown,
  connections: vi.fn(),
  chatEndpoints: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: mocks.companyId,
    selectedCompany: mocks.companyId && mocks.companyPrefix ? { id: mocks.companyId, issuePrefix: mocks.companyPrefix } : null,
  }),
}));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: mocks.pathname }) }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => mocks.session } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listConnections: (id: string) => mocks.connections(id) } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: (id: string) => mocks.chatEndpoints(id) } }));
vi.mock("./product-analytics", () => ({ refreshSessionReplay: () => mocks.refresh() }));

import { REPLAY_WORK_CONTENT_ATTRIBUTE } from "./privacy";
import { queryKeys } from "@/lib/queryKeys";
import {
  ReplayWorkContentVisibility,
  companyAllowsReplayWorkContent,
  connectionCarriesConnectedAccountData,
  isReplayWorkContentSourceChange,
  replayWorkContentQueryKeys,
  routeShowsCompany,
} from "./replay-work-content";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

/** A complete connection list, as the server sends it to a board reader. */
function connectionList(connections: ReturnType<typeof connection>[] = [], hiddenCount = 0) {
  return { connections, hiddenCount };
}

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

  it("flags a custom-named Slack chat channel by its provider", () => {
    // Removing a Slack channel archives its endpoint (gone from the endpoint
    // list) but keeps this connection row, named however the person chose.
    expect(connectionCarriesConnectedAccountData(connection({ name: "Support", config: { provider: "slack" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ name: "Support", config: { provider: "telegram" } }))).toBe(false);
  });

  it("flags apps that reach Google or Slack through another service", () => {
    for (const slug of ["zapier", "make", "gsc-wizard", "windsor-ai"]) {
      expect(connectionCarriesConnectedAccountData(connection({ config: { sourceTemplateKey: slug } }))).toBe(true);
    }
    // The same apps added by hand, under any name.
    expect(connectionCarriesConnectedAccountData(connection({ name: "Automations", transportConfig: { url: "https://mcp.zapier.com/api/mcp/s/abc/mcp" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ name: "Scenarios", transportConfig: { serverUrl: "https://eu1.make.com/mcp" } }))).toBe(true);
    expect(connectionCarriesConnectedAccountData(connection({ name: "Beauty", transportConfig: { url: "https://mcp.makeup.example.com/mcp" } }))).toBe(false);
    expect(connectionCarriesConnectedAccountData(connection({ name: "Notes", transportConfig: { url: "not a url" } }))).toBe(false);
  });

  it("flags a known gateway added through the generic setup, with no catalog slug", () => {
    // "Connect your own MCP server" saves the URL and a free name, no slug.
    for (const url of [
      "https://mcp.composio.dev/partner/mcp", "https://connect.composio.dev/mcp", "https://backend.composio.dev/v3/mcp/abc",
      "https://api.arcade.dev/mcp/gateway", "https://executor.sh/mcp",
    ]) {
      expect(connectionCarriesConnectedAccountData(connection({ name: "Team tools", transportConfig: { url } }))).toBe(true);
      expect(connectionCarriesConnectedAccountData(connection({ name: "Team tools", transportConfig: { serverUrl: url } }))).toBe(true);
    }
    for (const name of ["Composio", "Arcade gateway", "Executor", "Zapier", "Make", "Windsor.ai", "GSC Wizard"]) {
      expect(connectionCarriesConnectedAccountData(connection({ name, transportConfig: { url: "https://mcp.internal.example/mcp" } }))).toBe(true);
    }
    expect(connectionCarriesConnectedAccountData(connection({ name: "Maker space", transportConfig: { url: "https://decomposio.example/mcp" } }))).toBe(false);
  });

  it("leaves other connections alone", () => {
    expect(connectionCarriesConnectedAccountData(connection({ config: { sourceTemplateKey: "linear" } }))).toBe(false);
    expect(connectionCarriesConnectedAccountData(connection({ name: "GitHub", transportConfig: { url: "https://api.githubcopilot.com/mcp" } }))).toBe(false);
  });
});

describe("companyAllowsReplayWorkContent", () => {
  it("needs both lists loaded and no Google or Slack source", () => {
    expect(companyAllowsReplayWorkContent(undefined, [])).toBe(false);
    expect(companyAllowsReplayWorkContent(connectionList(), undefined)).toBe(false);
    expect(companyAllowsReplayWorkContent(connectionList(), [])).toBe(true);
    expect(companyAllowsReplayWorkContent(connectionList([connection()]), [{ provider: "github" } as never])).toBe(true);
    expect(companyAllowsReplayWorkContent(connectionList([connection({ config: { sourceTemplateKey: "gmail" } })]), [])).toBe(false);
    expect(companyAllowsReplayWorkContent(connectionList(), [{ provider: "slack" } as never])).toBe(false);
  });

  it("needs a connection list the server did not filter", () => {
    // Another person's draft (an expired Google sign-in returns to draft) or
    // a connector whose plugin is unavailable: the hidden row can be Google.
    expect(companyAllowsReplayWorkContent(connectionList([], 1), [])).toBe(false);
    expect(companyAllowsReplayWorkContent(connectionList([connection()], 2), [])).toBe(false);
    // An older server sends no count.
    expect(companyAllowsReplayWorkContent({ connections: [] }, [])).toBe(false);
  });
});

describe("routeShowsCompany", () => {
  it("accepts the selected company's own pages and pages with no company", () => {
    expect(routeShowsCompany("/ACME/issues/ACME-1", "ACME")).toBe(true);
    expect(routeShowsCompany("/acme/dashboard", "ACME")).toBe(true);
    expect(routeShowsCompany("/", "ACME")).toBe(true);
    expect(routeShowsCompany("/instance/settings", "ACME")).toBe(true);
  });

  it("rejects a page of another company, or any company page with no selected company", () => {
    expect(routeShowsCompany("/OTHER/issues/OTHER-1", "ACME")).toBe(false);
    expect(routeShowsCompany("/OTHER/issues/OTHER-1", null)).toBe(false);
    expect(routeShowsCompany("/OTHER/issues/OTHER-1", undefined)).toBe(false);
  });
});

describe("isReplayWorkContentSourceChange", () => {
  it("matches the activity the server logs when a source is added", () => {
    // The actions `server/src/routes/tool-access.ts` and the chat channel
    // services log. A connect from the Apps catalog logs `tool_app.*`.
    for (const action of [
      "tool_app.connected", "tool_app.oauth_connected", "tool_app.reconnected", "tool_example.installed",
      "tool_connection.created", "tool_connection.updated", "connection_installs.changed",
      "chat_endpoint.created", "chat_endpoint.updated", "chat_endpoint.reconnected", "company.imported",
    ]) {
      expect(isReplayWorkContentSourceChange(action)).toBe(true);
    }
  });

  it("matches every other action of a connection family, named or not", () => {
    // Other routes add a connection row too (a machine sign-in, a model
    // connection, an email channel, a GitHub chat app), and some build the
    // action name at run time. A new action in these families must re-check.
    for (const action of [
      "tool_connection.machine_sign_in_created", "tool_connection.archived", "tool_connection.some_future_action",
      "ai_connection.connected", "ai_connection.reconnected", "ai_connection.pool_saved",
      "email_endpoint.connected", "chat_github.app_connected", "tool_application.created",
    ]) {
      expect(isReplayWorkContentSourceChange(action)).toBe(true);
    }
  });

  it("ignores frequent activity that adds no source", () => {
    for (const action of [
      "tool_connection.health_check", "tool_connection.catalog_refresh", "tool_connection.credential_resolution",
      "tool_connection.webhook_processed", "ai_connection.credential_refreshed", "chat_endpoint.webhook_verified",
      "tool_gateway.call_completed", "issue.updated", "company.updated", null, undefined,
    ]) {
      expect(isReplayWorkContentSourceChange(action)).toBe(false);
    }
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
    await settle();
  }

  // Let the queries settle and React render the result.
  async function settle() {
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  }

  const visible = () => document.documentElement.getAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);

  beforeEach(() => {
    mocks.companyId = "co-1";
    mocks.companyPrefix = "ACME";
    mocks.pathname = "/ACME/issues/ACME-1";
    mocks.session = { browserAnalytics: { replayEnabled: true, replayWorkContentEnabled: true } };
    mocks.connections.mockReset().mockResolvedValue(connectionList());
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
    mocks.connections.mockResolvedValue(connectionList([connection({ config: { sourceTemplateKey: "google-workspace" } })]));
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

  it("keeps work content masked when the server hid a connection from this viewer", async () => {
    // A Google connection returns to draft when its sign-in expires, and the
    // list hides another person's draft from a member, so the visible part
    // of the list proves nothing.
    mocks.connections.mockResolvedValue(connectionList([], 1));
    await render();
    expect(visible()).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps work content masked when the server does not say whether the list is complete", async () => {
    mocks.connections.mockResolvedValue({ connections: [] });
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

  it.each([
    null,
    { browserAnalytics: null },
    { browserAnalytics: { replayEnabled: false, replayWorkContentEnabled: true } },
    { browserAnalytics: { replayEnabled: true } },
    { browserAnalytics: { replayEnabled: true, replayWorkContentEnabled: false } },
  ])("makes no source requests and stays masked without both deployment switches: %j", async (session) => {
    mocks.session = session;
    await render();
    expect(visible()).toBeNull();
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.chatEndpoints).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("masks cached eligible content when the deployment opt-in is withdrawn", async () => {
    await render();
    expect(visible()).toBe("visible");
    await act(async () => {
      queryClient.setQueryData(queryKeys.auth.session, {
        browserAnalytics: { replayEnabled: true, replayWorkContentEnabled: false },
      });
    });
    await settle();
    expect(visible()).toBeNull();
    expect(mocks.connections).toHaveBeenCalledTimes(1);
    expect(mocks.chatEndpoints).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("masks again as soon as a source change resets the check, and stays masked for a new Google connection", async () => {
    await render();
    expect(visible()).toBe("visible");
    let finishReload: (value: unknown) => void = () => {};
    mocks.connections.mockImplementation(() => new Promise((resolve) => { finishReload = resolve; }));
    await act(async () => {
      void queryClient.resetQueries({ queryKey: replayWorkContentQueryKeys.connections("co-1") });
    });
    await settle();
    expect(visible()).toBeNull();
    finishReload(connectionList([connection({ config: { sourceTemplateKey: "gmail" } })]));
    await settle();
    expect(visible()).toBeNull();
    expect(mocks.connections).toHaveBeenCalledTimes(2);
  });

  it("masks while the page shows another company than the selected one", async () => {
    // The selection follows the URL in an effect after the page renders, and
    // a manual switch delays it, so another company's task can render first.
    await render();
    expect(visible()).toBe("visible");
    mocks.pathname = "/OTHER/issues/OTHER-7";
    await render();
    expect(visible()).toBeNull();
    mocks.pathname = "/ACME/issues/ACME-1";
    await render();
    expect(visible()).toBe("visible");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("masks while an invalidated list refreshes, and shows again without another snapshot", async () => {
    // `LiveUpdatesProvider` invalidates every active query when the tab
    // returns or the socket reopens, because it missed events meanwhile.
    await render();
    expect(visible()).toBe("visible");
    let finishReload: (value: unknown) => void = () => {};
    mocks.chatEndpoints.mockImplementation(() => new Promise((resolve) => { finishReload = resolve; }));
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: replayWorkContentQueryKeys.chatEndpoints("co-1") });
    });
    await settle();
    expect(visible()).toBeNull();
    finishReload([]);
    await settle();
    expect(visible()).toBe("visible");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts from unknown on a return to a company, and takes a new snapshot when it shows", async () => {
    await render();
    expect(visible()).toBe("visible");
    mocks.companyId = "co-2";
    mocks.companyPrefix = "OTHER";
    mocks.pathname = "/OTHER/dashboard";
    mocks.connections.mockResolvedValue(connectionList([connection({ config: { sourceTemplateKey: "gmail" } })]));
    await render();
    expect(visible()).toBeNull();
    mocks.companyId = "co-1";
    mocks.companyPrefix = "ACME";
    mocks.pathname = "/ACME/dashboard";
    let finishReload: (value: unknown) => void = () => {};
    mocks.connections.mockImplementation(() => new Promise((resolve) => { finishReload = resolve; }));
    await render();
    // The first answer for co-1 is gone: nothing shows until a new one loads.
    expect(visible()).toBeNull();
    finishReload(connectionList());
    await settle();
    expect(visible()).toBe("visible");
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("masks when a refresh fails, even with an earlier answer cached", async () => {
    await render();
    expect(visible()).toBe("visible");
    mocks.connections.mockRejectedValue(new Error("403"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: replayWorkContentQueryKeys.connections("co-1") });
    });
    await settle();
    expect(visible()).toBeNull();
  });

  it("clears the attribute on unmount", async () => {
    await render();
    expect(visible()).toBe("visible");
    act(() => root.unmount());
    expect(visible()).toBeNull();
    root = createRoot(host);
  });
});
