import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createCoalescedAsyncTrigger,
  isChatPublicationCommitSignal,
  publishChatPublicationCommitSignal,
} from "./chat-publication-reconciliation.js";
import {
  publishGlobalLiveEvent,
  publishLiveEvent,
  subscribeAllCompanyLiveEvents,
  subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "./live-events.js";
import { SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES } from "./safe-native-chat-progress.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("createCoalescedAsyncTrigger", () => {
  it("coalesces notifications received before the scheduled pass starts", async () => {
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError,
      minimumSpacingMs: 0,
    });

    trigger.notify();
    trigger.notify();
    trigger.notify();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("records one dirty follow-up when notifications arrive in flight", async () => {
    const started = deferred();
    const release = deferred();
    const run = vi
      .fn(async () => undefined)
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });

    trigger.notify();
    await started.promise;
    trigger.notify();
    trigger.notify();
    trigger.notify();
    release.resolve();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not turn periodic recovery polls into dirty follow-ups", async () => {
    const started = deferred();
    const release = deferred();
    const run = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });

    trigger.poll();
    await started.promise;
    trigger.poll();
    trigger.poll();
    release.resolve();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("contains an error and remains available to the recovery poll", async () => {
    const failure = new Error("publication scan failed");
    const run = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(failure);
    const onError = vi.fn();
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError,
      minimumSpacingMs: 0,
    });

    trigger.notify();
    await trigger.drain();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);

    trigger.poll();
    await trigger.drain();
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("joins current work at shutdown and discards only its recoverable dirty bit", async () => {
    const started = deferred();
    const release = deferred();
    const run = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });

    trigger.notify();
    await started.promise;
    trigger.notify();
    trigger.stop();
    let drained = false;
    const draining = trigger.drain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    release.resolve();
    await draining;
    trigger.notify();
    trigger.poll();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caps sustained notifications without overlap or losing the last wake", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 100,
    });
    try {
      trigger.notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 9; index += 1) {
        await vi.advanceTimersByTimeAsync(10);
        trigger.notify();
      }
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(run).toHaveBeenCalledTimes(2);

      // A new event immediately after the capped pass is not lost, but it
      // cannot create another scan until the next minimum-spacing boundary.
      trigger.notify();
      await vi.advanceTimersByTimeAsync(99);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(3);
      expect(maxActive).toBe(1);
      await trigger.drain();
    } finally {
      trigger.stop();
      vi.useRealTimers();
    }
  });

  it("cancels a not-yet-started paced pass during shutdown", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    const run = vi.fn(async () => undefined);
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 100,
    });
    try {
      trigger.notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-09-08T00:00:00.010Z"));
      trigger.notify();
      trigger.stop();
      await trigger.drain();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      trigger.stop();
      vi.useRealTimers();
    }
  });
});

describe("chat publication commit signals", () => {
  it("emits the accepted signals only after their durable source writes", () => {
    const heartbeatSource = readFileSync(
      new URL("./heartbeat.ts", import.meta.url),
      "utf8",
    );
    const appendRunEventStart = heartbeatSource.indexOf(
      "async function appendRunEvent(",
    );
    const persistedEvent = heartbeatSource.indexOf(
      "await appendHeartbeatRunEvent",
      appendRunEventStart,
    );
    const emittedEvent = heartbeatSource.indexOf(
      "publishLiveEvent({",
      persistedEvent,
    );
    expect(appendRunEventStart).toBeGreaterThanOrEqual(0);
    expect(persistedEvent).toBeGreaterThan(appendRunEventStart);
    expect(emittedEvent).toBeGreaterThan(persistedEvent);

    const presentationMarker = heartbeatSource.indexOf(
      'eventType: "run.presentation.resolved"',
    );
    const committedComment = heartbeatSource.lastIndexOf(
      "await issuesSvc.addComment",
      presentationMarker,
    );
    expect(presentationMarker).toBeGreaterThanOrEqual(0);
    expect(committedComment).toBeGreaterThanOrEqual(0);
    expect(presentationMarker).toBeGreaterThan(committedComment);
  });

  it("accepts only the closed durable progress and final-presentation event types", () => {
    for (const eventType of SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES) {
      expect(
        isChatPublicationCommitSignal({
          type: "heartbeat.run.event",
          payload: { eventType },
        }),
      ).toBe(true);
    }
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.event",
        payload: { eventType: "run.presentation.resolved" },
      }),
    ).toBe(true);
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.event",
        payload: { eventType: "lifecycle" },
      }),
    ).toBe(false);
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.status",
        payload: { eventType: "run.presentation.resolved" },
      }),
    ).toBe(false);
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.event",
        payload: { eventType: "tool.execution.future_event" },
      }),
    ).toBe(false);
  });

  it("observes company events without changing the public global event stream", () => {
    const observed: string[] = [];
    const globallyObserved: string[] = [];
    const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
      observed.push(`${event.companyId}:${event.type}`);
    });
    const unsubscribeGlobal = subscribeGlobalLiveEvents((event) => {
      globallyObserved.push(`${event.companyId}:${event.type}`);
    });
    try {
      expect(publishChatPublicationCommitSignal({
        companyId: "publication-signal-company",
        issueId: "publication-signal-issue",
        runId: "publication-signal-run",
        agentId: "publication-signal-agent",
        seq: 7,
        eventType: "tool.execution.started",
      })).toBe(true);
      expect(publishChatPublicationCommitSignal({
        companyId: "publication-signal-company",
        issueId: "publication-signal-issue",
        runId: "publication-signal-run",
        agentId: "publication-signal-agent",
        seq: 8,
        eventType: "provider.notice",
      })).toBe(false);
      publishLiveEvent({
        companyId: "publication-signal-company",
        type: "heartbeat.run.status",
        payload: {},
      });
      publishGlobalLiveEvent({
        type: "plugin.ui.updated",
        payload: {},
      });
    } finally {
      unsubscribe();
      unsubscribeGlobal();
    }

    expect(observed).toEqual([
      "publication-signal-company:heartbeat.run.event",
      "publication-signal-company:heartbeat.run.status",
    ]);
    expect(globallyObserved).toEqual(["*:plugin.ui.updated"]);
  });

  it("contains a live subscriber failure after the durable source committed", () => {
    const unsubscribe = subscribeCompanyLiveEvents(
      "publication-signal-listener-failure",
      () => {
        throw new Error("simulated_live_listener_failure");
      },
    );
    try {
      expect(publishChatPublicationCommitSignal({
        companyId: "publication-signal-listener-failure",
        issueId: "publication-signal-issue",
        runId: "publication-signal-run",
        agentId: "publication-signal-agent",
        eventType: "run.presentation.resolved",
      })).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("ignores pre-publication lifecycle events and wakes only after the commit marker", async () => {
    let publicationCommitted = false;
    const run = vi.fn(async () => {
      expect(publicationCommitted).toBe(true);
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });
    const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
      if (isChatPublicationCommitSignal(event)) trigger.notify();
    });
    try {
      // Status/lifecycle events may be emitted before a publication transaction
      // commits or after it rolls back. They must leave recovery to polling.
      publishLiveEvent({
        companyId: "publication-commit-boundary-company",
        type: "heartbeat.run.event",
        payload: { eventType: "lifecycle" },
      });
      await trigger.drain();
      expect(run).not.toHaveBeenCalled();

      publicationCommitted = true;
      publishLiveEvent({
        companyId: "publication-commit-boundary-company",
        type: "heartbeat.run.event",
        payload: { eventType: "run.presentation.resolved" },
      });
      await trigger.drain();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      trigger.stop();
      await trigger.drain();
    }
  });
});
