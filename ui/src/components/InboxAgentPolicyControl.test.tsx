// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboxAgentPolicy } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxAgentPolicyControl } from "./InboxAgentPolicyControl";

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInboxAgentPolicyApi = vi.hoisted(() => ({ getMine: vi.fn(), updateMine: vi.fn() }));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/inbox-agent-policy", () => ({ inboxAgentPolicyApi: mockInboxAgentPolicyApi }));
vi.mock("./AgentIconPicker", () => ({ AgentIcon: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function policy(overrides: Partial<InboxAgentPolicy> = {}): InboxAgentPolicy {
  return {
    companyId: "company-1",
    userId: "user-1",
    mode: "open",
    allowedAgentIds: [],
    materialized: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function render(container: HTMLDivElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <InboxAgentPolicyControl companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  return root;
}

function optionByTitle(container: HTMLElement, title: string) {
  return Array.from(container.querySelectorAll('[role="radio"]'))
    .find((node) => node.textContent?.includes(title)) as HTMLButtonElement | undefined;
}

describe("InboxAgentPolicyControl", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "Gardener", role: "gardener", status: "active", icon: null },
      { id: "agent-2", name: "Coder", role: "engineer", status: "active", icon: null },
      { id: "agent-3", name: "Retired", role: "engineer", status: "terminated", icon: null },
    ]);
    mockInboxAgentPolicyApi.getMine.mockResolvedValue(policy());
    mockInboxAgentPolicyApi.updateMine.mockImplementation((_companyId: string, input) =>
      Promise.resolve(policy({ ...input, materialized: true })),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("surfaces policy load failures instead of staying on loading", async () => {
    mockInboxAgentPolicyApi.getMine.mockRejectedValue(new Error("Policy endpoint failed"));
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Policy endpoint failed");
      expect(container.textContent).not.toContain("Loading inbox agent policy");
    });

    act(() => root.unmount());
  });

  it("renders all three policy states with the persisted mode selected", async () => {
    mockInboxAgentPolicyApi.getMine.mockResolvedValue(policy({ mode: "disabled" }));
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(optionByTitle(container, "Any of my agents")).toBeTruthy();
      expect(optionByTitle(container, "Only chosen agents")).toBeTruthy();
      expect(optionByTitle(container, "Off")).toBeTruthy();
      expect(optionByTitle(container, "Off")?.getAttribute("aria-checked")).toBe("true");
      expect(optionByTitle(container, "Any of my agents")?.getAttribute("aria-checked")).toBe("false");
    });

    act(() => root.unmount());
  });

  it("round-trips an allowlist selection through the PUT endpoint", async () => {
    const root = render(container);
    await flush();

    // Save disabled until the draft diverges from the persisted policy.
    await waitForAssertion(() => {
      const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"));
      expect(save?.disabled).toBe(true);
    });

    // Switch to allowlist — only non-terminated agents are selectable.
    await act(async () => optionByTitle(container, "Only chosen agents")!.click());
    await flush();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Gardener");
      expect(container.textContent).toContain("Coder");
      expect(container.textContent).not.toContain("Retired");
    });

    const gardenerCheckbox = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Allow Gardener to tidy my inbox"]',
    );
    expect(gardenerCheckbox).toBeTruthy();
    await act(async () => gardenerCheckbox!.click());
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"))!;
    await waitForAssertion(() => expect(saveButton.disabled).toBe(false));

    await act(async () => saveButton.click());
    await flush();

    expect(mockInboxAgentPolicyApi.updateMine).toHaveBeenCalledWith("company-1", {
      mode: "allowlist",
      allowedAgentIds: ["agent-1"],
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Saved");
      const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"));
      expect(save?.disabled).toBe(true);
    });

    act(() => root.unmount());
  });

  it("clears the allowlist when switching to Off before saving", async () => {
    mockInboxAgentPolicyApi.getMine.mockResolvedValue(policy({ mode: "allowlist", allowedAgentIds: ["agent-1"], materialized: true }));
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(optionByTitle(container, "Only chosen agents")?.getAttribute("aria-checked")).toBe("true");
    });

    await act(async () => optionByTitle(container, "Off")!.click());
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"))!;
    await waitForAssertion(() => expect(saveButton.disabled).toBe(false));
    await act(async () => saveButton.click());
    await flush();

    expect(mockInboxAgentPolicyApi.updateMine).toHaveBeenCalledWith("company-1", {
      mode: "disabled",
      allowedAgentIds: [],
    });

    act(() => root.unmount());
  });
});
