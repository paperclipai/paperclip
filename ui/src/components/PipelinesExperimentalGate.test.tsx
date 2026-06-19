// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelinesExperimentalGate } from "./PipelinesExperimentalGate";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("PipelinesExperimentalGate", () => {
  let container: HTMLDivElement;

  async function renderGate() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PipelinesExperimentalGate>
            <div>Pipeline route content</div>
          </PipelinesExperimentalGate>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("blocks pipeline route content when the experimental flag is disabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enablePipelines: false });
    const root = await renderGate();

    expect(container.textContent).toContain("Pipelines are disabled");
    expect(container.textContent).toContain("Instance Settings");
    expect(container.textContent).not.toContain("Pipeline route content");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/company/settings/instance/experimental");

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders pipeline route content when the experimental flag is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enablePipelines: true });
    const root = await renderGate();

    expect(container.textContent).toContain("Pipeline route content");
    expect(container.textContent).not.toContain("Pipelines are disabled");

    flushSync(() => {
      root.unmount();
    });
  });
});
