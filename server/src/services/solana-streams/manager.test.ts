import { describe, expect, it, vi } from "vitest";
import { createSolanaStreamManager } from "./manager.js";
import type { SolanaStreamEvent, SolanaStreamSource } from "./types.js";

function createMockSource(): SolanaStreamSource {
  let running = false;
  const listeners = new Set<(event: SolanaStreamEvent) => void>();
  return {
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
    isHealthy: () => running,
    onEvent: (listener) => {
      listeners.add(listener);
      const unsubscribe = () => listeners.delete(listener);
      return unsubscribe;
    },
  };
}

describe("createSolanaStreamManager", () => {
  it("removes the source event listener when the stream is deleted", async () => {
    const manager = createSolanaStreamManager();
    const source = createMockSource();
    const stream = manager.createStream(
      {
        id: "test",
        name: "Test",
        rpcUrl: "http://localhost:8899",
        commitment: "confirmed",
        filters: [],
        enabled: true,
      },
      source,
    );

    const unsubscribe = vi.fn();
    stream.unsubscribe = unsubscribe;

    await manager.deleteStream("test");
    expect(unsubscribe).toHaveBeenCalled();
  });
});
