import { describe, expect, it } from "vitest";
import type { AcpPermissionRequest } from "acpx/runtime";
import {
  createAcpPermissionObserver,
  mapPermissionObserverMethod,
  mapPermissionObserverOutcome,
  mapPermissionObserverToolKind,
  type PermissionObserverLogEvent,
} from "./permission-observer.js";

function buildRequest(overrides: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest {
  return {
    sessionId: "session-1",
    inferredKind: "execute",
    raw: {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1" },
      options: [],
    },
    ...overrides,
  } as AcpPermissionRequest;
}

describe("permission-observer closed-enum mappers", () => {
  it("maps a recognized method and returns 'unknown' for anything else", () => {
    expect(mapPermissionObserverMethod("session/request_permission")).toBe("session/request_permission");
    expect(mapPermissionObserverMethod("session/other_method")).toBe("unknown");
    expect(mapPermissionObserverMethod(undefined)).toBe("unknown");
    expect(mapPermissionObserverMethod(42)).toBe("unknown");
  });

  it("maps a recognized tool kind and returns 'unknown' for anything else", () => {
    expect(mapPermissionObserverToolKind("execute")).toBe("execute");
    expect(mapPermissionObserverToolKind("teleport")).toBe("unknown");
    expect(mapPermissionObserverToolKind(undefined)).toBe("unknown");
  });

  it("maps a terminal outcome and returns 'unknown' for a non-terminal or unrecognized status", () => {
    expect(mapPermissionObserverOutcome("completed")).toBe("completed");
    expect(mapPermissionObserverOutcome("failed")).toBe("failed");
    expect(mapPermissionObserverOutcome("pending")).toBe("unknown");
    expect(mapPermissionObserverOutcome("something-else")).toBe("unknown");
  });
});

describe("createAcpPermissionObserver — handlePermissionRequest", () => {
  it("resolves to undefined for a normal request", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const result = await observer.handlePermissionRequest(buildRequest(), { signal: new AbortController().signal });
    expect(result).toBeUndefined();
  });

  it("resolves to undefined for a request that carries unknown fields", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const request = buildRequest({
      inferredKind: "not-a-real-kind" as unknown as AcpPermissionRequest["inferredKind"],
      raw: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
        options: [],
        _meta: { anExtraField: "some value nobody declared" },
      } as AcpPermissionRequest["raw"],
    });
    const result = await observer.handlePermissionRequest(request, { signal: new AbortController().signal });
    expect(result).toBeUndefined();
  });

  it("resolves to undefined even when the injected log sink throws", async () => {
    const observer = createAcpPermissionObserver({
      emitLog: () => {
        throw new Error("sink failure");
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const result = await observer.handlePermissionRequest(buildRequest(), { signal: new AbortController().signal });
    expect(result).toBeUndefined();
  });

  it("never awaits the log write on the hook path", async () => {
    let logCalled = false;
    const observer = createAcpPermissionObserver({
      // A log sink that returns a promise which never resolves. If the hook
      // awaited it internally, the assertion below would never run.
      emitLog: () => {
        logCalled = true;
        return new Promise(() => {}) as unknown as void;
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    let settled = false;
    const promise = observer.handlePermissionRequest(buildRequest(), { signal: new AbortController().signal });
    void promise.then(() => {
      settled = true;
    });
    // Flush one microtask turn. A synchronous hook body resolves within it;
    // an awaited I/O call would not.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(logCalled).toBe(true);
  });

  it("emits only allow-listed scalar fields, never the raw request payload", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const longString = "x".repeat(10_000);
    const request = buildRequest({
      raw: {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          rawInput: { command: "rm -rf /", nested: { secret: "s3cr3t" } },
        },
        options: [],
        _meta: { note: longString },
      } as unknown as AcpPermissionRequest["raw"],
    });
    (request as unknown as { error: unknown }).error = { data: { stack: "leaked stack trace" } };
    await observer.handlePermissionRequest(request, { signal: new AbortController().signal });

    expect(events).toHaveLength(1);
    const [event] = events;
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("leaked stack trace");
    expect(serialized).not.toContain(longString);
    expect(Object.keys(event).sort()).toEqual(
      ["method", "permissionMode", "sessionId", "stage", "toolCallId", "toolKind", "transport", "type"].sort(),
    );
  });

  it("maps an unmapped tool kind to exactly 'unknown', dropping the source string", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const request = buildRequest({ inferredKind: "levitate" as unknown as AcpPermissionRequest["inferredKind"] });
    await observer.handlePermissionRequest(request, { signal: new AbortController().signal });
    expect(events[0]?.toolKind).toBe("unknown");
    expect(JSON.stringify(events[0])).not.toContain("levitate");
  });
});

describe("createAcpPermissionObserver — ledger lifecycle", () => {
  it("opens an entry on receipt, closes it on the terminal tool_call_update, and reports the age", async () => {
    let clock = 1_000;
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
      now: () => clock,
    });
    await observer.handlePermissionRequest(buildRequest(), { signal: new AbortController().signal });
    clock += 4_200;
    observer.noteToolCallEvent("session-1", { toolCallId: "tool-1", status: "completed" });

    const settled = events.find((event) => event.type === "acpx.permission_settled");
    expect(settled).toMatchObject({
      type: "acpx.permission_settled",
      sessionId: "session-1",
      toolCallId: "tool-1",
      outcome: "completed",
      ageMs: 4_200,
    });

    // A settled entry must not resurface at finalization.
    events.length = 0;
    await observer.finalizeRun();
    expect(events).toHaveLength(0);
  });

  it("reports one unsettled event per still-open entry at run finalization, with the last observed stage", async () => {
    let clock = 0;
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
      now: () => clock,
    });
    await observer.handlePermissionRequest(buildRequest(), { signal: new AbortController().signal });
    await observer.handlePermissionRequest(
      buildRequest({
        raw: { sessionId: "session-1", toolCall: { toolCallId: "tool-2" }, options: [] } as AcpPermissionRequest["raw"],
      }),
      { signal: new AbortController().signal },
    );
    // tool-1 advances to "in_progress" but never reaches a terminal status.
    observer.noteToolCallEvent("session-1", { toolCallId: "tool-1", status: "in_progress" });
    clock = 27 * 60 * 1000;

    await observer.finalizeRun();

    const unsettled = events.filter((event) => event.type === "acpx.permission_unsettled");
    expect(unsettled).toHaveLength(2);
    const byToolCallId = Object.fromEntries(unsettled.map((event) => [event.toolCallId, event]));
    expect(byToolCallId["tool-1"]).toMatchObject({ stage: "in_progress", ageMs: 27 * 60 * 1000 });
    expect(byToolCallId["tool-2"]).toMatchObject({ stage: "requested", ageMs: 27 * 60 * 1000 });

    // Finalization drains the ledger; a second call reports nothing new.
    events.length = 0;
    await observer.finalizeRun();
    expect(events).toHaveLength(0);
  });

  it("does not close an entry on a non-terminal tool_call status", () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    observer.noteToolCallEvent("session-1", { toolCallId: "tool-1", status: "pending" });
    expect(events.filter((event) => event.type === "acpx.permission_settled")).toHaveLength(0);
  });

  it("ignores a tool_call event for a toolCallId it never opened", () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    observer.noteToolCallEvent("session-1", { toolCallId: "never-opened", status: "completed" });
    expect(events).toHaveLength(0);
  });

  it("does not open a ledger entry for a request with no tool-call identifier", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const request = buildRequest({
      raw: { sessionId: "session-1", toolCall: {}, options: [] } as unknown as AcpPermissionRequest["raw"],
    });
    await observer.handlePermissionRequest(request, { signal: new AbortController().signal });

    const observed = events.filter((event) => event.type === "acpx.permission_observed");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ toolCallId: "unknown" });

    events.length = 0;
    await observer.finalizeRun();
    expect(events).toHaveLength(0);
  });

  it("does not let two requests with a missing session identifier share one ledger entry", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const firstRequest = buildRequest({
      sessionId: undefined as unknown as string,
      raw: { toolCall: { toolCallId: "tool-1" }, options: [] } as unknown as AcpPermissionRequest["raw"],
    });
    const secondRequest = buildRequest({
      sessionId: undefined as unknown as string,
      raw: { toolCall: { toolCallId: "tool-2" }, options: [] } as unknown as AcpPermissionRequest["raw"],
    });
    await observer.handlePermissionRequest(firstRequest, { signal: new AbortController().signal });
    await observer.handlePermissionRequest(secondRequest, { signal: new AbortController().signal });

    // Neither request carried a real session identifier, so neither one opened
    // a ledger entry. A terminal tool_call event for either tool call must
    // find nothing to settle.
    observer.noteToolCallEvent(undefined, { toolCallId: "tool-1", status: "completed" });
    observer.noteToolCallEvent(undefined, { toolCallId: "tool-2", status: "completed" });
    expect(events.filter((event) => event.type === "acpx.permission_settled")).toHaveLength(0);

    events.length = 0;
    await observer.finalizeRun();
    expect(events).toHaveLength(0);
  });
});

describe("createAcpPermissionObserver — per-run budgets", () => {
  function buildRequestFor(sessionId: string, toolCallId: string): AcpPermissionRequest {
    return buildRequest({
      sessionId,
      raw: { sessionId, toolCall: { toolCallId }, options: [] } as AcpPermissionRequest["raw"],
    });
  }

  it("caps the ledger and the observed-event count when more than 256 requests never settle", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 300; i += 1) {
      await observer.handlePermissionRequest(buildRequestFor(`session-${i}`, `tool-${i}`), { signal });
    }

    const observed = events.filter((event) => event.type === "acpx.permission_observed");
    expect(observed.length).toBeLessThanOrEqual(256);

    events.length = 0;
    await observer.finalizeRun();
    const unsettled = events.filter((event) => event.type === "acpx.permission_unsettled");
    expect(unsettled.length).toBeLessThanOrEqual(256);
    const summaries = events.filter((event) => event.type === "acpx.permission_observer_truncated");
    expect(summaries).toHaveLength(1);
  });

  it("bounds cumulative settled emissions at 256 across more than 1000 open-and-settle cycles", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 1_100; i += 1) {
      const sessionId = `session-${i}`;
      const toolCallId = `tool-${i}`;
      await observer.handlePermissionRequest(buildRequestFor(sessionId, toolCallId), { signal });
      observer.noteToolCallEvent(sessionId, { toolCallId, status: "completed" });
    }

    const settled = events.filter((event) => event.type === "acpx.permission_settled");
    expect(settled.length).toBeLessThanOrEqual(256);

    events.length = 0;
    await observer.finalizeRun();
    expect(events.filter((event) => event.type === "acpx.permission_observer_truncated")).toHaveLength(1);
  });

  it("keeps the unsettled-event budget reachable after a normal run spends the settled budget", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    // A normal run: 256 requests open and settle during the turn.
    for (let i = 0; i < 256; i += 1) {
      const sessionId = `session-${i}`;
      const toolCallId = `tool-${i}`;
      await observer.handlePermissionRequest(buildRequestFor(sessionId, toolCallId), { signal });
      observer.noteToolCallEvent(sessionId, { toolCallId, status: "completed" });
    }
    // One more request opens and never settles. This is the stall.
    await observer.handlePermissionRequest(buildRequestFor("session-stall", "tool-stall"), { signal });

    events.length = 0;
    await observer.finalizeRun();
    const unsettled = events.filter((event) => event.type === "acpx.permission_unsettled");
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({ toolCallId: "tool-stall" });
  });

  it("bounds cumulative unsettled emissions at 256 when more than 256 requests never settle", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 300; i += 1) {
      await observer.handlePermissionRequest(buildRequestFor(`session-${i}`, `tool-${i}`), { signal });
    }

    events.length = 0;
    await observer.finalizeRun();
    const unsettled = events.filter((event) => event.type === "acpx.permission_unsettled");
    expect(unsettled.length).toBeLessThanOrEqual(256);
  });

  it("emits exactly one truncated summary event across two finalizeRun calls", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 300; i += 1) {
      await observer.handlePermissionRequest(buildRequestFor(`session-${i}`, `tool-${i}`), { signal });
    }

    events.length = 0;
    await observer.finalizeRun();
    await observer.finalizeRun();
    expect(events.filter((event) => event.type === "acpx.permission_observer_truncated")).toHaveLength(1);
  });

  it("keeps the settled-event budget reachable after the observed budget is spent", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    const opened: Array<{ sessionId: string; toolCallId: string }> = [];
    for (let i = 0; i < 256; i += 1) {
      const sessionId = `session-${i}`;
      const toolCallId = `tool-${i}`;
      opened.push({ sessionId, toolCallId });
      await observer.handlePermissionRequest(buildRequestFor(sessionId, toolCallId), { signal });
    }
    // The observed budget is now fully spent. A further request emits no
    // "acpx.permission_observed" event.
    await observer.handlePermissionRequest(buildRequestFor("session-extra", "tool-extra"), { signal });
    expect(events.filter((event) => event.type === "acpx.permission_observed")).toHaveLength(256);

    events.length = 0;
    for (const { sessionId, toolCallId } of opened) {
      observer.noteToolCallEvent(sessionId, { toolCallId, status: "completed" });
    }

    const settled = events.filter((event) => event.type === "acpx.permission_settled");
    expect(settled.length).toBe(256);
  });

  it("emits a summary event with only the four counters and the type, using an exact key match", async () => {
    const events: PermissionObserverLogEvent[] = [];
    const observer = createAcpPermissionObserver({
      emitLog: (event) => {
        events.push(event);
      },
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 300; i += 1) {
      await observer.handlePermissionRequest(buildRequestFor(`session-${i}`, `tool-${i}`), { signal });
    }

    events.length = 0;
    await observer.finalizeRun();
    const summary = events.find((event) => event.type === "acpx.permission_observer_truncated");
    expect(summary).toBeDefined();
    expect(Object.keys(summary as object).sort()).toEqual(
      [
        "suppressedLedgerEntries",
        "suppressedObservedEvents",
        "suppressedSettledEvents",
        "suppressedUnsettledEvents",
        "type",
      ].sort(),
    );
    expect(typeof summary?.suppressedLedgerEntries).toBe("number");
    expect(typeof summary?.suppressedObservedEvents).toBe("number");
    expect(typeof summary?.suppressedSettledEvents).toBe("number");
    expect(typeof summary?.suppressedUnsettledEvents).toBe("number");
  });

  it("still resolves handlePermissionRequest to undefined, and throws nothing, once every cap is reached", async () => {
    const observer = createAcpPermissionObserver({
      emitLog: () => {},
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 300; i += 1) {
      await observer.handlePermissionRequest(buildRequestFor(`session-${i}`, `tool-${i}`), { signal });
    }
    const result = await observer.handlePermissionRequest(buildRequestFor("session-last", "tool-last"), { signal });
    expect(result).toBeUndefined();
    await expect(observer.finalizeRun()).resolves.toBeUndefined();
  });
});

describe("createAcpPermissionObserver — asynchronous log persistence", () => {
  it("waits for a write still pending from an earlier event before finalizeRun resolves", async () => {
    const durable: PermissionObserverLogEvent[] = [];
    const releaseWrite: Array<() => void> = [];
    const observer = createAcpPermissionObserver({
      // A durable log sink that starts a write and only completes it when the
      // test calls the matching release function. This stands in for a real
      // write to storage that takes more than one microtask turn.
      emitLog: (event) =>
        new Promise<void>((resolve) => {
          releaseWrite.push(() => {
            durable.push(event);
            resolve();
          });
        }),
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    // This request's "observed" write starts but does not finish. The tool
    // call it opened never settles, so the entry is still open at
    // finalization.
    await observer.handlePermissionRequest(buildRequest(), { signal });
    expect(durable).toHaveLength(0);

    const finalizePromise = observer.finalizeRun();
    // finalizeRun has started its own "unsettled" write for the still-open
    // entry. That write is also pending. Flush a few microtask turns: if
    // finalizeRun dropped either write's promise, it would resolve here even
    // though neither write has completed.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(durable).toHaveLength(0);

    // Release both writes, the one queued before finalizeRun ran and the one
    // finalizeRun queued itself.
    for (const release of releaseWrite) release();
    await finalizePromise;

    expect(durable.map((event) => event.type).sort()).toEqual(
      ["acpx.permission_observed", "acpx.permission_unsettled"].sort(),
    );
  });

  it("resolves finalizeRun without throwing when a queued write rejects", async () => {
    const observer = createAcpPermissionObserver({
      emitLog: () => Promise.reject(new Error("durable sink unavailable")),
      permissionMode: "approve-all",
      transport: "sandbox",
    });
    const signal = new AbortController().signal;
    await observer.handlePermissionRequest(buildRequest(), { signal });
    await expect(observer.finalizeRun()).resolves.toBeUndefined();
  });
});
