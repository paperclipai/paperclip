import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { chatPermissionStore } from "../services/chat-permissions.js";

describe("chatPermissionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the decision when the client approves", async () => {
    const store = chatPermissionStore();
    const promise = store.await("tool-1", "session-1", 60_000);
    expect(store.hasPending("tool-1")).toBe(true);
    expect(store.resolve("tool-1", "approve")).toBe(true);
    await expect(promise).resolves.toBe("approve");
    expect(store.hasPending("tool-1")).toBe(false);
  });

  it("resolves with deny when the client denies", async () => {
    const store = chatPermissionStore();
    const promise = store.await("tool-2", "session-1", 60_000);
    store.resolve("tool-2", "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("times out as deny after the TTL elapses", async () => {
    const store = chatPermissionStore();
    const promise = store.await("tool-3", "session-1", 5_000);
    vi.advanceTimersByTime(5_001);
    await expect(promise).resolves.toBe("deny");
    expect(store.hasPending("tool-3")).toBe(false);
  });

  it("cancelSession denies all pending tool calls for that session", async () => {
    const store = chatPermissionStore();
    const a = store.await("tool-a", "session-X", 60_000);
    const b = store.await("tool-b", "session-X", 60_000);
    const c = store.await("tool-c", "session-Y", 60_000);
    store.cancelSession("session-X");
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
    expect(store.hasPending("tool-c")).toBe(true);
    store.resolve("tool-c", "approve");
    await expect(c).resolves.toBe("approve");
  });

  it("re-awaiting the same toolUseId denies the prior pending request", async () => {
    const store = chatPermissionStore();
    const first = store.await("tool-rep", "session-1", 60_000);
    const second = store.await("tool-rep", "session-1", 60_000);
    await expect(first).resolves.toBe("deny");
    store.resolve("tool-rep", "approve");
    await expect(second).resolves.toBe("approve");
  });

  it("resolve returns false for unknown toolUseId", () => {
    const store = chatPermissionStore();
    expect(store.resolve("nope", "approve")).toBe(false);
  });
});
