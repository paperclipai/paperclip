// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanyEnvironments } from "./CompanyEnvironments";

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  probe: vi.fn(),
  probeConfig: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setDefault: vi.fn(),
  customImageTemplate: vi.fn(),
  startCustomImageSetupSession: vi.fn(),
  customImageSetupSession: vi.fn(),
  finishCustomImageSetupSession: vi.fn(),
  cancelCustomImageSetupSession: vi.fn(),
  rollbackCustomImageTemplate: vi.fn(),
  disableCustomImageTemplate: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Minimal Radix dialog dependency for jsdom.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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

function editButtons(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "Edit");
}

function click(element: Element | null | undefined) {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function getOpenDialog(): HTMLElement | null {
  return document.body.querySelector("[role='dialog']");
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    companyId: "company-1",
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
    companyId: "company-1",
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

describe("CompanyEnvironments — test provider button", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let probeResolvers: Map<string, () => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    probeResolvers = new Map();
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockEnvironmentsApi.capabilities.mockResolvedValue({ adapters: [], sandboxProviders: {} });
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
    vi.clearAllMocks();
  });

  it("shows the testing state only on the clicked environment's button", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
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
    expect(mockEnvironmentsApi.probe).toHaveBeenCalledExactlyOnceWith("env-1");
  });

  it("keeps the second environment's testing state when an earlier probe settles", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
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

  it("opens the add-environment form in a dialog and closes it on cancel", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => {
      findButton(container, "Add environment")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(getOpenDialog()?.textContent).toContain("Add environment");

    await act(async () => {
      findButton(document.body, "Cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(getOpenDialog()).toBeNull();
  });

  it("opens the edit form in a dialog with existing values and closes after save", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => {
      findButton(container, "Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const dialog = getOpenDialog();
    expect(dialog?.textContent).toContain("Edit environment");
    expect(
      Array.from(dialog?.querySelectorAll("input") ?? []).some((input) => (input as HTMLInputElement).value === "Alpha"),
    ).toBe(true);

    await act(async () => {
      findButton(document.body, "Save environment")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockEnvironmentsApi.update).toHaveBeenCalledExactlyOnceWith(
      "env-1",
      expect.objectContaining({ name: "Alpha", driver: "sandbox" }),
    );
    expect(getOpenDialog()).toBeNull();
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Daytona supports setup + capture → "Configure image" in its config dialog.
    await act(async () => click(editButtons(container)[0]));
    await waitForAssertion(() => {
      expect(getOpenDialog()?.textContent).toContain("Configure image");
    });
    expect(mockEnvironmentsApi.customImageTemplate).toHaveBeenCalledExactlyOnceWith("env-1", "company-1");
    await act(async () => click(findButton(document.body, "Cancel")));
    await waitForAssertion(() => expect(getOpenDialog()).toBeNull());

    // E2B does not advertise interactive setup.
    await act(async () => click(editButtons(container)[1]));
    await waitForAssertion(() => {
      expect(getOpenDialog()?.textContent).toContain("Unsupported provider");
    });
    expect(getOpenDialog()?.textContent).not.toContain("Configure image");
    await act(async () => click(findButton(document.body, "Cancel")));
    await waitForAssertion(() => expect(getOpenDialog()).toBeNull());

    // Provider advertises setup but cannot capture an image.
    await act(async () => click(editButtons(container)[2]));
    await waitForAssertion(() => {
      expect(getOpenDialog()?.textContent).toContain("Setup capture unavailable");
    });
    expect(getOpenDialog()?.textContent).not.toContain("Configure image");
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => click(editButtons(container)[0]));
    await waitForAssertion(() => {
      expect(getOpenDialog()?.textContent).toContain(command);
    });

    await act(async () => click(findButton(getOpenDialog()!, "Cancel")));
    await waitForAssertion(() => {
      expect(getOpenDialog()?.textContent).toContain("Setup cancelled");
    });

    expect(mockEnvironmentsApi.cancelCustomImageSetupSession).toHaveBeenCalledExactlyOnceWith(
      "session-1",
      { reason: "operator cancelled" },
    );
    expect(getOpenDialog()?.textContent).not.toContain(command);
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => click(editButtons(container)[0]));
    await waitForAssertion(() => {
      expect(getOpenDialog()?.textContent).toContain("Setup expired");
    });
    expect(getOpenDialog()?.textContent).not.toContain(command);
  });

  it("shows active template controls for refresh, rollback, and disable", async () => {
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => click(editButtons(container)[0]));
    await waitForAssertion(() => {
      const dialog = getOpenDialog();
      expect(dialog?.textContent).toContain("Active template");
      expect(findButton(dialog!, "Refresh")).toBeTruthy();
      expect(findButton(dialog!, "Rollback")).toBeTruthy();
      expect(findButton(dialog!, "Disable")).toBeTruthy();
    });

    await act(async () => click(findButton(getOpenDialog()!, "Refresh")));
    await flushReact();

    expect(mockEnvironmentsApi.startCustomImageSetupSession).toHaveBeenCalledWith(
      "env-1",
      "company-1",
      { templateId: "template-active" },
    );
  });
});
