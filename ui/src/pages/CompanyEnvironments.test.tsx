// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanyEnvironments } from "./CompanyEnvironments";
import { ApiError } from "@/api/client";

const xtermMocks = vi.hoisted(() => {
  class MockTerminal {
    readonly options: Record<string, unknown>;
    cols: number;
    rows: number;
    writes: string[] = [];
    focused = false;
    disposed = false;
    openedElement: HTMLElement | null = null;
    private readonly dataHandlers: Array<(data: string) => void> = [];

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      this.cols = typeof options.cols === "number" ? options.cols : 80;
      this.rows = typeof options.rows === "number" ? options.rows : 24;
      xtermMocks.terminalInstances.push(this);
    }

    loadAddon(addon: { activate?: (terminal: MockTerminal) => void }) {
      addon.activate?.(this);
    }

    open(element: HTMLElement) {
      this.openedElement = element;
      element.dataset.mockXtermOpen = "true";
    }

    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
      return {
        dispose: () => {
          const index = this.dataHandlers.indexOf(handler);
          if (index >= 0) this.dataHandlers.splice(index, 1);
        },
      };
    }

    emitData(data: string) {
      for (const handler of this.dataHandlers) handler(data);
    }

    write(data: string) {
      this.writes.push(data);
      if (!this.openedElement) return;
      const chunk = document.createElement("span");
      // Keep test DOM readable without reimplementing xterm's ANSI parser.
      chunk.textContent = data.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      this.openedElement.appendChild(chunk);
    }

    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }

    focus() {
      this.focused = true;
      this.openedElement?.focus();
    }

    reset() {
      this.writes = [];
      if (this.openedElement) this.openedElement.textContent = "";
    }

    clear() {
      if (this.openedElement) this.openedElement.textContent = "";
    }

    dispose() {
      this.disposed = true;
    }
  }

  class MockFitAddon {
    fitCalls = 0;
    terminal: MockTerminal | null = null;

    constructor() {
      xtermMocks.fitAddonInstances.push(this);
    }

    activate(terminal: MockTerminal) {
      this.terminal = terminal;
    }

    fit() {
      this.fitCalls += 1;
      this.terminal?.resize(120, 32);
    }
  }

  return {
    MockTerminal,
    MockFitAddon,
    terminalInstances: [] as MockTerminal[],
    fitAddonInstances: [] as MockFitAddon[],
    reset() {
      this.terminalInstances.length = 0;
      this.fitAddonInstances.length = 0;
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: xtermMocks.MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: xtermMocks.MockFitAddon,
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  secretRefs: vi.fn(),
  probe: vi.fn(),
  probeConfig: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  deleteBlastRadius: vi.fn(),
  setDefault: vi.fn(),
  customImageTemplate: vi.fn(),
  startCustomImageSetupSession: vi.fn(),
  customImageSetupSession: vi.fn(),
  createCustomImageTerminalSessionToken: vi.fn(),
  finishCustomImageSetupSession: vi.fn(),
  cancelCustomImageSetupSession: vi.fn(),
  rollbackCustomImageTemplate: vi.fn(),
  relinkCustomImageTemplate: vi.fn(),
  disableCustomImageTemplate: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: null,
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
  useToastActions: () => ({ pushToast: vi.fn() }),
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Minimal browser APIs for jsdom.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new Event("close") as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
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

function testProviderButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((button) => {
    const label = button.textContent?.trim();
    return label === "Test provider" || label === "Testing...";
  });
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

function findAction(root: ParentNode, label: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("button,a")).find((element) => element.textContent?.trim() === label);
}

function editButtons(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button,a")).filter((element) => element.textContent?.trim() === "Edit");
}

function click(element: Element | null | undefined) {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const ENVIRONMENTS_PATH = "/company/settings/instance/environments";

function getEnvironmentFormPage(): HTMLElement | null {
  return document.body.querySelector("[data-testid='environment-form-page']");
}

// Opens the edit page for the environment at `index`. The environment list
// depends on an async query. Under a loaded test worker that query can resolve
// after the first flush, so a direct click can miss the Edit control and never
// open the form page. This helper first waits for the control, then clicks it,
// then waits for the form page.
async function openEnvironmentEditPage(container: HTMLElement, index = 0) {
  await waitForAssertion(() => {
    expect(editButtons(container)[index]).toBeTruthy();
  });
  await act(async () => click(editButtons(container)[index]));
  await waitForAssertion(() => {
    expect(getEnvironmentFormPage()).not.toBeNull();
  });
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

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    environmentId: "env-1",
    templateId: null,
    promotedTemplateId: null,
    provider: "daytona",
    providerLeaseId: "lease-redacted",
    environmentLeaseId: null,
    status: "waiting_for_user",
    startedByUserId: "user-1",
    startedByAgentId: null,
    baseTemplateRef: null,
    expiresAt: "2026-06-25T21:00:00.000Z",
    finishedAt: null,
    failureReason: null,
    connectionSummary: {
      type: "ssh",
      username: "sandbox",
      hostRedacted: true,
      portRedacted: true,
    },
    connectionSecretRef: "secret-redacted",
    metadata: null,
    createdAt: "2026-06-25T20:00:00.000Z",
    updatedAt: "2026-06-25T20:00:00.000Z",
    ...overrides,
  };
}

function createTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "template-1",
    environmentId: "env-1",
    provider: "daytona",
    templateKind: "snapshot",
    templateRef: "redacted-template-ref",
    sourceTemplateRef: null,
    sourceEnvironmentConfigFingerprint: "fingerprint",
    status: "active",
    createdByUserId: "user-1",
    createdByAgentId: null,
    capturedAt: "2026-06-25T20:00:00.000Z",
    lastUsedAt: null,
    supersededByTemplateId: null,
    metadata: null,
    createdAt: "2026-06-25T20:00:00.000Z",
    updatedAt: "2026-06-25T20:00:00.000Z",
    ...overrides,
  };
}

function createDeleteBlastRadius(overrides: {
  canDelete?: boolean;
  deleteBlockedReasons?: string[];
  staticReferences?: Record<string, unknown>;
  activeRuntimeUse?: Record<string, unknown>;
  pendingCleanupLeaseCount?: number;
  reusableSandboxLeaseCount?: number;
  reusableSandboxLeaseHolders?: Array<Record<string, unknown>>;
} = {}) {
  return {
    environmentId: "env-1",
    canDelete: overrides.canDelete ?? true,
    deleteBlockedReasons: overrides.deleteBlockedReasons ?? [],
    reusableSandboxLeaseHolders: overrides.reusableSandboxLeaseHolders ?? [],
    staticReferences: {
      isManagedLocal: false,
      isInstanceDefault: false,
      agentDefaultCount: 0,
      executionWorkspaceSelectionCount: 0,
      issueSelectionCount: 0,
      projectSelectionCount: 0,
      secretBindingCount: 0,
      ...overrides.staticReferences,
    },
    activeRuntimeUse: {
      activeLeaseCount: 0,
      activeCustomImageSetupSessionCount: 0,
      hasActiveRuntimeUse: false,
      ...overrides.activeRuntimeUse,
    },
    pendingCleanupLeaseCount: overrides.pendingCleanupLeaseCount ?? 0,
    reusableSandboxLeaseCount: overrides.reusableSandboxLeaseCount ?? 0,
  };
}

function supportedDaytonaCapabilities() {
  return {
    adapters: [],
    drivers: { local: "supported", ssh: "supported", sandbox: "supported", plugin: "unsupported" },
    sandboxProviders: {
      daytona: {
        status: "supported",
        supportsSavedProbe: true,
        supportsUnsavedProbe: true,
        supportsRunExecution: true,
        supportsReusableLeases: true,
        supportsInteractiveSetup: true,
        interactiveSetupConnectionTypes: ["ssh"],
        supportsTemplateCapture: true,
        supportsTemplateDelete: true,
        displayName: "Daytona",
      },
    },
  };
}

describe("CompanyEnvironments — test provider button", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let probeResolvers: Map<string, () => void>;
  let originalWebSocket: typeof WebSocket | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    probeResolvers = new Map();
    originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    xtermMocks.reset();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockEnvironmentsApi.capabilities.mockResolvedValue({ adapters: [], sandboxProviders: {} });
    mockEnvironmentsApi.secretRefs.mockResolvedValue({ refs: [] });
    mockSecretsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentsApi.startCustomImageSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: { type: "ssh", command: "ssh sandbox@setup.example.invalid" },
    });
    mockEnvironmentsApi.customImageSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: { type: "ssh", command: "ssh sandbox@setup.example.invalid" },
    });
    mockEnvironmentsApi.createCustomImageTerminalSessionToken.mockResolvedValue({
      id: "terminal-session-1",
      token: "terminal-token-terminal-token-123456",
      expiresAt: "2026-06-25T20:05:00.000Z",
      setupSessionId: "session-1",
      environmentId: "env-1",
      connectionType: "ssh",
      websocketPath:
        "/api/environment-custom-image-setup-sessions/session-1/terminal/ws?terminalSessionId=terminal-session-1",
    });
    mockEnvironmentsApi.finishCustomImageSetupSession.mockResolvedValue({
      session: createSession({ status: "promoted", promotedTemplateId: "template-1", finishedAt: "2026-06-25T20:10:00.000Z" }),
      template: createTemplate(),
      connectionPayload: null,
    });
    mockEnvironmentsApi.cancelCustomImageSetupSession.mockResolvedValue(
      createSession({ status: "cancelled", finishedAt: "2026-06-25T20:10:00.000Z" }),
    );
    mockEnvironmentsApi.rollbackCustomImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-previous" }),
      supersededTemplate: createTemplate({ id: "template-current", status: "superseded" }),
    });
    mockEnvironmentsApi.relinkCustomImageTemplate.mockResolvedValue({
      template: createTemplate({ id: "template-relinked" }),
      classification: "knob_only",
    });
    mockEnvironmentsApi.disableCustomImageTemplate.mockResolvedValue(
      createTemplate({ status: "revoked" }),
    );
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Alpha", driver: "sandbox", description: null, config: { provider: "e2b" } },
      { id: "env-2", name: "Beta", driver: "sandbox", description: null, config: { provider: "e2b" } },
    ]);
    mockEnvironmentsApi.create.mockImplementation(async (_companyId: string, body: { name: string }) => ({
      id: "env-new",
      name: body.name,
      driver: "ssh",
      description: null,
      config: {},
    }));
    mockEnvironmentsApi.update.mockImplementation(async (environmentId: string, body: { name: string }) => ({
      id: environmentId,
      name: body.name,
      driver: "sandbox",
      description: null,
      config: { provider: "e2b" },
    }));
    mockEnvironmentsApi.deleteBlastRadius.mockResolvedValue(createDeleteBlastRadius());
    mockEnvironmentsApi.remove.mockImplementation(async (environmentId: string) => ({
      id: environmentId,
      name: environmentId === "env-1" ? "Alpha" : "Beta",
      driver: "sandbox",
      description: null,
      config: { provider: "e2b" },
    }));
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.update.mockResolvedValue({});
    // Each probe stays pending until its resolver is called, so the testing
    // state remains observable and can be settled per environment.
    mockEnvironmentsApi.probe.mockImplementation(
      (environmentId: string) =>
        new Promise<{ ok: boolean; driver: string; summary: string; details: null }>((resolve) => {
          probeResolvers.set(environmentId, () =>
            resolve({ ok: true, driver: "sandbox", summary: "ok", details: null }),
          );
        }),
    );
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    document.body.innerHTML = "";
    if (originalWebSocket) {
      globalThis.WebSocket = originalWebSocket;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).WebSocket;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("shows the testing state only on the clicked environment's button", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    const buttonsBefore = testProviderButtons(container);
    expect(buttonsBefore).toHaveLength(2);
    expect(buttonsBefore.every((button) => button.textContent?.trim() === "Test provider")).toBe(true);
    expect(buttonsBefore.every((button) => !button.disabled)).toBe(true);

    await act(async () => {
      buttonsBefore[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const buttonsAfter = testProviderButtons(container);
    expect(buttonsAfter).toHaveLength(2);
    expect(buttonsAfter[0].textContent?.trim()).toBe("Testing...");
    expect(buttonsAfter[0].disabled).toBe(true);
    expect(buttonsAfter[1].textContent?.trim()).toBe("Test provider");
    expect(buttonsAfter[1].disabled).toBe(false);
    expect(mockEnvironmentsApi.probe).toHaveBeenCalledExactlyOnceWith("env-1", "company-1");
  });

  it("explains that successful sandbox provider tests use a temporary sandbox", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.probe.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Connected to Daytona sandbox paperclip-probe.",
      details: {
        provider: "daytona",
        diagnostics: [],
        metadata: {
          provider: "daytona",
          sandboxId: "473167E9",
          sandboxName: "paperclip-probe",
        },
      },
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await act(async () => {
      testProviderButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockEnvironmentsApi.probe).toHaveBeenCalledExactlyOnceWith("env-1", "company-1");
    expect(container.textContent).toContain("Connected to Daytona sandbox paperclip-probe.");
    expect(container.textContent).not.toContain("Verified temporary daytona sandbox");
    expect(container.textContent).not.toContain("Test probes clean up the validation sandbox after the check");
    expect(container.textContent).not.toContain("provider dashboard");
  });

  it("does not show sandbox lifecycle success copy for failed sandbox provider tests", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.probe.mockResolvedValue({
      ok: false,
      driver: "sandbox",
      summary: "Daytona sandbox probe failed.",
      details: {
        provider: "daytona",
        error: "Sandbox image was not found.",
        metadata: {
          provider: "daytona",
          sandboxId: "473167E9",
          sandboxName: "paperclip-probe",
        },
      },
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await act(async () => {
      testProviderButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Daytona sandbox probe failed.");
    expect(container.textContent).toContain("Sandbox image was not found.");
    expect(container.textContent).not.toContain("Verified temporary daytona sandbox");
    expect(container.textContent).not.toContain("Test probes clean up the validation sandbox after the check");
  });

  it("keeps the second environment's testing state when an earlier probe settles", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    // Click both rows in quick succession while both probes are still pending.
    await act(async () => {
      testProviderButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      testProviderButtons(container)[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Settle only the first environment's probe.
    await act(async () => {
      probeResolvers.get("env-1")?.();
    });
    await flushReact();

    const buttons = testProviderButtons(container);
    expect(buttons[1].textContent?.trim()).toBe("Testing...");
    expect(buttons[1].disabled).toBe(true);
  });

  it("opens the add-environment form on a standalone page and closes it on cancel", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await act(async () => {
      click(container.querySelector('[aria-label="Add environment"]'));
    });

    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Add environment");
    });

    await act(async () => {
      findButton(document.body, "Cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(getEnvironmentFormPage()).toBeNull();
  });

  it("opens the edit form on a standalone page with existing values and closes after save", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await act(async () => {
      click(findAction(container, "Edit"));
    });

    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
    });

    const page = getEnvironmentFormPage();
    expect(document.body.querySelector("[role='dialog']")).toBeNull();
    expect(
      Array.from(page?.querySelectorAll("input") ?? []).some((input) => (input as HTMLInputElement).value === "Alpha"),
    ).toBe(true);

    await act(async () => click(findButton(page!, "Add variable")));
    await flushReact();
    const variableName = page!.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    const variableValue = page!.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    await act(async () => {
      setInputValue(variableName, "API_TOKEN");
      setInputValue(variableValue, "draft-token");
    });
    await flushReact();

    await act(async () => {
      findButton(document.body, "Save environment")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockEnvironmentsApi.update).toHaveBeenCalledExactlyOnceWith(
      "env-1",
      expect.objectContaining({
        name: "Alpha",
        driver: "sandbox",
        envVars: { API_TOKEN: { type: "plain", value: "draft-token" } },
      }),
      // The secret-context company must ride along so the server can scope
      // bindings even when the environment has none yet.
      "company-1",
    );
    expect(getEnvironmentFormPage()).toBeNull();
  });

  it("confirms before cancelling the edit page with unsaved environment variable drafts", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await act(async () => {
      click(findAction(container, "Edit"));
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
    });
    const page = getEnvironmentFormPage()!;

    await act(async () => click(findButton(page, "Add variable")));
    await flushReact();
    const variableName = page.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    const variableValue = page.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    await act(async () => {
      setInputValue(variableName, "API_TOKEN");
      setInputValue(variableValue, "draft-token");
    });
    await flushReact();

    await act(async () => click(findButton(document.body, "Cancel")));
    await flushReact();

    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved environment changes?");
    expect(getEnvironmentFormPage()).not.toBeNull();

    confirmSpy.mockReturnValue(true);
    await act(async () => click(findButton(document.body, "Cancel")));
    await flushReact();

    expect(getEnvironmentFormPage()).toBeNull();
  });

  it("keeps unload and in-app link warnings after env var changes are staged into the form", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await act(async () => {
      click(findAction(container, "Edit"));
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
    });
    const page = getEnvironmentFormPage()!;

    await act(async () => click(findButton(page, "Add variable")));
    await flushReact();
    const variableName = page.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    const variableValue = page.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    await act(async () => {
      setInputValue(variableName, "API_TOKEN");
      setInputValue(variableValue, "draft-token");
    });
    await flushReact();

    await act(async () => click(findButton(page, "Save")));
    await flushReact();
    expect(page.textContent).not.toContain("Unsaved changes");

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    const link = document.createElement("a");
    link.href = "/agents/dashboard";
    document.body.appendChild(link);
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(clickEvent);

    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved environment changes?");
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(getEnvironmentFormPage()).not.toBeNull();
    link.remove();
  });

  it("shows image setup controls only for providers advertising setup and capture support", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
      { id: "env-2", name: "E2B", driver: "sandbox", description: null, config: { provider: "e2b" } },
      { id: "env-3", name: "Policy", driver: "sandbox", description: null, config: { provider: "policy" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue({
      adapters: [],
      drivers: { local: "supported", ssh: "supported", sandbox: "supported", plugin: "unsupported" },
      sandboxProviders: {
        daytona: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: true,
          interactiveSetupConnectionTypes: ["ssh"],
          supportsTemplateCapture: true,
          supportsTemplateDelete: true,
          displayName: "Daytona",
        },
        e2b: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: false,
          interactiveSetupConnectionTypes: [],
          supportsTemplateCapture: false,
          supportsTemplateDelete: false,
          displayName: "E2B",
        },
        policy: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: true,
          interactiveSetupConnectionTypes: ["ssh"],
          supportsTemplateCapture: false,
          supportsTemplateDelete: false,
          displayName: "Policy Sandbox",
        },
      },
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    // Daytona supports setup + capture -> "Configure image" on its edit page.
    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Configure image");
    });
    expect(mockEnvironmentsApi.customImageTemplate).toHaveBeenCalledExactlyOnceWith("env-1", "company-1");
    await act(async () => click(findButton(document.body, "Cancel")));
    await waitForAssertion(() => expect(getEnvironmentFormPage()).toBeNull());

    // E2B does not advertise interactive setup.
    await openEnvironmentEditPage(container, 1);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Unsupported provider");
    });
    expect(getEnvironmentFormPage()?.textContent).not.toContain("Configure image");
    await act(async () => click(findButton(document.body, "Cancel")));
    await waitForAssertion(() => expect(getEnvironmentFormPage()).toBeNull());

    // Provider advertises setup but cannot capture an image.
    await openEnvironmentEditPage(container, 2);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Setup capture unavailable");
    });
    expect(getEnvironmentFormPage()?.textContent).not.toContain("Configure image");
  });

  it("shows a live connect command and removes it after cancellation", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const command = "ssh sandbox@setup.example.invalid -p 2222";
    let activeSession: ReturnType<typeof createSession> | null = createSession();
    let latestSession: ReturnType<typeof createSession> | null = activeSession;
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue({
      adapters: [],
      drivers: { local: "supported", ssh: "supported", sandbox: "supported", plugin: "unsupported" },
      sandboxProviders: {
        daytona: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: true,
          interactiveSetupConnectionTypes: ["ssh"],
          supportsTemplateCapture: true,
          supportsTemplateDelete: true,
          displayName: "Daytona",
        },
      },
    });
    mockEnvironmentsApi.customImageTemplate.mockImplementation(async () => ({
      activeTemplate: null,
      activeSession,
      latestSession,
    }));
    mockEnvironmentsApi.customImageSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: { type: "ssh", command },
    });
    mockEnvironmentsApi.cancelCustomImageSetupSession.mockImplementation(async () => {
      activeSession = null;
      latestSession = createSession({ status: "cancelled", finishedAt: "2026-06-25T20:10:00.000Z" });
      return latestSession;
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain(command);
    });

    await act(async () => click(findButton(getEnvironmentFormPage()!, "Cancel")));
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Setup cancelled");
    });

    expect(mockEnvironmentsApi.cancelCustomImageSetupSession).toHaveBeenCalledExactlyOnceWith(
      "session-1",
      { reason: "operator cancelled" },
    );
    expect(getEnvironmentFormPage()?.textContent).not.toContain(command);
  });

  it("opens an embedded browser terminal automatically while preserving the SSH command fallback", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const command = "ssh sandbox@setup.example.invalid -p 2222";
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: null,
      activeSession: createSession(),
      latestSession: createSession(),
    });
    mockEnvironmentsApi.customImageSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: { type: "ssh", command },
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain(command);
      expect(getEnvironmentFormPage()?.textContent).toContain("Browser terminal");
      expect(getEnvironmentFormPage()?.textContent).toContain("SSH command fallback");
      expect(mockEnvironmentsApi.createCustomImageTerminalSessionToken).toHaveBeenCalledExactlyOnceWith("session-1", {});
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    expect(FakeWebSocket.instances[0].url).toContain(
      "/api/environment-custom-image-setup-sessions/session-1/terminal/ws?terminalSessionId=terminal-session-1",
    );
    expect(FakeWebSocket.instances[0].url).not.toContain("token=");
    expect(FakeWebSocket.instances[0].url).not.toContain("terminal-token-terminal-token-123456");
    expect(FakeWebSocket.instances[0].url).toContain("cols=120");
    expect(FakeWebSocket.instances[0].url).toContain("rows=32");
    expect(xtermMocks.terminalInstances[0].options.cursorBlink).toBe(true);
    expect(xtermMocks.terminalInstances[0].options.cursorInactiveStyle).toBe("bar");
    expect(xtermMocks.terminalInstances[0].options.cursorStyle).toBe("bar");
    expect(xtermMocks.terminalInstances[0].options.cursorWidth).toBe(2);
    expect(xtermMocks.terminalInstances[0].options.customGlyphs).toBe(true);
    expect(xtermMocks.terminalInstances[0].options.letterSpacing).toBe(0);
    expect(xtermMocks.terminalInstances[0].options.theme).toMatchObject({
      cursor: "#22d3ee",
      cursorAccent: "#020617",
    });
    expect(String(xtermMocks.terminalInstances[0].options.fontFamily)).toContain("Nerd Font");

    await act(async () => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].emitMessage(JSON.stringify({ type: "ready" }));
      FakeWebSocket.instances[0].emitMessage(JSON.stringify({ type: "output", data: "\u001b[?2004hsetup shell\r\n$ " }));
    });
    const terminalScreen = getEnvironmentFormPage()?.querySelector<HTMLElement>(
      "[data-testid='custom-image-terminal-screen-session-1']",
    );
    await waitForAssertion(() => {
      expect(terminalScreen?.dataset.mockXtermOpen).toBe("true");
      expect(xtermMocks.terminalInstances[0].writes.join("")).toContain("setup shell");
      expect(xtermMocks.terminalInstances[0].focused).toBe(true);
      expect(document.activeElement).toBe(terminalScreen);
      expect(getEnvironmentFormPage()?.textContent).toContain(command);
    });
    expect(FakeWebSocket.instances[0].sent).toContain(JSON.stringify({
      type: "auth",
      token: "terminal-token-terminal-token-123456",
    }));
    expect(FakeWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "resize", cols: 120, rows: 32 }));

    await act(async () => {
      xtermMocks.terminalInstances[0].emitData("l");
      xtermMocks.terminalInstances[0].emitData("\r");
    });

    expect(FakeWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "input", data: "l" }));
    expect(FakeWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "input", data: "\r" }));
  });

  it("keeps the environment edit page open when Escape is pressed in setup terminal", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const command = "ssh sandbox@setup.example.invalid -p 2222";
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: null,
      activeSession: createSession(),
      latestSession: createSession(),
    });
    mockEnvironmentsApi.customImageSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: { type: "ssh", command },
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    let terminalScreen: HTMLElement | null = null;
    await waitForAssertion(() => {
      terminalScreen = getEnvironmentFormPage()?.querySelector<HTMLElement>(
        "[data-testid='custom-image-terminal-screen-session-1']",
      ) ?? null;
      expect(terminalScreen).toBeTruthy();
      expect(document.body.querySelector("[role='dialog']")).toBeNull();
    });

    await act(async () => {
      terminalScreen?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushReact();

    expect(getEnvironmentFormPage()?.textContent).toContain(command);
    expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
  });

  it("does not render connect details when an active session refreshes as expired", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const command = "ssh sandbox@setup.example.invalid -p 2222";
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue({
      adapters: [],
      drivers: { local: "supported", ssh: "supported", sandbox: "supported", plugin: "unsupported" },
      sandboxProviders: {
        daytona: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: true,
          interactiveSetupConnectionTypes: ["ssh"],
          supportsTemplateCapture: true,
          supportsTemplateDelete: true,
          displayName: "Daytona",
        },
      },
    });
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: null,
      activeSession: createSession(),
      latestSession: createSession(),
    });
    mockEnvironmentsApi.customImageSetupSession.mockResolvedValue({
      session: createSession({ status: "timed_out", finishedAt: "2026-06-25T20:10:00.000Z" }),
      connectionPayload: { type: "ssh", command },
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Setup expired");
    });
    expect(getEnvironmentFormPage()?.textContent).not.toContain(command);
  });

  it("shows a setup connection refresh fallback without breaking finish or cancel", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: null,
      activeSession: createSession(),
      latestSession: createSession(),
    });
    mockEnvironmentsApi.customImageSetupSession.mockRejectedValue(new Error("proxy unavailable"));

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Setup connection details could not be refreshed.");
    });

    const dialog = getEnvironmentFormPage()!;
    expect(findButton(dialog, "Finished")?.disabled).toBe(false);
    expect(findButton(dialog, "Cancel")?.disabled).toBe(false);

    await act(async () => click(findButton(dialog, "Finished")));
    await flushReact();

    expect(mockEnvironmentsApi.finishCustomImageSetupSession).toHaveBeenCalledExactlyOnceWith("session-1", {});
  });

  it("shows provider fallback messaging for unsupported setup connection payloads", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: null,
      activeSession: createSession(),
      latestSession: createSession(),
    });
    mockEnvironmentsApi.customImageSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: { type: "browser_terminal", command: null },
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Browser terminal is not available for this provider connection.");
    });

    const dialog = getEnvironmentFormPage()!;
    expect(findButton(dialog, "Finished")?.disabled).toBe(false);
    expect(findButton(dialog, "Cancel")?.disabled).toBe(false);
  });

  it("shows active template controls for refresh, rollback, and disable", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const activeTemplateId = "12345678-90ab-cdef-1234-567890abcdef";
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue({
      adapters: [],
      drivers: { local: "supported", ssh: "supported", sandbox: "supported", plugin: "unsupported" },
      sandboxProviders: {
        daytona: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: true,
          interactiveSetupConnectionTypes: ["ssh"],
          supportsTemplateCapture: true,
          supportsTemplateDelete: true,
          displayName: "Daytona",
        },
      },
    });
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: activeTemplateId }),
      activeSession: null,
      latestSession: null,
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage();
      expect(dialog?.textContent).toContain("Active template");
      expect(dialog?.textContent).toContain("redacted-template-ref");
      expect(dialog?.textContent).not.toContain("id 12345678-90a");
      expect(
        dialog?.querySelector(
          "[title='Provider snapshot ref redacted-template-ref (Paperclip template 12345678-90ab-cdef-1234-567890abcdef)']",
        ),
      ).toBeTruthy();
      expect(findButton(dialog!, "Refresh")).toBeTruthy();
      expect(findButton(dialog!, "Rollback")).toBeTruthy();
      expect(findButton(dialog!, "Disable")).toBeTruthy();
    });

    await act(async () => click(findButton(getEnvironmentFormPage()!, "Refresh")));
    await flushReact();

    expect(mockEnvironmentsApi.startCustomImageSetupSession).toHaveBeenCalledWith(
      "env-1",
      "company-1",
      { templateId: activeTemplateId },
    );
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Browser terminal");
      expect(getEnvironmentFormPage()?.textContent).toContain("SSH command fallback");
      expect(mockEnvironmentsApi.createCustomImageTerminalSessionToken).toHaveBeenCalledExactlyOnceWith("session-1", {});
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });

  it("allows stale capturing setup sessions to be cancelled back to active template controls", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const activeTemplate = createTemplate({ id: "template-active" });
    let activeSession: ReturnType<typeof createSession> | null = createSession({ status: "capturing" });
    let latestSession: ReturnType<typeof createSession> | null = activeSession;
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockImplementation(async () => ({
      activeTemplate,
      activeSession,
      latestSession,
    }));
    mockEnvironmentsApi.customImageSetupSession.mockResolvedValue({
      session: activeSession,
      connectionPayload: null,
    });
    mockEnvironmentsApi.cancelCustomImageSetupSession.mockImplementation(async () => {
      activeSession = null;
      latestSession = createSession({ status: "cancelled", finishedAt: "2026-06-25T20:10:00.000Z" });
      return latestSession;
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage()!;
      expect(dialog.textContent).toContain("Capturing template");
      expect(dialog.textContent).toContain("Capture is in progress.");
      expect(findButton(dialog, "Finished")?.disabled).toBe(true);
      expect(findButton(dialog, "Cancel")?.disabled).toBe(false);
    });

    await act(async () => click(findButton(getEnvironmentFormPage()!, "Cancel")));
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage()!;
      expect(dialog.textContent).toContain("Active template");
      expect(findButton(dialog, "Refresh")).toBeTruthy();
    });

    expect(mockEnvironmentsApi.cancelCustomImageSetupSession).toHaveBeenCalledExactlyOnceWith(
      "session-1",
      { reason: "operator cancelled" },
    );
  });

  it("shows an out-of-sync warning when the active template no longer matches the saved config", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-active" }),
      activeTemplateMatchesConfig: false,
      activeSession: null,
      latestSession: null,
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage()!;
      expect(dialog.textContent).toContain("Active template");
      expect(dialog.textContent).toContain("Not in use — the environment configuration changed");
    });
  });

  it("names the changed boot-source field in the out-of-sync banner for a boot-source drift", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-active" }),
      activeTemplateMatchesConfig: false,
      activeTemplateDrift: {
        classification: "boot_source_drift",
        driftedPaths: [{ path: "snapshot", from: "a", to: "b" }],
      },
      activeSession: null,
      latestSession: null,
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage()!;
      expect(dialog.textContent).toContain("Not in use — Base image changed: snapshot `a` -> `b`");
      expect(dialog.textContent).not.toContain("the environment configuration changed");
    });
  });

  it("keeps the generic out-of-sync banner for an unclassified drift", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-active" }),
      activeTemplateMatchesConfig: false,
      activeTemplateDrift: { classification: "unclassified", driftedPaths: [{ path: "apiUrl" }] },
      activeSession: null,
      latestSession: null,
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage()!;
      expect(dialog.textContent).toContain("Not in use — the environment configuration changed");
      expect(dialog.textContent).not.toContain("Base image changed");
    });
  });

  it("does not show the out-of-sync warning when the active template matches the saved config", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(supportedDaytonaCapabilities());
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-active" }),
      activeTemplateMatchesConfig: true,
      activeSession: null,
      latestSession: null,
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage()!;
      expect(dialog.textContent).toContain("Active template");
      expect(dialog.textContent).not.toContain("Not in use");
    });
  });

  it("passes company context when rolling back and disabling an active template", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue({
      adapters: [],
      drivers: { local: "supported", ssh: "supported", sandbox: "supported", plugin: "unsupported" },
      sandboxProviders: {
        daytona: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: true,
          interactiveSetupConnectionTypes: ["ssh"],
          supportsTemplateCapture: true,
          supportsTemplateDelete: true,
          displayName: "Daytona",
        },
      },
    });
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-active" }),
      activeSession: null,
      latestSession: null,
    });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage();
      expect(dialog?.textContent).toContain("Active template");
      expect(findButton(dialog!, "Rollback")).toBeTruthy();
      expect(findButton(dialog!, "Disable")).toBeTruthy();
    });

    await act(async () => click(findButton(getEnvironmentFormPage()!, "Rollback")));
    await waitForAssertion(() => {
      expect(mockEnvironmentsApi.rollbackCustomImageTemplate).toHaveBeenCalledExactlyOnceWith("env-1", "company-1");
    });

    await act(async () => click(findButton(getEnvironmentFormPage()!, "Disable")));
    await waitForAssertion(() => {
      expect(mockEnvironmentsApi.disableCustomImageTemplate).toHaveBeenCalledExactlyOnceWith("env-1", "company-1");
    });
  });

  function setupOutOfSyncTemplatePanel() {
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Daytona", driver: "sandbox", description: null, config: { provider: "daytona" } },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue({
      adapters: [],
      drivers: { local: "supported", ssh: "supported", sandbox: "supported", plugin: "unsupported" },
      sandboxProviders: {
        daytona: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: true,
          supportsInteractiveSetup: true,
          interactiveSetupConnectionTypes: ["ssh"],
          supportsTemplateCapture: true,
          supportsTemplateDelete: true,
          displayName: "Daytona",
        },
      },
    });
    mockEnvironmentsApi.customImageTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-active" }),
      activeTemplateMatchesConfig: false,
      activeSession: null,
      latestSession: null,
    });
  }

  it("relinks an out-of-sync template and names both remedies in the copy", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setupOutOfSyncTemplatePanel();

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    await openEnvironmentEditPage(container);
    await waitForAssertion(() => {
      const dialog = getEnvironmentFormPage()!;
      expect(dialog.textContent).toContain("relink this image or capture a new one");
      expect(findButton(dialog, "Relink")).toBeTruthy();
    });

    await act(async () => click(findButton(getEnvironmentFormPage()!, "Relink")));
    await waitForAssertion(() => {
      expect(mockEnvironmentsApi.relinkCustomImageTemplate).toHaveBeenCalledExactlyOnceWith("env-1", "company-1");
    });
  });

  it("confirms boot-source drift before re-sending the relink with the flag", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setupOutOfSyncTemplatePanel();
    mockEnvironmentsApi.relinkCustomImageTemplate
      .mockRejectedValueOnce(new ApiError("Confirm the relink.", 409, {
        error: "Confirm the relink.",
        details: {
          classification: "boot_source_drift",
          driftedPaths: [{ path: "image", from: "fake:base", to: "fake:other" }],
        },
      }))
      .mockResolvedValueOnce({
        template: createTemplate({ id: "template-relinked" }),
        classification: "boot_source_drift",
      });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    try {
      await act(async () => {
        root!.render(renderCompanyEnvironments(queryClient));
      });
      await flushReact();
      await openEnvironmentEditPage(container);
      await waitForAssertion(() => {
        expect(findButton(getEnvironmentFormPage()!, "Relink")).toBeTruthy();
      });

      await act(async () => click(findButton(getEnvironmentFormPage()!, "Relink")));
      await waitForAssertion(() => {
        expect(mockEnvironmentsApi.relinkCustomImageTemplate).toHaveBeenNthCalledWith(1, "env-1", "company-1");
        expect(mockEnvironmentsApi.relinkCustomImageTemplate).toHaveBeenNthCalledWith(
          2,
          "env-1",
          "company-1",
          { confirmBootSourceDrift: true },
        );
      });
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy.mock.calls[0]![0]).toContain("image fake:base -> fake:other");
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("does not re-send the relink when the operator declines the confirmation", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setupOutOfSyncTemplatePanel();
    mockEnvironmentsApi.relinkCustomImageTemplate.mockRejectedValueOnce(new ApiError("Cannot verify.", 409, {
      error: "Cannot verify.",
      details: { classification: "unclassified", driftedPaths: [{ path: "apiUrl" }] },
    }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    try {
      await act(async () => {
        root!.render(renderCompanyEnvironments(queryClient));
      });
      await flushReact();
      await openEnvironmentEditPage(container);
      await waitForAssertion(() => {
        expect(findButton(getEnvironmentFormPage()!, "Relink")).toBeTruthy();
      });

      await act(async () => click(findButton(getEnvironmentFormPage()!, "Relink")));
      await waitForAssertion(() => {
        expect(confirmSpy).toHaveBeenCalledTimes(1);
      });
      expect(confirmSpy.mock.calls[0]![0]).toContain("cannot verify the boot source");
      expect(mockEnvironmentsApi.relinkCustomImageTemplate).toHaveBeenCalledTimes(1);
      expect(mockEnvironmentsApi.relinkCustomImageTemplate).toHaveBeenCalledWith("env-1", "company-1");
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("offers the implicit Local option in the default picker by default", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    const options = Array.from(container.querySelectorAll("option"));
    expect(options.some((option) => option.textContent?.trim() === "Local")).toBe(true);
  });

  it("hides the implicit Local option in the default picker under managed-sandbox-only", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
      enableManagedSandboxOnly: true,
    });
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();

    const options = Array.from(container.querySelectorAll("option"));
    expect(options.some((option) => option.textContent?.trim() === "Local")).toBe(false);
    // Saved non-local environments remain selectable defaults.
    expect(options.some((option) => option.textContent?.includes("Alpha"))).toBe(true);
  });

  it("reassigns this company's active agents to the chosen environment before deleting", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "Iris", status: "active", defaultEnvironmentId: "env-1" },
      { id: "agent-2", name: "Miles", status: "active", defaultEnvironmentId: "env-2" },
      { id: "agent-3", name: "Retired", status: "terminated", defaultEnvironmentId: "env-1" },
    ]);
    mockEnvironmentsApi.deleteBlastRadius.mockResolvedValue(
      createDeleteBlastRadius({ staticReferences: { agentDefaultCount: 2 } }),
    );
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient, `${ENVIRONMENTS_PATH}/env-1/edit`));
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
    });

    const deleteButton = document.body.querySelector<HTMLButtonElement>("[data-testid='environment-delete-button']");
    expect(deleteButton).not.toBeNull();
    await act(async () => click(deleteButton));

    await waitForAssertion(() => {
      expect(
        document.body.querySelector("[data-testid='environment-delete-dialog']")?.textContent,
      ).toContain("1 agent uses this environment as their default");
    });
    const dialog = document.body.querySelector<HTMLElement>("[data-testid='environment-delete-dialog']")!;
    // Only this company's active agents are reassignable; the terminated one is
    // left to the FK fallback and surfaces through the impact note instead.
    expect(dialog.textContent).toContain("Iris");
    expect(dialog.textContent).not.toContain("Retired");
    expect(dialog.textContent).toContain("Other references to this environment");

    const reassignSelect = dialog.querySelector<HTMLSelectElement>(
      "[data-testid='environment-delete-reassign-select']",
    )!;
    const optionLabels = Array.from(reassignSelect.querySelectorAll("option")).map((option) =>
      option.textContent?.trim(),
    );
    expect(optionLabels).toEqual(["Default: Local", "Beta · sandbox"]);
    await act(async () => setSelectValue(reassignSelect, "env-2"));

    await act(async () =>
      click(document.body.querySelector("[data-testid='environment-delete-confirm']")),
    );
    await flushReact();

    expect(mockAgentsApi.update).toHaveBeenCalledExactlyOnceWith(
      "agent-1",
      { defaultEnvironmentId: "env-2" },
      "company-1",
    );
    expect(mockEnvironmentsApi.remove).toHaveBeenCalledExactlyOnceWith("env-1");
    expect(mockAgentsApi.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnvironmentsApi.remove.mock.invocationCallOrder[0],
    );
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()).toBeNull();
    });
  });

  it("deletes without any reassignment when no agents use the environment", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-2", name: "Miles", status: "active", defaultEnvironmentId: "env-2" },
    ]);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient, `${ENVIRONMENTS_PATH}/env-1/edit`));
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
    });

    await act(async () =>
      click(document.body.querySelector("[data-testid='environment-delete-button']")),
    );
    await waitForAssertion(() => {
      expect(
        document.body.querySelector("[data-testid='environment-delete-dialog']")?.textContent,
      ).toContain("permanently deleted");
    });
    expect(
      document.body.querySelector("[data-testid='environment-delete-reassign-select']"),
    ).toBeNull();

    await act(async () =>
      click(document.body.querySelector("[data-testid='environment-delete-confirm']")),
    );
    await flushReact();

    expect(mockAgentsApi.update).not.toHaveBeenCalled();
    expect(mockEnvironmentsApi.remove).toHaveBeenCalledExactlyOnceWith("env-1");
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()).toBeNull();
    });
  });

  it("disables the delete confirmation while the server would block the delete", async () => {
    mockEnvironmentsApi.deleteBlastRadius.mockResolvedValue(
      createDeleteBlastRadius({
        canDelete: false,
        deleteBlockedReasons: ["instance_default"],
        staticReferences: { isInstanceDefault: true },
      }),
    );
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient, `${ENVIRONMENTS_PATH}/env-1/edit`));
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
    });

    await act(async () =>
      click(document.body.querySelector("[data-testid='environment-delete-button']")),
    );
    await waitForAssertion(() => {
      expect(
        document.body.querySelector("[data-testid='environment-delete-dialog']")?.textContent,
      ).toContain("Cannot delete the current instance default environment");
    });

    const confirm = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='environment-delete-confirm']",
    )!;
    expect(confirm.disabled).toBe(true);
    expect(
      document.body.querySelector("[data-testid='environment-delete-reassign-select']"),
    ).toBeNull();
    expect(mockEnvironmentsApi.remove).not.toHaveBeenCalled();
  });

  it("links the workspaces holding blocking sandbox leases in the delete dialog", async () => {
    mockEnvironmentsApi.deleteBlastRadius.mockResolvedValue(
      createDeleteBlastRadius({
        canDelete: false,
        deleteBlockedReasons: ["reusable_sandbox_lease"],
        reusableSandboxLeaseCount: 3,
        reusableSandboxLeaseHolders: [
          {
            leaseId: "lease-1",
            executionWorkspaceId: "ws-1",
            executionWorkspaceName: "ACME-7-fix-the-thing",
            issueId: "issue-1",
            issueIdentifier: "ACME-7",
            issueTitle: "Fix the thing",
          },
          {
            leaseId: "lease-2",
            executionWorkspaceId: "ws-1",
            executionWorkspaceName: "ACME-7-fix-the-thing",
            issueId: "issue-2",
            issueIdentifier: "ACME-9",
            issueTitle: "Follow-up",
          },
          {
            leaseId: "lease-3",
            executionWorkspaceId: null,
            executionWorkspaceName: null,
            issueId: null,
            issueIdentifier: null,
            issueTitle: null,
          },
        ],
      }),
    );
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient, `${ENVIRONMENTS_PATH}/env-1/edit`));
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Edit environment");
    });

    await act(async () =>
      click(document.body.querySelector("[data-testid='environment-delete-button']")),
    );
    await waitForAssertion(() => {
      expect(
        document.body.querySelector("[data-testid='environment-delete-lease-holders']"),
      ).not.toBeNull();
    });

    const holders = document.body.querySelector<HTMLElement>(
      "[data-testid='environment-delete-lease-holders']",
    )!;
    const workspaceLink = holders.querySelector<HTMLAnchorElement>("a[href='/execution-workspaces/ws-1']");
    expect(workspaceLink?.textContent).toBe("ACME-7-fix-the-thing");
    // The two leases on ws-1 collapse into one row naming both issues.
    expect(holders.querySelectorAll("li")).toHaveLength(2);
    expect(holders.textContent).toContain("2 sandbox leases");
    expect(holders.textContent).toContain("ACME-7, ACME-9");
    expect(holders.textContent).toContain("Workspace no longer on record");

    // Leases as the only blocker are consentable: the confirm stays enabled
    // and destroys the sandboxes as part of the delete.
    const confirm = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='environment-delete-confirm']",
    )!;
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent?.trim()).toBe("Destroy 3 sandboxes and delete");

    await act(async () => click(confirm));
    await flushReact();

    expect(mockEnvironmentsApi.remove).toHaveBeenCalledExactlyOnceWith("env-1", {
      destroyReusableSandboxLeases: true,
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()).toBeNull();
    });
  });

  it("does not offer delete on the add-environment page", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(renderCompanyEnvironments(queryClient, `${ENVIRONMENTS_PATH}/new`));
    });
    await waitForAssertion(() => {
      expect(getEnvironmentFormPage()?.textContent).toContain("Add environment");
    });

    expect(document.body.querySelector("[data-testid='environment-delete-button']")).toBeNull();
  });
});
