// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  putDefaultExecutionPolicy: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

const baseCompany: Company = {
  id: "company-1",
  name: "Paperclip",
  description: "Original description",
  logoUrl: null,
  issuePrefix: "PAP",
  status: "active",
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
  defaultExecutionPolicy: null,
} as unknown as Company;

let selectedCompany: Company = baseCompany;

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../hooks/useCloudInstance", () => ({
  useCloudInstance: () => null,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [selectedCompany],
    selectedCompany,
    selectedCompanyId: selectedCompany.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (current: unknown) => current,
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => null,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function getNameInput(container: HTMLElement): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (el) => el.textContent?.trim() === "Organization name",
  );
  const input = label?.parentElement?.parentElement?.querySelector("input");
  if (!input) throw new Error("Organization name input not found");
  return input as HTMLInputElement;
}

function getDescriptionInput(container: HTMLElement): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (el) => el.textContent?.trim() === "Description",
  );
  const input = label?.parentElement?.parentElement?.querySelector("input");
  if (!input) throw new Error("Description input not found");
  return input as HTMLInputElement;
}

function getPolicyTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector(
    "[data-testid='company-settings-default-execution-policy-textarea']",
  );
  if (!textarea) throw new Error("Policy textarea not found");
  return textarea as HTMLTextAreaElement;
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CompanySettings default execution policy draft", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let CompanySettings: Awaited<typeof import("./CompanySettings")>["CompanySettings"];

  async function renderApp() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/company/settings"]}>
            <TooltipProvider>
              <CompanySettings />
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(async () => {
    selectedCompany = { ...baseCompany };
    mockCompaniesApi.update.mockReset();
    mockCompaniesApi.putDefaultExecutionPolicy.mockReset();
    mockCompaniesApi.update.mockResolvedValue(selectedCompany);

    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    ({ CompanySettings } = await import("./CompanySettings"));

    root = createRoot(container);
    await renderApp();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("does not discard an unsaved organization name edit when the policy textarea is typed in", async () => {
    const nameInput = getNameInput(container);
    setInputValue(nameInput, "Renamed Co");
    await flushReact();
    expect(nameInput.value).toBe("Renamed Co");

    const policyTextarea = getPolicyTextarea(container);
    setInputValue(policyTextarea, "{");
    await flushReact();

    expect(getNameInput(container).value).toBe("Renamed Co");
  });

  it("does not discard an unsaved organization name edit when an unrelated refetch replaces selectedCompany with a new, unchanged-looking object", async () => {
    const nameInput = getNameInput(container);
    setInputValue(nameInput, "Renamed Co");
    await flushReact();
    expect(nameInput.value).toBe("Renamed Co");

    selectedCompany = { ...baseCompany };
    await renderApp();

    expect(getNameInput(container).value).toBe("Renamed Co");
  });

  it("does not clobber a newer policy draft with an in-flight save's stale result", async () => {
    let resolveSave: (value: { defaultExecutionPolicy: Company["defaultExecutionPolicy"] }) => void = () => {};
    mockCompaniesApi.putDefaultExecutionPolicy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const policyTextarea = getPolicyTextarea(container);
    setInputValue(policyTextarea, '{"stages":[]}');
    await flushReact();

    const saveButton = container.querySelector(
      "[data-testid='company-settings-default-execution-policy-save']",
    ) as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    setInputValue(getPolicyTextarea(container), '{"stages":[],"maxReviewRounds":2}');
    await flushReact();

    await act(async () => {
      resolveSave({ defaultExecutionPolicy: { stages: [] } as unknown as Company["defaultExecutionPolicy"] });
    });
    await flushReact();
    await flushReact();

    expect(getPolicyTextarea(container).value).toBe('{"stages":[],"maxReviewRounds":2}');
  });

  it("does not label a newer unsaved edit as Saved once an earlier in-flight save resolves", async () => {
    let resolveSave: (value: { defaultExecutionPolicy: Company["defaultExecutionPolicy"] }) => void = () => {};
    mockCompaniesApi.putDefaultExecutionPolicy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    setInputValue(getPolicyTextarea(container), '{"stages":[]}');
    await flushReact();

    const saveButton = container.querySelector(
      "[data-testid='company-settings-default-execution-policy-save']",
    ) as HTMLButtonElement | null;
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    setInputValue(getPolicyTextarea(container), '{"stages":[],"maxReviewRounds":2}');
    await flushReact();

    await act(async () => {
      resolveSave({ defaultExecutionPolicy: { stages: [] } as unknown as Company["defaultExecutionPolicy"] });
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Saved");
    expect(saveButton!.textContent).toBe("Save changes");
  });

  it("still clears the dirty flag after a successful save when the companies-stats cache holds a non-list shape", async () => {
    const { queryKeys } = await import("../lib/queryKeys");
    queryClient.setQueryData(queryKeys.companies.stats, { totalCompanies: 1 });

    mockCompaniesApi.putDefaultExecutionPolicy.mockResolvedValue({
      defaultExecutionPolicy: { stages: [] },
    });

    setInputValue(getPolicyTextarea(container), '{"stages":[]}');
    await flushReact();

    const saveButton = container.querySelector(
      "[data-testid='company-settings-default-execution-policy-save']",
    ) as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(
      container.querySelector("[data-testid='company-settings-default-execution-policy-save']"),
    ).toBeNull();
  });

  it("refreshes an untouched organization name instead of treating an external rename as a local edit", async () => {
    selectedCompany = { ...baseCompany, name: "Renamed By Other Tab" };
    await renderApp();

    expect(getNameInput(container).value).toBe("Renamed By Other Tab");
    expect(container.textContent).not.toContain("Save changes");
  });

  it("refreshes an untouched organization description the same way", async () => {
    selectedCompany = { ...baseCompany, description: "Set by another tab" };
    await renderApp();

    expect(getDescriptionInput(container).value).toBe("Set by another tab");
    expect(container.textContent).not.toContain("Save changes");
  });

  it("still discards a real unsaved edit on an actual company switch, but preserves it across a same-company refetch", async () => {
    const nameInput = getNameInput(container);
    setInputValue(nameInput, "Mid-edit Name");
    await flushReact();
    expect(getNameInput(container).value).toBe("Mid-edit Name");

    selectedCompany = { ...baseCompany, id: "company-2", name: "Second Co" };
    await renderApp();

    expect(getNameInput(container).value).toBe("Second Co");
  });
});
