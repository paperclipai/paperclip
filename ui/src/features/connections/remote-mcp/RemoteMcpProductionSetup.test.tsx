// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { toolsApi } from "@/api/tools";
import { RemoteMcpProductionSetup } from "./RemoteMcpProductionSetup";
import type { RemoteMcpSetupState } from "./types";

vi.mock("@/api/tools", () => ({ toolsApi: { getConnectionInstalls: vi.fn() } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("@/api/companies-query", () => ({ resolveAccountUserId: async () => null }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
vi.mock("../ConnectionSetupFlow", () => ({ readConnectionIntentOAuthOutcome: () => null }));
vi.mock("../ConnectionInstructions", () => ({ ConnectionInstructionsEditor: () => null }));
vi.mock("./RemoteMcpConnectionSetup", () => ({
  RemoteMcpConnectionSetup: ({ state }: { state: RemoteMcpSetupState }) => (
    <div data-testid="remote-mcp-setup">{state.allAgents ? "all agents" : state.agentIds.join(",")}</div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connection = {
  id: "connection-1", companyId: "company", name: "Composio", status: "active",
  credentialPolicy: "organization", authKind: "oauth", config: { url: "https://connect.composio.dev/mcp" },
} as unknown as ToolConnection;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function render() {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <RemoteMcpProductionSetup providerId="composio" connection={connection} />
    </QueryClientProvider>,
  ));
}

beforeEach(() => {
  vi.mocked(toolsApi.getConnectionInstalls).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

it("keeps saved access on screen when a refetch fails during an outage", async () => {
  vi.mocked(toolsApi.getConnectionInstalls).mockResolvedValue({ installs: [{ targetType: "agent", targetId: "agent-1" }] } as never);
  render();
  await vi.waitFor(() => expect(container.querySelector('[data-testid="remote-mcp-setup"]')?.textContent).toBe("agent-1"));

  vi.mocked(toolsApi.getConnectionInstalls).mockRejectedValue(
    new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
  );
  await act(async () => {
    await client.invalidateQueries();
  });

  expect(container.querySelector('[data-testid="remote-mcp-setup"]')?.textContent).toBe("agent-1");
  expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  expect(container.textContent).not.toContain("Paperclip is restarting.");
  expect(container.textContent).not.toContain("Loading saved access");
});

it("shows readable copy with a retry when saved access cannot be loaded", async () => {
  vi.mocked(toolsApi.getConnectionInstalls)
    .mockRejectedValueOnce(new ApiError("Request failed: 500", 500, { error: "internal_error" }))
    .mockResolvedValue({ installs: [] } as never);
  render();
  await vi.waitFor(() => expect(container.querySelector('[data-query-view="error"]')).not.toBeNull());
  expect(container.textContent).toContain("Couldn't load saved access");
  expect(container.textContent).not.toContain("internal_error");
  expect(container.textContent).not.toContain("Request failed: 500");
  expect(container.querySelector('[data-testid="remote-mcp-setup"]')).toBeNull();

  act(() => (container.querySelector('[data-query-view="error"] button') as HTMLButtonElement).click());
  await vi.waitFor(() => expect(container.querySelector('[data-testid="remote-mcp-setup"]')).not.toBeNull());
  expect(toolsApi.getConnectionInstalls).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-query-view="error"]')).toBeNull();
});
