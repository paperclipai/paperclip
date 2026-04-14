// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Projects } from "./Projects";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listProjectsMock = vi.fn();
const openNewProjectMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

let selectedCompanyId: string | null = "company-1";

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: () => listProjectsMock(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewProject: openNewProjectMock }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    projects: {
      list: (companyId: string) => ["projects", companyId],
    },
  },
}));

vi.mock("../components/EntityRow", () => ({
  EntityRow: ({ title }: { title: string }) => <div>{title}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Projects", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    listProjectsMock.mockResolvedValue([]);
    openNewProjectMock.mockReset();
    setBreadcrumbsMock.mockReset();
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
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <Projects />
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

    throw new Error("Timed out waiting for Projects to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看项目。") === true);

    expect(container.textContent).toContain("选择一个公司以查看项目。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([{ label: "项目" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized empty state when no projects exist", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("暂无项目。") === true);

    expect(container.textContent).toContain("暂无项目。");
    expect(container.textContent).toContain("添加项目");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized action when projects exist", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    listProjectsMock.mockResolvedValue([
      { id: "project-1", name: "Ship localization", archivedAt: null },
    ]);
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Ship localization") === true);

    expect(container.textContent).toContain("添加项目");
    expect(container.textContent).toContain("Ship localization");

    await act(async () => {
      root.unmount();
    });
  });
});
