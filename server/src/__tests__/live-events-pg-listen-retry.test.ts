import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";

/**
 * Unit tests for the pg transport's LISTEN failure self-heal path.
 *
 * The embedded-Postgres integration suite (live-events-cross-replica.test.ts)
 * cannot force `sql.listen()` to reject deterministically, so these tests
 * mock the postgres-js client: the subscription seat must survive a failed
 * LISTEN, the LISTEN must be retried with backoff, and the first successful
 * retry must deliver a synthetic transport.resync (events NOTIFYed during
 * the dark window are gone — at-most-once).
 */

const mocks = vi.hoisted(() => ({
  listen: vi.fn<
    (
      channel: string,
      onNotify: (raw: string) => void,
      onListen?: () => void,
    ) => Promise<{ unlisten: () => Promise<void> }>
  >(),
  notify: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
}));

vi.mock("@paperclipai/db", () => ({
  postgres: () => {
    // Tagged-template calls (only used by stats()) resolve to an empty row set.
    const sql = (() => Promise.resolve([])) as unknown as Record<string, unknown>;
    sql.listen = mocks.listen;
    sql.notify = mocks.notify;
    sql.end = mocks.end;
    return sql;
  },
}));

import { createPgLiveEventsTransport } from "../services/live-events/pg-transport.js";

describe("pg transport LISTEN failure self-heal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listen.mockReset();
    mocks.notify.mockClear();
    mocks.end.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the subscription seated, retries the LISTEN, and delivers a resync on recovery", async () => {
    const notifyHandlers: Array<(raw: string) => void> = [];
    mocks.listen.mockImplementation(async (_channel, onNotify, onListen) => {
      if (mocks.listen.mock.calls.length === 1) throw new Error("ECONNREFUSED");
      notifyHandlers.push(onNotify);
      onListen?.();
      return { unlisten: async () => {} };
    });

    const transport = createPgLiveEventsTransport({ databaseUrl: "postgres://unused" });
    const received: LiveEvent[] = [];
    transport.subscribe("company-a", (event) => received.push(event));

    // First LISTEN rejects; whenSubscribed settles on the failed attempt.
    await transport.whenSubscribed?.("company-a");
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);

    // The retry fires after the initial backoff and succeeds.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    await transport.whenSubscribed?.("company-a");

    // Recovery delivers a synthetic resync so consumers refetch what the
    // dark window dropped.
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("transport.resync");
    expect(received[0]?.payload).toEqual({ __resync: true });

    // Cross-replica delivery works through the retried LISTEN.
    const inbound: LiveEvent = {
      id: 42,
      companyId: "company-a",
      type: "activity.logged",
      createdAt: new Date().toISOString(),
      payload: {},
    };
    notifyHandlers[0]?.(JSON.stringify({ kind: "full", origin: "other-replica", event: inbound }));
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(inbound);

    await transport.close();
  });

  it("backs off exponentially while the LISTEN keeps failing", async () => {
    mocks.listen.mockRejectedValue(new Error("ECONNREFUSED"));

    const transport = createPgLiveEventsTransport({ databaseUrl: "postgres://unused" });
    transport.subscribe("company-a", () => {});
    await transport.whenSubscribed?.("company-a");
    expect(mocks.listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // retry #1 after 1s
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // 1s into the 2s backoff
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // retry #2 after 2s total
    expect(mocks.listen).toHaveBeenCalledTimes(3);

    await transport.close();
  });

  it("cancels the pending retry when the last subscriber detaches", async () => {
    mocks.listen.mockRejectedValue(new Error("ECONNREFUSED"));

    const transport = createPgLiveEventsTransport({ databaseUrl: "postgres://unused" });
    const handler = () => {};
    transport.subscribe("company-a", handler);
    await transport.whenSubscribed?.("company-a");
    expect(mocks.listen).toHaveBeenCalledTimes(1);

    transport.unsubscribe("company-a", handler);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.listen).toHaveBeenCalledTimes(1);

    await transport.close();
  });

  it("cancels the pending retry on close()", async () => {
    mocks.listen.mockRejectedValue(new Error("ECONNREFUSED"));

    const transport = createPgLiveEventsTransport({ databaseUrl: "postgres://unused" });
    transport.subscribe("company-a", () => {});
    await transport.whenSubscribed?.("company-a");
    expect(mocks.listen).toHaveBeenCalledTimes(1);

    await transport.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });
});
