// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActionButtons } from "./AgentActionButtons";
import { useAgentLifecycleStatus } from "./AgentLifecycleStatus";
import { queryKeys } from "../lib/queryKeys";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({
  get: vi.fn(),
  invoke: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  approve: vi.fn(),
  terminate: vi.fn(),
  resetSession: vi.fn(),
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  create: vi.fn(),
  hire: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha Agent",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
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
  };
}

describe("AgentActionButtons", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let invalidateQueries: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidateQueries = vi.spyOn(queryClient, "invalidateQueries") as unknown as ReturnType<typeof vi.fn>;
    mockAgentsApi.clearError.mockResolvedValue(makeAgent({ status: "idle" }));
    mockAgentsApi.pause.mockResolvedValue(makeAgent({ status: "paused" }));
    mockAgentsApi.resume.mockResolvedValue(makeAgent({ status: "idle" }));
    mockAgentsApi.terminate.mockResolvedValue(makeAgent({ status: "terminated" }));
    mockAgentsApi.invoke.mockResolvedValue({ id: "run-1" });
    mockAgentsApi.resetSession.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(agent: Agent, props: Partial<ComponentProps<typeof AgentActionButtons>> = {}) {
    root ??= createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentActionButtons agent={agent} companyId="company-1" runLabel="Run Heartbeat" {...props} />
      </QueryClientProvider>,
    );
  }

  it.each(["codex_local", "claude_local", "opencode_local", "pi_local", "paperclip_runner"])("returns unfinished %s agents to their saved runner", async adapterType => {
    render(makeAgent({ adapterType, status: "paused", lifecycleState: "paused", pauseReason: "setup" }));
    await flushReact();
    const finish = [...container.querySelectorAll("button")].find(button => button.textContent === "Finish setup");
    expect(finish).toBeTruthy();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Resume")).toBe(false);
    await act(() => finish!.click());
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("setupAgentId=agent-1"));
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining(`runner=${adapterType === "paperclip_runner" ? "paperclip" : "legacy"}`));
    expect(mockAgentsApi.resume).not.toHaveBeenCalled();
  });

  it.each(["paused", "preparing", "verifying", "pausing", undefined] as const)("replaces run controls with one setup action when lifecycle is %s", async lifecycleState => {
    render(makeAgent({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" }, status: "paused", lifecycleState, pauseReason: "setup" }));
    await flushReact();
    const buttons = [...container.querySelectorAll("button")];
    const finish = buttons.filter(button => button.textContent === "Finish setup");
    expect(finish).toHaveLength(1);
    expect(buttons.some(button => /Run Heartbeat|^Resume$|^Pause$/.test(button.textContent ?? ""))).toBe(false);
    await act(() => finish[0].click());
    const target = new URL(mockNavigate.mock.calls[0][0], "https://example.test");
    expect(target.pathname).toBe("/agents/new");
    expect(Object.fromEntries(target.searchParams)).toMatchObject({ setupAgentId: "agent-1", adapterType: "paperclip_runner", runnerProvider: "claude", runner: "paperclip" });
    expect(mockAgentsApi.invoke).not.toHaveBeenCalled();
    expect(mockAgentsApi.resume).not.toHaveBeenCalled();
  });

  it.each(["terminating", "cleaning_up", "terminated", "rejected"] as const)("does not reopen setup during %s", async lifecycleState => {
    render(makeAgent({ status: "terminated", lifecycleState, pauseReason: "setup" }));
    await flushReact();
    expect(container.textContent).not.toContain("Finish setup");
  });

  it("restores Run after lifecycle refresh completes setup without replacing the editable record", async () => {
    const draft = makeAgent({ status: "paused", lifecycleState: "paused", lifecycleVersion: 1, pauseReason: "setup", pausedAt: new Date("2026-01-01T00:00:00Z"), adapterConfig: { model: "saved-model" } });
    queryClient.setQueryData(queryKeys.agents.detail("alpha"), draft);
    mockAgentsApi.get.mockResolvedValueOnce(draft);
    function LiveActions() {
      const lifecycle = useAgentLifecycleStatus(draft);
      return <AgentActionButtons agent={{ ...draft, ...lifecycle.data }} companyId="company-1" runLabel="Run Heartbeat" />;
    }
    root = createRoot(container);
    root.render(<QueryClientProvider client={queryClient}><LiveActions /></QueryClientProvider>);
    await flushReact();
    expect(container.textContent).toContain("Finish setup");
    mockAgentsApi.get.mockResolvedValue({ ...draft, status: "idle", lifecycleState: "ready", lifecycleVersion: 2, pauseReason: null, pausedAt: null, adapterConfig: { model: "updated-on-server" } });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: [...queryKeys.agents.detail(draft.id), "lifecycle", draft.companyId] }); });
    await flushReact();
    expect(container.textContent).not.toContain("Finish setup");
    const run = [...container.querySelectorAll("button")].find(button => button.textContent === "Run Heartbeat");
    expect(run?.disabled).toBe(false);
    expect(queryClient.getQueryData<Agent>(queryKeys.agents.detail("alpha"))?.adapterConfig).toEqual({ model: "saved-model" });
    expect(mockAgentsApi.get).toHaveBeenLastCalledWith("agent-1", "company-1");
    await act(() => run!.click());
    await flushReact();
    expect(mockAgentsApi.invoke).toHaveBeenCalledWith("agent-1", "company-1");
  });

  it("checks unsaved changes before leaving to finish setup", async () => {
    const onBeforeNavigate = vi.fn(() => false);
    render(makeAgent({ status: "paused", lifecycleState: "paused", pauseReason: "setup" }), { hasPendingNavigationChanges: true, onBeforeNavigate });
    await flushReact();
    await act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Finish setup")!.click());
    expect(onBeforeNavigate).toHaveBeenCalledOnce();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockAgentsApi.invoke).not.toHaveBeenCalled();
  });

  it("keeps setup available when the caller hides Run or blocks work", async () => {
    render(makeAgent({ status: "paused", lifecycleState: "paused", pauseReason: "setup" }), { showRun: false, workActionsDisabled: true });
    await flushReact();
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Finish setup")!.disabled).toBe(false);
  });

  it("offers Run after setup completes without turning a manual pause into setup", async () => {
    render(makeAgent({ status: "paused", lifecycleState: "paused", pauseReason: "setup" }));
    await flushReact();
    render(makeAgent({ status: "paused", lifecycleState: "paused", pauseReason: "manual" }));
    await flushReact();
    expect(container.textContent).toContain("Resume");
    expect(container.textContent).not.toContain("Finish setup");
    render(makeAgent({ status: "idle", lifecycleState: "ready", pauseReason: null }));
    await flushReact();
    const run = [...container.querySelectorAll("button")].find(button => button.textContent === "Run Heartbeat");
    expect(run?.disabled).toBe(false);
    await act(() => run!.click());
    await flushReact();
    expect(mockAgentsApi.invoke).toHaveBeenCalledWith("agent-1", "company-1");
  });

  it.each(["preparing", "verifying", "resuming"] as const)("offers pause rather than resume during %s", async lifecycleState => {
    render(makeAgent({ status: "paused", lifecycleState }));
    await flushReact();
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.some(button => button.textContent === "Resume")).toBe(false);
    const pause = buttons.find(button => button.textContent === "Pause")!;
    expect(pause.disabled).toBe(false);
    await act(async () => pause.click());
    await flushReact();
    expect(mockAgentsApi.pause).toHaveBeenCalledWith("agent-1", "company-1");
  });

  it.each(["pausing", "terminating", "cleaning_up", "terminated", "rejected"] as const)("disables pause and resume during %s", async lifecycleState => {
    render(makeAgent({ status: lifecycleState === "pausing" ? "paused" : "terminated", lifecycleState }));
    await flushReact();
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find(button => button.textContent === "Pause")!.disabled).toBe(true);
    if (lifecycleState !== "pausing") {
      expect(buttons.find(button => button.textContent === "Run Heartbeat")!.disabled).toBe(true);
      expect(buttons.find(button => button.textContent === "Assign Task")!.disabled).toBe(true);
    }
  });

  it("replaces the pause slot with Clear error for error agents", async () => {
    render(makeAgent({ status: "error" }));
    await flushReact();

    expect(container.textContent).toContain("Clear error");
    expect(container.textContent).not.toContain("Pause");
    expect(container.textContent).toContain("Run Heartbeat");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Reset Sessions");
  });

  it("calls clearError and refreshes agent-related queries", async () => {
    render(makeAgent({ status: "error" }));
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Clear error and return agent to idle"]')?.click();
    });
    await flushReact();

    expect(mockAgentsApi.clearError).toHaveBeenCalledWith("agent-1", "company-1");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "alpha"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "runtime-state", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "task-sessions", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "company-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["live-runs", "company-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["heartbeats", "company-1", "agent-1"] });
  });

  it("keeps the normal pause action for non-error agents", async () => {
    render(makeAgent({ status: "active" }));
    await flushReact();

    expect(container.textContent).toContain("Pause");
    expect(container.textContent).not.toContain("Clear error");
  });

  it.each([false, true])("keeps the normal run action when persistent tracing is %s", async tracingEnabled => {
    render(makeAgent({ runtimeConfig: tracingEnabled ? { debug: { providerTrace: "raw" } } : {} }));
    await flushReact();

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.some(button => button.textContent?.includes("Run with provider trace"))).toBe(false);
    expect(container.textContent?.includes("Raw tracing on")).toBe(tracingEnabled);

    await act(async () => {
      buttons.find(button => button.textContent === "Run Heartbeat")!.click();
    });
    await flushReact();

    expect(mockAgentsApi.invoke).toHaveBeenCalledExactlyOnceWith("agent-1", "company-1");
    expect(mockNavigate).toHaveBeenCalledWith("/agents/alpha/runs/run-1");
  });

  it.each(["terminating", "cleaning_up"] as const)("keeps the detail page open during %s", async lifecycleState => {
    mockAgentsApi.terminate.mockResolvedValue(makeAgent({ status: "terminated", lifecycleState }));
    const onTerminateSuccess = vi.fn();
    render(makeAgent(), { onTerminateSuccess });
    await flushReact();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')!.click(); });
    await flushReact();
    await act(async () => { Array.from(document.body.querySelectorAll("button")).find(button => button.textContent?.includes("Terminate"))!.click(); });
    await flushReact();
    expect(mockAgentsApi.terminate).toHaveBeenCalledWith("agent-1", "company-1");
    expect(onTerminateSuccess).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "agent-1"] });
  });

  it("calls the terminate success handler after terminating an agent", async () => {
    const onTerminateSuccess = vi.fn();
    render(makeAgent(), { onTerminateSuccess });
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    const terminateButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Terminate"));
    expect(terminateButton).toBeTruthy();

    await act(async () => {
      terminateButton?.click();
    });
    await flushReact();

    expect(mockAgentsApi.terminate).toHaveBeenCalledWith("agent-1", "company-1");
    expect(onTerminateSuccess).toHaveBeenCalledWith(expect.objectContaining({
      id: "agent-1",
      status: "terminated",
    }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "alpha"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "company-1"] });
  });

  it("does not terminate when navigation away from a dirty detail page is rejected", async () => {
    const onBeforeNavigate = vi.fn().mockReturnValue(false);
    render(makeAgent(), { onBeforeNavigate, onTerminateSuccess: vi.fn() });
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    const terminateButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Terminate"));
    await act(async () => {
      terminateButton?.click();
    });
    await flushReact();

    expect(onBeforeNavigate).toHaveBeenCalledOnce();
    expect(mockAgentsApi.terminate).not.toHaveBeenCalled();
  });

  it("rechecks navigation when the form becomes dirty while termination is pending", async () => {
    let resolveTermination!: (agent: Agent) => void;
    mockAgentsApi.terminate.mockReturnValue(new Promise((resolve) => {
      resolveTermination = resolve;
    }));
    const onBeforeNavigate = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const onTerminateSuccess = vi.fn();
    const agent = makeAgent();
    render(agent, {
      hasPendingNavigationChanges: false,
      onBeforeNavigate,
      onTerminateSuccess,
    });
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();
    const terminateButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Terminate"));
    await act(async () => {
      terminateButton?.click();
    });
    await flushReact();

    render(agent, {
      hasPendingNavigationChanges: true,
      onBeforeNavigate,
      onTerminateSuccess,
    });
    await flushReact();
    resolveTermination(makeAgent({ status: "terminated" }));
    await flushReact();

    expect(onBeforeNavigate).toHaveBeenCalledTimes(2);
    expect(onTerminateSuccess).not.toHaveBeenCalled();
  });
});
