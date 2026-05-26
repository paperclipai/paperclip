import { describe, expect, it, vi } from "vitest";
import { registerAwaitingHumanBridgeAdapter, resolveAwaitingHumanBridgeAdapter } from "../services/awaiting-human-bridge-registry.js";

describe("awaiting-human-bridge-registry", () => {
  it("resolves a registered adapter factory", () => {
    const mockAdapter = { send: vi.fn(), poll: vi.fn(), close: vi.fn() };
    registerAwaitingHumanBridgeAdapter("mock", () => mockAdapter as any);

    const db = {} as any;
    const resolved = resolveAwaitingHumanBridgeAdapter("mock", db);

    expect(resolved).toBe(mockAdapter);
  });

  it("throws for unknown provider", () => {
    expect(() => resolveAwaitingHumanBridgeAdapter("unknown", {} as any)).toThrow(
      "Unknown awaiting human bridge provider: unknown",
    );
  });
});
