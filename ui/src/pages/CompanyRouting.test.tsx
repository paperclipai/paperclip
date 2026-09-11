// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { CompanyRouting } from "./CompanyRouting";

const mockRoutingApi = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  listRules: vi.fn(),
  upsertRule: vi.fn(),
  applyDefaultRules: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../api/routing", () => ({
  routingApi: mockRoutingApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
    selectedCompany: null,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function findAction(root: ParentNode, label: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("button")).find(
    (element) => element.textContent?.trim() === label,
  );
}

function click(element: Element | null | undefined) {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

const PROFILE = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  name: "Fable worker",
  providerFamily: "anthropic",
  agentId: "22222222-2222-4222-8222-222222222222",
  model: "claude-fable-5",
  effort: "high",
  roleCapabilities: ["worker"],
  enabled: true,
  maxConcurrentAttempts: 2,
  version: 3,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

describe("CompanyRouting", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockRoutingApi.listProfiles.mockResolvedValue([PROFILE]);
    mockRoutingApi.listRules.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([
      { id: PROFILE.agentId, name: "Fable agent" },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(queryClient: QueryClient) {
    return (
      <QueryClientProvider client={queryClient}>
        <CompanyRouting />
      </QueryClientProvider>
    );
  }

  it("shows the 422 details.code verbatim when a rule save hits reviewer-family-conflict", async () => {
    mockRoutingApi.upsertRule.mockRejectedValue(
      new ApiError("Invariant violated", 422, {
        error: "Invariant violated",
        details: { code: "reviewer-family-conflict" },
      }),
    );
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(render(queryClient));
    });
    await waitForAssertion(() => expect(container.textContent).toContain("feature_standard"));

    const featureRow = container.querySelector("[data-task-class='feature_standard']");
    expect(featureRow).toBeTruthy();
    await act(async () => {
      click(findAction(featureRow!, "Save rule"));
    });

    await waitForAssertion(() => {
      expect(mockRoutingApi.upsertRule).toHaveBeenCalled();
      const alert = featureRow!.querySelector("[role='alert']");
      expect(alert?.textContent).toBe("reviewer-family-conflict");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an explicit version-conflict message when a profile update returns 409", async () => {
    mockRoutingApi.updateProfile.mockRejectedValue(
      new ApiError("Version conflict", 409, {
        error: "Version conflict",
        details: { code: "version_conflict" },
      }),
    );
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(render(queryClient));
    });
    await waitForAssertion(() => expect(container.textContent).toContain("Fable worker"));

    await act(async () => {
      click(findAction(container, "Disable"));
    });

    await waitForAssertion(() => {
      expect(mockRoutingApi.updateProfile).toHaveBeenCalledWith(
        PROFILE.id,
        expect.objectContaining({ expectedVersion: 3, enabled: false }),
      );
      expect(container.textContent).toContain(
        "Version conflict: this record changed since you loaded it. Reload and retry.",
      );
    });

    await act(async () => {
      root.unmount();
    });
  });
});
