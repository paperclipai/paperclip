// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

// A tiny external store stands in for the company list query, so a save can
// hand the page a fresh company object the way a real refetch does.
const companyStore = vi.hoisted(() => {
  type Company = Record<string, unknown>;
  const initial: Company = {
    id: "company-1",
    name: "Acme Robotics",
    description: null,
    status: "active",
    issuePrefix: "ACM",
    brandColor: null,
    logoUrl: null,
    attachmentMaxBytes: null,
    requireBoardApprovalForNewAgents: false,
    interactionResolverGovernance: {},
    defaultDecisionOwnerUserId: null,
    budgetOwnerUserId: "user-1",
  };
  let company: Company = initial;
  const listeners = new Set<() => void>();
  return {
    initial,
    get: () => company,
    set(next: Company) {
      company = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/CompanyContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useCompany: () => {
      const company = useSyncExternalStore(companyStore.subscribe, companyStore.get);
      return {
        companies: [company],
        selectedCompany: company,
        selectedCompanyId: company.id,
        setSelectedCompanyId: mockSetSelectedCompanyId,
      };
    },
  };
});

// The governance panel has its own tests; here only its frame matters.
vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => <div data-testid="interaction-governance-panel" />,
  applyGovernanceChange: (governance: unknown) => governance,
}));

// These sections own their own queries (and their own "Save changes").
vi.mock("../components/observability/AgentObservabilitySettings", () => ({
  AgentObservabilitySettingsSection: () => null,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBERS = {
  members: [
    { id: "membership-1", user: { id: "user-1", name: "Ada Lovelace", email: "ada@example.test" } },
    { id: "membership-2", user: { id: "user-2", name: "Grace Hopper", email: "grace@example.test" } },
  ],
};

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
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

describe("CompanySettings Decisions section", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyStore.set({ ...companyStore.initial });
    mockAccessApi.listMembers.mockResolvedValue(MEMBERS);
    // Mirrors the server: the PATCH answers with the updated company, and the
    // refetch then carries it to the page.
    mockCompaniesApi.update.mockImplementation(
      async (_companyId: string, patch: Record<string, unknown>) => {
        await Promise.resolve();
        const next = { ...companyStore.get(), ...patch };
        companyStore.set(next);
        return next;
      },
    );
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // CloudAccessGate owns the health fetch in the app.
    queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: null });
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    // Members fill the pickers before anyone can choose.
    await waitForAssertion(() => {
      expect(getByLabelText("Budget owner").querySelectorAll("option")).toHaveLength(3);
    });
  }

  /** The control a `<label>` with exactly this text names via `htmlFor`. */
  function getByLabelText(text: string): HTMLSelectElement {
    const label = Array.from(container.querySelectorAll("label")).find(
      (element) => element.textContent?.trim() === text,
    );
    expect(label, `label "${text}"`).toBeDefined();
    expect(label!.htmlFor).not.toBe("");
    const control = document.getElementById(label!.htmlFor);
    expect(control).toBeInstanceOf(HTMLSelectElement);
    return control as HTMLSelectElement;
  }

  function changeSelect(select: HTMLSelectElement, value: string) {
    // Go through the native setter so React sees a real change.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    act(() => {
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function typeInto(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function statusFor(select: HTMLSelectElement) {
    return select.parentElement!.querySelector("[role=status]")?.textContent?.trim() ?? "";
  }

  function alertFor(select: HTMLSelectElement) {
    return select.parentElement!.querySelector("[role=alert]")?.textContent?.trim() ?? null;
  }

  function saveChangesButtons() {
    return Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Save changes",
    );
  }

  it("names both owner selects with an associated label", async () => {
    await render();
    const decisionOwner = getByLabelText("Default decision owner");
    const budgetOwner = getByLabelText("Budget owner");

    expect(decisionOwner.dataset.testid).toBe("company-settings-default-decision-owner");
    expect(budgetOwner.dataset.testid).toBe("company-settings-budget-owner");
    expect(Array.from(decisionOwner.labels ?? []).map((label) => label.textContent)).toEqual([
      "Default decision owner",
    ]);
    expect(budgetOwner.value).toBe("user-1");
  });

  it("saves the default decision owner on change with only that field", async () => {
    await render();
    const decisionOwner = getByLabelText("Default decision owner");
    // Nothing is waiting on the page-level save before or after the change.
    expect(saveChangesButtons()).toHaveLength(0);

    changeSelect(decisionOwner, "user-2");

    await waitForAssertion(() => {
      expect(statusFor(getByLabelText("Default decision owner"))).toBe("Saved");
    });
    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", {
      defaultDecisionOwnerUserId: "user-2",
    });
    expect(getByLabelText("Default decision owner").value).toBe("user-2");
    expect(saveChangesButtons()).toHaveLength(0);
  });

  it("clears the budget owner with an explicit null", async () => {
    await render();

    changeSelect(getByLabelText("Budget owner"), "");

    await waitForAssertion(() => {
      expect(statusFor(getByLabelText("Budget owner"))).toBe("Saved");
    });
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { budgetOwnerUserId: null });
    expect(getByLabelText("Budget owner").value).toBe("");
  });

  it("shows the server's rejection and keeps the saved owner", async () => {
    const message = "Budget owner must be an active member of this company";
    mockCompaniesApi.update.mockRejectedValueOnce(
      new ApiError(message, 422, { error: message }),
    );
    await render();

    changeSelect(getByLabelText("Budget owner"), "user-2");

    await waitForAssertion(() => {
      expect(alertFor(getByLabelText("Budget owner"))).toBe(message);
    });
    const budgetOwner = getByLabelText("Budget owner");
    expect(budgetOwner.value).toBe("user-1");
    expect(budgetOwner.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(budgetOwner.getAttribute("aria-describedby")!)?.textContent).toBe(
      message,
    );
  });

  it("keeps an unsaved organization name draft when an owner saves", async () => {
    await render();
    const nameInput = container.querySelector<HTMLInputElement>("input[type=text]")!;
    typeInto(nameInput, "Acme Labs");
    expect(saveChangesButtons()).toHaveLength(1);

    changeSelect(getByLabelText("Default decision owner"), "user-2");

    await waitForAssertion(() => {
      expect(statusFor(getByLabelText("Default decision owner"))).toBe("Saved");
    });
    // The owner PATCH did not carry the draft, and the refetch did not wipe it.
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", {
      defaultDecisionOwnerUserId: "user-2",
    });
    expect(container.querySelector<HTMLInputElement>("input[type=text]")!.value).toBe("Acme Labs");
    expect(saveChangesButtons()).toHaveLength(1);
  });

  it("frames the interaction governance table to the form column", async () => {
    await render();
    const frame = container.querySelector("[data-testid=interaction-governance-panel]")!.parentElement!;
    expect(frame.dataset.testid).toBe("company-settings-interaction-governance-frame");
    expect(frame.className.split(" ")).toEqual(
      expect.arrayContaining(["min-w-0", "max-w-2xl", "overflow-x-auto"]),
    );
  });
});
