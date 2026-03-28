import { describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { createCompanyLiveEventsRegistry } from "./live-events-socket";

interface FakeSocket {
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

function createFakeSocket(): FakeSocket {
  return {
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
}

describe("createCompanyLiveEventsRegistry", () => {
  it("shares a single websocket per company across multiple subscribers", () => {
    const sockets: FakeSocket[] = [];
    const registry = createCompanyLiveEventsRegistry({
      createSocket: () => {
        const socket = createFakeSocket();
        sockets.push(socket);
        return socket as never;
      },
      getLocation: () => ({
        host: "127.0.0.1:3100",
        protocol: "http:",
      }),
    });
    const receivedByA: LiveEvent[] = [];
    const receivedByB: LiveEvent[] = [];

    const unsubscribeA = registry.subscribe("company-1", {
      onEvent: (event) => {
        receivedByA.push(event);
      },
    });
    const unsubscribeB = registry.subscribe("company-1", {
      onEvent: (event) => {
        receivedByB.push(event);
      },
    });

    expect(sockets).toHaveLength(1);

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        id: 1,
        type: "heartbeat.run.status",
        companyId: "company-1",
        createdAt: "2026-03-23T00:00:00.000Z",
        payload: { runId: "run-1", status: "running" },
      } satisfies LiveEvent),
    });

    expect(receivedByA).toHaveLength(1);
    expect(receivedByB).toHaveLength(1);

    unsubscribeA();
    expect(sockets[0]?.close).not.toHaveBeenCalled();

    unsubscribeB();
    expect(sockets[0]?.close).toHaveBeenCalledWith(1000, "last_subscriber");
  });

  it("notifies late subscribers immediately when the shared socket is already open", () => {
    const socket = createFakeSocket();
    const registry = createCompanyLiveEventsRegistry({
      createSocket: () => socket as never,
      getLocation: () => ({
        host: "127.0.0.1:3100",
        protocol: "http:",
      }),
    });
    const onOpen = vi.fn();

    registry.subscribe("company-1", {});
    socket.onopen?.();

    const unsubscribe = registry.subscribe("company-1", { onOpen });

    expect(onOpen).toHaveBeenCalledWith({ isReconnect: false });

    unsubscribe();
  });
});
