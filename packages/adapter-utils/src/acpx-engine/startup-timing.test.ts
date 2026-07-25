import { describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "../types.js";
import { measureStartupStep } from "./startup-timing.js";

describe("measureStartupStep", () => {
  it("emits one run.startup.step event with the step name and measured durationMs", async () => {
    let t = 0;
    const now = () => t;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    const result = await measureStartupStep({ onEvent }, now, "stage.sync", async () => {
      t = 150; // clock advances while the wrapped step runs
      return "ok";
    });

    expect(result).toBe("ok");
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "run.startup.step",
      stream: "system",
      level: "info",
      payload: { step: "stage.sync", durationMs: 150 },
    });
    expect(events[0]!.message).toBe("startup step: stage.sync (150ms)");
  });

  it("returns the wrapped fn result unchanged", async () => {
    const now = () => 0;
    const onEvent = vi.fn(async () => {});
    const value = { nested: [1, 2, 3] };

    const result = await measureStartupStep({ onEvent }, now, "workspace.resolve", async () => value);

    expect(result).toBe(value);
  });

  it("still emits the timing event and re-throws when fn rejects", async () => {
    let t = 0;
    const now = () => t;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });
    const boom = new Error("step failed");

    await expect(
      measureStartupStep({ onEvent }, now, "acp.handshake", async () => {
        t = 42;
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      eventType: "run.startup.step",
      payload: { step: "acp.handshake", durationMs: 42 },
    });
  });

  it("swallows onEvent errors without changing the wrapped fn result", async () => {
    let t = 0;
    const now = () => t;
    const onEvent = vi.fn(async () => {
      throw new Error("sink failed");
    });

    const result = await measureStartupStep({ onEvent }, now, "bridge.paperclip", async () => {
      t = 17;
      return "value";
    });

    expect(result).toBe("value");
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("swallows onEvent errors without replacing a wrapped fn error", async () => {
    let t = 0;
    const now = () => t;
    const onEvent = vi.fn(async () => {
      throw new Error("sink failed");
    });
    const boom = new Error("step failed");

    await expect(
      measureStartupStep({ onEvent }, now, "bridge.process-session", async () => {
        t = 17;
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("does not throw when ctx.onEvent is undefined", async () => {
    const now = () => 0;

    await expect(
      measureStartupStep({}, now, "bridge.paperclip", async () => "value"),
    ).resolves.toBe("value");
  });

  it("still surfaces the fn error when ctx.onEvent is undefined", async () => {
    const now = () => 0;
    const boom = new Error("undefined-sink failure");

    await expect(
      measureStartupStep({}, now, "bridge.process-session", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
