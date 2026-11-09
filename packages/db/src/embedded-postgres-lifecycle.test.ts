import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";

describe("loadWithoutEmbeddedPostgresExitHooks", () => {
  it("removes every eager exit hook from the real embedded-postgres import", async () => {
    const eventNames = [
      "exit",
      "beforeExit",
      "SIGHUP",
      "SIGINT",
      "SIGTERM",
      "SIGBREAK",
      "message",
    ];
    const before = new Map(eventNames.map((eventName) => [
      eventName,
      process.rawListeners(eventName),
    ]));
    const moduleName = "embedded-postgres";

    await loadWithoutEmbeddedPostgresExitHooks(() => import(moduleName));

    for (const eventName of eventNames) {
      expect(process.rawListeners(eventName)).toEqual(before.get(eventName));
    }
  });

  it("removes dependency exit hooks while preserving existing listeners", async () => {
    const target = new EventEmitter();
    const existingSignalListener = vi.fn();
    const existingExitListener = vi.fn();
    target.on("SIGTERM", existingSignalListener);
    target.on("exit", existingExitListener);

    const dependencyListener = vi.fn();
    const loaded = await loadWithoutEmbeddedPostgresExitHooks(
      async () => {
        for (const eventName of [
          "exit",
          "beforeExit",
          "SIGHUP",
          "SIGINT",
          "SIGTERM",
          "SIGBREAK",
          "message",
        ]) {
          target.on(eventName, dependencyListener);
        }
        return { default: class EmbeddedPostgres {} };
      },
      target,
    );

    expect(loaded.default.name).toBe("EmbeddedPostgres");
    expect(target.rawListeners("SIGTERM")).toEqual([existingSignalListener]);
    expect(target.rawListeners("exit")).toEqual([existingExitListener]);
    for (const eventName of ["beforeExit", "SIGHUP", "SIGINT", "SIGBREAK", "message"]) {
      expect(target.rawListeners(eventName)).toEqual([]);
    }
  });

  it("cleans up listeners even when the import fails", async () => {
    const target = new EventEmitter();
    const dependencyListener = vi.fn();

    await expect(loadWithoutEmbeddedPostgresExitHooks(
      async () => {
        target.on("SIGTERM", dependencyListener);
        throw new Error("import failed");
      },
      target,
    )).rejects.toThrow("import failed");

    expect(target.rawListeners("SIGTERM")).toEqual([]);
  });
});
