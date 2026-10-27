import type { QueueEntry } from "chat";
import { describe, expect, it } from "vitest";
import {
  createPaperclipChatSdkState,
  type ChatSdkStateCompareAndSetInput,
  type ChatSdkStateDeleteInput,
  type ChatSdkStatePersistence,
  type ChatSdkStateRecord,
  type ChatSdkStateScope,
} from "./chat-sdk-state.js";

class MemoryCasPersistence implements ChatSdkStatePersistence {
  readonly records = new Map<string, ChatSdkStateRecord>();
  readonly writes: ChatSdkStateCompareAndSetInput[] = [];

  private id(scope: ChatSdkStateScope, key: string): string {
    return `${scope.companyId}\0${scope.endpointId}\0${key}`;
  }

  async read(
    scope: ChatSdkStateScope,
    key: string,
  ): Promise<ChatSdkStateRecord | null> {
    return this.records.get(this.id(scope, key)) ?? null;
  }

  async compareAndSet(input: ChatSdkStateCompareAndSetInput): Promise<boolean> {
    const id = this.id(input, input.key);
    const current = this.records.get(id);
    if (
      input.expectedVersion === null
        ? current !== undefined
        : current?.version !== input.expectedVersion
    ) {
      return false;
    }
    this.writes.push(input);
    this.records.set(id, {
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      value: JSON.parse(JSON.stringify(input.value)) as unknown,
      version: (current?.version ?? 0) + 1,
    });
    return true;
  }

  async deleteIfVersion(input: ChatSdkStateDeleteInput): Promise<boolean> {
    const id = this.id(input, input.key);
    const current = this.records.get(id);
    if (current?.version !== input.expectedVersion) return false;
    this.records.delete(id);
    return true;
  }
}

function fixture(now: Date = new Date("2026-09-04T12:00:00.000Z")) {
  const persistence = new MemoryCasPersistence();
  let currentTime = now;
  const state = createPaperclipChatSdkState({
    companyId: "company-1",
    endpointId: "endpoint-1",
    persistence,
    now: () => currentTime,
  });
  return {
    persistence,
    state,
    advance(ms: number) {
      currentTime = new Date(currentTime.getTime() + ms);
    },
  };
}

describe("PaperclipChatSdkStateAdapter", () => {
  it("requires Chat SDK lifecycle connection before state operations", async () => {
    const { state } = fixture();
    await expect(state.get("key")).rejects.toThrow("is not connected");
    await state.connect();
    await state.set("key", "value");
    expect(await state.get("key")).toBe("value");
    await state.disconnect();
    await expect(state.get("key")).rejects.toThrow("is not connected");
  });

  it("scopes and hashes persistent keys and wraps values in a versioned envelope", async () => {
    const { persistence, state } = fixture();
    await state.connect();
    await state.set("provider-token:do-not-put-this-in-a-key", { ok: true });

    expect(persistence.writes).toHaveLength(1);
    const [write] = persistence.writes;
    expect(write).toMatchObject({
      companyId: "company-1",
      endpointId: "endpoint-1",
    });
    expect(write?.key).toMatch(/^cache:[a-f0-9]{64}$/);
    expect(write?.key).not.toContain("provider-token");
    expect(write?.value).toEqual({
      kind: "cache",
      schemaVersion: 1,
      value: { ok: true },
    });
  });

  it("applies TTL and supports atomic set-if-absent after expiry", async () => {
    const { advance, state } = fixture();
    await state.connect();
    expect(await state.setIfNotExists("dedupe", "first", 100)).toBe(true);
    expect(await state.setIfNotExists("dedupe", "second", 100)).toBe(false);
    expect(await state.get("dedupe")).toBe("first");
    advance(101);
    expect(await state.setIfNotExists("dedupe", "second", 100)).toBe(true);
    expect(await state.get("dedupe")).toBe("second");
  });

  it("enforces token ownership while extending and releasing locks", async () => {
    const { advance, state } = fixture();
    await state.connect();
    const first = await state.acquireLock("thread-1", 100);
    expect(first).not.toBeNull();
    expect(await state.acquireLock("thread-1", 100)).toBeNull();
    expect(
      await state.extendLock({ ...first!, token: "not-the-owner" }, 100),
    ).toBe(false);
    await state.releaseLock({ ...first!, token: "not-the-owner" });
    expect(await state.acquireLock("thread-1", 100)).toBeNull();
    expect(await state.extendLock(first!, 200)).toBe(true);
    advance(150);
    expect(await state.acquireLock("thread-1", 100)).toBeNull();
    advance(51);
    const replacement = await state.acquireLock("thread-1", 100);
    expect(replacement?.token).not.toBe(first?.token);
    await state.releaseLock(first!);
    expect(await state.acquireLock("thread-1", 100)).toBeNull();
    await state.releaseLock(replacement!);
    expect(await state.acquireLock("thread-1", 100)).not.toBeNull();
  });

  it("atomically appends and trims lists under concurrent writers", async () => {
    const { state } = fixture();
    await state.connect();
    await Promise.all([
      state.appendToList("history", 1),
      state.appendToList("history", 2),
      state.appendToList("history", 3),
    ]);
    expect(await state.getList<number>("history")).toHaveLength(3);
    await state.appendToList("history", 4, { maxLength: 2 });
    const values = await state.getList<number>("history");
    expect(values).toHaveLength(2);
    expect(values.at(-1)).toBe(4);
  });

  it("keeps only the newest queued messages and discards expired entries", async () => {
    const { advance, state } = fixture();
    await state.connect();
    const base = Date.parse("2026-09-04T12:00:00.000Z");
    const entry = (id: string, expiresAt: number): QueueEntry =>
      ({
        enqueuedAt: base,
        expiresAt,
        message: { id, threadId: "thread-1" },
      }) as QueueEntry;

    await state.enqueue("thread-1", entry("one", base + 100), 2);
    await state.enqueue("thread-1", entry("two", base + 200), 2);
    expect(await state.enqueue("thread-1", entry("three", base + 300), 2)).toBe(
      2,
    );
    expect((await state.dequeue("thread-1"))?.message.id).toBe("two");
    advance(301);
    expect(await state.queueDepth("thread-1")).toBe(0);
    expect(await state.dequeue("thread-1")).toBeNull();
  });

  it("rejects unversioned state and oversized values", async () => {
    const persistence = new MemoryCasPersistence();
    const state = createPaperclipChatSdkState({
      companyId: "company-1",
      endpointId: "endpoint-1",
      persistence,
      maxValueBytes: 64,
    });
    await state.connect();
    await expect(state.set("large", "x".repeat(100))).rejects.toThrow(
      "byte limit",
    );

    const valid = createPaperclipChatSdkState({
      companyId: "company-1",
      endpointId: "endpoint-1",
      persistence,
    });
    await valid.connect();
    await valid.set("corrupt", "before");
    const key = persistence.writes.at(-1)!.key;
    const record = persistence.records.get(`company-1\0endpoint-1\0${key}`)!;
    record.value = { value: "missing schema" };
    await expect(valid.get("corrupt")).rejects.toThrow(
      "Invalid Chat SDK state envelope",
    );
  });
});
