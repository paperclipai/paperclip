// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getSessionMock = vi.fn();
const signInEmailMock = vi.fn();
const signUpEmailMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const navigateMock = vi.fn();

let nextPath = "/";

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInEmail: (payload: unknown) => signInEmailMock(payload),
    signUpEmail: (payload: unknown) => signUpEmailMock(payload),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    auth: { session: ["auth", "session"] },
    companies: { all: ["companies"] },
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [{ get: (key: string) => (key === "next" ? nextPath : null) }],
}));

vi.mock("@/components/AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => <div>ascii-art</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AuthPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    nextPath = "/";
    getSessionMock.mockResolvedValue(null);
    signInEmailMock.mockResolvedValue(undefined);
    signUpEmailMock.mockResolvedValue(undefined);
    invalidateQueriesMock.mockReset();
    navigateMock.mockReset();
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
            <AuthPage />
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

    throw new Error("Timed out waiting for AuthPage to settle");
  }

  it("renders localized loading state", async () => {
    getSessionMock.mockImplementation(() => new Promise(() => {}));
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    expect(container.textContent).toContain("加载中…");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized sign-in state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("登录到 Paperclip") === true);

    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("登录到 Paperclip");
    expect(container.textContent).toContain("使用你的邮箱和密码访问此实例。");
    expect(container.textContent).toContain("邮箱");
    expect(container.textContent).toContain("密码");
    expect(container.textContent).toContain("登录");
    expect(container.textContent).toContain("还没有账号？");
    expect(container.textContent).toContain("创建一个");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized sign-up state after toggle", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("创建一个") === true);

    const toggleButton = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("创建一个"));
    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("创建你的 Paperclip 账号") === true);

    expect(container.textContent).toContain("创建你的 Paperclip 账号");
    expect(container.textContent).toContain("为此实例创建账号。v1 不要求邮箱确认。");
    expect(container.textContent).toContain("姓名");
    expect(container.textContent).toContain("创建账号");
    expect(container.textContent).toContain("已经有账号了？");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized required fields validation", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("登录到 Paperclip") === true);

    const submitButton = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("登录"));
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("请填写所有必填字段。") === true);

    expect(container.textContent).toContain("请填写所有必填字段。");

    await act(async () => {
      root.unmount();
    });
  });
});
