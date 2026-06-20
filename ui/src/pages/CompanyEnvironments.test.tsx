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
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
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

function testProviderButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((button) => {
    const label = button.textContent?.trim();
    return label === "Test provider" || label === "Testing...";
  });
}

describe("CompanyEnvironments — test provider button", () => {
  let container: HTMLDivElement;
  let probeResolvers: Map<string, () => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    probeResolvers = new Map();
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockEnvironmentsApi.capabilities.mockResolvedValue({ adapters: [], sandboxProviders: {} });
    mockSecretsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Alpha", driver: "sandbox", description: null, config: { provider: "e2b" } },
      { id: "env-2", name: "Beta", driver: "sandbox", description: null, config: { provider: "e2b" } },
    ]);
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
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the testing state only on the clicked environment's button", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
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
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
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
});
