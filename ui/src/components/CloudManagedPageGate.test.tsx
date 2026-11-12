// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { CloudManagedPageGate } from "./CloudManagedPageGate";

vi.mock("@/lib/router", () => ({
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(replace)} />
  ),
  Outlet: () => <div data-testid="page-content">Page content</div>,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("CloudManagedPageGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderGate(health?: Record<string, unknown>) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (health !== undefined) {
      queryClient.setQueryData(queryKeys.health, health);
    }
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <CloudManagedPageGate />
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
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("redirects to the settings root on a Cloud-managed instance", async () => {
    await renderGate({ status: "ok", cloud: { managed: true } });

    expect(container.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe(
      "/company/settings",
    );
    expect(container.querySelector('[data-testid="page-content"]')).toBeNull();
  });

  it("renders the page on a self-hosted instance", async () => {
    await renderGate({ status: "ok" });

    expect(container.querySelector('[data-testid="page-content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  });
});
