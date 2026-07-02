import { describe, it, expect, vi } from "vitest";

// Mock @kubernetes/client-node's Exec so execInPod runs against a fake exec
// that we drive frame-by-frame. h.execImpl is swapped per test.
const h = vi.hoisted(() => ({
  execImpl: null as unknown as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock("@kubernetes/client-node", () => ({
  Exec: class {
    constructor(_kc: unknown) {}
    exec(...args: unknown[]) {
      return h.execImpl(...args);
    }
  },
}));

import { execInPod } from "../../src/pod-exec.js";

describe("execInPod streaming (onChunk)", () => {
  it("forwards each stdout/stderr data frame to onChunk while still buffering the full output", async () => {
    h.execImpl = async (...args: unknown[]) => {
      const stdout = args[4] as NodeJS.WritableStream;
      const stderr = args[5] as NodeJS.WritableStream;
      const statusCb = args[8] as (status: { status: string }) => void;
      // Emit two stdout frames + one stderr frame, then a Success status, on a
      // later tick (mirrors the real client's async data delivery).
      queueMicrotask(() => {
        stdout.write(Buffer.from("hello ", "utf-8"));
        stdout.write(Buffer.from("world", "utf-8"));
        stderr.write(Buffer.from("warn", "utf-8"));
        statusCb({ status: "Success" });
        stdout.end();
        stderr.end();
      });
      return { close: () => {} };
    };

    const chunks: Array<[string, string]> = [];
    const result = await execInPod(
      {} as never,
      "ns",
      "pod",
      "agent",
      ["echo", "hi"],
      undefined,
      5_000,
      (stream, text) => chunks.push([stream, text]),
    );

    expect(chunks).toEqual([
      ["stdout", "hello "],
      ["stdout", "world"],
      ["stderr", "warn"],
    ]);
    // Buffered result is preserved (concatenation of frames).
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn");
    expect(result.exitCode).toBe(0);
  });

  it("still resolves the buffered result when no onChunk is provided (backward-compatible)", async () => {
    h.execImpl = async (...args: unknown[]) => {
      const stdout = args[4] as NodeJS.WritableStream;
      const stderr = args[5] as NodeJS.WritableStream;
      const statusCb = args[8] as (status: { status: string }) => void;
      queueMicrotask(() => {
        stdout.write(Buffer.from("abc", "utf-8"));
        statusCb({ status: "Success" });
        stdout.end();
        stderr.end();
      });
      return { close: () => {} };
    };

    const result = await execInPod({} as never, "ns", "pod", "agent", ["echo"], undefined, 5_000);
    expect(result.stdout).toBe("abc");
    expect(result.exitCode).toBe(0);
  });

  it("does not let a throwing onChunk consumer break output capture", async () => {
    h.execImpl = async (...args: unknown[]) => {
      const stdout = args[4] as NodeJS.WritableStream;
      const stderr = args[5] as NodeJS.WritableStream;
      const statusCb = args[8] as (status: { status: string }) => void;
      queueMicrotask(() => {
        stdout.write(Buffer.from("keep", "utf-8"));
        statusCb({ status: "Success" });
        stdout.end();
        stderr.end();
      });
      return { close: () => {} };
    };

    const result = await execInPod(
      {} as never,
      "ns",
      "pod",
      "agent",
      ["echo"],
      undefined,
      5_000,
      () => {
        throw new Error("consumer blew up");
      },
    );
    expect(result.stdout).toBe("keep");
    expect(result.exitCode).toBe(0);
  });
});
