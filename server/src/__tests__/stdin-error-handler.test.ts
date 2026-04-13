import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installStdinErrorHandler } from "../stdin-error-handler.js";

class FakeReadStream extends EventEmitter {
  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}

describe("installStdinErrorHandler", () => {
  it("swallows terminal teardown EIO read errors", () => {
    const stream = new FakeReadStream();
    installStdinErrorHandler(stream, { label: "dev-runner" });

    expect(() => {
      stream.emit("error", Object.assign(new Error("read EIO"), {
        code: "EIO",
        syscall: "read",
      }));
    }).not.toThrow();
  });

  it("logs unexpected stdin errors instead of crashing", () => {
    const stream = new FakeReadStream();
    const logger = vi.fn();
    installStdinErrorHandler(stream, { label: "server", log: logger });

    expect(() => {
      stream.emit("error", Object.assign(new Error("boom"), {
        code: "EPERM",
        syscall: "read",
      }));
    }).not.toThrow();

    expect(logger).toHaveBeenCalledWith("[paperclip] server stdin error ignored: boom");
  });
});
