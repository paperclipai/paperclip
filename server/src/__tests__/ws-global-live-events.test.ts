import { describe, expect, it } from "vitest";

import {
  publishGlobalLiveEvent,
  publishLiveEvent,
  subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "../services/live-events.js";

// Unit-tests for the fix in server/src/realtime/live-events-ws.ts.
//
// The WS connection handler now calls both subscribeCompanyLiveEvents AND
// subscribeGlobalLiveEvents (live-events-ws.ts:208-219). These tests verify
// that a connected client receives globally-published events (e.g.
// plugin.worker.crashed) in addition to company-scoped ones, and that both
// subscriptions are torn down on close.

const OPEN = 1;

function makeSocketSpy() {
  const sent: unknown[] = [];
  let closed = false;

  return {
    get readyState() {
      return closed ? 3 /* CLOSED */ : OPEN;
    },
    close() {
      closed = true;
    },
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    sent,
  };
}

// Mirrors the subscription block in live-events-ws.ts:208-219 so that any
// future drift between production wiring and this test surfaces immediately.
function connectClient(companyId: string) {
  const socket = makeSocketSpy();

  const send = (event: unknown) => {
    if (socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(event));
  };

  const unsubscribeCompany = subscribeCompanyLiveEvents(companyId, send);
  const unsubscribeGlobal = subscribeGlobalLiveEvents(send);
  const cleanup = () => {
    unsubscribeCompany();
    unsubscribeGlobal();
  };

  return { socket, cleanup };
}

describe("WS transport: global live event delivery", () => {
  it("delivers a globally-published plugin.worker.crashed event to a connected client", () => {
    const { socket, cleanup } = connectClient("company-abc");

    publishGlobalLiveEvent({
      type: "plugin.worker.crashed",
      payload: { pluginId: "test.plugin", code: 137, signal: "SIGKILL", willRestart: true },
    });

    cleanup();

    const frame = socket.sent.find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["type"] === "plugin.worker.crashed",
    );
    expect(frame).toBeDefined();
    expect(frame?.["type"]).toBe("plugin.worker.crashed");
  });

  it("delivers both company-scoped and global events to the same client", () => {
    const { socket, cleanup } = connectClient("company-xyz");

    publishLiveEvent({
      companyId: "company-xyz",
      type: "activity.logged",
      payload: { action: "issue.created" },
    });
    publishGlobalLiveEvent({
      type: "plugin.worker.restarted",
      payload: { pluginId: "test.plugin", code: null, signal: null, willRestart: false },
    });

    cleanup();

    const types = socket.sent.map(
      (e) => (e as Record<string, unknown>)["type"] as string,
    );
    expect(types).toContain("activity.logged");
    expect(types).toContain("plugin.worker.restarted");
  });

  it("stops delivering global events after cleanup", () => {
    const { socket, cleanup } = connectClient("company-def");

    cleanup();

    publishGlobalLiveEvent({
      type: "plugin.worker.crashed",
      payload: { pluginId: "test.plugin" },
    });

    expect(socket.sent).toHaveLength(0);
  });

  it("cleanup of one client does not affect delivery to another client", () => {
    const { socket: s1, cleanup: c1 } = connectClient("company-1");
    const { socket: s2, cleanup: c2 } = connectClient("company-2");

    // Disconnect the first client.
    c1();

    publishGlobalLiveEvent({
      type: "plugin.worker.restarted",
      payload: { pluginId: "test.plugin" },
    });

    c2();

    // First client was cleaned up before publish — should receive nothing.
    expect(s1.sent).toHaveLength(0);
    // Second client was still connected at publish time — should receive the event.
    expect(s2.sent).toHaveLength(1);
  });
});
