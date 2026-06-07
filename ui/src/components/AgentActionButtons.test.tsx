// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActionButtons } from "./AgentActionButtons";

const mockAgentsApi = vi.hoisted(() => ({
  invoke: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  approve: vi.fn(),
  terminate: vi.fn(),
  create: vi.fn(),
  hire: vi.fn(),
  resetSession: vi.fn(),
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({
    openNewIssue: mockOpenNewIssue,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

async function clickElement(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function openOverflowMenu() {
  const trigger = document.body.querySelector('button[aria-label="Open actions for Alpha"]');
  await clickElement(trigger);
}

function menuTerminateItem(): Element | undefined {
  // The overflow menu item is a plain <button> (no data-variant), unlike the
  // dialog's destructive confirm button.
  return Array.from(document.body.querySelectorAll("button")).find(
    (button) =>
      button.textContent?.includes("Terminate Agent") &&
      button.getAttribute("data-variant") === null,
  );
}

function confirmTerminateButton(): Element | null {
  return document.body.querySelector('button[data-variant="destructive"]');
}

describe("AgentActionButtons terminate confirmation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockAgentsApi.terminate.mockResolvedValue(makeAgent({ status: "terminated" }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container.remove();
    vi.clearAllMocks();
  });

  async function render(agent: Agent = makeAgent()) {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <AgentActionButtons agent={agent} companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("does not terminate until the confirmation is accepted", async () => {
    await render();
    await openOverflowMenu();

    await clickElement(menuTerminateItem());
    // Opening the menu item must NOT fire the irreversible mutation immediately.
    expect(mockAgentsApi.terminate).not.toHaveBeenCalled();

    // A confirmation dialog now gates the action.
    const confirm = confirmTerminateButton();
    expect(confirm).not.toBeNull();

    await clickElement(confirm);
    expect(mockAgentsApi.terminate).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.terminate).toHaveBeenCalledWith("agent-1", "company-1");
  });

  it("cancels without terminating", async () => {
    await render();
    await openOverflowMenu();
    await clickElement(menuTerminateItem());

    const cancel = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    await clickElement(cancel);

    expect(mockAgentsApi.terminate).not.toHaveBeenCalled();
    // Dialog closed: the destructive confirm button is gone.
    expect(confirmTerminateButton()).toBeNull();
  });
});
