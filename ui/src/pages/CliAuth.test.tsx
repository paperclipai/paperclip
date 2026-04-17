// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliAuthPage } from "./CliAuth";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getSessionMock = vi.fn();
const getCliAuthChallengeMock = vi.fn();
const approveCliAuthChallengeMock = vi.fn();
const cancelCliAuthChallengeMock = vi.fn();

let challengeId = "challenge-1";
let token = "secret-token";

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    getCliAuthChallenge: () => getCliAuthChallengeMock(),
    approveCliAuthChallenge: () => approveCliAuthChallengeMock(),
    cancelCliAuthChallenge: () => cancelCliAuthChallengeMock(),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    auth: { session: ["auth", "session"] },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useParams: () => ({ id: challengeId }),
  useSearchParams: () => [{ get: (key: string) => (key === "token" ? token : null) }],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CliAuthPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    challengeId = "challenge-1";
    token = "secret-token";
    getSessionMock.mockResolvedValue(null);
    getCliAuthChallengeMock.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "paperclip auth",
      clientName: null,
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: new Date().toISOString(),
      approvedByUser: null,
      requiresSignIn: true,
      canApprove: false,
      currentUserId: null,
    });
    approveCliAuthChallengeMock.mockResolvedValue({ approved: true, status: "approved" });
    cancelCliAuthChallengeMock.mockResolvedValue({ cancelled: true, status: "cancelled" });
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
            <CliAuthPage />
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

    throw new Error("Timed out waiting for CliAuthPage to settle");
  }

  it("renders localized invalid URL state", async () => {
    challengeId = "";
    token = "";
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("无效的 CLI 认证链接。") === true);

    expect(container.textContent).toContain("无效的 CLI 认证链接。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized sign-in required state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("需要先登录") === true);

    expect(container.textContent).toContain("需要先登录");
    expect(container.textContent).toContain("请先登录或创建账号，然后返回此页面批准 CLI 访问请求。");
    expect(container.textContent).toContain("登录 / 创建账号");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized approved state", async () => {
    getCliAuthChallengeMock.mockResolvedValue({
      id: "challenge-1",
      status: "approved",
      command: "paperclip auth",
      clientName: null,
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: new Date().toISOString(),
      cancelledAt: null,
      expiresAt: new Date().toISOString(),
      approvedByUser: null,
      requiresSignIn: false,
      canApprove: true,
      currentUserId: "user-1",
    });
    getSessionMock.mockResolvedValue({ id: "user-1" });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("CLI 访问已批准") === true);

    expect(container.textContent).toContain("CLI 访问已批准");
    expect(container.textContent).toContain("Paperclip CLI 现在可以在发起请求的机器上完成认证。");
    expect(container.textContent).toContain("命令");
    expect(container.textContent).toContain("paperclip auth");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized expired state", async () => {
    getCliAuthChallengeMock.mockResolvedValue({
      id: "challenge-1",
      status: "expired",
      command: "paperclip auth",
      clientName: null,
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: new Date().toISOString(),
      approvedByUser: null,
      requiresSignIn: false,
      canApprove: false,
      currentUserId: "user-1",
    });
    getSessionMock.mockResolvedValue({ id: "user-1" });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("CLI 认证挑战已过期") === true);

    expect(container.textContent).toContain("CLI 认证挑战已过期");
    expect(container.textContent).toContain("请从终端重新发起 CLI 认证流程以生成新的批准请求。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized challenge details", async () => {
    getCliAuthChallengeMock.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "paperclip auth",
      clientName: null,
      requestedAccess: "instance_admin_required",
      requestedCompanyId: "company-1",
      requestedCompanyName: "Paperclip",
      approvedAt: null,
      cancelledAt: null,
      expiresAt: new Date().toISOString(),
      approvedByUser: null,
      requiresSignIn: false,
      canApprove: false,
      currentUserId: "user-1",
    });
    getSessionMock.mockResolvedValue({ id: "user-1" });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("批准 Paperclip CLI 访问") === true);

    expect(container.textContent).toContain("批准 Paperclip CLI 访问");
    expect(container.textContent).toContain("命令");
    expect(container.textContent).toContain("客户端");
    expect(container.textContent).toContain("请求的访问权限");
    expect(container.textContent).toContain("实例管理员");
    expect(container.textContent).toContain("请求的公司");
    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("此挑战需要实例管理员权限。请使用实例管理员账号登录后再批准。");
    expect(container.textContent).toContain("批准 CLI 访问");
    expect(container.textContent).toContain("取消");

    await act(async () => {
      root.unmount();
    });
  });
});
