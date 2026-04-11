// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSidebar } from "./InstanceSidebar";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    list: vi.fn(),
  },
}));

vi.mock("@/lib/queryKeys", () => ({
  queryKeys: {
    plugins: { all: ["plugins", "all"] },
  },
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("InstanceSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("renders localized sidebar labels", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <InstanceSidebar />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("实例设置");
    expect(container.textContent).toContain("通用");
    expect(container.textContent).toContain("心跳");
    expect(container.textContent).toContain("实验功能");

    await act(async () => {
      root.unmount();
    });
  });
});
