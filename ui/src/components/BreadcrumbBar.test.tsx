// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";

const navigateState = vi.hoisted(() => ({
  fn: vi.fn(),
}));

const breadcrumbsState = vi.hoisted(() => ({
  breadcrumbs: [] as Array<{ label: string; href?: string }>,
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: true,
  toggleSidebar: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: null as string | null,
  selectedCompany: null as {
    issuePrefix: string;
    status: "active" | "paused" | "archived";
    pauseReason?: string | null;
  } | null,
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockCompaniesApi = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateState.fn,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
  usePluginLaunchers: () => ({ launchers: [] }),
}));

vi.mock("./CompanyRuntimeButton", () => ({
  CompanyRuntimeButton: () => <div>Runtime</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderBreadcrumbBar(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BreadcrumbBar />
      </QueryClientProvider>,
    );
  });

  return { root };
}

describe("BreadcrumbBar mobile navigation", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    navigateState.fn.mockReset();
    sidebarState.toggleSidebar.mockReset();
    toastState.pushToast.mockReset();
    mockCompaniesApi.pause.mockReset();
    mockCompaniesApi.resume.mockReset();
    breadcrumbsState.breadcrumbs = [];
    sidebarState.isMobile = true;
    companyState.selectedCompanyId = null;
    companyState.selectedCompany = null;
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a mobile back button to the nearest breadcrumb target", () => {
    breadcrumbsState.breadcrumbs = [
      { label: "Agents", href: "/agents" },
      { label: "Platform Engineer" },
    ];

    const { root } = renderBreadcrumbBar(container);

    const backButton = container.querySelector('button[aria-label="Back to Agents"]') as HTMLButtonElement | null;
    expect(backButton).not.toBeNull();

    act(() => {
      backButton?.click();
    });

    expect(navigateState.fn).toHaveBeenCalledWith("/agents");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the sidebar menu button on top-level mobile pages", () => {
    breadcrumbsState.breadcrumbs = [{ label: "Dashboard" }];

    const { root } = renderBreadcrumbBar(container);

    const menuButton = container.querySelector('button[aria-label="Open sidebar"]') as HTMLButtonElement | null;
    expect(menuButton).not.toBeNull();

    act(() => {
      menuButton?.click();
    });

    expect(sidebarState.toggleSidebar).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
