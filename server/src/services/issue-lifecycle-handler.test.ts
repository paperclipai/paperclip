import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStopRuntimeServices = vi.fn();
const mockAddComment = vi.fn();

vi.mock("./workspace-runtime.js", () => ({
  stopRuntimeServicesForExecutionWorkspace: (...args: unknown[]) => mockStopRuntimeServices(...args),
}));

vi.mock("./issues.js", () => ({
  issueService: () => ({
    addComment: (...args: unknown[]) => mockAddComment(...args),
  }),
}));

vi.mock("./activity-log.js", () => ({
  publishPluginDomainEvent: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-00000000-0000-0000-0000-000000000001";
const ISSUE_ID = "iss-00000000-0000-0000-0000-000000000001";
const OTHER_ISSUE_ID = "iss-00000000-0000-0000-0000-000000000002";

function makeWorkspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    status: "active",
    cwd: "/tmp/workspace",
    ...overrides,
  };
}

function makeIssueSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    status: "done",
    ...overrides,
  };
}

type SelectChainOptions = { rows: unknown[] };

function makeSelectChain({ rows }: SelectChainOptions) {
  return {
    from: () => ({
      where: () => ({
        then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(rows)),
      }),
    }),
  };
}

function createFakeDb(opts: {
  workspaceRows?: unknown[];
  liveOwnerRows?: unknown[];
}) {
  let selectCount = 0;
  const workspaceRows = opts.workspaceRows ?? [makeWorkspaceRow()];
  const liveOwnerRows = opts.liveOwnerRows ?? [];

  return {
    select: vi.fn(() => {
      selectCount += 1;
      // 1st select: workspace lookup
      // 2nd select: live owners query
      return makeSelectChain({
        rows: selectCount === 1 ? workspaceRows : liveOwnerRows,
      });
    }),
  } as unknown as import("@paperclipai/db").Db;
}

function makeEvent(payloadOverrides: Record<string, unknown> = {}): import("@paperclipai/plugin-sdk").PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.lifecycle.terminated",
    occurredAt: new Date().toISOString(),
    companyId: "cmp-1",
    payload: {
      issueId: ISSUE_ID,
      terminalStatus: "done",
      closedAt: new Date().toISOString(),
      executionWorkspaceId: WORKSPACE_ID,
      ...payloadOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Import the module under test after mocks are set up
// ---------------------------------------------------------------------------

// Dynamic import so vi.mock hoisting works correctly.
const { registerIssueLifecycleHandler, emitIssueLifecycleTerminated } = await import("./issue-lifecycle-handler.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitIssueLifecycleTerminated", () => {
  it("calls publishPluginDomainEvent with correct payload shape", async () => {
    const { publishPluginDomainEvent } = await import("./activity-log.js");
    const mockPublish = vi.mocked(publishPluginDomainEvent);
    mockPublish.mockClear();

    emitIssueLifecycleTerminated({
      id: ISSUE_ID,
      companyId: "cmp-1",
      status: "done",
      completedAt: new Date("2026-05-06T00:00:00Z"),
      executionWorkspaceId: WORKSPACE_ID,
    });

    expect(mockPublish).toHaveBeenCalledOnce();
    const event = mockPublish.mock.calls[0]?.[0] as import("@paperclipai/plugin-sdk").PluginEvent;
    expect(event.eventType).toBe("issue.lifecycle.terminated");
    expect(event.entityId).toBe(ISSUE_ID);
    const payload = event.payload as Record<string, unknown>;
    expect(payload.issueId).toBe(ISSUE_ID);
    expect(payload.terminalStatus).toBe("done");
    expect(payload.executionWorkspaceId).toBe(WORKSPACE_ID);
    expect(payload.closedAt).toBe("2026-05-06T00:00:00.000Z");
  });

  it("uses null for executionWorkspaceId when issue has none", async () => {
    const { publishPluginDomainEvent } = await import("./activity-log.js");
    const mockPublish = vi.mocked(publishPluginDomainEvent);
    mockPublish.mockClear();

    emitIssueLifecycleTerminated({
      id: ISSUE_ID,
      companyId: "cmp-1",
      status: "cancelled",
    });

    const event = mockPublish.mock.calls[0]?.[0] as import("@paperclipai/plugin-sdk").PluginEvent;
    const payload = event.payload as Record<string, unknown>;
    expect(payload.executionWorkspaceId).toBeNull();
    expect(payload.terminalStatus).toBe("cancelled");
  });
});

describe("IssueLifecycleTerminated handler (via registerIssueLifecycleHandler)", () => {
  let handlerFn: (event: import("@paperclipai/plugin-sdk").PluginEvent) => Promise<void>;

  beforeEach(() => {
    mockStopRuntimeServices.mockReset();
    mockAddComment.mockReset();

    // Capture the handler registered via subscribe
    const subscribedHandlers: Array<(event: import("@paperclipai/plugin-sdk").PluginEvent) => Promise<void>> = [];
    const fakeBus = {
      forPlugin: () => ({
        subscribe: (_pattern: string, fn: (event: import("@paperclipai/plugin-sdk").PluginEvent) => Promise<void>) => {
          subscribedHandlers.push(fn);
        },
      }),
    } as unknown as import("./plugin-event-bus.js").PluginEventBus;

    const db = createFakeDb({});
    registerIssueLifecycleHandler(db, fakeBus);
    handlerFn = subscribedHandlers[0]!;
  });

  it("is a no-op when executionWorkspaceId is null", async () => {
    const db = createFakeDb({ workspaceRows: [] });
    const fakeBus = captureRegistration(db);
    await fakeBus.handle(makeEvent({ executionWorkspaceId: null }));
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
  });

  it("stops services when workspace is active and no live owners remain", async () => {
    mockStopRuntimeServices.mockResolvedValue(undefined);
    const db = createFakeDb({
      workspaceRows: [makeWorkspaceRow()],
      liveOwnerRows: [], // no other live owners
    });
    const bus = captureRegistration(db);
    await bus.handle(makeEvent());
    expect(mockStopRuntimeServices).toHaveBeenCalledOnce();
    expect(mockStopRuntimeServices).toHaveBeenCalledWith(
      expect.objectContaining({ executionWorkspaceId: WORKSPACE_ID }),
    );
  });

  it("skips stop when live owners still hold the workspace", async () => {
    const db = createFakeDb({
      workspaceRows: [makeWorkspaceRow()],
      liveOwnerRows: [makeIssueSummary({ id: OTHER_ISSUE_ID, status: "in_progress" })],
    });
    const bus = captureRegistration(db);
    await bus.handle(makeEvent());
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
  });

  it("is idempotent: skips stop when workspace is already archived", async () => {
    const db = createFakeDb({
      workspaceRows: [makeWorkspaceRow({ status: "archived" })],
      liveOwnerRows: [],
    });
    const bus = captureRegistration(db);
    await bus.handle(makeEvent());
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
  });

  it("is idempotent: skips stop when workspace is not found", async () => {
    const db = createFakeDb({ workspaceRows: [] });
    const bus = captureRegistration(db);
    await bus.handle(makeEvent());
    expect(mockStopRuntimeServices).not.toHaveBeenCalled();
  });

  it("posts a failure comment on the closing issue when stop fails after retries", async () => {
    vi.useFakeTimers();
    try {
      mockStopRuntimeServices.mockRejectedValue(new Error("process refused SIGTERM"));
      mockAddComment.mockResolvedValue({ id: "cmt-1" });

      const db = createFakeDb({
        workspaceRows: [makeWorkspaceRow()],
        liveOwnerRows: [],
      });
      const bus = captureRegistration(db);

      // Start handler and advance all fake timers (skips exponential retry delays).
      const handlePromise = bus.handle(makeEvent());
      await vi.runAllTimersAsync();
      await handlePromise;

      expect(mockAddComment).toHaveBeenCalledOnce();
      const [commentIssueId, commentBody] = mockAddComment.mock.calls[0] as [string, string, unknown];
      expect(commentIssueId).toBe(ISSUE_ID);
      expect(commentBody).toContain("Workspace teardown failed");
      expect(commentBody).toContain(WORKSPACE_ID);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: capture registered handler from a fresh bus
// ---------------------------------------------------------------------------

function captureRegistration(db: import("@paperclipai/db").Db) {
  const captured: { fn?: (event: import("@paperclipai/plugin-sdk").PluginEvent) => Promise<void> } = {};
  const fakeBus = {
    forPlugin: () => ({
      subscribe: (_pattern: string, fn: (event: import("@paperclipai/plugin-sdk").PluginEvent) => Promise<void>) => {
        captured.fn = fn;
      },
    }),
  } as unknown as import("./plugin-event-bus.js").PluginEventBus;
  registerIssueLifecycleHandler(db, fakeBus);
  return {
    handle: (event: import("@paperclipai/plugin-sdk").PluginEvent) => {
      if (!captured.fn) throw new Error("handler not registered");
      return captured.fn(event);
    },
  };
}
