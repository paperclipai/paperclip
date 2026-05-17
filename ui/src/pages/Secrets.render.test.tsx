// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySecretProviderConfig, SecretProviderDescriptor } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderVaultsTab, Secrets } from "./Secrets";

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  providers: vi.fn(),
  providerHealth: vi.fn(),
  providerConfigs: vi.fn(),
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  disableProviderConfig: vi.fn(),
  setDefaultProviderConfig: vi.fn(),
  checkProviderConfigHealth: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  usage: vi.fn(),
  accessEvents: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
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
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const providers: SecretProviderDescriptor[] = [
  {
    id: "local_encrypted",
    label: "Local encrypted",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: false,
    configured: true,
  },
  {
    id: "aws_secrets_manager",
    label: "AWS Secrets Manager",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: true,
    configured: true,
  },
  {
    id: "gcp_secret_manager",
    label: "GCP Secret Manager",
    requiresExternalRef: false,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: false,
  },
  {
    id: "vault",
    label: "Vault",
    requiresExternalRef: false,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: false,
  },
];

const providerConfigs = [
  {
    id: "vault-local",
    provider: "local_encrypted",
    displayName: "Local default",
    status: "ready",
    isDefault: true,
    healthStatus: "ready",
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
  },
  {
    id: "vault-aws",
    provider: "aws_secrets_manager",
    displayName: "AWS production",
    status: "ready",
    isDefault: false,
    healthStatus: null,
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
  },
] satisfies Partial<CompanySecretProviderConfig>[];

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Secrets page layout", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.providers.mockResolvedValue(providers);
    mockSecretsApi.providerHealth.mockResolvedValue({
      providers: [
        {
          provider: "local_encrypted",
          status: "warn",
          message: "Local encrypted provider has a warning.",
          warnings: ["Backup reminder"],
        },
      ],
    });
    mockSecretsApi.providerConfigs.mockResolvedValue(providerConfigs);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uses the shared search/filter/tab affordances and keeps vault sections quiet", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Secrets />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('input[data-page-search-target="true"][aria-label="Search secrets"]')).not.toBeNull();
    expect(container.textContent).toContain("Use secrets by binding them to runtime environment variables.");
    expect(container.textContent).toContain("GH_TOKEN");
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.textContent).not.toContain("Provider warnings detected");
    expect(container.textContent).not.toContain("2/2 active");

    await act(async () => {
      root.unmount();
    });

    const vaultRoot = createRoot(container);
    await act(async () => {
      vaultRoot.render(
        <ProviderVaultsTab
          providers={providers}
          providerConfigs={providerConfigs as CompanySecretProviderConfig[]}
          loading={false}
          error={null}
          onRetry={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onDisable={vi.fn()}
          onSetDefault={vi.fn()}
          onHealthCheck={vi.fn()}
          pendingActionId={null}
        />,
      );
    });
    await flushReact();

    expect(container.querySelector('a[href="#provider-vaults-local_encrypted"]')).not.toBeNull();
    expect(container.textContent).toContain("AWS production");
    expect(container.textContent).not.toContain("Managed writes");
    expect(container.textContent).not.toContain("External refs");

    await act(async () => {
      vaultRoot.unmount();
    });
  });

  it("opens reference details from the secrets table count", async () => {
    mockSecretsApi.list.mockResolvedValue([
      {
        id: "secret-openai",
        companyId: "company-1",
        key: "openai_api_key",
        name: "OPENAI_API_KEY",
        provider: "local_encrypted",
        status: "active",
        managedMode: "paperclip_managed",
        externalRef: null,
        providerConfigId: null,
        providerMetadata: null,
        latestVersion: 1,
        description: null,
        lastResolvedAt: null,
        lastRotatedAt: null,
        deletedAt: null,
        createdByAgentId: null,
        createdByUserId: "user-1",
        referenceCount: 2,
        createdAt: new Date("2026-05-06T00:00:00.000Z"),
        updatedAt: new Date("2026-05-06T00:00:00.000Z"),
      },
    ]);
    mockSecretsApi.usage.mockResolvedValue({
      secretId: "secret-openai",
      bindings: [
        {
          id: "binding-agent",
          companyId: "company-1",
          secretId: "secret-openai",
          targetType: "agent",
          targetId: "agent-1",
          configPath: "env.OPENAI_API_KEY",
          versionSelector: "latest",
          required: true,
          label: null,
          target: {
            type: "agent",
            id: "agent-1",
            label: "CodexCoder",
            href: "/agents/codexcoder",
            status: "idle",
          },
          createdAt: new Date("2026-05-06T00:00:00.000Z"),
          updatedAt: new Date("2026-05-06T00:00:00.000Z"),
        },
      ],
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <Secrets />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    const referencesButton = container.querySelector(
      'button[aria-label="View references for OPENAI_API_KEY"]',
    ) as HTMLButtonElement | null;
    expect(referencesButton?.textContent).toBe("2");

    await act(async () => {
      referencesButton?.click();
    });
    await flushReact();

    expect(mockSecretsApi.usage).toHaveBeenCalledWith("secret-openai");
    expect(document.body.textContent).toContain("Secret references");
    expect(document.body.textContent).toContain("CodexCoder");
    expect(document.body.textContent).toContain("env.OPENAI_API_KEY");

    await act(async () => {
      root.unmount();
    });
  });
});
