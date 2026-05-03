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
    expect(store.hasPending("session-1", "tool-1")).toBe(true);
    expect(store.resolve("session-1", "tool-1", "approve")).toBe(true);
    await expect(promise).resolves.toBe("approve");
    expect(store.hasPending("session-1", "tool-1")).toBe(false);
  });

  it("resolves with deny when the client denies", async () => {
    const store = chatPermissionStore();
    const promise = store.await("tool-2", "session-1", 60_000);
    store.resolve("session-1", "tool-2", "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("times out as deny after the TTL elapses", async () => {
    const store = chatPermissionStore();
    const promise = store.await("tool-3", "session-1", 5_000);
    vi.advanceTimersByTime(5_001);
    await expect(promise).resolves.toBe("deny");
    expect(store.hasPending("session-1", "tool-3")).toBe(false);
  });

  it("cancelSession denies all pending tool calls for that session", async () => {
    const store = chatPermissionStore();
    const a = store.await("tool-a", "session-X", 60_000);
    const b = store.await("tool-b", "session-X", 60_000);
    const c = store.await("tool-c", "session-Y", 60_000);
    store.cancelSession("session-X");
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
    expect(store.hasPending("session-Y", "tool-c")).toBe(true);
    store.resolve("session-Y", "tool-c", "approve");
    await expect(c).resolves.toBe("approve");
  });

  it("re-awaiting the same toolUseId denies the prior pending request", async () => {
    const store = chatPermissionStore();
    const first = store.await("tool-rep", "session-1", 60_000);
    const second = store.await("tool-rep", "session-1", 60_000);
    await expect(first).resolves.toBe("deny");
    store.resolve("session-1", "tool-rep", "approve");
    await expect(second).resolves.toBe("approve");
  });

  it("resolve returns false for unknown toolUseId", () => {
    const store = chatPermissionStore();
    expect(store.resolve("session-1", "nope", "approve")).toBe(false);
  });

  it("isolates tool ids across sessions (synthetic ids like 'call_0' don't collide)", async () => {
    const store = chatPermissionStore();
    const a = store.await("call_0", "session-A", 60_000);
    const b = store.await("call_0", "session-B", 60_000);
    expect(store.hasPending("session-A", "call_0")).toBe(true);
    expect(store.hasPending("session-B", "call_0")).toBe(true);
    store.resolve("session-A", "call_0", "approve");
    store.resolve("session-B", "call_0", "deny");
    await expect(a).resolves.toBe("approve");
    await expect(b).resolves.toBe("deny");
  });
});
