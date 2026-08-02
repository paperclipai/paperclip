import { describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "../types.js";
import type { StartupSpan, StartupTracer } from "./startup-timing.js";
import { measureStartupStep, normalizeProviderFamily } from "./startup-timing.js";

/**
 * A recording span for the mock tracer. It captures the attribute set, the
 * status, and the end count so a test can assert the emitted span shape.
 */
class MockSpan implements StartupSpan {
  readonly attributes: Record<string, string | number | boolean> = {};
  status: { code: number; message?: string } | undefined;
  endCount = 0;

  constructor(
    readonly name: string,
    initial: Record<string, string | number | boolean> | undefined,
  ) {
    if (initial) Object.assign(this.attributes, initial);
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  setStatus(status: { code: number; message?: string }): void {
    this.status = status;
  }

  end(): void {
    this.endCount += 1;
  }
}

/** A recording tracer that keeps every span it opens for assertions. */
function makeMockTracer(): { tracer: StartupTracer; spans: MockSpan[] } {
  const spans: MockSpan[] = [];
  const tracer: StartupTracer = {
    startSpan(name, options) {
      const span = new MockSpan(name, options?.attributes);
      spans.push(span);
      return span;
    },
  };
  return { tracer, spans };
}

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

  it("opens one span and ends it once for a normal step", async () => {
    const { tracer, spans } = makeMockTracer();
    const onEvent = vi.fn(async () => {});

    await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok", {
      tracer,
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("stage.sync");
    expect(spans[0]!.attributes.step).toBe("stage.sync");
    expect(spans[0]!.endCount).toBe(1);
  });

  it("ends the span and sets an error status when fn throws, then re-throws", async () => {
    const { tracer, spans } = makeMockTracer();
    const onEvent = vi.fn(async () => {});
    const boom = new Error("step failed");

    await expect(
      measureStartupStep({ onEvent }, () => 0, "acp.handshake", async () => {
        throw boom;
      }, { tracer }),
    ).rejects.toBe(boom);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.endCount).toBe(1);
    // SpanStatusCode.ERROR === 2 in @opentelemetry/api.
    expect(spans[0]!.status?.code).toBe(2);
  });

  it("sets the same roundTrips / providerExecMs / providerGetMs deltas on the payload and the span", async () => {
    let t = 0;
    const now = () => t;
    let execCount = 5;
    let execMs = 100;
    let getMs = 40;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });
    const { tracer, spans } = makeMockTracer();

    await measureStartupStep({ onEvent }, now, "stage.sync", async () => {
      t = 90;
      execCount += 3;
      execMs += 600;
      getMs += 15;
      return "ok";
    }, {
      tracer,
      roundTrips: () => execCount,
      providerExecMs: () => execMs,
      providerGetMs: () => getMs,
    });

    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.roundTrips).toBe(3);
    expect(payload.providerExecMs).toBe(600);
    expect(payload.providerGetMs).toBe(15);
    // The span carries the identical deltas — one build block feeds both.
    expect(spans[0]!.attributes.roundTrips).toBe(3);
    expect(spans[0]!.attributes.providerExecMs).toBe(600);
    expect(spans[0]!.attributes.providerGetMs).toBe(15);
  });

  it("sets no span attribute (and no payload field) when a reader returns undefined", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });
    const { tracer, spans } = makeMockTracer();

    await measureStartupStep({ onEvent }, () => 0, "workspace.resolve", async () => "ok", {
      tracer,
      // A reader may return undefined when the counter is unavailable. The guard
      // must omit the attribute rather than emit NaN or 0.
      roundTrips: () => undefined as unknown as number,
      providerExecMs: () => undefined as unknown as number,
    });

    expect(spans[0]!.attributes).not.toHaveProperty("roundTrips");
    expect(spans[0]!.attributes).not.toHaveProperty("providerExecMs");
    expect(Object.values(spans[0]!.attributes).some((v) => Number.isNaN(v))).toBe(false);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("roundTrips");
    expect(payload).not.toHaveProperty("providerExecMs");
  });

  it("normalizes a plugin-backed provider key to plugin and keeps a built-in family as-is", async () => {
    const onEvent = vi.fn(async () => {});

    const custom = makeMockTracer();
    await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok", {
      tracer: custom.tracer,
      provider: "acme-cloud-runner",
    });
    expect(custom.spans[0]!.attributes.provider).toBe("plugin");

    const builtIn = makeMockTracer();
    await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok", {
      tracer: builtIn.tracer,
      provider: "daytona",
    });
    expect(builtIn.spans[0]!.attributes.provider).toBe("daytona");
  });

  it("normalizeProviderFamily maps every non-built-in key to plugin", () => {
    for (const key of ["daytona", "kubernetes", "e2b", "cloudflare", "exe-dev", "modal", "novita"]) {
      expect(normalizeProviderFamily(key)).toBe(key);
    }
    for (const key of ["acme", "my-plugin", "", "DAYTONA", undefined]) {
      expect(normalizeProviderFamily(key)).toBe("plugin");
    }
  });

  it("emits exactly the allowlisted span-attribute key set and no command / path / ID / error-text key", async () => {
    const onEvent = vi.fn(async () => {});
    const { tracer, spans } = makeMockTracer();

    await measureStartupStep({ onEvent }, () => 0, "acp.handshake", async () => "ok", {
      tracer,
      provider: "daytona",
      roundTrips: () => 3,
      providerExecMs: () => 600,
      providerGetMs: () => 15,
      // extra() carries caller-measured numbers into the EVENT payload only.
      // It must never widen the span-attribute set.
      extra: () => ({ createRuntimeMs: 12, ensureSessionMs: 6988 }),
    });

    expect(Object.keys(spans[0]!.attributes).sort()).toEqual(
      ["provider", "providerExecMs", "providerGetMs", "roundTrips", "step"],
    );
    // extra() keys stay off the span.
    expect(spans[0]!.attributes).not.toHaveProperty("createRuntimeMs");
    expect(spans[0]!.attributes).not.toHaveProperty("ensureSessionMs");
    // No free-form identifier / command / path key leaks in. The pattern uses
    // no `i` flag, so the camelCase `Id` matches `runId` / `userId` but not the
    // "id" inside the allowlisted `provider`.
    for (const key of Object.keys(spans[0]!.attributes)) {
      expect(key).not.toMatch(/command|args|env|stdout|stderr|path|url|repo|ref|branch|Id|_id|error|message/);
    }
  });

  it("uses a no-op tracer by default so a call without a tracer changes nothing", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    // No tracer supplied. The helper must still emit the event and return the
    // value without throwing.
    const result = await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok", {
      roundTrips: () => 3,
    });

    expect(result).toBe("ok");
    expect(events[0]!.payload).toMatchObject({ step: "stage.sync" });
  });
});
