// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act as reactAct } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "../api/client";
import type { HealthStatus } from "../api/health";
import { Companies } from "./Companies";

const mockCompaniesApi = vi.hoisted(() => ({
  stats: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const mockOpenOnboarding = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: "company-1",
        issuePrefix: "PAP",
        name: "Acme Labs",
        status: "active",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
      },
    ],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: mockOpenOnboarding }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  reactAct(() => flushSync(callback));
}

async function flushReact() {
  await reactAct(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const CLOUD_HEALTH = {
  status: "ok" as const,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme-labs",
    cloudBaseUrl: "https://cloud.example.test",
  },
};

describe("Companies page", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.stats.mockResolvedValue({});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage({ cloud, health }: { cloud?: boolean; health?: HealthStatus } = {}) {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (cloud) queryClient.setQueryData(queryKeys.health, CLOUD_HEALTH);
    if (health) queryClient.setQueryData(queryKeys.health, health);
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Companies />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  async function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(button, `button ${label}`).toBeDefined();
    act(() => button!.click());
    await flushReact();
    await flushReact();
  }

  it.each([
    undefined,
    { status: "ok" as const },
    { status: "ok" as const, features: { companyDeletionEnabled: false } },
  ])("hides deletion without an explicit health feature grant: %j", async (health) => {
    const root = await renderPage({ health });
    expect(container.textContent).not.toContain("Delete Organization");
    expect(mockCompaniesApi.remove).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("deletes when enabled and closes the confirmation after success", async () => {
    mockCompaniesApi.remove.mockResolvedValue({ ok: true });
    const root = await renderPage({ health: { status: "ok", features: { companyDeletionEnabled: true } } });
    await clickButton("Delete Organization");
    await clickButton("Delete");
    expect(mockCompaniesApi.remove).toHaveBeenCalledWith("company-1");
    expect(container.textContent).not.toContain("This cannot be undone.");
    act(() => root.unmount());
  });

  it("hides deletion after a failed health refresh even with a cached grant", async () => {
    const root = await renderPage({ health: { status: "ok", features: { companyDeletionEnabled: true } } });
    act(() => {
      queryClient.getQueryCache().find({ queryKey: queryKeys.health })!.setState({
        status: "error", error: new Error("Health unavailable"),
      });
    });
    await flushReact();
    expect(container.textContent).not.toContain("Delete Organization");
    expect(mockCompaniesApi.remove).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("shows an unexpected 403 and clears it when a new confirmation is opened", async () => {
    mockCompaniesApi.remove.mockRejectedValue(new ApiError("Company deletion is disabled", 403, {}));
    const root = await renderPage({ health: { status: "ok", features: { companyDeletionEnabled: true } } });
    await clickButton("Delete Organization");
    await clickButton("Delete");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Company deletion is disabled");
    expect(container.textContent).toContain("This cannot be undone.");
    await clickButton("Cancel");
    await clickButton("Delete Organization");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    act(() => root.unmount());
  });

  it("removes an open deletion confirmation when the health feature is disabled", async () => {
    const root = await renderPage({ health: { status: "ok", features: { companyDeletionEnabled: true } } });
    await clickButton("Delete Organization");
    act(() => {
      queryClient.setQueryData(queryKeys.health, { status: "ok", features: { companyDeletionEnabled: false } });
    });
    await flushReact();
    await flushReact();
    expect(container.textContent).not.toContain("Delete Organization");
    expect(container.textContent).not.toContain("This cannot be undone.");
    expect(mockCompaniesApi.remove).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("keeps an in-flight deletion observed when its menu item is clicked again", async () => {
    let rejectDeletion!: (reason: ApiError) => void;
    mockCompaniesApi.remove.mockReturnValue(new Promise((_resolve, reject) => { rejectDeletion = reject; }));
    const root = await renderPage({ health: { status: "ok", features: { companyDeletionEnabled: true } } });
    await clickButton("Delete Organization");
    await clickButton("Delete");
    await clickButton("Delete Organization");
    act(() => rejectDeletion(new ApiError("Company deletion is disabled", 403, {})));
    await flushReact();
    await flushReact();
    expect(mockCompaniesApi.remove).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Company deletion is disabled");
    act(() => root.unmount());
  });

  it.each(["disabled", "unavailable"])("keeps a pending rejection visible when health becomes %s", async (healthState) => {
    let rejectDeletion!: (reason: ApiError) => void;
    mockCompaniesApi.remove.mockReturnValue(new Promise((_resolve, reject) => { rejectDeletion = reject; }));
    const root = await renderPage({ health: { status: "ok", features: { companyDeletionEnabled: true } } });
    await clickButton("Delete Organization");
    await clickButton("Delete");
    act(() => {
      if (healthState === "disabled") {
        queryClient.setQueryData(queryKeys.health, { status: "ok", features: { companyDeletionEnabled: false } });
      } else {
        queryClient.getQueryCache().find({ queryKey: queryKeys.health })!.setState({
          status: "error", error: new Error("Health unavailable"),
        });
      }
    });
    await flushReact();
    act(() => rejectDeletion(new ApiError("Company deletion is disabled", 403, {})));
    await flushReact();
    await flushReact();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Company deletion is disabled");
    expect(container.textContent).not.toContain("Delete Organization");
    const deleteButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Delete");
    expect(deleteButton?.disabled).toBe(true);
    await clickButton("Delete");
    expect(mockCompaniesApi.remove).toHaveBeenCalledTimes(1);
    await clickButton("Cancel");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    act(() => root.unmount());
  });

  it("offers the company wizard when self-hosted", async () => {
    const root = await renderPage();

    expect(container.textContent).toContain("New Organization");

    act(() => {
      root.unmount();
    });
  });

  it("hides the company wizard on a cloud-managed instance", async () => {
    const root = await renderPage({ cloud: true });

    // Cloud stacks hold exactly one company and POST /companies is a 403 floor,
    // so the entry point must not be offered at all.
    expect(container.textContent).not.toContain("New Organization");
    expect(container.textContent).toContain("Acme Labs");
    expect(mockOpenOnboarding).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
