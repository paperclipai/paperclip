// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteLandingPage } from "./InviteLanding";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getHealthMock = vi.fn();
const getSessionMock = vi.fn();
const getInviteMock = vi.fn();
const acceptInviteMock = vi.fn();
const invalidateQueriesMock = vi.fn();

let token = "invite-token";

vi.mock("../api/health", () => ({
  healthApi: {
    get: () => getHealthMock(),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    getInvite: () => getInviteMock(),
    acceptInvite: () => acceptInviteMock(),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    health: ["health"],
    auth: { session: ["auth", "session"] },
    companies: { all: ["companies"] },
    access: { invite: (nextToken: string) => ["invite", nextToken] },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useParams: () => ({ token }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("InviteLandingPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    token = "invite-token";
    getHealthMock.mockResolvedValue({ deploymentMode: "authenticated" });
    getSessionMock.mockResolvedValue(null);
    getInviteMock.mockResolvedValue({
      token: "invite-token",
      companyName: "Paperclip",
      inviteType: "company_join",
      allowedJoinTypes: "both",
      expiresAt: new Date().toISOString(),
    });
    acceptInviteMock.mockResolvedValue({ id: "join-1" });
    invalidateQueriesMock.mockReset();
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
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(invalidateQueriesMock);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <InviteLandingPage />
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

    throw new Error("Timed out waiting for InviteLandingPage to settle");
  }

  it("renders localized invalid token state", async () => {
    token = "";
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("无效的邀请码。") === true);

    expect(container.textContent).toContain("无效的邀请码。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized unavailable state", async () => {
    getInviteMock.mockResolvedValue(null);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("邀请不可用") === true);

    expect(container.textContent).toContain("邀请不可用");
    expect(container.textContent).toContain("此邀请可能已过期、被撤销或已被使用。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized bootstrap success state", async () => {
    getHealthMock.mockResolvedValue({ deploymentMode: "local_trusted" });
    getInviteMock.mockResolvedValue({
      token: "invite-token",
      companyName: null,
      inviteType: "bootstrap_ceo",
      allowedJoinTypes: "human",
      expiresAt: new Date().toISOString(),
    });
    acceptInviteMock.mockResolvedValue({ bootstrapAccepted: true, userId: "user-1" });
    getSessionMock.mockResolvedValue({ id: "user-1" });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("接受引导邀请") === true);
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("接受引导邀请"));
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    await waitFor(() => acceptInviteMock.mock.calls.length > 0 && container.textContent?.includes("引导完成") === true);

    expect(container.textContent).toContain("引导完成");
    expect(container.textContent).toContain("首个实例管理员现已配置完成。你可以继续进入看板。");
    expect(container.textContent).toContain("打开看板");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized join success shells", async () => {
    getHealthMock.mockResolvedValue({ deploymentMode: "local_trusted" });
    getSessionMock.mockResolvedValue({ id: "user-1" });
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("提交加入请求") === true);
    const submit = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("提交加入请求"));
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitFor(() => acceptInviteMock.mock.calls.length > 0 && container.textContent?.includes("加入请求已提交") === true);

    expect(container.textContent).toContain("加入请求已提交");
    expect(container.textContent).toContain("你的请求正在等待管理员批准。在批准之前你将无法访问。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized join form labels and sign-in prompt", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("以 人类 身份加入") === true);

    expect(container.textContent).toContain("以 人类 身份加入");
    expect(container.textContent).toContain("以 智能体 身份加入");

    const agentJoinButton = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("以 智能体 身份加入"));
    await act(async () => {
      agentJoinButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("智能体名称") === true);

    expect(container.textContent).toContain("智能体名称");
    expect(container.textContent).toContain("适配器类型");
    expect(container.textContent).toContain("能力（可选）");
    expect(container.textContent).not.toContain("登录 / 创建账号");

    await act(async () => {
      root.unmount();
    });
  });
});
