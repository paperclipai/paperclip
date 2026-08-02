// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatRedesignGate } from "./TaskChatRedesignGate";
import { useTaskChatRedesignEnabled } from "@/hooks/useTaskChatRedesignEnabled";

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
  Outlet: () => <div data-testid="outlet">gated content</div>,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("TaskChatRedesignGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderGate() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TaskChatRedesignGate />
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

  it("redirects to the company home when the flag is off (flag-off isolation)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableTaskChatRedesign: false });
    await renderGate();
    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-to")).toBe("/dashboard");
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
  });

  it("renders the gated harness when the flag is on", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableTaskChatRedesign: true });
    await renderGate();
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  });
});

describe("useTaskChatRedesignEnabled", () => {
  it("resolves to flag-off when rendered without a QueryClientProvider", () => {
    // Rendered detached (no provider) it must default OFF and loaded — this is
    // what makes flag-off the provable current behavior at every call site.
    let captured: { enabled: boolean; loaded: boolean } | null = null;
    function Probe() {
      captured = useTaskChatRedesignEnabled();
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() => root.render(<Probe />));
    flushSync(() => root.unmount());
    expect(captured).toEqual({ enabled: false, loaded: true });
  });
});
