// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act as reactAct } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { Companies } from "./Companies";
import { setLocale } from "../i18n";

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
        createdAt: "2026-09-01T12:00:00.000Z",
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
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

  beforeEach(() => {
    setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.stats.mockResolvedValue({});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    setLocale("en");
  });

  async function renderPage({ cloud }: { cloud?: boolean } = {}) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (cloud) queryClient.setQueryData(queryKeys.health, CLOUD_HEALTH);
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

  it("offers the company wizard when self-hosted", async () => {
    const root = await renderPage();

    expect(container.textContent).toContain("New Organization");

    act(() => {
      root.unmount();
    });
  });

  it.each([
    [1, "1 агент", "1 задача"], [2, "2 агента", "2 задачи"],
    [5, "5 агентов", "5 задач"], [21, "21 агент", "21 задача"],
    [22, "22 агента", "22 задачи"], [25, "25 агентов", "25 задач"],
  ])("retranslates organization counts (%i) without altering data", async (count, agents, tasks) => {
    mockCompaniesApi.stats.mockResolvedValue({ "company-1": { agentCount: count, issueCount: count } });
    const root = await renderPage();
    await reactAct(async () => setLocale("ru"));
    expect(container.textContent).toContain(agents);
    expect(container.textContent).toContain(tasks);
    expect(container.textContent).toContain("Acme Labs");
    expect(container.textContent).toContain("активна");
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
    expect(mockCompaniesApi.remove).not.toHaveBeenCalled();
    await reactAct(async () => setLocale("en"));
    expect(container.textContent).toContain(`${count} ${count === 1 ? "agent" : "agents"}`);
    act(() => root.unmount());
  });

  it("keeps an organization rename draft across EN/RU and sends the original name", async () => {
    mockCompaniesApi.update.mockResolvedValue({});
    const root = await renderPage();
    await reactAct(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!.click());
    const input = container.querySelector<HTMLInputElement>("input")!;
    await reactAct(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Моя команда / Acme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await reactAct(async () => setLocale("ru"));
    expect(input.value).toBe("Моя команда / Acme");
    expect(input.getAttribute("aria-label")).toBe("Название организации");
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
    await reactAct(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Сохранить"]')!.click());
    expect(mockCompaniesApi.update).toHaveBeenCalledExactlyOnceWith("company-1", { name: "Моя команда / Acme" });
    await reactAct(async () => root.unmount());
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
