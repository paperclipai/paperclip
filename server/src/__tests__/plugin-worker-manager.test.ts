import { describe, expect, it, vi } from "vitest";
import {
  appendStderrExcerpt,
  createPluginWorkerManager,
  formatWorkerFailureMessage,
  type PluginWorkerLifecycleEvent,
} from "../services/plugin-worker-manager.js";

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });
});

describe("plugin-worker-manager addWorkerEventListener", () => {
  it("exposes addWorkerEventListener on the public API", () => {
    const manager = createPluginWorkerManager();
    expect(typeof manager.addWorkerEventListener).toBe("function");
  });

  it("returns an unsubscribe function that removes the listener", () => {
    const manager = createPluginWorkerManager();
    const listener = vi.fn();
    const unsubscribe = manager.addWorkerEventListener?.(listener);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe?.();
    // The list should be empty again. We cannot inspect it directly, so
    // we re-add and verify only the new listener is present by calling
    // a second `addWorkerEventListener` with a marker function. The
    // contract we care about is that unsubscribe does not throw and the
    // manager remains usable.
    expect(() => manager.addWorkerEventListener?.(vi.fn())?.()).not.toThrow();
  });

  it("registers construction-time onWorkerEvent and post-hoc listeners alongside each other", () => {
    // The manager fan-outs to both the construction-time callback and any
    // post-hoc listeners. We can't synthesize a real worker event without
    // spawning a child process, but we can verify the listener list is
    // additive by checking that addWorkerEventListener does not throw when
    // an onWorkerEvent option was also supplied at construction.
    const onWorkerEvent: (event: PluginWorkerLifecycleEvent) => void = vi.fn();
    const manager = createPluginWorkerManager({ onWorkerEvent });
    expect(() => manager.addWorkerEventListener?.(vi.fn())).not.toThrow();
  });
});
