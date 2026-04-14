// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardClaimPage } from "./BoardClaim";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getSessionMock = vi.fn();
const getBoardClaimStatusMock = vi.fn();
const claimBoardMock = vi.fn();

let token = "claim-token";
let code = "challenge-code";

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    getBoardClaimStatus: () => getBoardClaimStatusMock(),
    claimBoard: () => claimBoardMock(),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    auth: { session: ["auth", "session"] },
    health: ["health"],
    companies: { all: ["companies"], stats: ["companies", "stats"] },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useParams: () => ({ token }),
  useSearchParams: () => [{ get: (key: string) => (key === "code" ? code : null) }],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BoardClaimPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    token = "claim-token";
    code = "challenge-code";
    getSessionMock.mockResolvedValue(null);
    getBoardClaimStatusMock.mockResolvedValue({
      status: "available",
      requiresSignIn: true,
      expiresAt: null,
      claimedByUserId: null,
    });
    claimBoardMock.mockResolvedValue({ claimed: true, userId: "user-1" });
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <BoardClaimPage />
          </I18nProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    return root;
  }

  async function waitFor(condition: () => boolean, attempts = 10) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    throw new Error("Timed out waiting for BoardClaimPage to settle");
  }

  it("renders localized invalid URL state", async () => {
    token = "";
    code = "";
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("无效的看板认领链接。") === true);

    expect(container.textContent).toContain("无效的看板认领链接。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized sign-in required state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("需要先登录") === true);

    expect(container.textContent).toContain("需要先登录");
    expect(container.textContent).toContain("请先登录或创建账号，然后返回此页面认领看板所有权。");
    expect(container.textContent).toContain("登录 / 创建账号");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized available claim state and triggers claim action", async () => {
    getBoardClaimStatusMock.mockResolvedValue({
      status: "available",
      requiresSignIn: false,
      expiresAt: null,
      claimedByUserId: null,
    });
    getSessionMock.mockResolvedValue({ id: "user-1" });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("认领看板所有权") === true);

    expect(container.textContent).toContain("认领看板所有权");
    expect(container.textContent).toContain("这将把你的用户提升为实例管理员，并把公司所有权访问从 local trusted 模式迁移过来。");
    expect(container.textContent).toContain("认领所有权");

    const claimButton = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("认领所有权"));
    expect(claimButton).toBeTruthy();

    await act(async () => {
      claimButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(claimBoardMock).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized claimed state", async () => {
    getBoardClaimStatusMock.mockResolvedValue({
      status: "claimed",
      requiresSignIn: false,
      expiresAt: null,
      claimedByUserId: "user-1",
    });
    getSessionMock.mockResolvedValue({ id: "user-1" });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("看板所有权已认领") === true);

    expect(container.textContent).toContain("看板所有权已认领");
    expect(container.textContent).toContain("此实例现已关联到你当前登录的用户。");
    expect(container.textContent).toContain("打开看板");

    await act(async () => {
      root.unmount();
    });
  });
});
