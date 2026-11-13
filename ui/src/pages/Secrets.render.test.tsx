// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot as createReactRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  CompanySecret,
  CompanySecretProviderConfig,
  RemoteSecretImportPreviewResult,
  SecretAccessEvent,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretProviderDescriptor,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderVaultsTab, Secrets } from "./Secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

// Counts origin classification, the per-row work of the managed grouping, and
// throws above a limit so a runaway render fails at once.
const originWork = vi.hoisted(() => ({ calls: 0, limit: Number.POSITIVE_INFINITY }));

vi.mock("./secrets/secret-origin", async () => {
  const actual = await vi.importActual<typeof import("./secrets/secret-origin")>("./secrets/secret-origin");
  return {
    ...actual,
    classifySecretOrigin: (input: Parameters<typeof actual.classifySecretOrigin>[0]) => {
      originWork.calls += 1;
      if (originWork.calls > originWork.limit) {
        throw new Error(`classifySecretOrigin ran ${originWork.calls} times; the limit is ${originWork.limit}`);
      }
      return actual.classifySecretOrigin(input);
    },
  };
});

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
  listProposals: vi.fn(),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
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

// Menus are Radix portals; render them inline so their items are reachable in jsdom.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} data-testid={testId} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Radix checkboxes and popovers measure themselves; jsdom has no ResizeObserver.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

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
    supportsExternalValueWrites: true,
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

const activeRoots = new Set<Root>();

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void>;
  flushSync(() => {
    result = callback();
  });
  await result!;
}

function createRoot(container: Element | DocumentFragment) {
  const root = createReactRoot(container);
  const unmount = root.unmount.bind(root);
  root.unmount = () => {
    if (!activeRoots.delete(root)) return;
    unmount();
  };
  activeRoots.add(root);
  return root;
}

function unmountActiveRoots() {
  for (const root of [...activeRoots]) root.unmount();
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

const bodyText = () => document.body.textContent ?? "";
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const detailsPanel = () => document.querySelector('[data-testid="secret-details"]') as HTMLElement | null;
const openDialog = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .filter(
      (node) =>
        node.getAttribute("data-testid") !== "secret-details" &&
        node.getAttribute("data-slot") !== "popover-content",
    )
    .at(-1) ?? null;
const teamTable = () => document.querySelector('[data-testid="secrets-table-view"]') as HTMLElement | null;

/** A button, tab, radio or menu item by its visible text (exact unless `partial`). */
function findControl(label: string, root: ParentNode | null = document.body, partial = false) {
  return [...(root?.querySelectorAll<HTMLElement>('button, [role="tab"], [role="menuitem"]') ?? [])].find((node) => {
    const text = node.textContent?.trim() ?? "";
    return partial ? text.includes(label) : text === label;
  });
}

async function click(node: Element | null | undefined) {
  expect(node, "expected something to click").toBeTruthy();
  await act(async () => {
    (node as HTMLElement).click();
  });
  await flushReact();
}

/** Radix tabs and triggers activate on pointerdown/keydown rather than click. */
async function press(node: Element | null | undefined) {
  expect(node, "expected something to press").toBeTruthy();
  await act(async () => {
    node!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    node!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    (node as HTMLElement).click();
  });
  await flushReact();
}

async function openTab(label: string) {
  await press(
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith(label)),
  );
}

async function openNewSecret() {
  await click(document.querySelector("button[data-toolbar-primary]"));
}

async function typeInto(id: string, value: string) {
  const field = byId<HTMLInputElement | HTMLTextAreaElement>(id);
  expect(field, `expected a field with id ${id}`).not.toBeNull();
  await act(async () => {
    if (field instanceof HTMLTextAreaElement) setTextareaValue(field, value);
    else setInputValue(field as HTMLInputElement, value);
  });
  await flushReact();
}

async function submitNewSecret(label = "Create secret") {
  await click(findControl(label, openDialog()));
  await flushReact();
}

async function chooseWhoProvides(label: "Organization" | "Each user") {
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) => radio.textContent?.includes(label)),
  );
}

async function openMoreOptions() {
  await click(findControl("More options", openDialog()));
}

function teamRow(name: string) {
  return [...(teamTable()?.querySelectorAll<HTMLElement>('[role="row"]') ?? [])].find((row) =>
    row.textContent?.includes(name),
  );
}

async function chooseFilter(label: string) {
  const option = () =>
    [...document.querySelectorAll("label")]
      .find((node) => node.textContent?.trim() === label)
      ?.querySelector('input[type="radio"]');
  if (!option()) await click(findControl("Filter"));
  await click(option());
}

async function openAwsVaultDialog() {
  await openTab("Vaults");
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "AWS Secrets Manager",
    ),
  );
}

async function openNamingAndTags() {
  await click(findControl("Naming and tags", openDialog()));
}

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return { status: "active", adapterConfig: {}, ...overrides } as Agent;
}

function secretRef(secretId: string) {
  return { type: "secret_ref", secretId };
}

function makeAccessEvent(index: number, overrides: Partial<SecretAccessEvent> = {}): SecretAccessEvent {
  return {
    id: `event-${index}`,
    companyId: "company-1",
    secretId: "secret-openai",
    userSecretDefinitionId: null,
    secretScope: "company",
    version: 1,
    provider: "local_encrypted",
    responsibleUserId: null,
    credentialOwnerUserId: null,
    credentialSubjectType: null,
    credentialSubjectId: null,
    actorType: "agent",
    actorId: "agent-coder",
    consumerType: "agent",
    consumerId: "agent-coder",
    configPath: "env.OPENAI_API_KEY",
    issueId: null,
    heartbeatRunId: null,
    pluginId: null,
    outcome: "success",
    errorCode: null,
    createdAt: new Date(Date.UTC(2026, 4, 6, 0, index)),
    ...overrides,
  } as SecretAccessEvent;
}

function makeProviderConfig(
  overrides: Partial<CompanySecretProviderConfig> & Pick<CompanySecretProviderConfig, "id" | "provider">,
): CompanySecretProviderConfig {
  return {
    companyId: "company-1",
    displayName: overrides.id,
    status: "ready",
    isDefault: false,
    config: {},
    healthStatus: null,
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
    disabledAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as CompanySecretProviderConfig;
}

function seedDefaults() {
  mockSecretsApi.list.mockResolvedValue([]);
  mockSecretsApi.providers.mockResolvedValue(providers);
  mockSecretsApi.providerHealth.mockResolvedValue({ providers: [] });
  mockSecretsApi.providerConfigs.mockResolvedValue(providerConfigs);
  mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValue(makeDiscoveryPreview());
  mockSecretsApi.checkProviderConfigHealth.mockResolvedValue({ status: "ok", message: "Reachable" });
  mockSecretsApi.remoteImportPreview.mockResolvedValue(makeRemoteImportPreview());
  mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([]);
  mockSecretsApi.userSecretDefinitionCoverage.mockResolvedValue(userSecretCoverage);
  mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
  mockSecretsApi.listProposals.mockResolvedValue([]);
  mockSecretsApi.usage.mockResolvedValue({ secretId: "secret-openai", bindings: [] });
  mockSecretsApi.accessEvents.mockResolvedValue([]);
  mockAgentsApi.list.mockResolvedValue([]);
}

/** Creating a secret also makes it show up in the next list read, as it would on the server. */
function resolveCreateWith(secret: CompanySecret) {
  mockSecretsApi.create.mockImplementation(async () => {
    mockSecretsApi.list.mockResolvedValue([secret]);
    return secret;
  });
}

function renderVaultsTab(
  container: HTMLDivElement,
  props: Partial<Parameters<typeof ProviderVaultsTab>[0]> = {},
) {
  const handlers = {
    onRetry: vi.fn(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDisable: vi.fn(),
    onEnable: vi.fn(),
    onRemove: vi.fn(),
    onSetDefault: vi.fn(),
    onHealthCheck: vi.fn(),
    onImportSecrets: vi.fn(),
  };
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <ProviderVaultsTab
        providers={providers}
        providerConfigs={providerConfigs as CompanySecretProviderConfig[]}
        loading={false}
        error={null}
        pendingActionId={null}
        {...handlers}
        {...props}
      />,
    );
  });
  return { root, handlers };
}

async function renderSecrets(
  container: HTMLDivElement,
  {
    path = "/",
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }: { path?: string; queryClient?: QueryClient } = {},
) {
  const root = createRoot(container);
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

describe("Secrets page layout", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    seedDefaults();
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
  });

  afterEach(() => {
    unmountActiveRoots();
    container.remove();
    document.body.innerHTML = "";
    vi.resetAllMocks();
  });

  it("uses the shared search/filter affordances and one line of help instead of a banner", async () => {
    await renderSecrets(container);

    expect(container.querySelector('input[data-page-search-target="true"][aria-label="Search secrets"]')).not.toBeNull();
    expect(container.querySelector('[data-canonical-toolbar="secrets"]')).not.toBeNull();
    expect(container.textContent).toContain("API keys and tokens your agents use while they work.");
    expect(findControl("How secrets work", container, true)).toBeDefined();
    expect(container.textContent).not.toContain("Use secrets by binding them to runtime environment variables.");
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.textContent).not.toContain("Provider warnings detected");
    expect(findControl("Folders", container)).toBeUndefined();
    expect(findControl("Flat", container)).toBeUndefined();

    // New secret is the one primary action; folder and import live in the overflow menu.
    expect(document.querySelector("button[data-toolbar-primary]")?.textContent).toContain("New secret");
    expect(findControl("New folder")?.getAttribute("role")).toBe("menuitem");
    expect(findControl("Import from a vault")?.getAttribute("role")).toBe("menuitem");
  });

  it("opens the import dialog from the overflow menu", async () => {
    await renderSecrets(container);

    await click(findControl("Import from a vault"));
    await flushReact();

    expect(bodyText()).toContain("Import secrets from a vault");
  });

  it("imports existing AWS secrets from a vault's menu", async () => {
    await renderSecrets(container);
    await openTab("Vaults");

    await click(document.querySelector('[data-testid="provider-vault-refresh-secrets-vault-aws"]'));
    await flushReact();

    expect(bodyText()).toContain("Import secrets from a vault");
    expect(mockSecretsApi.remoteImportPreview).toHaveBeenCalledWith("company-1", {
      providerConfigId: "vault-aws",
      query: null,
      nextToken: null,
      pageSize: 50,
    });
  });

  it("warns that removing a vault only removes it from Paperclip", async () => {
    mockSecretsApi.removeProviderConfig.mockResolvedValueOnce(providerConfigs[1]);
    await renderSecrets(container);
    await openTab("Vaults");

    await click(findControl("Remove vault", document.querySelector('[data-testid="provider-vault-vault-aws"]')));

    const dialog = openDialog();
    expect(dialog?.textContent).toContain("Remove AWS production");
    expect(dialog?.textContent).toContain("from Paperclip only");
    expect(dialog?.textContent).toContain("Nothing is deleted in AWS.");

    await click(findControl("Remove vault", dialog));

    expect(mockSecretsApi.removeProviderConfig).toHaveBeenCalledWith("vault-aws");
    expect(mockSecretsApi.disableProviderConfig).not.toHaveBeenCalled();
  });

  it("shows agents, other places, details and activity in one scrolling panel", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "CodexCoder", adapterConfig: { env: { OPENAI_API_KEY: secretRef("secret-openai") } } }),
    ]);
    const binding = {
      companyId: "company-1",
      secretId: "secret-openai",
      versionSelector: "latest",
      required: true,
      label: null,
      createdAt: new Date("2026-05-06T00:00:00.000Z"),
      updatedAt: new Date("2026-05-06T00:00:00.000Z"),
    };
    mockSecretsApi.usage.mockResolvedValue({
      secretId: "secret-openai",
      bindings: [
        {
          ...binding,
          id: "binding-agent",
          targetType: "agent",
          targetId: "agent-1",
          configPath: "env.OPENAI_API_KEY",
          target: { type: "agent", id: "agent-1", label: "CodexCoder", href: "/agents/codexcoder", status: "idle" },
        },
        {
          ...binding,
          id: "binding-project",
          targetType: "project",
          targetId: "project-1",
          configPath: "env.OPENAI_API_KEY",
          target: { type: "project", id: "project-1", label: "Billing", href: "/projects/billing", status: null },
        },
      ],
    });
    await renderSecrets(container);

    expect(container.querySelector('button[aria-label="Actions for OPENAI_API_KEY"]')).not.toBeNull();
    await click(teamRow("OPENAI_API_KEY"));
    await waitForReact(() => detailsPanel()?.querySelector('[aria-label="Also set in"]') != null);

    const panel = detailsPanel()!;
    expect(mockSecretsApi.usage).toHaveBeenCalledWith("secret-openai");
    expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(panel.textContent).not.toContain("View in Usage");
    expect([...panel.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Agents that can use it",
      "Also set in",
      "Details",
      "Activity",
    ]);

    const agents = panel.querySelector('[aria-label="Agents that can use it"]')!;
    expect(agents.textContent).toContain("CodexCoder");
    expect(agents.textContent).toContain("OPENAI_API_KEY");

    // The agent is already listed above, so "Also set in" only names the rest.
    const elsewhere = panel.querySelector('[aria-label="Also set in"]')!;
    expect(elsewhere.textContent).toContain("Billing");
    expect(elsewhere.textContent).toContain("env.OPENAI_API_KEY");
    expect(elsewhere.textContent).not.toContain("CodexCoder");
    expect(elsewhere.textContent).not.toContain("project-1");
  });

  it("caps activity at five entries until asked for the rest", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-coder", name: "CodexCoder" })]);
    mockSecretsApi.accessEvents.mockResolvedValue([
      makeAccessEvent(0, { outcome: "not_allowed" }),
      ...[1, 2, 3, 4, 5, 6].map((index) => makeAccessEvent(index)),
    ]);
    await renderSecrets(container, { path: "/company/settings/secrets?secret=secret-openai" });
    await waitForReact(() => findControl("Show all activity", detailsPanel()) != null);

    const activity = detailsPanel()!.querySelector('[aria-label="Activity"]')!;
    expect(activity.querySelectorAll("li")).toHaveLength(5);
    // Raw agent ids are resolved to names, and a refusal reads as one.
    expect(activity.textContent).toContain("CodexCoder was refused: no access");
    expect(activity.textContent).toContain("CodexCoder used it");
    expect(activity.textContent).not.toContain("agent-coder");

    await click(findControl("Show all activity", activity));

    expect(activity.querySelectorAll("li")).toHaveLength(7);
    expect(findControl("Show all activity", activity)).toBeUndefined();
  });

  it("opens the secret detail sheet from a ?secret= deep link", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);

    await renderSecrets(container, { path: "/company/settings/secrets?secret=secret-openai" });

    // The detail sheet is open without any clicks: the deep link drives selection.
    const panel = detailsPanel();
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.textContent).toContain("OPENAI_API_KEY");
    expect(panel?.textContent).toContain("openai_api_key");
    expect(findControl("Copy link", panel)).toBeDefined();
    expect(panel?.textContent).toContain("No agent can use this secret yet.");
  });

  it("writes a new value through the provider for external reference secrets", async () => {
    const externalSecret = makeCompanySecret({
      id: "secret-neon",
      key: "neon_admin_api_key",
      name: "paperclip-cloud/prod/provider/neon/admin-api-key",
      provider: "aws_secrets_manager",
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip-cloud/prod/provider/neon/admin-api-key",
      providerConfigId: "vault-aws",
    });
    mockSecretsApi.list.mockResolvedValue([externalSecret]);
    mockSecretsApi.rotate.mockResolvedValue({ ...externalSecret, latestVersion: 2 });

    await renderSecrets(container, { path: "/company/settings/secrets?secret=secret-neon" });

    // The panel names the vault the secret is linked from.
    expect(detailsPanel()?.textContent).toContain("Linked from");
    expect(detailsPanel()?.textContent).toContain("AWS production · AWS Secrets Manager");

    // AWS supports write-through, so the primary action replaces the value.
    await click(findControl("Replace value", detailsPanel()));

    // Both modes are offered; replacing the value is the default.
    const dialog = openDialog()!;
    expect(dialog.textContent).toContain("Replace value");
    expect(dialog.textContent).toContain("Change reference");

    await typeInto("rotate-value", "rotated-neon-admin-key");
    const submitButton = findControl("Save new value", dialog) as HTMLButtonElement | undefined;
    expect(submitButton?.disabled).toBe(false);
    await click(submitButton);

    expect(mockSecretsApi.rotate).toHaveBeenCalledWith("secret-neon", {
      value: "rotated-neon-admin-key",
      providerConfigId: "vault-aws",
    });
  });

  it("merges company secrets and each-user definitions into the Secrets list", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret({ referenceCount: 0 })]);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([makeUserSecretDefinition()]);
    await renderSecrets(container);

    const tableView = teamTable()!;
    expect([...tableView.querySelectorAll('[role="columnheader"]')].map((header) => header.textContent)).toEqual([
      "Name",
      "Provided by",
      "Used by",
      "Updated",
      "Actions",
    ]);
    expect(teamRow("OPENAI_API_KEY")?.textContent).toContain("Organization");
    expect(teamRow("Personal GitHub token")?.textContent).toContain("Each user · 3 of 5 added");
    // Rows no longer repeat the key, the always-on status, the version or the storage mode.
    expect(tableView.textContent).not.toContain("openai_api_key");
    expect(tableView.textContent).not.toContain("PERSONAL_GH_TOKEN");
    expect(tableView.textContent).not.toContain("Active");
    expect(tableView.textContent).not.toContain("v1");
    expect(tableView.textContent).not.toContain("managed");
    expect(container.textContent).not.toContain("User secret definitions");

    const listContainer = container.querySelector('[data-testid="secrets-list-container"]');
    expect(listContainer?.parentElement?.className).not.toContain("overflow-y-auto");
    const cardView = container.querySelector('[data-testid="secrets-card-view"]');
    expect(listContainer?.className).toContain("@container");
    expect(tableView.className).toContain("@min-[40rem]:block");
    expect(tableView.className).not.toContain("md:block");
    // Grid template lives in the token layer: --gtc-54 in ui/src/index.css.
    expect(tableView.querySelector("[role='row']")?.className).toContain("grid-cols-(--gtc-54)");
    expect(cardView?.className).toContain("@min-[40rem]:hidden");
    expect(cardView?.className).not.toContain("md:hidden");

    expect(mockSecretsApi.list).toHaveBeenCalledWith("company-1");
    expect(mockSecretsApi.listUserSecretDefinitions).toHaveBeenCalledWith("company-1");
  });

  it("shows who uses each secret from the agents' own configs", async () => {
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({ id: "s-one", key: "one", name: "ONE_AGENT", referenceCount: 1 }),
      makeCompanySecret({ id: "s-two", key: "two", name: "TWO_AGENTS", referenceCount: 2 }),
      makeCompanySecret({ id: "s-none", key: "none", name: "UNUSED", referenceCount: 0 }),
      makeCompanySecret({ id: "s-project", key: "project", name: "PROJECT_ONLY", referenceCount: 3 }),
      makeCompanySecret({ id: "s-linked", key: "linked", name: "LINKED", provider: "aws_secrets_manager",
        managedMode: "external_reference", externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:x",
        providerConfigId: "vault-aws", referenceCount: 0 }),
    ]);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([makeUserSecretDefinition()]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-coder",
        name: "CodexCoder",
        adapterConfig: {
          env: {
            ONE_AGENT: secretRef("s-one"),
            TWO_AGENTS: secretRef("s-two"),
            GH: { type: "user_secret_ref", key: "PERSONAL_GH_TOKEN" },
          },
        },
      }),
      makeAgent({ id: "agent-reviewer", name: "Reviewer", adapterConfig: { "access.SHARED": secretRef("s-two") } }),
      makeAgent({ id: "agent-gone", name: "Retired", status: "terminated", adapterConfig: { env: { X: secretRef("s-none") } } }),
    ]);
    await renderSecrets(container);

    expect(mockAgentsApi.list).toHaveBeenCalledWith("company-1");
    expect(teamRow("ONE_AGENT")?.textContent).toContain("CodexCoder");
    expect(teamRow("TWO_AGENTS")?.textContent).toContain("2 agents");
    expect(teamRow("TWO_AGENTS")?.querySelectorAll('[data-slot="agent-avatar"]')).toHaveLength(2);
    expect(teamRow("UNUSED")?.textContent).toContain("Not used yet");
    expect(teamRow("PROJECT_ONLY")?.textContent).toContain("Set in 3 places");
    expect(teamRow("Personal GitHub token")?.textContent).toContain("CodexCoder");
    // Only a secret kept outside Paperclip's own storage names its vault.
    expect(teamRow("LINKED")?.textContent).toContain("Linked from AWS production · AWS Secrets Manager");
    expect(teamRow("UNUSED")?.textContent).not.toContain("Stored in");
  });

  it("keeps Paperclip's own secrets out of the team list, grouped and collapsed", async () => {
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret(),
      makeCompanySecret({ id: "s-chat", key: "chat_slack_5c860bfd_bottoken_565d9081", name: "chat.slack.5c860bfd.botToken.565d9081" }),
      makeCompanySecret({
        id: "s-neon",
        key: "tool_app.500df1ea-4b23-4c24-93a4-c9802c893448.oauth_access_token",
        name: "Neon for the organization OAuth access token 80255b18",
      }),
      makeCompanySecret({
        id: "s-routine",
        key: "routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29",
        name: "routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29",
      }),
    ]);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([
      makeUserSecretDefinition({
        id: "def-github-oauth",
        key: "tool_oauth.9ad19afd-323d-47c7-8b95-3d58fda94dcf.oauth_access_token",
        name: "GitHub access token",
      }),
    ]);
    await renderSecrets(container);

    expect(teamTable()?.textContent).toContain("OPENAI_API_KEY");
    expect(teamTable()?.textContent).not.toContain("chat.slack");
    expect(teamTable()?.textContent).not.toContain("Neon");
    expect(teamTable()?.textContent).not.toContain("GitHub access token");

    const section = container.querySelector('[data-testid="managed-secrets"]') as HTMLElement;
    const toggle = section.querySelector("button") as HTMLButtonElement;
    expect(toggle.textContent).toContain("Managed by Paperclip");
    expect(toggle.textContent).toContain("4");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(section.querySelector('[data-testid^="managed-secret-group-"]')).toBeNull();

    await click(toggle);

    expect(
      [...section.querySelectorAll('[data-testid^="managed-secret-group-"]')].map((group) =>
        group.getAttribute("data-testid"),
      ),
    ).toEqual(["managed-secret-group-connections", "managed-secret-group-chat", "managed-secret-group-routines"]);
    const connections = section.querySelector('[data-testid="managed-secret-group-connections"]') as HTMLElement;
    expect(connections.textContent).toContain("2 secrets");
    expect(section.textContent).not.toContain("Slack bot token");

    await click(section.querySelector('[data-testid="managed-secret-group-chat"] button'));
    await click(connections.querySelector("button"));
    await click(section.querySelector('[data-testid="managed-secret-group-routines"] button'));

    // Record ids give way to what each secret is for.
    expect(section.textContent).toContain("Slack bot token");
    expect(section.textContent).toContain("Neon for the organization OAuth access token");
    expect(section.textContent).toContain("GitHub access token");
    expect(section.textContent).toContain("Routine webhook secret");
    expect(section.textContent).not.toContain("565d9081");
    expect(section.textContent).not.toContain("80255b18");
    expect(section.textContent).not.toContain("604ffeed");
    expect(connections.textContent).toContain("Each user");
  });

  it("opens the managed section for a search and hides it inside a folder", async () => {
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({ id: "s-dev", key: "dev_api", name: "dev/api" }),
      makeCompanySecret({ id: "s-chat", key: "chat_slack_5c860bfd_bottoken_565d9081", name: "chat.slack.5c860bfd.botToken.565d9081" }),
    ]);
    const root = await renderSecrets(container);

    await act(async () =>
      setInputValue(container.querySelector('input[aria-label="Search secrets"]') as HTMLInputElement, "slack"),
    );
    await flushReact();

    const section = container.querySelector('[data-testid="managed-secrets"]') as HTMLElement;
    expect(section.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(section.textContent).toContain("Slack bot token");
    expect(container.textContent).toContain("None of the secrets your team added match.");

    await act(async () => root.unmount());
    const inFolder = document.createElement("div");
    document.body.appendChild(inFolder);
    await renderSecrets(inFolder, { path: "/?path=dev" });

    expect(inFolder.querySelector('[data-testid="secrets-table-view"]')?.textContent).toContain("api");
    expect(inFolder.querySelector('[data-testid="managed-secrets"]')).toBeNull();
  });

  it("lists active and disabled secrets by default and archived ones on request", async () => {
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret(),
      makeCompanySecret({ id: "s-off", key: "legacy", name: "LEGACY_DSN", status: "disabled" }),
      makeCompanySecret({ id: "s-old", key: "heroku", name: "HEROKU_API_KEY", status: "archived" }),
    ]);
    await renderSecrets(container);

    expect(teamRow("OPENAI_API_KEY")).toBeDefined();
    expect(teamRow("LEGACY_DSN")?.textContent).toContain("Disabled");
    expect(teamRow("HEROKU_API_KEY")).toBeUndefined();
    expect(container.querySelector('button[aria-label^="Remove filter"]')).toBeNull();

    await chooseFilter("Archived");

    expect(teamRow("HEROKU_API_KEY")?.textContent).toContain("Archived");
    expect(teamRow("OPENAI_API_KEY")).toBeUndefined();

    await click(container.querySelector('button[aria-label="Remove filter Archived"]'));

    expect(teamRow("OPENAI_API_KEY")).toBeDefined();
    expect(teamRow("HEROKU_API_KEY")).toBeUndefined();

    await chooseFilter("Each user");

    expect(container.querySelector('button[aria-label="Remove filter Each user"]')).not.toBeNull();
    expect(container.textContent).toContain("No secrets match your filters.");
  });

  it("keeps the loaded secrets list visible when a refetch fails during an outage", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await renderSecrets(container, { queryClient });
    expect(container.textContent).toContain("OPENAI_API_KEY");

    mockSecretsApi.list.mockRejectedValue(
      new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list("company-1") });
    });
    await flushReact();
    await flushReact();

    expect(mockSecretsApi.list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("OPENAI_API_KEY");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
  });

  it("shows readable copy and a Retry button when the secrets list fails to load", async () => {
    mockSecretsApi.list
      .mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }))
      .mockResolvedValue([makeCompanySecret()]);
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
    await waitForReact(() => container.querySelector('[data-query-view="error"]') !== null);

    const errorState = container.querySelector('[data-query-view="error"]');
    expect(errorState?.textContent).toContain("Couldn't load secrets");
    expect(errorState?.textContent).toContain("Boom");
    expect(container.querySelector('[data-testid="secrets-list-container"]')).toBeNull();
    const retryButton = [...(errorState?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Retry"),
    ) as HTMLButtonElement | undefined;
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.click();
    });
    await waitForReact(() => container.textContent?.includes("OPENAI_API_KEY") ?? false);

    expect(mockSecretsApi.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  });

  it("keeps Create enabled and says what is missing", async () => {
    await renderSecrets(container);
    await openNewSecret();

    const dialog = openDialog()!;
    const createButton = findControl("Create secret", dialog) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    expect(dialog.querySelector('[role="alert"]')).toBeNull();

    await submitNewSecret();

    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("Give the secret a name.");
    expect(byId<HTMLInputElement>("new-secret-name")?.getAttribute("aria-invalid")).toBe("true");

    await typeInto("new-secret-name", "Linear API key");
    // The name is not an environment variable, so the dialog says what agents will read.
    expect(byId("new-secret-name-hint")?.textContent).toBe("Agents read it as LINEAR_API_KEY.");
    await submitNewSecret();

    expect(byId("new-secret-value-hint")?.textContent).toBe("Paste the value to store.");
    expect(byId("new-secret-value-hint")?.getAttribute("role")).toBe("alert");
    expect(mockSecretsApi.create).not.toHaveBeenCalled();
  });

  it("keeps a value pasted into Value as it is, even when it looks like NAME=value", async () => {
    await renderSecrets(container);
    await openNewSecret();
    await typeInto("new-secret-name", "Signing key");

    // Base64 padding makes a raw credential look like an assignment.
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "abc123==" } });
    await act(async () => {
      byId("new-secret-value")!.dispatchEvent(paste);
    });
    await flushReact();

    expect(paste.defaultPrevented).toBe(false);
    expect(byId<HTMLInputElement>("new-secret-name")?.value).toBe("Signing key");
    expect(byId<HTMLTextAreaElement>("new-secret-value")?.value).toBe("");
  });

  it("fills name and value from a pasted NAME=value and masks the value until shown", async () => {
    await renderSecrets(container);
    await openNewSecret();

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => 'export GITHUB_TOKEN="ghp_example"' },
    });
    await act(async () => {
      byId("new-secret-name")!.dispatchEvent(paste);
    });
    await flushReact();

    expect(paste.defaultPrevented).toBe(true);
    expect(byId<HTMLInputElement>("new-secret-name")?.value).toBe("GITHUB_TOKEN");
    const value = byId<HTMLTextAreaElement>("new-secret-value")!;
    expect(value.value).toBe("ghp_example");

    expect(value.className).toContain("secret-value-masked");
    const toggle = openDialog()!.querySelector('button[aria-label="Show value"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await click(toggle);
    expect(value.className).not.toContain("secret-value-masked");
    expect(openDialog()!.querySelector('button[aria-label="Hide value"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("creates an each-user secret from the unified New secret dialog", async () => {
    const definition = makeUserSecretDefinition({ name: "Personal GitHub token" });
    mockSecretsApi.createUserSecretDefinition.mockResolvedValueOnce(definition);
    await renderSecrets(container);
    await openNewSecret();

    const radios = [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(byId("new-secret-value")).not.toBeNull();

    await chooseWhoProvides("Each user");

    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(byId("new-secret-provider")).toBeNull();
    expect(byId("new-secret-vault")).toBeNull();
    expect(byId("new-secret-value")).toBeNull();

    await typeInto("new-secret-name", "Personal GitHub token");
    await typeInto("new-secret-usage-guidance", "Create a fine-grained PAT with repo read access.");
    await openMoreOptions();
    expect(byId<HTMLInputElement>("new-secret-key")?.value).toBe("PERSONAL_GITHUB_TOKEN");

    await submitNewSecret();

    expect(mockSecretsApi.createUserSecretDefinition).toHaveBeenCalledWith("company-1", {
      name: "Personal GitHub token",
      description: null,
      usageGuidance: "Create a fine-grained PAT with repo read access.",
      key: "PERSONAL_GITHUB_TOKEN",
      status: "active",
    });
    expect(mockSecretsApi.create).not.toHaveBeenCalled();
  });

  it("opens the New secret dialog when provider queries fail", async () => {
    mockSecretsApi.providers.mockRejectedValueOnce(new ApiError("Providers unavailable", 403, null));
    mockSecretsApi.providerConfigs.mockRejectedValueOnce(new ApiError("Provider vaults unavailable", 403, null));
    await renderSecrets(container);
    await openNewSecret();

    expect(bodyText()).toContain("Create secret");
    expect(bodyText()).toContain("Select a provider.");
  });

  it("groups a large inventory with work proportional to its size, including while searching", async () => {
    const managed = Array.from({ length: 1700 }, (_, index) =>
      makeCompanySecret({
        id: `managed-${index}`,
        name: `chat.slack.${String(index).padStart(8, "0")}.botToken.565d9081`,
        key: `chat_slack_${index}_bottoken`,
      }),
    );
    const team = Array.from({ length: 300 }, (_, index) =>
      makeCompanySecret({ id: `team-${index}`, name: `team/SERVICE_${index}_KEY`, key: `service-${index}-key` }),
    );
    const total = managed.length + team.length;
    mockSecretsApi.list.mockResolvedValue([...managed, ...team]);
    mockAgentsApi.list.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) =>
        makeAgent({
          id: `agent-${index}`,
          name: `Agent ${index}`,
          adapterConfig: { env: Object.fromEntries(team.slice(index, index + 10).map((secret) => [`VAR_${secret.id}`, secretRef(secret.id)])) },
        }),
      ),
    );
    originWork.calls = 0;
    // Each row is classified once per change to the filtered list. Loading settles in a few such changes.
    originWork.limit = total * 4;
    try {
      await renderSecrets(container);
      await waitForReact(() => document.querySelector('[data-testid="managed-secrets"]') !== null);

      expect(originWork.calls).toBeGreaterThanOrEqual(total);
      expect(document.querySelector('[data-testid="managed-secrets"]')?.textContent).toContain("1700");

      // A search that matches a handful of rows classifies only the rows that match.
      originWork.calls = 0;
      originWork.limit = total;
      const search = document.querySelector<HTMLInputElement>('input[aria-label="Search secrets"]')!;
      await act(async () => setInputValue(search, "SERVICE_29"));
      await flushReact();

      // SERVICE_29 and SERVICE_290 to SERVICE_299.
      expect(bodyText()).toContain("11 matches across all folders");
      expect(originWork.calls).toBeLessThanOrEqual(total);
      expect(document.querySelector('[data-testid="managed-secrets"]')).toBeNull();
    } finally {
      originWork.limit = Number.POSITIVE_INFINITY;
    }
  });

  it("offers Stored in only when there is more than one place to store a secret", async () => {
    mockSecretsApi.providers.mockResolvedValue([providers[0], { ...providers[1], configured: false }]);
    mockSecretsApi.providerConfigs.mockResolvedValue([]);
    const root = await renderSecrets(container);
    await openNewSecret();

    expect(byId("new-secret-vault")).toBeNull();
    expect(byId("new-secret-value-hint")?.textContent).toContain("Encrypted and stored in Paperclip.");

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    const second = document.createElement("div");
    document.body.appendChild(second);
    mockSecretsApi.providers.mockResolvedValue(providers);
    mockSecretsApi.providerConfigs.mockResolvedValue([
      ...providerConfigs,
      makeProviderConfig({
        id: "vault-down",
        provider: "aws_secrets_manager",
        displayName: "staging-eu",
        healthStatus: "error",
        healthMessage: "AWS denied access.",
      }),
    ]);
    await renderSecrets(second);
    await openNewSecret();

    const select = byId<HTMLSelectElement>("new-secret-vault")!;
    expect(select.value).toBe("local_encrypted:vault-local");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Local default · Paperclip-encrypted (default)",
      "AWS production · AWS Secrets Manager",
      "staging-eu · AWS Secrets Manager — unavailable",
    ]);
    expect(byId("new-secret-value-hint")?.textContent).toBe("After saving it can be replaced, never viewed.");
  });

  it("refuses to create in storage that is unavailable and says why", async () => {
    mockSecretsApi.providers.mockResolvedValue([providers[0]]);
    mockSecretsApi.providerConfigs.mockResolvedValue([]);
    mockSecretsApi.providerHealth.mockResolvedValue({
      providers: [{ provider: "local_encrypted", status: "error", message: "The encryption key is missing." }],
    });
    await renderSecrets(container);
    await openNewSecret();
    await typeInto("new-secret-name", "GITHUB_TOKEN");
    await typeInto("new-secret-value", "ghp_example");

    expect(openDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Local encrypted health check failed: The encryption key is missing.",
    );
    const createButton = findControl("Create secret", openDialog()) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    await submitNewSecret();

    expect(mockSecretsApi.create).not.toHaveBeenCalled();
  });

  it("explains an unavailable vault in Stored in, blocks create, and leads to Vaults", async () => {
    mockSecretsApi.providerConfigs.mockResolvedValue([
      ...providerConfigs,
      makeProviderConfig({
        id: "vault-down",
        provider: "aws_secrets_manager",
        displayName: "staging-eu",
        healthStatus: "error",
        healthMessage: "AWS denied access.",
      }),
    ]);
    await renderSecrets(container);
    await openNewSecret();
    await typeInto("new-secret-name", "GITHUB_TOKEN");
    await typeInto("new-secret-value", "ghp_example");

    await act(async () => setSelectValue(byId<HTMLSelectElement>("new-secret-vault")!, "aws_secrets_manager:vault-down"));
    await flushReact();

    const select = byId<HTMLSelectElement>("new-secret-vault")!;
    expect(select.value).toBe("aws_secrets_manager:vault-down");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(byId("new-secret-vault-hint")?.textContent).toBe(
      "AWS denied access. Choose another vault, or fix it in Vaults.",
    );
    // Linking is not offered for a vault Paperclip cannot reach.
    expect(findControl("Use a secret that already exists", openDialog(), true)).toBeUndefined();

    await submitNewSecret();
    expect(mockSecretsApi.create).not.toHaveBeenCalled();

    await click(findControl("fix it in Vaults", openDialog()));

    expect(openDialog()).toBeNull();
    expect(container.querySelector('[data-testid="provider-vault-vault-down"]')?.textContent).toContain(
      "AWS denied access.",
    );
  });

  it("gives the chosen agents access as soon as the secret is created", async () => {
    const coder = makeAgent({ id: "agent-coder", name: "CodexCoder", adapterConfig: { model: "x", env: { OTHER: "1" } } });
    mockAgentsApi.list.mockResolvedValue([coder, makeAgent({ id: "agent-gone", name: "Retired", status: "terminated" })]);
    mockAgentsApi.get.mockResolvedValue(coder);
    mockAgentsApi.update.mockResolvedValue(coder);
    resolveCreateWith(makeCompanySecret({ id: "created", key: "linear-api-key", name: "Linear API key" }));
    await renderSecrets(container);
    await openNewSecret();
    await typeInto("new-secret-name", "Linear API key");
    await typeInto("new-secret-value", "lin_api_example");

    await click(findControl("Add agent", openDialog(), true));
    expect(document.querySelector('[aria-label="Allow Retired"]')).toBeNull();
    await click(document.querySelector('[aria-label="Allow CodexCoder"]'));
    expect(openDialog()?.querySelector('button[aria-label="Remove CodexCoder"]')).not.toBeNull();

    await submitNewSecret();
    await waitForReact(() => mockAgentsApi.update.mock.calls.length > 0);

    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Linear API key", value: "lin_api_example", managedMode: "paperclip_managed" }),
    );
    expect(mockAgentsApi.get).toHaveBeenCalledWith("agent-coder", "company-1");
    // The binding is merged into the agent's freshest config, named from the secret.
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "agent-coder",
      {
        adapterConfig: { model: "x", env: { OTHER: "1", LINEAR_API_KEY: secretRef("created") } },
        replaceAdapterConfig: true,
      },
      "company-1",
    );
    // The new secret opens in its details panel; that is the confirmation, not a toast.
    await waitForReact(() => detailsPanel() != null);
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("keeps the new secret and reports agents that could not be given access", async () => {
    const coder = makeAgent({ id: "agent-coder", name: "CodexCoder", adapterConfig: { env: { LINEAR_API_KEY: "taken" } } });
    mockAgentsApi.list.mockResolvedValue([coder]);
    mockAgentsApi.get.mockResolvedValue(coder);
    resolveCreateWith(makeCompanySecret({ id: "created", key: "linear-api-key", name: "Linear API key" }));
    await renderSecrets(container);
    await openNewSecret();
    await typeInto("new-secret-name", "Linear API key");
    await typeInto("new-secret-value", "lin_api_example");
    await click(findControl("Add agent", openDialog(), true));
    await click(document.querySelector('[aria-label="Allow CodexCoder"]'));

    await submitNewSecret();
    await waitForReact(() => mockPushToast.mock.calls.length > 0);

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.update).not.toHaveBeenCalled();
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Some agents were not given access",
        body: expect.stringContaining("CodexCoder already has an env var named LINEAR_API_KEY."),
        tone: "error",
      }),
    );
    await waitForReact(() => detailsPanel() != null);
    expect(detailsPanel()?.textContent).toContain("Linear API key");
  });

  it("asks for a usable name before giving agents access to one they could not read", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-coder", name: "CodexCoder" })]);
    await renderSecrets(container);
    await openNewSecret();
    await typeInto("new-secret-name", "2024 billing key");
    await typeInto("new-secret-value", "example");
    await click(findControl("Add agent", openDialog(), true));
    await click(document.querySelector('[aria-label="Allow CodexCoder"]'));

    await submitNewSecret();

    expect(openDialog()?.textContent).toContain("Agents can only read names made of letters, digits and underscores");
    expect(mockSecretsApi.create).not.toHaveBeenCalled();
  });

  it.each([false, true])("opens the admin-visible each-user details panel (definition link: %s)", async (fromLink) => {
    const definition = makeUserSecretDefinition();
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([definition]);
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition, secret: null }]);
    await renderSecrets(container, {
      path: fromLink ? `/company/settings/secrets?definition=${definition.id}` : "/company/settings/secrets",
    });

    if (!fromLink) await click(teamRow("Personal GitHub token"));
    await waitForReact(() => detailsPanel()?.textContent?.includes("3 of 5") ?? false);

    const panel = detailsPanel()!;
    expect(panel.textContent).toContain("Personal GitHub token");
    expect(panel.textContent).toContain("PERSONAL_GH_TOKEN");
    expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect([...panel.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Agents that can use it",
      "Members",
      "Details",
    ]);
    expect(panel.querySelector('[aria-label="Members"]')?.textContent).toContain(
      "3 of 5 members have added their value.",
    );
    expect(panel.querySelector('[aria-label="Details"]')?.textContent).toContain(
      "Create a fine-grained PAT with repo read access.",
    );
    expect(panel.textContent).not.toContain("View in Coverage");

    await click(findControl("Set my value", panel));

    expect(bodyText()).toContain("Set your value");
  });

  it("opens the current person's Set value form through My secrets without admin definitions", async () => {
    const definition = makeUserSecretDefinition({ key: "PERSONAL_PUBLISHING_KEY", name: "Personal publishing credential" });
    mockSecretsApi.listUserSecretDefinitions.mockRejectedValue(new ApiError("Forbidden", 403, null));
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition, secret: null }]);
    await renderSecrets(container, { path: "/company/settings/secrets" });

    await openTab("My secrets");
    const row = [...container.querySelectorAll("li")].find((node) =>
      node.textContent?.includes("Personal publishing credential"),
    );
    await click(findControl("Set value", row));

    expect(bodyText()).toContain("Set your value");
    expect(openDialog()?.textContent).toContain("Personal publishing credential");
    expect(mockSecretsApi.createMyUserSecret).not.toHaveBeenCalled();
  });

  it("keeps the new secret value textarea width-constrained for long tokens", async () => {
    await renderSecrets(container);
    await openNewSecret();

    const secretValueTextarea = byId<HTMLTextAreaElement>("new-secret-value");
    expect(secretValueTextarea).not.toBeNull();
    expect(secretValueTextarea?.className).toContain("min-w-0");
    expect(secretValueTextarea?.className).toContain("overflow-x-hidden");
    expect(secretValueTextarea?.className).toContain("break-all");
  });

  it("explains AWS managed secret creation failures with actionable safe details", async () => {
    const rawProviderMessage =
      "AccessDeniedException: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.create.mockRejectedValueOnce(
      new ApiError("AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.", 403, {
        details: {
          rawProviderMessage,
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
    await renderSecrets(container);
    await openNewSecret();

    await typeInto("new-secret-name", "AWS test token");
    await act(async () => setSelectValue(byId<HTMLSelectElement>("new-secret-vault")!, "aws_secrets_manager:vault-aws"));
    await flushReact();
    await typeInto("new-secret-value", "secret-value");

    // A vault that can hold existing secrets offers linking one instead.
    expect(findControl("Use a secret that already exists in AWS production · AWS Secrets Manager instead", openDialog())).toBeDefined();

    await submitNewSecret();
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ provider: "aws_secrets_manager", providerConfigId: "vault-aws" }),
    );
    const errorBanner = document.querySelector('[data-testid="secret-create-error"]');
    expect(errorBanner?.textContent).toContain("AWS secret creation needs CreateSecret permission");
    expect(errorBanner?.textContent).toContain("secretsmanager:CreateSecret");
    expect(errorBanner?.textContent).toContain("us-east-1");
    expect(errorBanner?.textContent).toContain("link it as an external reference");
    expect(errorBanner?.textContent).toContain("vault-aws");
    expect(errorBanner?.textContent).not.toContain(rawProviderMessage);
    expect(errorBanner?.textContent).not.toContain("123456789012");
    // What was typed is kept so the person can try again.
    expect(byId<HTMLInputElement>("new-secret-name")?.value).toBe("AWS test token");
  });

  it("links an existing secret in a vault instead of storing a new value", async () => {
    mockSecretsApi.create.mockResolvedValue(
      makeCompanySecret({ id: "linked", name: "Production database", managedMode: "external_reference" }),
    );
    await renderSecrets(container);
    await openNewSecret();
    await typeInto("new-secret-name", "Production database");
    await act(async () => setSelectValue(byId<HTMLSelectElement>("new-secret-vault")!, "aws_secrets_manager:vault-aws"));
    await flushReact();

    await click(findControl("Use a secret that already exists", openDialog(), true));

    expect(byId("new-secret-value")).toBeNull();
    await submitNewSecret("Link secret");
    expect(byId("new-secret-ref-hint")?.textContent).toBe("Paste the secret's ARN or path.");

    await typeInto("new-secret-ref", "arn:aws:secretsmanager:us-east-1:1:secret:prod/db");
    await submitNewSecret("Link secret");

    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Production database",
        managedMode: "external_reference",
        externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/db",
        providerConfigId: "vault-aws",
      }),
    );
  });

  it("renders generic secret creation failures with a stable selector", async () => {
    mockSecretsApi.create.mockRejectedValueOnce(new ApiError("Secret creation failed", 500, null));
    await renderSecrets(container);
    await openNewSecret();

    await typeInto("new-secret-name", "Failed token");
    await typeInto("new-secret-value", "secret-value");
    await submitNewSecret();
    await flushReact();

    const errorBanner = document.querySelector('[data-testid="secret-create-error"]');
    expect(errorBanner?.textContent).toBe("Secret creation failed");
  });

  it("lists vaults flat, with the default following where a new secret would land", async () => {
    const { root } = renderVaultsTab(container, { secrets: [makeCompanySecret(), makeCompanySecret({ id: "s2", providerConfigId: "vault-aws" })] });

    expect(container.querySelector('a[href="#provider-vaults-local_encrypted"]')).toBeNull();
    expect(container.querySelectorAll("ul > li")).toHaveLength(3);
    expect(container.textContent).not.toContain("Managed writes");
    expect(container.textContent).not.toContain("External refs");
    expect(container.textContent).not.toContain("Local encrypted");

    // A usable Paperclip-encrypted vault takes over as the default from built-in storage.
    const builtIn = container.querySelector('[data-testid="provider-vault-built-in"]') as HTMLElement;
    expect(builtIn.textContent).toContain("Paperclip");
    expect(builtIn.textContent).toContain("1 secret");
    expect(builtIn.textContent).not.toContain("Default");
    const local = container.querySelector('[data-testid="provider-vault-vault-local"]') as HTMLElement;
    expect(local.textContent).toContain("Local default");
    expect(local.textContent).toContain("Paperclip-encrypted");
    expect(local.textContent).toContain("Default");
    const aws = container.querySelector('[data-testid="provider-vault-vault-aws"]') as HTMLElement;
    expect(aws.textContent).toContain("AWS production");
    expect(aws.textContent).toContain("Not checked yet");
    expect(aws.textContent).toContain("1 secret");
    expect(aws.textContent).not.toContain("Default");

    flushSync(() => root.unmount());
    const second = document.createElement("div");
    document.body.appendChild(second);
    renderVaultsTab(second, {
      providerConfigs: [makeProviderConfig({ id: "vault-aws", provider: "aws_secrets_manager", displayName: "AWS production", isDefault: true })],
    });

    expect(second.querySelector('[data-testid="provider-vault-built-in"]')?.textContent).toContain("Default");
    expect(second.querySelector('[data-testid="provider-vault-vault-aws"]')?.textContent).toContain(
      "Default for AWS Secrets Manager",
    );
  });

  it("offers Check again on an unhealthy vault and Enable on a disabled one", async () => {
    const { handlers } = renderVaultsTab(container, {
      providerConfigs: [
        makeProviderConfig({
          id: "vault-down",
          provider: "aws_secrets_manager",
          displayName: "staging-eu",
          healthStatus: "error",
          healthMessage: "AWS denied access.",
          healthDetails: { code: "access_denied", message: "AWS denied access.", guidance: ["Grant secretsmanager:ListSecrets."] },
        }),
        makeProviderConfig({ id: "vault-off", provider: "aws_secrets_manager", displayName: "old-vault", status: "disabled" }),
      ],
    });

    const down = container.querySelector('[data-testid="provider-vault-vault-down"]') as HTMLElement;
    expect(down.querySelector('[role="alert"]')?.textContent).toContain("AWS denied access.");
    expect(down.textContent).toContain("Grant secretsmanager:ListSecrets.");
    // Importing from, or defaulting to, a vault that cannot be reached is not offered.
    expect((down.querySelector('[data-testid="provider-vault-refresh-secrets-vault-down"]') as HTMLButtonElement).disabled).toBe(true);
    expect(findControl("Make default", down)).toBeUndefined();
    await click(findControl("Check again", down));
    expect(handlers.onHealthCheck).toHaveBeenCalledWith(expect.objectContaining({ id: "vault-down" }));

    const off = container.querySelector('[data-testid="provider-vault-vault-off"]') as HTMLElement;
    expect(off.textContent).toContain("Disabled");
    expect(findControl("Disable", off)).toBeUndefined();
    await click(findControl("Enable", off));
    expect(handlers.onEnable).toHaveBeenCalledWith(expect.objectContaining({ id: "vault-off" }));
    expect(handlers.onDisable).not.toHaveBeenCalled();
  });

  it("re-enables a disabled vault from the page", async () => {
    const disabled = makeProviderConfig({ id: "vault-off", provider: "aws_secrets_manager", displayName: "old-vault", status: "disabled" });
    mockSecretsApi.providerConfigs.mockResolvedValue([disabled]);
    mockSecretsApi.updateProviderConfig.mockResolvedValue({ ...disabled, status: "ready" });
    await renderSecrets(container);
    await openTab("Vaults");

    await click(findControl("Enable", document.querySelector('[data-testid="provider-vault-vault-off"]')));

    expect(mockSecretsApi.updateProviderConfig).toHaveBeenCalledWith("vault-off", { status: "ready" });
  });

  it("unlocks a vault's menu again once its action has finished", async () => {
    const vault = makeProviderConfig({ id: "vault-aws", provider: "aws_secrets_manager", displayName: "prod-us-east" });
    mockSecretsApi.providerConfigs.mockResolvedValue([vault]);
    await renderSecrets(container);
    await openTab("Vaults");
    const row = () => document.querySelector('[data-testid="provider-vault-vault-aws"]');
    const menuButton = () => row()?.querySelector('button[aria-label="Actions for prod-us-east"]') as HTMLButtonElement;

    await click(findControl("Check connection", row()));
    await waitForReact(() => mockPushToast.mock.calls.some(([toast]) => toast.title === "The vault is working"));
    await flushReact();

    expect(mockSecretsApi.checkProviderConfigHealth).toHaveBeenCalledWith("vault-aws");
    expect(menuButton().disabled).toBe(false);
    expect((findControl("Edit connection", row()) as HTMLButtonElement).disabled).toBe(false);
  });

  it("returns a disabled draft vault to its draft status, which is the only one the server accepts for it", async () => {
    const draft = makeProviderConfig({ id: "vault-gcp", provider: "gcp_secret_manager", displayName: "gcp-draft", status: "disabled" });
    mockSecretsApi.providerConfigs.mockResolvedValue([draft]);
    mockSecretsApi.updateProviderConfig.mockResolvedValue({ ...draft, status: "coming_soon" });
    await renderSecrets(container);
    await openTab("Vaults");

    await click(findControl("Enable", document.querySelector('[data-testid="provider-vault-vault-gcp"]')));

    expect(mockSecretsApi.updateProviderConfig).toHaveBeenCalledWith("vault-gcp", { status: "coming_soon" });
  });

  it("says so when the check of a new vault could not run, and keeps the vault", async () => {
    const saved = makeProviderConfig({ id: "vault-new", provider: "aws_secrets_manager", displayName: "prod-eu-west" });
    mockSecretsApi.createProviderConfig.mockResolvedValue(saved);
    mockSecretsApi.checkProviderConfigHealth.mockRejectedValue(new ApiError("Service unavailable", 503, {}));
    await renderSecrets(container);
    await openAwsVaultDialog();
    await typeInto("vault-name", "prod-eu-west");
    await typeInto("provider-vault-aws-region", "eu-west-1");

    await click(findControl("Connect vault", openDialog()));
    await waitForReact(() => mockPushToast.mock.calls.some(([toast]) => toast.title === "Couldn't check prod-eu-west"));

    const toast = mockPushToast.mock.calls.map(([entry]) => entry).find((entry) => entry.title === "Couldn't check prod-eu-west");
    expect(toast.tone).toBe("error");
    expect(toast.body).toContain("The vault is saved. Use Check connection in its menu to try again.");
    expect(mockSecretsApi.createProviderConfig).toHaveBeenCalledTimes(1);
  });

  it("offers the vault kinds Paperclip supports and marks the rest Coming soon", async () => {
    const { handlers } = renderVaultsTab(container);

    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"]')][0].querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    );
    expect([...items].map((item) => [item.textContent, item.disabled])).toEqual([
      ["Paperclip-encrypted vault", false],
      ["AWS Secrets Manager", false],
      ["GCP Secret ManagerComing soon", true],
      ["VaultComing soon", true],
    ]);

    await click(items[1]);
    expect(handlers.onCreate).toHaveBeenCalledWith("aws_secrets_manager");
  });

  it("validates the vault form with Connect enabled, then checks the new vault straight away", async () => {
    const saved = makeProviderConfig({ id: "vault-new", provider: "aws_secrets_manager", displayName: "prod-eu-west" });
    mockSecretsApi.createProviderConfig.mockResolvedValue(saved);
    mockSecretsApi.checkProviderConfigHealth.mockResolvedValue({ status: "error", message: "AWS denied access." });
    await renderSecrets(container);
    await openAwsVaultDialog();

    const dialog = openDialog()!;
    expect(dialog.textContent).toContain("Connect AWS Secrets Manager");
    expect(byId("vault-status")).toBeNull();
    expect(byId("vault-provider")).toBeNull();
    const connect = findControl("Connect vault", dialog) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);

    await click(connect);

    expect([...dialog.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual([
      "Give the vault a name your team will recognize.",
      "Enter the AWS region, such as us-east-1.",
    ]);
    expect(mockSecretsApi.createProviderConfig).not.toHaveBeenCalled();

    await typeInto("vault-name", " prod-eu-west ");
    await typeInto("provider-vault-aws-region", "eu-west-1");
    await click(findControl("Connect vault", dialog));
    await waitForReact(() => mockSecretsApi.checkProviderConfigHealth.mock.calls.length > 0);

    expect(mockSecretsApi.createProviderConfig).toHaveBeenCalledWith("company-1", {
      provider: "aws_secrets_manager",
      displayName: "prod-eu-west",
      status: "ready",
      isDefault: false,
      config: {
        region: "eu-west-1",
        namespace: null,
        secretNamePrefix: null,
        kmsKeyId: null,
        ownerTag: null,
        environmentTag: null,
      },
    });
    expect(mockSecretsApi.checkProviderConfigHealth).toHaveBeenCalledWith("vault-new");
    await waitForReact(() => mockPushToast.mock.calls.length > 1);
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Vault connected", body: "prod-eu-west" }));
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "prod-eu-west can't be reached", body: "AWS denied access.", tone: "error" }),
    );
  });

  it("checks AWS access and applies suggested naming settings as prefill", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValueOnce(makeDiscoveryPreview());
    await renderSecrets(container);
    await openAwsVaultDialog();

    const discoveryButton = document.querySelector(
      '[data-testid="aws-vault-discovery-button"]',
    ) as HTMLButtonElement | null;
    expect(discoveryButton).not.toBeNull();
    expect(discoveryButton?.disabled).toBe(true);
    // Naming settings stay tucked away until asked for.
    expect(byId("provider-vault-secret-name-prefix")).toBeNull();

    await openNamingAndTags();
    await typeInto("provider-vault-aws-region", "us-east-1");
    await typeInto("provider-vault-secret-name-prefix", "paperclip");

    expect(discoveryButton?.disabled).toBe(false);
    await click(discoveryButton);
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
    expect(bodyText()).toContain("AWS production");

    await click(findControl("Use values", openDialog(), true));

    expect(byId<HTMLInputElement>("vault-name")?.value).toBe("AWS production");
    expect(byId<HTMLInputElement>("provider-vault-namespace")?.value).toBe("prod-use1");
    expect(byId<HTMLInputElement>("provider-vault-secret-name-prefix")?.value).toBe("paperclip");
    expect(byId<HTMLInputElement>("provider-vault-kms-key-id")?.value).toBe("alias/paperclip-secrets");
    expect(byId<HTMLInputElement>("provider-vault-owner-tag")?.value).toBe("platform");
    expect(byId<HTMLInputElement>("provider-vault-environment-tag")?.value).toBe("production");
    expect(mockSecretsApi.createProviderConfig).not.toHaveBeenCalled();
  });

  it("opens the naming settings when suggested values are applied with them closed", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValueOnce(makeDiscoveryPreview());
    await renderSecrets(container);
    await openAwsVaultDialog();
    await typeInto("provider-vault-aws-region", "us-east-1");
    await click(document.querySelector('[data-testid="aws-vault-discovery-button"]'));
    await flushReact();

    await click(findControl("Use values", openDialog(), true));

    expect(byId<HTMLInputElement>("provider-vault-namespace")?.value).toBe("prod-use1");
  });

  it("shows AWS access errors without replacing manual vault form values", async () => {
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.providerConfigDiscoveryPreview.mockRejectedValueOnce(
      new ApiError("AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.", 403, {
        details: {
          rawProviderMessage,
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
    await renderSecrets(container);
    await openAwsVaultDialog();
    await openNamingAndTags();

    await typeInto("provider-vault-aws-region", "us-west-2");
    await typeInto("provider-vault-namespace", "manual-prod");
    await click(document.querySelector('[data-testid="aws-vault-discovery-button"]'));
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
    expect(byId<HTMLInputElement>("provider-vault-aws-region")?.value).toBe("us-west-2");
    expect(byId<HTMLInputElement>("provider-vault-namespace")?.value).toBe("manual-prod");
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
    await renderSecrets(container);
    await openAwsVaultDialog();

    await typeInto("provider-vault-aws-region", "us-west-1");
    await click(document.querySelector('[data-testid="aws-vault-discovery-button"]'));
    await flushReact();

    const errorBanner = document.querySelector('[data-testid="aws-vault-discovery-error"]');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain("AWS discovery failed");
    expect(errorBanner?.textContent).toContain("AWS discovery request failed before IAM evaluation.");
    expect(errorBanner?.textContent).toContain("proxy_forbidden");
    expect(errorBanner?.textContent).not.toContain("AWS discovery needs ListSecrets permission");
  });

  it("derives the key from the name under More options until the key is edited", async () => {
    await renderSecrets(container);
    await openNewSecret();

    const nameInput = byId<HTMLInputElement>("new-secret-name")!;
    const valueTextarea = byId<HTMLTextAreaElement>("new-secret-value")!;

    // The name reads like the environment variable people arrive with, and the value follows it.
    expect(nameInput.placeholder).toBe("GITHUB_TOKEN");
    expect(
      nameInput.compareDocumentPosition(valueTextarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The key is an advanced detail: out of the way until More options is opened.
    expect(byId("new-secret-key")).toBeNull();
    expect(findControl("Edit", openDialog())).toBeUndefined();

    await typeInto("new-secret-name", "OpenAI API Key");
    await openMoreOptions();

    const keyInput = byId<HTMLInputElement>("new-secret-key")!;
    expect(keyInput.readOnly).toBe(false);
    expect(keyInput.value).toBe("openai-api-key");
    expect(
      valueTextarea.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(byId("new-secret-description")).not.toBeNull();

    await typeInto("new-secret-key", "custom-key");
    await typeInto("new-secret-name", "OpenAI API Key v2");

    // Once edited, the key stops following the name.
    expect(byId<HTMLInputElement>("new-secret-key")?.value).toBe("custom-key");
  });

  it("grants and revokes agent access from the secret detail sheet", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    const coder = makeAgent({ id: "agent-coder", name: "CodexCoder" });
    const reviewer = makeAgent({
      id: "agent-reviewer",
      name: "Reviewer",
      adapterConfig: { env: { OPENAI_API_KEY: secretRef("secret-openai") } },
    });
    mockAgentsApi.list.mockResolvedValue([coder, reviewer]);
    mockAgentsApi.get.mockImplementation(async (id: string) =>
      id === "agent-coder" ? coder : reviewer,
    );
    mockAgentsApi.update.mockImplementation(async (id: string) =>
      id === "agent-coder" ? coder : reviewer,
    );
    await renderSecrets(container);

    await click(teamRow("OPENAI_API_KEY"));
    await waitForReact(() => detailsPanel()?.textContent?.includes("Reviewer") ?? false);

    // Existing access is listed with the name the agent reads it under.
    const access = detailsPanel()!.querySelector('[aria-label="Agents that can use it"]') as HTMLElement;
    expect(access.textContent).toContain("Reviewer");
    expect(access.textContent).toContain("OPENAI_API_KEY");
    expect(byId("agent-access-agent")).toBeNull();

    await click(findControl("Add agent", access, true));

    expect(byId<HTMLInputElement>("agent-access-env-key")?.value).toBe("OPENAI_API_KEY");
    const give = findControl("Give access") as HTMLButtonElement;
    expect(give.disabled).toBe(true);

    await click(byId("agent-access-agent"));

    // Agents that already have access are not offered again.
    expect(document.body.querySelector('[aria-label="Select Reviewer"]')).toBeNull();
    await click(document.body.querySelector('[aria-label="Select CodexCoder"]'));
    await click(findControl("Give access"));
    await flushReact();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "agent-coder",
      {
        adapterConfig: {
          env: { OPENAI_API_KEY: secretRef("secret-openai") },
        },
        replaceAdapterConfig: true,
      },
      "company-1",
    );

    await click(document.body.querySelector('button[aria-label="Remove access for Reviewer"]'));
    await flushReact();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "agent-reviewer",
      { adapterConfig: { env: {} }, replaceAdapterConfig: true },
      "company-1",
    );
  });

  it("names the environment variable after the secret, not its folder", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret({ id: "s-db", key: "staging-database-url", name: "staging/DATABASE_URL" })]);
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-coder", name: "CodexCoder" })]);
    await renderSecrets(container, { path: "/company/settings/secrets?secret=s-db" });
    await waitForReact(() => findControl("Add agent", detailsPanel(), true) != null);

    await click(findControl("Add agent", detailsPanel(), true));

    expect(byId<HTMLInputElement>("agent-access-env-key")?.value).toBe("DATABASE_URL");
  });

  it("says AWS was reached when there is nothing to suggest, without blocking manual entry", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValueOnce(
      makeDiscoveryPreview({ candidates: [], sampledSecretCount: 0 }),
    );
    await renderSecrets(container);
    await openAwsVaultDialog();

    await typeInto("provider-vault-aws-region", "us-east-2");
    await click(document.querySelector('[data-testid="aws-vault-discovery-button"]'));
    await flushReact();

    expect(bodyText()).toContain("Paperclip reached AWS. There was nothing to suggest");
    expect(byId<HTMLInputElement>("provider-vault-aws-region")?.value).toBe("us-east-2");
  });
});

describe("Secrets folder view (PAP-14698)", () => {
  let container: HTMLDivElement;

  function seedFolderSecrets() {
    seedDefaults();
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({ id: "s1", key: "dev_github_oauth_clientid", name: "dev/github/oauth/clientid" }),
      makeCompanySecret({ id: "s2", key: "dev_github_oauth_clientsecret", name: "dev/github/oauth/clientsecret" }),
      makeCompanySecret({ id: "s3", key: "prod_api_token", name: "prod/api/token" }),
      makeCompanySecret({ id: "s4", key: "standalone", name: "standalone" }),
    ]);
  }

  function renderAt(path: string) {
    return renderSecrets(container, { path });
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
    unmountActiveRoots();
    container.remove();
    document.body.innerHTML = "";
    vi.resetAllMocks();
  });

  it("derives folders at the root with filtered counts and a flat standalone secret", async () => {
    await renderAt("/");

    const table = teamTable()!;
    expect(table.textContent).toContain("dev");
    expect(table.textContent).toContain("prod");
    expect(table.textContent).toContain("standalone");
    // dev groups both oauth secrets recursively; github and oauth are descendant folders.
    expect(table.textContent).toContain("2 secrets · 2 folders");
    expect(table.textContent).toContain("1 secret · 1 folder");
    // Folder rows are real links carrying ?path=.
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(links.some((href) => href.includes("path=dev"))).toBe(true);
    // The root needs no breadcrumb; it appears once a folder is open.
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
  });

  it("opens a deep ?path= link into the folder with breadcrumb, leaves, and an up affordance", async () => {
    await renderAt("/?path=dev/github/oauth");

    const breadcrumb = container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(breadcrumb).not.toBeNull();
    const current = container.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain("oauth");

    const table = teamTable()!;
    expect(table.textContent).toContain("clientid");
    expect(table.textContent).toContain("clientsecret");
    expect(table.textContent).toContain("Up to github");
    // Sibling trees are not shown while drilled in.
    expect(table.textContent).not.toContain("standalone");
  });

  it("renders the empty-folder state (breadcrumb intact) for an unknown path", async () => {
    await renderAt("/?path=does/not/exist");

    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull();
    expect(container.textContent).toContain("No secrets in this folder yet.");
    await click(findControl("New secret here", container, true));

    // The folder shows as a removable chip beside an empty name field.
    expect(openDialog()?.textContent).toContain("does/not/exist");
    expect(byId<HTMLInputElement>("new-secret-name")?.value).toBe("");
    expect(document.querySelector('button[aria-label="Remove folder prefix"]')).not.toBeNull();
  });

  it("distinguishes a filtered-empty folder from a genuinely empty folder", async () => {
    await renderAt("/?path=dev/github/oauth");

    await chooseFilter("Archived");
    await waitForReact(() => container.textContent?.includes("No secrets match your filters.") ?? false);

    expect(container.textContent).toContain("No secrets match your filters.");
    expect(container.textContent).not.toContain("New secret here");
  });

  it("creates a company secret from a folder prefix and derives the key from the full name", async () => {
    mockSecretsApi.create.mockResolvedValue(
      makeCompanySecret({ id: "created", name: "dev/github/oauth/clientsecret/deeper" }),
    );
    await renderAt("/?path=dev/github/oauth");
    await openNewSecret();

    expect(openDialog()?.textContent).toContain("dev/github/oauth");
    expect(byId<HTMLInputElement>("new-secret-name")?.value).toBe("");
    await typeInto("new-secret-name", "clientsecret/deeper");
    // Agents read the secret's own name, not its folder path.
    expect(byId("new-secret-name-hint")?.textContent).toBe("Agents read it as DEEPER.");
    await openMoreOptions();

    expect(byId<HTMLInputElement>("new-secret-key")?.value).toBe("dev-github-oauth-clientsecret-deeper");
    await typeInto("new-secret-value", "secret-value");
    await submitNewSecret();

    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "dev/github/oauth/clientsecret/deeper",
        key: "dev-github-oauth-clientsecret-deeper",
      }),
    );
  });

  it("keeps the folder prefix for Each user and exposes the full name when the chip is removed", async () => {
    await renderAt("/?path=dev/github/oauth");
    await openNewSecret();
    await chooseWhoProvides("Each user");

    await typeInto("new-secret-name", "personal-token");
    await openMoreOptions();
    expect(byId<HTMLInputElement>("new-secret-key")?.value).toBe("DEV_GITHUB_OAUTH_PERSONAL_TOKEN");

    await click(document.querySelector('button[aria-label="Remove folder prefix"]'));

    // Removing the chip keeps the path and makes it editable in the name field.
    expect(byId<HTMLInputElement>("new-secret-name")?.value).toBe("dev/github/oauth/personal-token");
    expect(byId<HTMLInputElement>("new-secret-key")?.value).toBe("DEV_GITHUB_OAUTH_PERSONAL_TOKEN");
    expect(openDialog()?.textContent).not.toContain("dev/github/oauth");
    expect(document.querySelector('button[aria-label="Remove folder prefix"]')).toBeNull();
  });

  it("validates New folder inline and stages the trimmed segment in the URL-backed folder view", async () => {
    await renderAt("/?path=dev/github/oauth");
    await click(findControl("New folder"));

    const folderInput = container.querySelector('input[aria-label="Folder name"]') as HTMLInputElement;
    await act(async () => setInputValue(folderInput, "bad/name"));
    const createFolderButton = findControl("Create folder", container);
    await click(createFolderButton);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Folder name cannot contain slashes.",
    );

    await act(async () => setInputValue(folderInput, "  staged  "));
    await flushReact();
    await click(createFolderButton);
    await waitForReact(() =>
      [...container.querySelectorAll('[aria-current="page"]')].some((node) =>
        node.textContent?.includes("staged"),
      ),
    );

    expect(container.textContent).toContain("No secrets in this folder yet.");
    expect(container.querySelector('input[aria-label="Folder name"]')).toBeNull();
  });

  it("always groups by folder, whatever view an earlier visit stored", async () => {
    window.localStorage.setItem("paperclip.secrets.viewMode", "flat");
    await renderAt("/");

    const table = teamTable()!;
    expect(table.textContent).toContain("2 secrets · 2 folders");
    expect(table.textContent).not.toContain("dev/github/oauth/clientid");
    expect(container.querySelector('[role="group"][aria-label="View mode"]')).toBeNull();
    expect(findControl("Flat", container)).toBeUndefined();
  });

  it("search is global across folders and shows full muted-path names", async () => {
    await renderAt("/?path=dev/github/oauth");

    const input = container.querySelector(
      'input[aria-label="Search secrets"]',
    ) as HTMLInputElement;
    await act(async () => setInputValue(input, "token"));
    await flushReact();

    expect(container.textContent).toContain("1 match across all folders");
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
    const table = teamTable()!;
    // prod/api/token lives outside the current folder yet still matches.
    expect(table.textContent).toContain("prod/api/");
    expect(table.textContent).toContain("token");
    expect(table.textContent).not.toContain("clientid");
  });
});

describe("Secrets operator-hidden tabs", () => {
  let container: HTMLDivElement;

  function renderWithHiddenSettings(hiddenSettings: string[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, { hiddenSettings } as never);
    return renderSecrets(container, { queryClient });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    seedDefaults();
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret({ id: "s1", key: "api_key", name: "api_key" })]);
  });

  afterEach(() => {
    unmountActiveRoots();
    container.remove();
    document.body.innerHTML = "";
    vi.resetAllMocks();
  });

  it("hides the Vaults and Proposals tabs and skips the proposals poll", async () => {
    await renderWithHiddenSettings([
      "company.secrets.vaults",
      "company.secrets.proposals",
    ]);

    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Secrets", "My secrets"]);
    expect(mockSecretsApi.listProposals).not.toHaveBeenCalled();
  });

  it("keeps both tabs when nothing is hidden", async () => {
    await renderWithHiddenSettings([]);

    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Secrets", "My secrets", "Vaults", "Proposals"]);
    expect(mockSecretsApi.listProposals).toHaveBeenCalled();
  });

  it("does not offer a route to Vaults from a secret's details when the tab is hidden", async () => {
    await renderWithHiddenSettings(["company.secrets.vaults"]);

    await click(teamRow("api_key"));
    await waitForReact(() => detailsPanel() != null);

    const stored = [...detailsPanel()!.querySelectorAll("dt")].find((term) => term.textContent === "Stored in");
    expect(stored?.nextElementSibling?.textContent).toBe("Paperclip");
    expect(stored?.nextElementSibling?.querySelector("button")).toBeNull();
  });
});
