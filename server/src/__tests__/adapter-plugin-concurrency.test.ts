import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: vi.fn(),
  testEnvironment: vi.fn(),
  sessionCodec: vi.fn(),
  listSkills: vi.fn(async () => []),
  syncSkills: vi.fn(async () => []),
  detectModel: vi.fn(),
}));

vi.mock("hermes-paperclip-adapter", () => ({
  agentConfigurationDoc: vi.fn(),
  models: [],
}));

import { withAdapterMutex } from "../routes/adapters.js";

// ---------------------------------------------------------------------------
// withAdapterMutex — serialisation tests
// ---------------------------------------------------------------------------

describe("withAdapterMutex", () => {
  it("serialises concurrent calls so they do not overlap", async () => {
    const log: string[] = [];

    const taskA = withAdapterMutex(async () => {
      log.push("A-start");
      await new Promise((r) => setTimeout(r, 50));
      log.push("A-end");
      return "a";
    });

    const taskB = withAdapterMutex(async () => {
      log.push("B-start");
      await new Promise((r) => setTimeout(r, 10));
      log.push("B-end");
      return "b";
    });

    const [resultA, resultB] = await Promise.all([taskA, taskB]);

    expect(resultA).toBe("a");
    expect(resultB).toBe("b");

    // A must fully complete before B starts (FIFO serialisation)
    expect(log).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("a failed task does not block subsequent tasks", async () => {
    const failing = withAdapterMutex(async () => {
      throw new Error("boom");
    });

    await expect(failing).rejects.toThrow("boom");

    const ok = await withAdapterMutex(async () => "ok");
    expect(ok).toBe("ok");
  });

  it("preserves FIFO order for many concurrent callers", async () => {
    const order: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      withAdapterMutex(async () => {
        order.push(i);
      }),
    );

    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns the value from the inner function", async () => {
    const result = await withAdapterMutex(async () => ({ answer: 42 }));
    expect(result).toEqual({ answer: 42 });
  });

  it("propagates errors from the inner function", async () => {
    await expect(
      withAdapterMutex(async () => {
        throw new TypeError("bad input");
      }),
    ).rejects.toThrow("bad input");
  });
});

// ---------------------------------------------------------------------------
// adapter-plugin-store — atomic write tests
// ---------------------------------------------------------------------------

describe("adapter-plugin-store atomic writes", () => {
  // We test the store in an isolated temp directory by stubbing HOME
  const originalHome = process.env.HOME;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-store-test-"));
    process.env.HOME = tmpDir;
    // Force the store module to pick up the new HOME by resetting its cache.
    // We re-import it fresh for each test.
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writeStore creates the file atomically via rename", async () => {
    // Dynamically import the store so it uses the stubbed HOME
    vi.resetModules();
    const store = await import("../services/adapter-plugin-store.js");

    const record = {
      packageName: "test-adapter",
      type: "test_type",
      installedAt: new Date().toISOString(),
    };

    store.addAdapterPlugin(record);

    // The store file should exist and contain the record
    const storePath = path.join(tmpDir, ".paperclip", "adapter-plugins.json");
    expect(fs.existsSync(storePath)).toBe(true);

    const contents = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(contents).toHaveLength(1);
    expect(contents[0].packageName).toBe("test-adapter");

    // No lingering temp files
    const dir = path.dirname(storePath);
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("addAdapterPlugin is idempotent for the same type", async () => {
    vi.resetModules();
    const store = await import("../services/adapter-plugin-store.js");

    const record1 = {
      packageName: "pkg-a",
      type: "my_adapter",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
    };
    const record2 = {
      packageName: "pkg-a",
      type: "my_adapter",
      version: "2.0.0",
      installedAt: new Date().toISOString(),
    };

    store.addAdapterPlugin(record1);
    store.addAdapterPlugin(record2);

    const plugins = store.listAdapterPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].version).toBe("2.0.0");
  });

  it("removeAdapterPlugin removes the correct record", async () => {
    vi.resetModules();
    const store = await import("../services/adapter-plugin-store.js");

    store.addAdapterPlugin({
      packageName: "a",
      type: "type_a",
      installedAt: new Date().toISOString(),
    });
    store.addAdapterPlugin({
      packageName: "b",
      type: "type_b",
      installedAt: new Date().toISOString(),
    });

    expect(store.listAdapterPlugins()).toHaveLength(2);

    const removed = store.removeAdapterPlugin("type_a");
    expect(removed).toBe(true);
    expect(store.listAdapterPlugins()).toHaveLength(1);
    expect(store.listAdapterPlugins()[0].type).toBe("type_b");
  });

  it("removeAdapterPlugin returns false for unknown type", async () => {
    vi.resetModules();
    const store = await import("../services/adapter-plugin-store.js");
    expect(store.removeAdapterPlugin("nonexistent")).toBe(false);
  });
});
