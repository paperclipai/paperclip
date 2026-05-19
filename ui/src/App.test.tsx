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

const mockRouterState = vi.hoisted(() => ({
  location: { pathname: "/instance/settings/general", search: "", hash: "" },
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
  useLocation: () => mockRouterState.location,
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
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    mockRouterState.location = { pathname: "/instance/settings/general", search: "", hash: "" };
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

  it("shows recovery guidance when the backend health check fails", async () => {
    mockHealthApi.get.mockRejectedValue(new Error("Failed to load health (500)"));

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

    expect(container.textContent).toContain("Paperclip backend is not ready");
    expect(container.textContent).toContain("重新檢查後端");
    expect(container.textContent).toContain("複製狀態紀錄");
    expect(container.textContent).toContain("可貼回紀錄的狀態摘要");
    expect(container.textContent).toContain("# Paperclip Preview Recovery");
    expect(container.textContent).toContain("先檢查");
    expect(container.textContent).toContain("再重啟");
    expect(container.textContent).toContain("還卡才重開機");
    expect(container.textContent).toContain("現在可以做");
    expect(container.textContent).toContain("先不要做");
    expect(container.textContent).toContain("保存、停用或清理資料");
    expect(container.textContent).toContain("恢復後才繼續");
    expect(container.textContent).toContain("後端 health 回到 status: ok");
    expect(container.textContent).toContain("沒有 postmaster.pid 警告");
    expect(container.textContent).toContain("重要位置");
    expect(container.textContent).toContain("http://localhost:5173/AI/office");
    expect(container.textContent).toContain("http://127.0.0.1:3100/api/health");
    expect(container.textContent).toContain("貼給 Codex 的求助文字");
    expect(container.textContent).toContain("關機前");
    expect(container.textContent).toContain("開機後");
    expect(container.textContent).toContain("先跑 office:check");
    expect(container.textContent).toContain("pnpm run office:check");
    expect(container.textContent).toContain("postmaster.pid");
    expect(container.textContent).toContain("Failed to load health (500)");
    expect(container.textContent).not.toContain("Outlet content");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the Virtual Office recovery title on office routes", async () => {
    mockRouterState.location = { pathname: "/AI/office", search: "", hash: "" };
    mockHealthApi.get.mockRejectedValue(new Error("Failed to load health (500)"));

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

    expect(container.textContent).toContain("Virtual Office 後端還沒準備好");
    expect(container.textContent).toContain("- Route: Virtual Office");
    expect(container.textContent).not.toContain("Paperclip backend is not ready");

    await act(async () => {
      root.unmount();
    });
  });

  it("lets users retry the backend health check from the recovery page", async () => {
    mockHealthApi.get.mockRejectedValue(new Error("Failed to load health (500)"));

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

    const retryButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("重新檢查後端"),
    );
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockHealthApi.get).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
    });
  });

  it("copies the backend recovery report from the recovery page", async () => {
    mockHealthApi.get.mockRejectedValue(new Error("Failed to load health (500)"));

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

    const copyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("複製狀態紀錄"),
    );
    expect(copyButton).toBeTruthy();

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("# Paperclip Preview Recovery"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Help prompt:"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("不要刪資料庫檔案"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:3100/api/health"));
    expect(container.textContent).toContain("已複製");

    await act(async () => {
      root.unmount();
    });
  });
});
