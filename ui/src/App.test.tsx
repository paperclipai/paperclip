// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAccessGate } from "./components/CloudAccessGate";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

vi.mock("./api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("./api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("./api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
  Outlet: () => <div>Outlet content</div>,
  Route: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Routes: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLocation: () => ({ pathname: "/instance/settings/general", search: "", hash: "" }),
  useParams: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CloudAccessGate", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows a no-access message for signed-in users without org access", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No company access");
    expect(container.textContent).not.toContain("Outlet content");

    await act(async () => {
      root.unmount();
    });
  });

  it("allows authenticated users with company access through to the board", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Outlet content");
    expect(container.textContent).not.toContain("No company access");

    await act(async () => {
      root.unmount();
    });
  });
});
