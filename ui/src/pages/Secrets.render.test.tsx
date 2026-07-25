// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  RemoteSecretImportPreviewResult,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretProviderDescriptor,
  UserSecretCoverageSummary,
  UserSecretDefinition,
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
  remoteImportPreview: vi.fn(),
  remoteImport: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  usage: vi.fn(),
  accessEvents: vi.fn(),
  listUserSecretDefinitions: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  updateUserSecretDefinition: vi.fn(),
  removeUserSecretDefinition: vi.fn(),
  userSecretDefinitionCoverage: vi.fn(),
  listMyUserSecrets: vi.fn(),
  createMyUserSecret: vi.fn(),
  updateMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
  removeMyUserSecret: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
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

async function waitForReact(predicate: () => boolean, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushReact();
  }
  throw new Error("Timed out waiting for React state to settle");
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

function makeRemoteImportPreview(
  overrides: Partial<RemoteSecretImportPreviewResult> = {},
): RemoteSecretImportPreviewResult {
  return {
    providerConfigId: "vault-aws",
    provider: "aws_secrets_manager",
    nextToken: null,
    candidates: [],
    ...overrides,
  };
}

function makeCompanySecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "secret-openai",
    companyId: "company-1",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
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
    ...overrides,
  };
}

function makeUserSecretDefinition(overrides: Partial<UserSecretDefinition> = {}): UserSecretDefinition {
  return {
    id: "def-github",
    companyId: "company-1",
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GitHub token",
    description: "Used when the responsible user's own repos must be reached.",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: "Create a fine-grained PAT with repo read access.",
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

const userSecretCoverage: UserSecretCoverageSummary = {
  definitionId: "def-github",
  configuredCount: 3,
  missingCount: 2,
  inactiveCount: 0,
};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
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
    mockSecretsApi.remoteImportPreview.mockResolvedValue(makeRemoteImportPreview());
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([]);
    mockSecretsApi.userSecretDefinitionCoverage.mockResolvedValue(userSecretCoverage);
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
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
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <Secrets />
          </QueryClientProvider>
        </MemoryRouter>,
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
          onImportSecrets={vi.fn()}
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

  it("refreshes existing AWS secrets from a provider vault card", async () => {
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

    const refreshButton = document.querySelector(
      '[data-testid="provider-vault-refresh-secrets-vault-aws"]',
    ) as HTMLButtonElement | null;
    expect(refreshButton).not.toBeNull();

    await act(async () => {
      refreshButton?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("Import from AWS Secrets Manager");
    expect(mockSecretsApi.remoteImportPreview).toHaveBeenCalledWith("company-1", {
      providerConfigId: "vault-aws",
      query: null,
      nextToken: null,
      pageSize: 50,
    });

    await act(async () => {
      root.unmount();
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
    expect(document.body.textContent).toContain("from Paperclip only");
    expect(document.body.textContent).toContain("does not delete");
    expect(document.body.textContent).toContain("AWS Secrets Manager");

    const confirmButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Remove from Paperclip"),
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

  it("keeps references reachable from the compact secrets row and detail drawer", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
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
      'button[aria-label="Actions for OPENAI_API_KEY"]',
    ) as HTMLButtonElement | null;
    expect(referencesButton).not.toBeNull();

    const companyRow = Array.from(container.querySelectorAll("[role='row']")).find(
      (row) => row.textContent?.includes("OPENAI_API_KEY"),
    ) as HTMLElement | undefined;
    await act(async () => {
      companyRow?.click();
    });
    await flushReact();

    const viewUsageButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("View in Usage"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      viewUsageButton?.click();
    });
    await flushReact();

    expect(mockSecretsApi.usage).toHaveBeenCalledWith("secret-openai");
    expect(document.body.textContent).toContain("CodexCoder");
    expect(document.body.textContent).toContain("env.OPENAI_API_KEY");

    await act(async () => {
      root.unmount();
    });
  });

  it("merges company secrets and each-user definitions into the Secrets list", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([makeUserSecretDefinition()]);
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

    expect(container.textContent).toContain("OPENAI_API_KEY");
    expect(container.textContent).toContain("Personal GitHub token");
    expect(container.textContent).toContain("Company");
    expect(container.textContent).toContain("Each user");
    expect(container.textContent).toContain("3/5 set");
    expect(container.textContent).not.toContain("User secret definitions");

    const listContainer = container.querySelector('[data-testid="secrets-list-container"]');
    const tableView = container.querySelector('[data-testid="secrets-table-view"]');
    const cardView = container.querySelector('[data-testid="secrets-card-view"]');
    expect(listContainer?.className).toContain("@container");
    expect(tableView?.className).toContain("@min-[40rem]:block");
    expect(tableView?.className).not.toContain("md:block");
    // Grid template lives in the token layer: --gtc-54 in ui/src/index.css
    // carries the original minmax(12rem,2.4fr)... template verbatim.
    expect(tableView?.querySelector("[role='row']")?.className).toContain("grid-cols-(--gtc-54)");
    expect(cardView?.className).toContain("@min-[40rem]:hidden");
    expect(cardView?.className).not.toContain("md:hidden");

    expect(mockSecretsApi.list).toHaveBeenCalledWith("company-1");
    expect(mockSecretsApi.listUserSecretDefinitions).toHaveBeenCalledWith("company-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("creates an each-user secret from the unified New secret dialog", async () => {
    const definition = makeUserSecretDefinition({ name: "Personal GitHub token" });
    mockSecretsApi.createUserSecretDefinition.mockResolvedValueOnce(definition);
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
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();

    const companyKeyInput = document.getElementById("new-secret-key") as HTMLInputElement;
    expect(companyKeyInput.readOnly).toBe(true);

    const editKeyButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Edit",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      editKeyButton?.click();
    });
    await flushReact();
    expect(companyKeyInput.readOnly).toBe(false);

    const eachUserButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Each user",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      eachUserButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      eachUserButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      eachUserButton?.click();
    });
    await flushReact();

    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    const keyInput = document.getElementById("new-secret-key") as HTMLInputElement;
    const usageGuidance = document.getElementById("new-secret-usage-guidance") as HTMLTextAreaElement;
    expect(keyInput.readOnly).toBe(true);
    expect(
      Array.from(document.body.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Edit",
      ),
    ).toBe(true);
    expect(document.getElementById("new-secret-provider")).toBeNull();
    expect(document.getElementById("new-secret-vault")).toBeNull();
    expect(document.getElementById("new-secret-value")).toBeNull();

    await act(async () => {
      setInputValue(nameInput, "Personal GitHub token");
      setTextareaValue(usageGuidance, "Create a fine-grained PAT with repo read access.");
    });
    await flushReact();

    expect(keyInput.value).toBe("PERSONAL_GITHUB_TOKEN");

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create user-provided secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      createButton?.click();
    });
    await flushReact();

    expect(mockSecretsApi.createUserSecretDefinition).toHaveBeenCalledWith("company-1", {
      name: "Personal GitHub token",
      description: null,
      usageGuidance: "Create a fine-grained PAT with repo read access.",
      key: "PERSONAL_GITHUB_TOKEN",
      status: "active",
    });
    expect(mockSecretsApi.create).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("opens the New secret dialog when provider queries fail", async () => {
    mockSecretsApi.providers.mockRejectedValueOnce(new ApiError("Providers unavailable", 403, null));
    mockSecretsApi.providerConfigs.mockRejectedValueOnce(new ApiError("Provider vaults unavailable", 403, null));
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
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Create secret");
    expect(document.body.textContent).toContain("Select a provider.");

    await act(async () => {
      root.unmount();
    });
  });

  it("opens the each-user detail sheet with coverage and set-my-value actions", async () => {
    const definition = makeUserSecretDefinition();
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([definition]);
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition, secret: null }]);
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

    const definitionRow = Array.from(container.querySelectorAll("[role='row']")).find(
      (row) => row.textContent?.includes("Personal GitHub token"),
    ) as HTMLElement | undefined;
    await act(async () => {
      definitionRow?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Personal GitHub token");
    expect(document.body.textContent).toContain("Details");
    expect(document.body.textContent).toContain("Coverage");
    expect(document.body.textContent).toContain("Usage");
    expect(document.body.textContent).toContain("Access events");

    const viewCoverageButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("View in Coverage"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      viewCoverageButton?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("3 of 5 set");
    expect(document.body.textContent).toContain("Secret values are never shown here");

    const setValueButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Set my value"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      setValueButton?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Set your value");
    expect(document.body.textContent).toContain("PERSONAL_GH_TOKEN");

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

  it("explains AWS managed secret creation failures with actionable safe details", async () => {
    const rawProviderMessage =
      "AccessDeniedException: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.create.mockRejectedValueOnce(
      new ApiError("AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.", 403, {
        details: {
          code: "access_denied",
          provider: "aws_secrets_manager",
          operation: "secret.create",
          providerConfigId: "vault-aws",
          region: "us-east-1",
          credentialPath: "Paperclip server runtime/provider credential path",
          requiredCapability: "secretsmanager:CreateSecret",
          actionableMessage:
            "AWS managed secret creation needs secretsmanager:CreateSecret in the selected region for this provider vault.",
          safeAlternative:
            "If the secret already exists in AWS, link it as an external reference instead of creating a Paperclip-managed value.",
        },
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

    const newSecretButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();

    await act(async () => {
      setInputValue(document.getElementById("new-secret-name") as HTMLInputElement, "AWS test token");
      setSelectValue(document.getElementById("new-secret-provider") as HTMLSelectElement, "aws_secrets_manager");
      setTextareaValue(document.getElementById("new-secret-value") as HTMLTextAreaElement, "secret-value");
    });
    await flushReact();

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create secret",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      createButton?.click();
    });
    await flushReact();
    await flushReact();

    const errorBanner = document.querySelector('[data-testid="secret-create-error"]');
    expect(errorBanner?.textContent).toContain("AWS secret creation needs CreateSecret permission");
    expect(errorBanner?.textContent).toContain("secretsmanager:CreateSecret");
    expect(errorBanner?.textContent).toContain("us-east-1");
    expect(errorBanner?.textContent).toContain("link it as an external reference");
    expect(errorBanner?.textContent).toContain("vault-aws");
    expect(errorBanner?.textContent).not.toContain(rawProviderMessage);
    expect(errorBanner?.textContent).not.toContain("123456789012");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders generic secret creation failures with a stable selector", async () => {
    mockSecretsApi.create.mockRejectedValueOnce(new ApiError("Secret creation failed", 500, null));
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
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();

    await act(async () => {
      setInputValue(document.getElementById("new-secret-name") as HTMLInputElement, "Failed token");
      setTextareaValue(document.getElementById("new-secret-value") as HTMLTextAreaElement, "secret-value");
    });
    await flushReact();

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create secret",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      createButton?.click();
    });
    await flushReact();
    await flushReact();

    const errorBanner = document.querySelector('[data-testid="secret-create-error"]');
    expect(errorBanner?.textContent).toBe("Secret creation failed");

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
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.providerConfigDiscoveryPreview.mockRejectedValueOnce(
      new ApiError("AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.", 403, {
        details: {
          code: "access_denied",
          provider: "aws_secrets_manager",
          operation: "secret_provider_config.discovery.preview",
          providerConfigId: "discovery-preview",
          providerVaultContext: "draft_config",
          region: "us-west-2",
          credentialPath: "Paperclip server runtime/provider credential path",
          requiredCapability: "secretsmanager:ListSecrets",
          actionableMessage:
            "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.",
          safeAlternative:
            "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.",
        },
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

    const errorBanner = document.querySelector('[data-testid="aws-vault-discovery-error"]');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain("AWS discovery needs ListSecrets permission");
    expect(errorBanner?.textContent).toContain("secretsmanager:ListSecrets");
    expect(errorBanner?.textContent).toContain("Paperclip server runtime/provider credential path");
    expect(errorBanner?.textContent).toContain("paste/link that ARN");
    expect(errorBanner?.textContent).toContain("DescribeSecret");
    expect(errorBanner?.textContent).toContain("us-west-2");
    expect(errorBanner?.textContent).toContain("secret_provider_config.discovery.preview");
    expect(errorBanner?.textContent).toContain("aws_secrets_manager");
    expect(errorBanner?.textContent).toContain("Safe request/error details");
    expect(errorBanner?.textContent).not.toContain(rawProviderMessage);
    expect(errorBanner?.textContent).not.toContain("arn:aws");
    expect(errorBanner?.textContent).not.toContain("123456789012");
    expect(regionInput.value).toBe("us-west-2");
    expect(namespaceInput.value).toBe("manual-prod");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps generic AWS discovery 403 errors on the generic failure path", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockRejectedValueOnce(
      new ApiError("AWS discovery request failed before IAM evaluation.", 403, {
        details: {
          code: "proxy_forbidden",
          provider: "aws_secrets_manager",
          operation: "secret_provider_config.discovery.preview",
          region: "us-west-1",
        },
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
    await act(async () => {
      setInputValue(regionInput, "us-west-1");
    });
    await flushReact();

    await act(async () => {
      (document.querySelector('[data-testid="aws-vault-discovery-button"]') as HTMLButtonElement | null)?.click();
    });
    await flushReact();
    await flushReact();

    const errorBanner = document.querySelector('[data-testid="aws-vault-discovery-error"]');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain("AWS discovery failed");
    expect(errorBanner?.textContent).toContain("AWS discovery request failed before IAM evaluation.");
    expect(errorBanner?.textContent).toContain("proxy_forbidden");
    expect(errorBanner?.textContent).not.toContain("AWS discovery needs ListSecrets permission");

    await act(async () => {
      root.unmount();
    });
  });

  it("auto-generates the key from the name and keeps it read-only until Edit", async () => {
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
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();

    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    const keyInput = document.getElementById("new-secret-key") as HTMLInputElement;
    const valueTextarea = document.getElementById("new-secret-value") as HTMLTextAreaElement;

    // Path-style placeholder and value directly after name for natural tab order.
    expect(nameInput.placeholder).toBe("/dev/foo/bar");
    expect(
      nameInput.compareDocumentPosition(valueTextarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      valueTextarea.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(keyInput.readOnly).toBe(true);
    await act(async () => {
      setInputValue(nameInput, "OpenAI API Key");
    });
    await flushReact();
    expect(keyInput.value).toBe("openai-api-key");

    const editKeyButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Edit",
    ) as HTMLButtonElement | undefined;
    expect(editKeyButton).toBeDefined();
    await act(async () => {
      editKeyButton?.click();
    });
    await flushReact();

    expect((document.getElementById("new-secret-key") as HTMLInputElement).readOnly).toBe(false);

    await act(async () => {
      setInputValue(document.getElementById("new-secret-key") as HTMLInputElement, "custom-key");
      setInputValue(nameInput, "OpenAI API Key v2");
    });
    await flushReact();

    // Once edited, the key stops following the name.
    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe("custom-key");

    await act(async () => {
      root.unmount();
    });
  });

  it("grants and revokes agent access from the secret detail sheet", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    mockSecretsApi.usage.mockResolvedValue({ secretId: "secret-openai", bindings: [] });
    mockSecretsApi.accessEvents.mockResolvedValue([]);
    const coder = {
      id: "agent-coder",
      name: "CodexCoder",
      status: "active",
      adapterConfig: {},
    };
    const reviewer = {
      id: "agent-reviewer",
      name: "Reviewer",
      status: "active",
      adapterConfig: {
        env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai" } },
      },
    };
    mockAgentsApi.list.mockResolvedValue([coder, reviewer]);
    mockAgentsApi.get.mockImplementation(async (id: string) =>
      id === "agent-coder" ? coder : reviewer,
    );
    mockAgentsApi.update.mockImplementation(async (id: string) =>
      id === "agent-coder" ? coder : reviewer,
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

    const companyRow = Array.from(container.querySelectorAll("[role='row']")).find(
      (row) => row.textContent?.includes("OPENAI_API_KEY"),
    ) as HTMLElement | undefined;
    await act(async () => {
      companyRow?.click();
    });
    await flushReact();
    await flushReact();

    // Existing access is listed right in the Details tab.
    expect(document.body.textContent).toContain("Agent access");
    expect(document.body.textContent).toContain("Reviewer");

    const agentSelect = document.getElementById("agent-access-agent") as HTMLButtonElement;
    const envKeyInput = document.getElementById("agent-access-env-key") as HTMLInputElement;
    expect(envKeyInput.value).toBe("OPENAI_API_KEY");

    await act(async () => {
      agentSelect.click();
    });
    await flushReact();

    // Agents that already have access are not offered again.
    expect(document.body.textContent).toContain("CodexCoder");
    expect(document.body.querySelector('[aria-label="Select Reviewer"]')).toBeNull();

    await act(async () => {
      (document.body.querySelector('[aria-label="Select CodexCoder"]') as HTMLButtonElement | null)?.click();
    });
    await flushReact();

    const addButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Add",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      addButton?.click();
    });
    await flushReact();
    await flushReact();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "agent-coder",
      {
        adapterConfig: {
          env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai" } },
        },
        replaceAdapterConfig: true,
      },
      "company-1",
    );

    const revokeButton = document.body.querySelector(
      'button[aria-label="Remove access for Reviewer"]',
    ) as HTMLButtonElement | null;
    expect(revokeButton).not.toBeNull();
    await act(async () => {
      revokeButton?.click();
    });
    await flushReact();
    await flushReact();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "agent-reviewer",
      { adapterConfig: { env: {} }, replaceAdapterConfig: true },
      "company-1",
    );

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

describe("Secrets folder view (PAP-14698)", () => {
  let container: HTMLDivElement;

  function seedFolderSecrets() {
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({ id: "s1", key: "dev_github_oauth_clientid", name: "dev/github/oauth/clientid" }),
      makeCompanySecret({ id: "s2", key: "dev_github_oauth_clientsecret", name: "dev/github/oauth/clientsecret" }),
      makeCompanySecret({ id: "s3", key: "prod_api_token", name: "prod/api/token" }),
      makeCompanySecret({ id: "s4", key: "standalone", name: "standalone" }),
    ]);
    mockSecretsApi.providers.mockResolvedValue(providers);
    mockSecretsApi.providerHealth.mockResolvedValue({ providers: [] });
    mockSecretsApi.providerConfigs.mockResolvedValue(providerConfigs);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([]);
    mockSecretsApi.userSecretDefinitionCoverage.mockResolvedValue(userSecretCoverage);
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
  }

  async function renderAt(path: string) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={queryClient}>
            <Secrets />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
    seedFolderSecrets();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("derives folders at the root with filtered counts and a flat standalone secret", async () => {
    const root = await renderAt("/");

    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    expect(table.textContent).toContain("dev");
    expect(table.textContent).toContain("prod");
    expect(table.textContent).toContain("standalone");
    // dev groups both oauth secrets recursively; github and oauth are descendant folders.
    expect(table.textContent).toContain("2 secrets · 2 folders");
    expect(table.textContent).toContain("1 secret · 1 folder");
    // Folder rows are real links carrying ?path=.
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(links.some((href) => href.includes("path=dev"))).toBe(true);

    await act(async () => root.unmount());
  });

  it("opens a deep ?path= link into the folder with breadcrumb, leaves, and an up affordance", async () => {
    const root = await renderAt("/?path=dev/github/oauth");

    const breadcrumb = container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(breadcrumb).not.toBeNull();
    const current = container.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain("oauth");

    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    expect(table.textContent).toContain("clientid");
    expect(table.textContent).toContain("clientsecret");
    expect(table.textContent).toContain("Up to github");
    // Sibling trees are not shown while drilled in.
    expect(table.textContent).not.toContain("standalone");

    await act(async () => root.unmount());
  });

  it("renders the empty-folder state (breadcrumb intact) for an unknown path", async () => {
    const root = await renderAt("/?path=does/not/exist");

    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull();
    expect(container.textContent).toContain("No secrets in this folder yet.");
    const cta = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("New secret here"),
    ) as HTMLButtonElement;
    expect(cta).toBeDefined();
    await act(async () => cta.click());
    await flushReact();

    expect(document.body.textContent).toContain("does/not/exist/");
    expect((document.getElementById("new-secret-name") as HTMLInputElement).value).toBe("");
    expect(document.querySelector('button[aria-label="Remove folder prefix"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("distinguishes a filtered-empty folder from a genuinely empty folder", async () => {
    const root = await renderAt("/?path=dev/github/oauth");
    const filterButton = document.querySelector('button[title="Filter"]') as HTMLButtonElement;
    await act(async () => filterButton.click());
    await flushReact();

    const archivedLabel = [...document.querySelectorAll("label")].find(
      (label) => label.textContent?.trim() === "Archived",
    ) as HTMLLabelElement;
    await act(async () => archivedLabel.click());
    await waitForReact(() => container.textContent?.includes("No secrets match your filters.") ?? false);

    expect(container.textContent).toContain("No secrets match your filters.");
    expect(container.textContent).not.toContain("New secret here");

    await act(async () => root.unmount());
  });

  it("creates a company secret from a folder prefix and derives the key from the full name", async () => {
    mockSecretsApi.create.mockResolvedValue(
      makeCompanySecret({ id: "created", name: "dev/github/oauth/clientsecret/deeper" }),
    );
    const root = await renderAt("/?path=dev/github/oauth");

    const newSecretButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New secret",
    ) as HTMLButtonElement;
    await act(async () => newSecretButton.click());
    await flushReact();

    expect(document.body.textContent).toContain("dev/github/oauth/");
    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    expect(nameInput.placeholder).toBe("clientsecret");
    expect(nameInput.value).toBe("");
    await act(async () => setInputValue(nameInput, "clientsecret/deeper"));
    await flushReact();

    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe(
      "dev-github-oauth-clientsecret-deeper",
    );
    await act(async () =>
      setTextareaValue(document.getElementById("new-secret-value") as HTMLTextAreaElement, "secret-value"),
    );
    const createButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create secret",
    ) as HTMLButtonElement;
    await act(async () => createButton.click());
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "dev/github/oauth/clientsecret/deeper" }),
    );

    await act(async () => root.unmount());
  });

  it("keeps the folder prefix for Each user and exposes the full name when the chip is removed", async () => {
    const root = await renderAt("/?path=dev/github/oauth");
    const newSecretButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New secret",
    ) as HTMLButtonElement;
    await act(async () => newSecretButton.click());
    await flushReact();

    const eachUserTab = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Each user",
    ) as HTMLButtonElement;
    await act(async () => {
      eachUserTab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      eachUserTab.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      eachUserTab.click();
    });
    await flushReact();

    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    await act(async () => setInputValue(nameInput, "personal-token"));
    await flushReact();
    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe(
      "DEV_GITHUB_OAUTH_PERSONAL_TOKEN",
    );

    const removePrefix = document.querySelector(
      'button[aria-label="Remove folder prefix"]',
    ) as HTMLButtonElement;
    await act(async () => removePrefix.click());
    await flushReact();
    expect((document.getElementById("new-secret-name") as HTMLInputElement).value).toBe(
      "dev/github/oauth/personal-token",
    );
    expect(document.querySelector('button[aria-label="Remove folder prefix"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("validates New folder inline and stages the trimmed segment in the URL-backed folder view", async () => {
    const root = await renderAt("/?path=dev/github/oauth");
    const newFolderButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New folder",
    ) as HTMLButtonElement;
    await act(async () => newFolderButton.click());
    await flushReact();

    const folderInput = container.querySelector('input[aria-label="Folder name"]') as HTMLInputElement;
    await act(async () => setInputValue(folderInput, "bad/name"));
    const createFolderButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create folder",
    ) as HTMLButtonElement;
    await act(async () => createFolderButton.click());
    await flushReact();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Folder name cannot contain slashes.",
    );

    await act(async () => setInputValue(folderInput, "  staged  "));
    await flushReact();
    await act(async () => createFolderButton.click());
    await waitForReact(() =>
      [...container.querySelectorAll('[aria-current="page"]')].some((node) =>
        node.textContent?.includes("staged"),
      ),
    );

    expect(
      [...container.querySelectorAll('[aria-current="page"]')].some((node) =>
        node.textContent?.includes("staged"),
      ),
    ).toBe(true);
    expect(container.textContent).toContain("No secrets in this folder yet.");
    expect(container.querySelector('input[aria-label="Folder name"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("creates a company secret from a folder prefix and derives the key from the full name", async () => {
    mockSecretsApi.create.mockResolvedValue(
      makeCompanySecret({ id: "created", name: "dev/github/oauth/clientsecret/deeper" }),
    );
    const root = await renderAt("/?path=dev/github/oauth");

    const newSecretButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New secret",
    ) as HTMLButtonElement;
    await act(async () => newSecretButton.click());
    await flushReact();

    expect(document.body.textContent).toContain("dev/github/oauth/");
    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    expect(nameInput.placeholder).toBe("clientsecret");
    expect(nameInput.value).toBe("");
    await act(async () => setInputValue(nameInput, "clientsecret/deeper"));
    await flushReact();

    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe(
      "dev-github-oauth-clientsecret-deeper",
    );
    await act(async () =>
      setTextareaValue(document.getElementById("new-secret-value") as HTMLTextAreaElement, "secret-value"),
    );
    const createButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create secret",
    ) as HTMLButtonElement;
    await act(async () => createButton.click());
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "dev/github/oauth/clientsecret/deeper" }),
    );

    await act(async () => root.unmount());
  });

  it("keeps the folder prefix for Each user and exposes the full name when the chip is removed", async () => {
    const root = await renderAt("/?path=dev/github/oauth");
    const newSecretButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New secret",
    ) as HTMLButtonElement;
    await act(async () => newSecretButton.click());
    await flushReact();

    const eachUserTab = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Each user",
    ) as HTMLButtonElement;
    await act(async () => {
      eachUserTab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      eachUserTab.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      eachUserTab.click();
    });
    await flushReact();

    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    await act(async () => setInputValue(nameInput, "personal-token"));
    await flushReact();
    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe(
      "DEV_GITHUB_OAUTH_PERSONAL_TOKEN",
    );

    const removePrefix = document.querySelector(
      'button[aria-label="Remove folder prefix"]',
    ) as HTMLButtonElement;
    await act(async () => removePrefix.click());
    await flushReact();
    expect((document.getElementById("new-secret-name") as HTMLInputElement).value).toBe(
      "dev/github/oauth/personal-token",
    );
    expect(document.querySelector('button[aria-label="Remove folder prefix"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("validates New folder inline and stages the trimmed segment in the URL-backed folder view", async () => {
    const root = await renderAt("/?path=dev/github/oauth");
    const newFolderButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New folder",
    ) as HTMLButtonElement;
    await act(async () => newFolderButton.click());
    await flushReact();

    const folderInput = container.querySelector('input[aria-label="Folder name"]') as HTMLInputElement;
    await act(async () => setInputValue(folderInput, "bad/name"));
    const createFolderButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create folder",
    ) as HTMLButtonElement;
    await act(async () => createFolderButton.click());
    await flushReact();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Folder name cannot contain slashes.",
    );

    await act(async () => setInputValue(folderInput, "  staged  "));
    await flushReact();
    await act(async () => createFolderButton.click());
    await waitForReact(() =>
      [...container.querySelectorAll('[aria-current="page"]')].some((node) =>
        node.textContent?.includes("staged"),
      ),
    );

    expect(
      [...container.querySelectorAll('[aria-current="page"]')].some((node) =>
        node.textContent?.includes("staged"),
      ),
    ).toBe(true);
    expect(container.textContent).toContain("No secrets in this folder yet.");
    expect(container.querySelector('input[aria-label="Folder name"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("Flat toggle reproduces the raw, ungrouped list", async () => {
    const root = await renderAt("/");

    const flatButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim().toLowerCase() === "flat",
    ) as HTMLButtonElement | undefined;
    expect(flatButton).toBeDefined();
    await act(async () => flatButton!.click());
    await flushReact();

    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    expect(table.textContent).toContain("dev/github/oauth/clientid");
    expect(table.textContent).not.toContain("2 secrets · 1 folder");

    await act(async () => root.unmount());
  });

  it("search is global across folders and shows full muted-path names", async () => {
    const root = await renderAt("/?path=dev/github/oauth");

    const input = container.querySelector(
      'input[aria-label="Search secrets"]',
    ) as HTMLInputElement;
    await act(async () => setInputValue(input, "token"));
    await flushReact();

    expect(container.textContent).toContain("Search results");
    expect(container.textContent).toContain("across all folders");
    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    // prod/api/token lives outside the current folder yet still matches.
    expect(table.textContent).toContain("prod/api/");
    expect(table.textContent).toContain("token");

    await act(async () => root.unmount());
  });
});
