// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IsolatedWorkspacesRouteGate } from "./IsolatedWorkspacesRouteGate";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(replace ?? false)} />
  ),
  Outlet: () => <div data-testid="workspace-route" />,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("IsolatedWorkspacesRouteGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderGate() {
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <IsolatedWorkspacesRouteGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("redirects to the dashboard when isolated workspaces are disabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    await renderGate();

    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-to")).toBe("/dashboard");
    expect(navigate?.getAttribute("data-replace")).toBe("true");
    expect(container.querySelector('[data-testid="workspace-route"]')).toBeNull();
  });

  it("renders the workspace routes when isolated workspaces are enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    await renderGate();

    expect(container.querySelector('[data-testid="workspace-route"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  });

  it("renders nothing while the flag is loading, so an enabled instance never flashes a redirect", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    await renderGate();

    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-route"]')).toBeNull();
  });
});
