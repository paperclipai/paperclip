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

  it("includes the roundTrips delta in the payload when a round-trip reader is supplied", async () => {
    let t = 0;
    const now = () => t;
    // Cumulative host→sandbox exec counter; the step performs 3 execs.
    let execCount = 5;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    await measureStartupStep({ onEvent }, now, "stage.sync", async () => {
      t = 90;
      execCount += 3;
      return "ok";
    }, { roundTrips: () => execCount });

    expect(events[0]!.payload).toMatchObject({
      step: "stage.sync",
      durationMs: 90,
      roundTrips: 3,
    });
  });

  it("reports roundTrips: 0 for a step that performs no execs (reader supplied)", async () => {
    const now = () => 0;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    await measureStartupStep({ onEvent }, now, "workspace.resolve", async () => "ok", {
      roundTrips: () => 7,
    });

    expect(events[0]!.payload).toMatchObject({ step: "workspace.resolve", roundTrips: 0 });
  });

  it("omits roundTrips from the payload when no reader is supplied", async () => {
    const now = () => 0;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    await measureStartupStep({ onEvent }, now, "workspace.resolve", async () => "ok");

    expect(events[0]!.payload).not.toHaveProperty("roundTrips");
  });

  it("accumulates provider exec/get durations and merges extra fields into the payload", async () => {
    let t = 0;
    const now = () => t;
    let execMs = 100;
    let getMs = 40;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    await measureStartupStep({ onEvent }, now, "acp.handshake", async () => {
      t = 7000;
      execMs += 600; // one provider executeCommand round-trip
      getMs += 15; // one client.get re-fetch
      return "handle";
    }, {
      providerExecMs: () => execMs,
      providerGetMs: () => getMs,
      extra: () => ({ createRuntimeMs: 12, ensureSessionMs: 6988 }),
    });

    expect(events[0]!.payload).toMatchObject({
      step: "acp.handshake",
      durationMs: 7000,
      providerExecMs: 600,
      providerGetMs: 15,
      createRuntimeMs: 12,
      ensureSessionMs: 6988,
    });
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
