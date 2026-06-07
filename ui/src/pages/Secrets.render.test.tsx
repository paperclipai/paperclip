// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CompanySecretProviderConfig,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderVaultsTab, Secrets } from "./Secrets";
import { ApiError } from "../api/client";

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  providers: vi.fn(),
  providerHealth: vi.fn(),
  providerConfigs: vi.fn(),
  providerConfigDiscoveryPreview: vi.fn(),
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  disableProviderConfig: vi.fn(),
  removeProviderConfig: vi.fn(),
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

function makeDiscoveryPreview(
  overrides: Partial<SecretProviderConfigDiscoveryPreviewResult> = {},
): SecretProviderConfigDiscoveryPreviewResult {
  return {
    provider: "aws_secrets_manager",
    nextToken: null,
    sampledSecretCount: 2,
    skippedForeignPaperclipSampleCount: 0,
    warnings: [],
    candidates: [
      {
        provider: "aws_secrets_manager",
        displayName: "AWS production",
        config: {
          region: "us-east-1",
          namespace: "prod-use1",
          secretNamePrefix: "paperclip",
          kmsKeyId: "alias/paperclip-secrets",
          ownerTag: "platform",
          environmentTag: "production",
        },
        sampleCount: 2,
        samples: [
          {
            name: "paperclip/prod-use1/company-1/openai",
            hasKmsKey: true,
            tagKeys: ["owner", "environment"],
          },
        ],
        signals: {
          namespace: "prod-use1",
          secretNamePrefix: "paperclip",
          environmentTag: "production",
          ownerTag: "platform",
          kmsKeyId: "alias/paperclip-secrets",
          hasKmsKey: true,
          sampleCount: 2,
          paperclipManagedSampleCount: 0,
          skippedForeignPaperclipSampleCount: 0,
        },
        warnings: [],
      },
    ],
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openAwsVaultDialog() {
  const vaultTabButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.includes("Provider vaults"),
  ) as HTMLButtonElement | undefined;
  await act(async () => {
    vaultTabButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    vaultTabButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    vaultTabButton?.click();
  });
  await flushReact();

  const addVaultButtons = [...document.querySelectorAll("button")].filter(
    (button) => button.textContent?.includes("Add vault"),
  ) as HTMLButtonElement[];
  await act(async () => {
    addVaultButtons[1]?.click();
  });
  await flushReact();
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
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValue(makeDiscoveryPreview());
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
          onRemove={vi.fn()}
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

  it("warns that removing a provider vault only removes Paperclip config", async () => {
    mockSecretsApi.removeProviderConfig.mockResolvedValueOnce(providerConfigs[1]);
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

    const vaultTabButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Provider vaults"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      vaultTabButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      vaultTabButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      vaultTabButton?.click();
    });
    await flushReact();

    const removeButtons = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Remove",
    ) as HTMLButtonElement[];
    await act(async () => {
      removeButtons[1]?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Remove provider vault");
    expect(document.body.textContent).toContain("from All Gas No Brakes only");
    expect(document.body.textContent).toContain("does not delete");
    expect(document.body.textContent).toContain("AWS Secrets Manager");

    const confirmButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Remove from All Gas No Brakes"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      confirmButton?.click();
    });
    await flushReact();

    expect(mockSecretsApi.removeProviderConfig).toHaveBeenCalledWith("vault-aws");
    expect(mockSecretsApi.disableProviderConfig).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
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

  it("keeps the new secret value textarea width-constrained for long tokens", async () => {
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

    const newSecretButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    expect(newSecretButton).toBeDefined();

    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();

    const secretValueTextarea = document.body.querySelector("#new-secret-value") as HTMLTextAreaElement | null;
    expect(secretValueTextarea).not.toBeNull();
    expect(secretValueTextarea?.className).toContain("min-w-0");
    expect(secretValueTextarea?.className).toContain("overflow-x-hidden");
    expect(secretValueTextarea?.className).toContain("break-all");

    await act(async () => {
      root.unmount();
    });
  });

  it("discovers AWS provider vault candidates and applies selected values as prefill", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValueOnce(makeDiscoveryPreview());
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
    await openAwsVaultDialog();

    const discoveryButton = document.querySelector(
      '[data-testid="aws-vault-discovery-button"]',
    ) as HTMLButtonElement | null;
    expect(discoveryButton).not.toBeNull();
    expect(discoveryButton?.disabled).toBe(true);

    const regionInput = document.getElementById("provider-vault-aws-region") as HTMLInputElement | null;
    const prefixInput = document.getElementById("provider-vault-secret-name-prefix") as HTMLInputElement | null;
    expect(regionInput).not.toBeNull();
    await act(async () => {
      setInputValue(regionInput!, "us-east-1");
      setInputValue(prefixInput!, "paperclip");
    });
    await flushReact();

    expect(discoveryButton?.disabled).toBe(false);
    await act(async () => {
      discoveryButton?.click();
    });
    await flushReact();
    await flushReact();

    expect(mockSecretsApi.providerConfigDiscoveryPreview).toHaveBeenCalledWith("company-1", {
      provider: "aws_secrets_manager",
      config: {
        region: "us-east-1",
        namespace: null,
        secretNamePrefix: "paperclip",
        kmsKeyId: null,
        ownerTag: null,
        environmentTag: null,
      },
      query: "paperclip",
      pageSize: 25,
    });
    expect(document.body.textContent).toContain("AWS production");

    const useValuesButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Use values"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      useValuesButton?.click();
    });
    await flushReact();

    expect((document.getElementById("vault-name") as HTMLInputElement).value).toBe("AWS production");
    expect((document.getElementById("provider-vault-namespace") as HTMLInputElement).value).toBe("prod-use1");
    expect((document.getElementById("provider-vault-secret-name-prefix") as HTMLInputElement).value).toBe("paperclip");
    expect((document.getElementById("provider-vault-kms-key-id") as HTMLInputElement).value).toBe("alias/paperclip-secrets");
    expect((document.getElementById("provider-vault-owner-tag") as HTMLInputElement).value).toBe("platform");
    expect((document.getElementById("provider-vault-environment-tag") as HTMLInputElement).value).toBe("production");
    expect(mockSecretsApi.createProviderConfig).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows AWS discovery errors without replacing manual vault form values", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockRejectedValueOnce(
      new ApiError("AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.", 403, {
        details: { code: "access_denied" },
      }),
    );
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
    await openAwsVaultDialog();

    const regionInput = document.getElementById("provider-vault-aws-region") as HTMLInputElement;
    const namespaceInput = document.getElementById("provider-vault-namespace") as HTMLInputElement;
    await act(async () => {
      setInputValue(regionInput, "us-west-2");
      setInputValue(namespaceInput, "manual-prod");
    });
    await flushReact();

    const discoveryButton = document.querySelector(
      '[data-testid="aws-vault-discovery-button"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      discoveryButton?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("AWS Secrets Manager denied the request");
    expect(regionInput.value).toBe("us-west-2");
    expect(namespaceInput.value).toBe("manual-prod");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an empty AWS discovery result without blocking manual entry", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValueOnce(
      makeDiscoveryPreview({ candidates: [], sampledSecretCount: 0 }),
    );
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
    await openAwsVaultDialog();

    const regionInput = document.getElementById("provider-vault-aws-region") as HTMLInputElement;
    await act(async () => {
      setInputValue(regionInput, "us-east-2");
    });
    await flushReact();
    await act(async () => {
      (document.querySelector('[data-testid="aws-vault-discovery-button"]') as HTMLButtonElement | null)?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("No AWS vault metadata candidates found");
    expect(regionInput.value).toBe("us-east-2");

    await act(async () => {
      root.unmount();
    });
  });
});
