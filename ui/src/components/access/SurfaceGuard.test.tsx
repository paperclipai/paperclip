// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));

import { SurfaceGuard } from "./SurfaceGuard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("SurfaceGuard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderGuard() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SurfaceGuard surface="company.members">
            <div>page</div>
          </SurfaceGuard>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("renders children when the surface is exposed", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(buildCurrentBoardAccess({}));
    const root = await renderGuard();
    expect(container.textContent).toContain("page");
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("redirects to the settings root when the surface is hidden", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({ exposedSurfaces: [] }),
    );
    const root = await renderGuard();
    expect(container.textContent).toContain("/company/settings");
    expect(container.textContent).not.toContain("page");
    await act(async () => root.unmount());
  });

  it("renders children while capabilities are unavailable (server enforces)", async () => {
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("offline"));
    const root = await renderGuard();
    expect(container.textContent).toContain("page");
    await act(async () => root.unmount());
  });
});
