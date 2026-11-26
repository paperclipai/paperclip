import { describe, expect, it } from "vitest";
import { KvStore } from "./store.js";

describe("KvStore", () => {
  it("sets, gets, and overwrites values", () => {
    const store = new KvStore();
    expect(store.get("a")).toBeUndefined();

    const first = store.set("a", "1");
    expect(first.key).toBe("a");
    expect(first.value).toBe("1");
    expect(store.get("a")?.value).toBe("1");

    store.set("a", "2");
    expect(store.get("a")?.value).toBe("2");
  });

  it("deletes keys and reports whether they existed", () => {
    const store = new KvStore();
    store.set("a", "1");
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.has("a")).toBe(false);
  });

  it("lists keys sorted and filtered by prefix", () => {
    const store = new KvStore();
    store.set("user:2", "b");
    store.set("user:1", "a");
    store.set("config:x", "c");

    expect(store.list().map((e) => e.key)).toEqual(["config:x", "user:1", "user:2"]);
    expect(store.list("user:").map((e) => e.key)).toEqual(["user:1", "user:2"]);
  });

  it("advances the revision on writes and deletes but not on no-op deletes", () => {
    const store = new KvStore();
    expect(store.revision).toBe(0);
    store.set("a", "1");
    expect(store.revision).toBe(1);
    store.delete("a");
    expect(store.revision).toBe(2);
    store.delete("missing");
    expect(store.revision).toBe(2);
  });

  it("produces a snapshot with count and revision", () => {
    const store = new KvStore();
    store.set("a", "1");
    store.set("b", "2");
    const snapshot = store.snapshot();
    expect(snapshot.count).toBe(2);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.entries.map((e) => e.key)).toEqual(["a", "b"]);
  });
});
