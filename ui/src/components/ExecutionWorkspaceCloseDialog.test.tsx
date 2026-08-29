// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionWorkspaceCloseReadiness } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionWorkspaceCloseDialog } from "./ExecutionWorkspaceCloseDialog";

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/execution-workspaces", () => ({ executionWorkspacesApi: mockExecutionWorkspacesApi }));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
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

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 30) {
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

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function readiness(overrides: Partial<ExecutionWorkspaceCloseReadiness> = {}): ExecutionWorkspaceCloseReadiness {
  return {
    workspaceId: "workspace-1",
    deliveryState: "merged_by_ancestry",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [],
    isDestructiveCloseAllowed: true,
    requiresGitUnavailableAcknowledgement: false,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    gitInspection: { state: "available", errorCode: null, message: null, retryable: false },
    git: null,
    runtimeServices: [],
    ...overrides,
  };
}

function renderDialog(
  root: Root,
  queryClient: QueryClient,
  props: { open: boolean; workspaceId?: string },
) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ExecutionWorkspaceCloseDialog
          workspaceId={props.workspaceId ?? "workspace-1"}
          workspaceName="Workspace one"
          currentStatus="active"
          open={props.open}
          onOpenChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
  });
}

describe("ExecutionWorkspaceCloseDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    setVisibility("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockExecutionWorkspacesApi.getCloseReadiness.mockResolvedValue(readiness());
    mockExecutionWorkspacesApi.update.mockResolvedValue({ id: "workspace-1", companyId: "company-1" });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
    setVisibility("visible");
  });

  it("does not fetch while closed or hidden and makes one request when visible", async () => {
    renderDialog(root, queryClient, { open: false });
    await flush();
    expect(mockExecutionWorkspacesApi.getCloseReadiness).not.toHaveBeenCalled();

    setVisibility("hidden");
    renderDialog(root, queryClient, { open: true });
    await flush();
    expect(mockExecutionWorkspacesApi.getCloseReadiness).not.toHaveBeenCalled();

    setVisibility("visible");
    await waitForAssertion(() => expect(mockExecutionWorkspacesApi.getCloseReadiness).toHaveBeenCalledTimes(1));
  });

  it("cancels on close and workspace change", async () => {
    const signals: AbortSignal[] = [];
    mockExecutionWorkspacesApi.getCloseReadiness.mockImplementation(
      (_id: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signals.push(options.signal);
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    renderDialog(root, queryClient, { open: true });
    await waitForAssertion(() => expect(signals).toHaveLength(1));

    renderDialog(root, queryClient, { open: false });
    await waitForAssertion(() => expect(signals[0]?.aborted).toBe(true));

    renderDialog(root, queryClient, { open: true, workspaceId: "workspace-2" });
    await waitForAssertion(() => expect(signals).toHaveLength(2));
    renderDialog(root, queryClient, { open: true, workspaceId: "workspace-3" });
    await waitForAssertion(() => expect(signals[1]?.aborted).toBe(true));
  });

  it("does not retry on focus or reconnect and debounces explicit retry", async () => {
    mockExecutionWorkspacesApi.getCloseReadiness.mockRejectedValue(new Error("Readiness unavailable"));
    renderDialog(root, queryClient, { open: true });
    await waitForAssertion(() => expect(document.body.textContent).toContain("Readiness unavailable"));
    expect(mockExecutionWorkspacesApi.getCloseReadiness).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(mockExecutionWorkspacesApi.getCloseReadiness).toHaveBeenCalledTimes(1);

    const retry = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Retry readiness check")) as HTMLButtonElement;
    await act(async () => {
      retry.click();
      retry.click();
    });
    await waitForAssertion(() => expect(mockExecutionWorkspacesApi.getCloseReadiness).toHaveBeenCalledTimes(2));
    await waitForAssertion(() => {
      const currentRetry = Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Retry readiness check")) as HTMLButtonElement | undefined;
      expect(currentRetry?.disabled).toBe(true);
    });
  });

  it("refetches once on reopen and requires acknowledgement for unavailable Git", async () => {
    mockExecutionWorkspacesApi.getCloseReadiness.mockResolvedValue(readiness({
      state: "blocked",
      blockingReasons: ["Git readiness is unavailable"],
      isDestructiveCloseAllowed: false,
      requiresGitUnavailableAcknowledgement: true,
      gitInspection: {
        state: "unavailable",
        errorCode: "workspace_git_scan_timeout",
        message: "The Git check timed out",
        retryable: false,
      },
    }));
    renderDialog(root, queryClient, { open: true });
    await waitForAssertion(() => expect(document.body.textContent).toContain("Git status unavailable"));
    expect(mockExecutionWorkspacesApi.getCloseReadiness).toHaveBeenCalledTimes(1);

    renderDialog(root, queryClient, { open: false });
    renderDialog(root, queryClient, { open: true });
    await waitForAssertion(() => expect(mockExecutionWorkspacesApi.getCloseReadiness).toHaveBeenCalledTimes(2));

    const closeButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Close workspace") as HTMLButtonElement;
    expect(closeButton.disabled).toBe(true);
    const acknowledge = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Acknowledge unavailable Git status"]',
    )!;
    await act(async () => acknowledge.click());
    expect(closeButton.disabled).toBe(false);

    await act(async () => closeButton.click());
    await waitForAssertion(() => expect(mockExecutionWorkspacesApi.update).toHaveBeenCalledWith(
      "workspace-1",
      { status: "archived", acknowledgeGitUnavailable: true },
    ));
  });
});
