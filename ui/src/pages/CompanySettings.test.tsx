// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AGENT_ADAPTER_TYPES, getEnvironmentCapabilities } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettings } from "./CompanySettings";
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
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
    selectedCompany: {
      id: "company-1",
      name: "Paperclip",
      description: null,
      brandColor: null,
      logoUrl: null,
      issuePrefix: "PAP",
    },
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanySettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
    });
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
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
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
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const editButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Edit");
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const providerSelect = Array.from(container.querySelectorAll("select"))
      .find((select) => Array.from(select.options).some((option) => option.value === "secure-plugin")) as HTMLSelectElement | undefined;
    expect(providerSelect).toBeTruthy();

    await act(async () => {
      providerSelect!.value = "secure-plugin";
      providerSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const templateInput = Array.from(container.querySelectorAll("input"))
      .find((input) => (input as HTMLInputElement).value === "saved-template") as HTMLInputElement | undefined;
    expect(templateInput?.value).toBe("saved-template");

    await act(async () => {
      root.unmount();
    });
  });

  it("offers a Kubernetes driver option and reveals k8s form fields when selected", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const driverSelect = Array.from(container.querySelectorAll("select"))
      .find((select) =>
        Array.from(select.options).some((option) => option.value === "ssh") &&
          Array.from(select.options).some((option) => option.value === "local"),
      ) as HTMLSelectElement | undefined;
    expect(driverSelect, "driver dropdown should be present").toBeTruthy();

    const optionValues = Array.from(driverSelect!.options).map((option) => option.value);
    expect(optionValues).toContain("k8s");
    const k8sOption = Array.from(driverSelect!.options).find((option) => option.value === "k8s");
    expect(k8sOption?.textContent?.trim()).toBe("Kubernetes");

    await act(async () => {
      driverSelect!.value = "k8s";
      driverSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Kubeconfig secret");
    expect(container.textContent).toContain("In-cluster auth");
    expect(container.textContent).toContain("Namespace");
    expect(container.textContent).toContain("Service account");
    expect(container.textContent).toContain("Node selector");
    expect(container.textContent).toContain("Tolerations");
    expect(container.textContent).toContain("Labels");
    expect(container.textContent).toContain("Image pull policy");
    expect(container.textContent).toContain("Workspace volume claim");
    expect(container.textContent).toContain("Workspace mount path");
    expect(container.textContent).toContain("Secrets namespace");
    expect(container.textContent).toContain("Provider pools");
    expect(container.textContent).toContain("Anthropic accounts");
    expect(container.textContent).toContain("OpenAI accounts");

    const poolKindSelects = Array.from(container.querySelectorAll("select"))
      .filter((s) => s.getAttribute("aria-label")?.toLowerCase().includes("pool kind"));
    expect(poolKindSelects.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      root.unmount();
    });
  });

  it("disables submit and shows an error when k8s tolerations contain malformed JSON", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const driverSelect = Array.from(container.querySelectorAll("select"))
      .find((select) =>
        Array.from(select.options).some((option) => option.value === "ssh") &&
          Array.from(select.options).some((option) => option.value === "local"),
      ) as HTMLSelectElement | undefined;
    expect(driverSelect, "driver dropdown should be present").toBeTruthy();

    await act(async () => {
      driverSelect!.value = "k8s";
      driverSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    // React's synthetic onChange listens at the document level and reads
    // target.value at handler time, but the input/textarea must be set via
    // the prototype's native value setter so React can pick up the diff.
    const setTextareaValue = (el: HTMLTextAreaElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const tolerationsTextarea = Array.from(container.querySelectorAll("textarea"))
      .find((t) => t.getAttribute("placeholder")?.includes("dedicated"));
    expect(tolerationsTextarea, "tolerations textarea should be present").toBeTruthy();

    await act(async () => {
      setTextareaValue(tolerationsTextarea as HTMLTextAreaElement, "this is not json");
    });
    await flushReact();

    expect(container.textContent).toContain("Tolerations must be a JSON array");

    const saveButton = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.trim().toLowerCase().match(/^(save|create)/));
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders a K8s column in the per-adapter capabilities table", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const tableHeaders = Array.from(container.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(tableHeaders).toContain("K8s");

    await act(async () => {
      root.unmount();
    });
  });
});
