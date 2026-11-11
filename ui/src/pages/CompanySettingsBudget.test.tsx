// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

const SELECTED_COMPANY = {
  id: "company-1",
  name: "Acme Robotics",
  description: null,
  status: "active",
  issuePrefix: "ACM",
  brandColor: null,
  logoUrl: null,
  attachmentMaxBytes: null,
  budgetMonthlyCents: 120_000,
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
};

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [SELECTED_COMPANY],
    selectedCompany: SELECTED_COMPANY,
    selectedCompanyId: SELECTED_COMPANY.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (governance: unknown) => governance,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SELF_HOSTED_HEALTH = { status: "ok" as const, cloud: null };

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("CompanySettings monthly budget", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.update.mockResolvedValue(SELECTED_COMPANY);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, SELF_HOSTED_HEALTH);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  function budgetInput() {
    return container.querySelector<HTMLInputElement>(
      "[data-testid=company-settings-budget-input]",
    );
  }

  function typeBudget(value: string) {
    const input = budgetInput();
    expect(input).toBeTruthy();
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function saveButton() {
    return Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === "Save changes",
    );
  }

  function clickSave() {
    const button = saveButton();
    expect(button).toBeDefined();
    flushSync(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("shows the stored budget in dollars", () => {
    const root = render();
    expect(budgetInput()?.value).toBe("1200");
    flushSync(() => root.unmount());
  });

  it("saves the budget as cents", async () => {
    const root = render();
    typeBudget("2500");
    clickSave();

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalledWith(SELECTED_COMPANY.id, {
        name: SELECTED_COMPANY.name,
        description: null,
        budgetMonthlyCents: 250_000,
      });
    });
    flushSync(() => root.unmount());
  });

  it("saves a cleared budget as no limit", async () => {
    const root = render();
    typeBudget("");
    clickSave();

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalledWith(SELECTED_COMPANY.id, {
        name: SELECTED_COMPANY.name,
        description: null,
        budgetMonthlyCents: 0,
      });
    });
    flushSync(() => root.unmount());
  });

  it("blocks the save while the budget is not a usable amount", () => {
    const root = render();
    typeBudget("-5");
    expect(saveButton()?.hasAttribute("disabled")).toBe(true);
    flushSync(() => root.unmount());
  });

  it("blocks the save on a partial number rather than clearing the limit", () => {
    const root = render();
    typeBudget("1e");
    expect(saveButton()?.hasAttribute("disabled")).toBe(true);
    flushSync(() => root.unmount());
  });

  it("blocks the save on an amount the budget column cannot hold", () => {
    const root = render();
    typeBudget("25000000");
    expect(saveButton()?.hasAttribute("disabled")).toBe(true);
    flushSync(() => root.unmount());
  });

  it("keeps the save hidden until the budget changes", () => {
    const root = render();
    expect(saveButton()).toBeUndefined();
    flushSync(() => root.unmount());
  });

  it("omits the budget when only the name changes", async () => {
    const root = render();
    const nameInput = container.querySelector<HTMLInputElement>("input[type=text]");
    expect(nameInput).toBeTruthy();
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(nameInput, "Acme Robotics Ltd");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickSave();

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalledWith(SELECTED_COMPANY.id, {
        name: "Acme Robotics Ltd",
        description: null,
      });
    });
    flushSync(() => root.unmount());
  });

  it("refreshes the budget views after saving the budget", async () => {
    const root = render();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    typeBudget("2500");
    clickSave();

    await waitForAssertion(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.budgets.overview(SELECTED_COMPANY.id),
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.dashboard(SELECTED_COMPANY.id),
      });
    });
    flushSync(() => root.unmount());
  });

  it("leaves the budget views alone when only the name changes", async () => {
    const root = render();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const nameInput = container.querySelector<HTMLInputElement>("input[type=text]");
    expect(nameInput).toBeTruthy();
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(nameInput, "Acme Robotics Ltd");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickSave();

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalled();
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.budgets.overview(SELECTED_COMPANY.id),
    });
    flushSync(() => root.unmount());
  });
});
