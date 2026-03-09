import { describe, expect, it, vi } from "vitest";
import worker from "../../../packages/plugins/examples/plugin-hello-world-example/src/worker.js";

describe("hello world example worker", () => {
  it("logs setup completion", async () => {
    const info = vi.fn();
    const ctx = {
      logger: {
        info,
      },
    };

    await worker.definition.setup?.(ctx as Parameters<NonNullable<typeof worker.definition.setup>>[0]);

    expect(info).toHaveBeenCalledWith("hello-world-example plugin setup complete");
  });

  it("returns an ok health payload", async () => {
    const result = await worker.definition.onHealth?.();

    expect(result).toEqual({
      status: "ok",
      message: "Hello World example plugin ready",
    });
  });
});
