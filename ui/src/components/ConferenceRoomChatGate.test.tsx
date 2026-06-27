// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConferenceRoomChatGate } from "./ConferenceRoomChatGate";

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

describe("ConferenceRoomChatGate (PAP-137)", () => {
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
          <ConferenceRoomChatGate />
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

  it("redirects to the company home when the flag is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    await renderGate();

    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-to")).toBe("/dashboard");
    expect(navigate?.getAttribute("data-replace")).toBe("true");
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
  });

  it("renders the gated routes when the flag is on", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    await renderGate();

    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  });

  it("renders nothing (no premature redirect) while the flag is loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    await renderGate();

    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
  });
});
