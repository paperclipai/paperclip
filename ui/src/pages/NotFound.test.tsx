// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundPage } from "./NotFound";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const setBreadcrumbsMock = vi.fn();

let pathname = "/missing";
let search = "";
let hash = "";
let companies: Array<{ issuePrefix: string }> = [];
let selectedCompany: { issuePrefix: string } | null = null;

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useLocation: () => ({ pathname, search, hash }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies, selectedCompany }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("NotFoundPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    pathname = "/missing";
    search = "";
    hash = "";
    companies = [];
    selectedCompany = null;
    setBreadcrumbsMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage(props?: { scope?: "board" | "invalid_company_prefix" | "global"; requestedPrefix?: string }) {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <NotFoundPage {...props} />
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

    throw new Error("Timed out waiting for NotFoundPage to settle");
  }

  it("renders localized global not-found state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("未找到页面") === true);

    expect(container.textContent).toContain("未找到页面");
    expect(container.textContent).toContain("此路由不存在。");
    expect(container.textContent).toContain("请求路径");
    expect(container.textContent).toContain("打开仪表盘");
    expect(container.textContent).toContain("返回首页");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "未找到" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized invalid company prefix state", async () => {
    pathname = "/ABC/missing";
    search = "?foo=1";
    hash = "#frag";
    selectedCompany = { issuePrefix: "pc" };
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage({ scope: "invalid_company_prefix", requestedPrefix: "abc" });

    await waitFor(() => container.textContent?.includes("未找到公司") === true);

    expect(container.textContent).toContain("未找到公司");
    expect(container.textContent).toContain("没有公司匹配前缀 \"ABC\"。");
    expect(container.textContent).toContain("/ABC/missing?foo=1#frag");
    expect(container.innerHTML).toContain("href=\"/pc/dashboard\"");

    await act(async () => {
      root.unmount();
    });
  });
});
