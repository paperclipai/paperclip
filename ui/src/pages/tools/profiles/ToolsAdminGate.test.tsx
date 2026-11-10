// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ConnectivityProvider, createConnectivityStore, type ConnectivityStore } from "@/lib/connectivity";
import { ToolsAdminGate } from "./ToolsAdminGate";

const getBoardAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: () => getBoardAccessMock() },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

const DENIAL = "Access profiles require editing access";

describe("ToolsAdminGate", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let store: ConnectivityStore;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    store?.dispose();
    vi.clearAllMocks();
  });

  async function render({ browserOnline = true }: { browserOnline?: boolean } = {}) {
    store = createConnectivityStore({
      probe: async () => ({ reachable: false, retryAfterMs: null }),
      browserOnline,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ConnectivityProvider store={store}>
          <QueryClientProvider client={client}>
            <ToolsAdminGate>
              <div>gated content</div>
            </ToolsAdminGate>
          </QueryClientProvider>
        </ConnectivityProvider>,
      );
    });
    await flushReact();
  }

  it("renders children once the loaded answer allows it", async () => {
    getBoardAccessMock.mockResolvedValue({ source: "local_implicit", isInstanceAdmin: false, memberships: [] });
    await render();
    expect(container.textContent).toContain("gated content");
    expect(container.textContent).not.toContain(DENIAL);
  });

  it("shows the denial card only for a loaded answer that says no", async () => {
    getBoardAccessMock.mockResolvedValue({ source: "cloud", isInstanceAdmin: false, memberships: [] });
    await render();
    expect(container.textContent).toContain(DENIAL);
    expect(container.textContent).not.toContain("gated content");
  });

  it("shows a placeholder, not a denial, during an outage before the first load", async () => {
    getBoardAccessMock.mockRejectedValue(
      new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
    );
    await render({ browserOnline: false });

    expect(container.textContent).toContain("Loading…");
    expect(container.textContent).not.toContain(DENIAL);
    expect(container.textContent).not.toContain("gated content");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
  });

  it("shows readable copy with Retry for a real error, not a denial", async () => {
    getBoardAccessMock
      .mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }))
      .mockResolvedValue({ source: "local_implicit", isInstanceAdmin: false, memberships: [] });
    await render();

    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn't check your access");
    expect(container.textContent).not.toContain(DENIAL);

    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Retry"));
    expect(retry, "Retry button").toBeTruthy();
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("gated content");
  });
});
