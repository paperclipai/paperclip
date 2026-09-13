// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { act as reactAct } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";

const { pushToast } = vi.hoisted(() => ({ pushToast: vi.fn(() => "toast-id") }));
vi.mock("./CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } }),
}));
vi.mock("./ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("../lib/router", () => ({ useLocation: () => ({ pathname: "/PAP/issues/PAP-204" }) }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "viewer" }, session: { id: "session", userId: "viewer" } }) },
}));
import {
  __liveUpdatesTestUtils,
  LiveUpdatesProvider,
  useCompanyLiveEvent,
  type CompanyLiveEventHandler,
} from "./LiveUpdatesProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { LiveEventSubscriptionContext, dispatchLiveEventToSubscribers } = __liveUpdatesTestUtils;

function act(callback: () => void) {
  flushSync(callback);
}

function progressEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1,
    companyId: "company-1",
    type: "heartbeat.run.progress",
    createdAt: "2026-07-15T00:00:00.000Z",
    payload: { issueId: "issue-1", message: "reviewing 14 open issues" },
    ...overrides,
  };
}

describe("useCompanyLiveEvent", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function renderWithSubscription(handler: CompanyLiveEventHandler) {
    const subscribers = new Set<CompanyLiveEventHandler>();
    const subscription = {
      subscribe: (fn: CompanyLiveEventHandler) => {
        subscribers.add(fn);
        return () => {
          subscribers.delete(fn);
        };
      },
    };

    function Consumer() {
      useCompanyLiveEvent(handler);
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(
        <LiveEventSubscriptionContext.Provider value={subscription}>
          <Consumer />
        </LiveEventSubscriptionContext.Provider>,
      );
    });

    return subscribers;
  }

  it("receives events dispatched through the shared registry", () => {
    const received: LiveEvent[] = [];
    const subscribers = renderWithSubscription((event) => received.push(event));

    act(() => dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent()));

    expect(received).toHaveLength(1);
    expect(received[0].payload.message).toBe("reviewing 14 open issues");
  });

  it("stops receiving events after unmount", () => {
    const received: LiveEvent[] = [];
    const subscribers = renderWithSubscription((event) => received.push(event));

    act(() => root?.unmount());
    root = null;

    act(() => dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent()));

    expect(received).toHaveLength(0);
  });

  it("no-ops without a surrounding provider", () => {
    function Consumer() {
      useCompanyLiveEvent(() => {
        throw new Error("should never be called");
      });
      return null;
    }

    root = createRoot(container);
    expect(() =>
      act(() => {
        root!.render(<Consumer />);
      }),
    ).not.toThrow();
  });
});

describe("LiveUpdatesProvider socket run notification scope", () => {
  let queryClient: QueryClient;
  let container: HTMLDivElement;
  let root: Root | null;
  let sockets: Array<{ onmessage: ((event: MessageEvent) => void) | null }>;

  beforeEach(() => {
    pushToast.mockClear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "viewer" }, session: { id: "session", userId: "viewer" } });
    queryClient.setQueryData(queryKeys.issues.detail("PAP-204"), {
      id: "root", companyId: "company-1", identifier: "PAP-204", assigneeAgentId: "parent-agent",
    });
    queryClient.setQueryData(queryKeys.issues.listByDescendantRoot("company-1", "root"), [
      { id: "child", companyId: "company-1", identifier: "PAP-205", assigneeAgentId: "child-agent", executionRunId: "child-run" },
    ]);
    queryClient.setQueryData(queryKeys.liveRuns("company-1"), [
      { id: "child-run", issueId: "child", agentId: "child-agent", status: "running" },
    ]);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    sockets = [];
    vi.stubGlobal("WebSocket", class {
      readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen = null;
      onclose = null;
      onerror = null;
      constructor() { sockets.push(this); }
      close() { this.readyState = 3; }
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await reactAct(async () => root?.unmount());
    root = null;
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function receiveStatus(payload: Record<string, unknown>) {
    await reactAct(async () => {
      root!.render(<QueryClientProvider client={queryClient}><LiveUpdatesProvider><span>Visible task</span></LiveUpdatesProvider></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.onmessage).toBeTypeOf("function");
    await reactAct(async () => sockets[0]!.onmessage!(new MessageEvent("message", {
      data: JSON.stringify({ id: 1, companyId: "company-1", type: "heartbeat.run.status", createdAt: "2026-09-09T18:00:00.000Z", payload }),
    })));
  }

  it("disconnects while hidden and reconciles active queries once on return", async () => {
    await receiveStatus({ runId: "child-run", agentId: "child-agent", status: "running" });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const visibility = vi.spyOn(document, "visibilityState", "get");
    await reactAct(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sockets[0].onmessage).toBeNull();
    invalidate.mockClear();
    await reactAct(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ type: "active" }, { cancelRefetch: false });
  });

  it.each(["parent-agent", "child-agent"])("shows an unrelated retryable failure without issueId for %s", async (agentId) => {
    // Match the retryable broadcast from execution-status-delivery.ts: it has
    // exact run identity but deliberately omits issueId and provider output.
    await receiveStatus({ runId: "unrelated-run", agentId, status: "failed", startedAt: "2026-09-09T17:59:00.000Z", finishedAt: "2026-09-09T18:00:00.000Z", deliveryId: "status-delivery" });
    expect(pushToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: "Agent run failed", dedupeKey: "run-status:unrelated-run:failed",
      action: { label: "View run", href: `/agents/${agentId}/runs/unrelated-run` },
    }));
  });

  it("retains the existing global no-success-toast policy independently of subtree membership", async () => {
    await receiveStatus({ runId: "unrelated-run", agentId: "child-agent", status: "succeeded" });
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("suppresses an exact descendant run before terminal cache removal", async () => {
    await receiveStatus({ runId: "child-run", agentId: "child-agent", status: "cancelled" });
    expect(pushToast).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.liveRuns("company-1"))).toEqual([]);
  });

  it("keeps a stopped visible task quiet when its retryable status follows live-cache eviction", async () => {
    // The route uses PAP-204, while IssueDetail's conversation loads run history
    // with the resolved UUID. The periodic status outbox omits issueId.
    queryClient.setQueryData(queryKeys.issues.runs("root"), [
      { runId: "parent-run", agentId: "parent-agent", status: "cancelled" },
    ]);
    queryClient.setQueryData(queryKeys.liveRuns("company-1"), [
      {
        id: "parent-run",
        issueId: "root",
        agentId: "parent-agent",
        status: "running",
      },
    ]);
    await receiveStatus({
      issueId: "root",
      runId: "parent-run",
      agentId: "parent-agent",
      status: "cancelled",
      triggerDetail: "system",
    });
    expect(pushToast).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.liveRuns("company-1"))).toEqual(
      [],
    );
    expect(
      queryClient.getQueryData(queryKeys.issues.runs("PAP-204")),
    ).toBeUndefined();

    await receiveStatus({
      runId: "parent-run",
      agentId: "parent-agent",
      status: "cancelled",
      startedAt: "2026-09-09T17:59:00.000Z",
      finishedAt: "2026-09-09T18:00:00.000Z",
      deliveryId: "retryable-parent-status",
    });
    expect(pushToast).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.issues.runs("root"))).toEqual([
      { runId: "parent-run", agentId: "parent-agent", status: "cancelled" },
    ]);
  });

  it.each(["active", "live", "linked"] as const)(
    "uses only an exact run from the visible task's canonical %s cache",
    async (cache) => {
      if (cache === "active") {
        queryClient.setQueryData(queryKeys.issues.activeRun("root"), {
          id: "parent-run",
        });
      } else if (cache === "live") {
        queryClient.setQueryData(queryKeys.issues.liveRuns("root"), [
          { id: "parent-run" },
        ]);
      } else {
        queryClient.setQueryData(queryKeys.issues.runs("root"), [
          { runId: "parent-run" },
        ]);
      }
      await receiveStatus({
        runId: "parent-run",
        agentId: "parent-agent",
        status: "cancelled",
        deliveryId: "retryable-parent-status",
      });
      expect(pushToast).not.toHaveBeenCalled();

      await receiveStatus({
        runId: "unrelated-run",
        agentId: "parent-agent",
        status: "cancelled",
        deliveryId: "retryable-unrelated-status",
      });
      expect(pushToast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          dedupeKey: "run-status:unrelated-run:cancelled",
        }),
      );
    },
  );

  it.each(["background", "explicit unrelated issue"])(
    "retains a canonical-history run notification for an %s event",
    async (scope) => {
      queryClient.setQueryData(queryKeys.issues.runs("root"), [
        { runId: "parent-run" },
      ]);
      if (scope === "background")
        vi.mocked(document.hasFocus).mockReturnValue(false);
      await receiveStatus({
        runId: "parent-run",
        agentId: "parent-agent",
        status: "cancelled",
        deliveryId: "retryable-parent-status",
        ...(scope === "explicit unrelated issue"
          ? { issueId: "unrelated" }
          : {}),
      });
      expect(pushToast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          dedupeKey: "run-status:parent-run:cancelled",
        }),
      );
    },
  );

  it("does not suppress an explicit unrelated task even when its run is cached", async () => {
    await receiveStatus({ issueId: "unrelated", runId: "child-run", agentId: "child-agent", status: "failed" });
    expect(pushToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dedupeKey: "run-status:child-run:failed" }));
  });

  it("keeps a stopped descendant quiet after its execution lock and live entry clear", async () => {
    // A previously visited child has canonical run history. The refreshed
    // subtree no longer holds executionRunId after the rich terminal event.
    queryClient.setQueryData(queryKeys.issues.runs("child"), [
      { runId: "child-run", agentId: "child-agent", status: "cancelled" },
    ]);
    await receiveStatus({
      issueId: "child",
      runId: "child-run",
      agentId: "child-agent",
      status: "cancelled",
      triggerDetail: "system",
    });
    expect(pushToast).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.liveRuns("company-1"))).toEqual(
      [],
    );
    queryClient.setQueryData(
      queryKeys.issues.listByDescendantRoot("company-1", "root"),
      [
        {
          id: "child",
          companyId: "company-1",
          identifier: "PAP-205",
          assigneeAgentId: "child-agent",
          executionRunId: null,
        },
      ],
    );

    await receiveStatus({
      runId: "child-run",
      agentId: "child-agent",
      status: "cancelled",
      startedAt: "2026-09-09T17:59:00.000Z",
      finishedAt: "2026-09-09T18:00:00.000Z",
      deliveryId: "retryable-child-status",
    });
    expect(pushToast).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.issues.runs("child"))).toEqual([
      { runId: "child-run", agentId: "child-agent", status: "cancelled" },
    ]);
  });

  it.each([
    ["child", "active"],
    ["child", "live"],
    ["child", "linked"],
    ["PAP-205", "active"],
    ["PAP-205", "live"],
    ["PAP-205", "linked"],
  ] as const)(
    "uses the current descendant's exact %s %s cache",
    async (ref, cache) => {
      queryClient.setQueryData(queryKeys.liveRuns("company-1"), []);
      queryClient.setQueryData(
        queryKeys.issues.listByDescendantRoot("company-1", "root"),
        [
          {
            id: "child",
            companyId: "company-1",
            identifier: "PAP-205",
            assigneeAgentId: "child-agent",
            executionRunId: null,
          },
        ],
      );
      if (cache === "active") {
        queryClient.setQueryData(queryKeys.issues.activeRun(ref), {
          id: "child-run",
        });
      } else if (cache === "live") {
        queryClient.setQueryData(queryKeys.issues.liveRuns(ref), [
          { id: "child-run" },
        ]);
      } else {
        queryClient.setQueryData(queryKeys.issues.runs(ref), [
          { runId: "child-run" },
        ]);
      }
      await receiveStatus({
        runId: "child-run",
        agentId: "child-agent",
        status: "cancelled",
        deliveryId: "retryable-child-status",
      });
      expect(pushToast).not.toHaveBeenCalled();
    },
  );

  it.each([
    "background",
    "explicit unrelated issue",
    "unrelated same-agent run",
    "removed descendant",
  ])("retains child-history notifications for %s", async (scope) => {
    queryClient.setQueryData(queryKeys.liveRuns("company-1"), []);
    queryClient.setQueryData(
      queryKeys.issues.listByDescendantRoot("company-1", "root"),
      scope === "removed descendant"
        ? []
        : [
            {
              id: "child",
              companyId: "company-1",
              identifier: "PAP-205",
              assigneeAgentId: "child-agent",
              executionRunId: null,
            },
          ],
    );
    queryClient.setQueryData(queryKeys.issues.runs("child"), [
      { runId: "child-run" },
    ]);
    queryClient.setQueryData(queryKeys.issues.runs("unrelated"), [
      { runId: "unrelated-run" },
    ]);
    if (scope === "background")
      vi.mocked(document.hasFocus).mockReturnValue(false);
    const runId =
      scope === "unrelated same-agent run" ? "unrelated-run" : "child-run";
    await receiveStatus({
      runId,
      agentId: "child-agent",
      status: "failed",
      deliveryId: "retryable-child-status",
      ...(scope === "explicit unrelated issue" ? { issueId: "unrelated" } : {}),
    });
    expect(pushToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ dedupeKey: `run-status:${runId}:failed` }),
    );
  });

  it("cannot create a run toast from an agent-only status with no run receipt", async () => {
    await receiveStatus({ agentId: "child-agent", status: "failed" });
    expect(pushToast).not.toHaveBeenCalled();
  });

  it.each(["child", "unrelated"])(
    "routes a never-visited child's retryable status by its explicit %s task",
    async (issueId) => {
      queryClient.setQueryData(queryKeys.liveRuns("company-1"), []);
      queryClient.setQueryData(
        queryKeys.issues.listByDescendantRoot("company-1", "root"),
        [
          {
            id: "child",
            companyId: "company-1",
            identifier: "PAP-205",
            assigneeAgentId: "child-agent",
            executionRunId: null,
          },
        ],
      );
      for (const ref of ["child", "PAP-205"]) {
        expect(
          queryClient.getQueryData(queryKeys.issues.runs(ref)),
        ).toBeUndefined();
        expect(
          queryClient.getQueryData(queryKeys.issues.activeRun(ref)),
        ).toBeUndefined();
        expect(
          queryClient.getQueryData(queryKeys.issues.liveRuns(ref)),
        ).toBeUndefined();
      }
      await receiveStatus({
        issueId,
        runId: "child-run",
        agentId: "child-agent",
        status: "cancelled",
        startedAt: "2026-09-09T17:59:00.000Z",
        finishedAt: "2026-09-09T18:00:00.000Z",
        deliveryId: "retryable-uncached-child-status",
      });
      if (issueId === "child") expect(pushToast).not.toHaveBeenCalled();
      else
        expect(pushToast).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            dedupeKey: "run-status:child-run:cancelled",
          }),
        );
    },
  );
});
