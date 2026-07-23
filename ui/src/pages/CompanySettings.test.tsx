// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AGENT_ADAPTER_TYPES, getEnvironmentCapabilities } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyEnvironments } from "./CompanyEnvironments";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  createOpenClawInvitePrompt: vi.fn(),
  getInviteOnboarding: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  probe: vi.fn(),
  probeConfig: vi.fn(),
  archive: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockPushToast,
  }),
  useToastActions: () => ({ pushToast: mockPushToast }),
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
    selectedCompany: null,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

const ENVIRONMENTS_PATH = "/company/settings/instance/environments";

function getEnvironmentFormPage(): HTMLElement | null {
  return document.body.querySelector("[data-testid='environment-form-page']");
}

function findAction(root: ParentNode, label: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("button,a")).find((element) => element.textContent?.trim() === label);
}

function click(element: Element | null | undefined) {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function renderCompanyEnvironments(queryClient: QueryClient, initialPath = ENVIRONMENTS_PATH) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>
          <Routes>
            <Route path={ENVIRONMENTS_PATH} element={<CompanyEnvironments />} />
            <Route path={`${ENVIRONMENTS_PATH}/new`} element={<CompanyEnvironments mode="create" />} />
            <Route path={`${ENVIRONMENTS_PATH}/:environmentId/edit`} element={<CompanyEnvironments mode="edit" />} />
          </Routes>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CompanyEnvironments", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
    });
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES),
    );
    mockSecretsApi.list.mockResolvedValue([]);
    mockCompaniesApi.update.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: null,
      brandColor: null,
      logoUrl: null,
      issuePrefix: "PAP",
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides sandbox creation when no run-capable sandbox provider plugins are installed", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    const optionLabels = Array.from(container.querySelectorAll("option")).map((option) => option.textContent?.trim());

    expect(optionLabels).not.toContain("Sandbox");
    expect(container.textContent).not.toContain("Fake sandbox");
    expect(container.textContent).not.toContain("Fake is the deterministic test provider");

    await act(async () => {
      root.unmount();
    });
  });

  it("omits the Local driver option and lists Sandbox before SSH", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES, {
        sandboxProviders: {
          "secure-plugin": {
            status: "supported",
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: "Secure Sandbox",
            configSchema: { type: "object", properties: {} },
          },
        },
      }),
    );

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    const addEnvironmentButton = findAction(container, "Add environment");
    expect(addEnvironmentButton).toBeTruthy();

    await act(async () => {
      click(addEnvironmentButton);
    });

    await waitForAssertion(() => expect(getEnvironmentFormPage()).toBeTruthy());
    const dialog = getEnvironmentFormPage();

    const driverSelect = Array.from(dialog?.querySelectorAll("select") ?? [])
      .find((select) => Array.from(select.options).some((option) => option.value === "ssh")) as
      | HTMLSelectElement
      | undefined;
    expect(driverSelect).toBeTruthy();

    const driverOptionValues = Array.from(driverSelect!.options).map((option) => option.value);
    expect(driverOptionValues).not.toContain("local");
    expect(driverOptionValues).toEqual(["sandbox", "ssh"]);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the Local driver option when editing an existing local environment", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockEnvironmentsApi.list.mockResolvedValue([
      {
        id: "env-local",
        companyId: "company-1",
        name: "Local host",
        description: null,
        driver: "local",
        status: "active",
        config: {},
        metadata: null,
        createdAt: new Date("2026-04-25T00:00:00.000Z"),
        updatedAt: new Date("2026-04-25T00:00:00.000Z"),
      },
    ]);

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    const editButton = findAction(container, "Edit");
    expect(editButton).toBeTruthy();

    await act(async () => {
      click(editButton);
    });

    await waitForAssertion(() => expect(getEnvironmentFormPage()).toBeTruthy());
    const dialog = getEnvironmentFormPage();

    const driverSelect = Array.from(dialog?.querySelectorAll("select") ?? [])
      .find((select) => Array.from(select.options).some((option) => option.value === "ssh")) as
      | HTMLSelectElement
      | undefined;
    expect(driverSelect).toBeTruthy();

    const driverOptionValues = Array.from(driverSelect!.options).map((option) => option.value);
    expect(driverOptionValues).toContain("local");
    expect(driverSelect!.value).toBe("local");

    await act(async () => {
      root.unmount();
    });
  });

  it("preserves sandbox config when re-selecting the same provider while editing", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockEnvironmentsApi.list.mockResolvedValue([
      {
        id: "env-1",
        companyId: "company-1",
        name: "Secure Sandbox",
        description: null,
        driver: "sandbox",
        status: "active",
        config: {
          provider: "secure-plugin",
          template: "saved-template",
        },
        metadata: null,
        createdAt: new Date("2026-04-25T00:00:00.000Z"),
        updatedAt: new Date("2026-04-25T00:00:00.000Z"),
      },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES, {
        sandboxProviders: {
          "secure-plugin": {
            status: "supported",
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: "Secure Sandbox",
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string", title: "Template" },
              },
            },
          },
        },
      }),
    );

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Secure Sandbox");

    const editButton = findAction(container, "Edit");
    expect(editButton).toBeTruthy();

    await act(async () => {
      click(editButton);
    });

    await waitForAssertion(() => expect(getEnvironmentFormPage()).toBeTruthy());
    const dialog = getEnvironmentFormPage();

    const providerSelect = Array.from(dialog?.querySelectorAll("select") ?? []).find((select) =>
      Array.from(select.options).some((option) => option.value === "secure-plugin"),
    ) as HTMLSelectElement | undefined;
    expect(providerSelect).toBeTruthy();

    await act(async () => {
      providerSelect!.value = "secure-plugin";
      providerSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const templateInput = Array.from(dialog?.querySelectorAll("input") ?? [])
      .find((input) => (input as HTMLInputElement).value === "saved-template") as HTMLInputElement | undefined;
    expect(templateInput?.value).toBe("saved-template");

    await act(async () => {
      root.unmount();
    });
  });
});
