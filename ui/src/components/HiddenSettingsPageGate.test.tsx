// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { HiddenSettingsPageGate } from "./HiddenSettingsPageGate";

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

describe("HiddenSettingsPageGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderGate(pageKey: string, health?: Record<string, unknown>) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (health !== undefined) {
      queryClient.setQueryData(queryKeys.health, health);
    }
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <HiddenSettingsPageGate pageKey={pageKey} />
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

  it("redirects to the settings root when the page is operator-hidden", async () => {
    await renderGate("instance.plugins", {
      status: "ok",
      hiddenSettings: ["instance.plugins", "instance.adapters"],
    });

    expect(container.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe(
      "/company/settings",
    );
    expect(container.querySelector('[data-testid="page-content"]')).toBeNull();
  });

  it("renders the page when it is not hidden", async () => {
    await renderGate("instance.plugins", { status: "ok", hiddenSettings: ["instance.access"] });

    expect(container.querySelector('[data-testid="page-content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  });

  it("renders the page when nothing is hidden at all", async () => {
    await renderGate("instance.adapters", { status: "ok" });

    expect(container.querySelector('[data-testid="page-content"]')).not.toBeNull();
  });

  it("renders nothing until health is cached", async () => {
    await renderGate("instance.plugins");

    expect(container.querySelector('[data-testid="page-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  });
});
