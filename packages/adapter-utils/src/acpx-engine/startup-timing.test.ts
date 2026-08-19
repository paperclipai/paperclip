import { describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "../types.js";
import type { StartupSpan, StartupTraceContext, StartupTracer } from "./startup-timing.js";
import {
  clampSpanLabel,
  createRuntimeSpanRunner,
  emitRunPhaseTiming,
  emitSkippedStartupStep,
  getActiveStepContext,
  measureStartupStep,
  NOOP_STARTUP_SPAN,
  NOOP_STARTUP_TRACE_CONTEXT,
  normalizeProviderFamily,
  RUN_PHASE_NAMES,
  RUN_PHASE_TIMING_EVENT_TYPE,
  runWithoutActiveStep,
  runWithRuntimeParent,
  SANDBOX_STARTUP_SPAN_ATTR_PREFIX,
  SANDBOX_STARTUP_SPAN_ATTRS,
  setSandboxRootSpanAttributes,
} from "./startup-timing.js";

const A = SANDBOX_STARTUP_SPAN_ATTRS;

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

  it("emits only the high-level fields (step, durationMs, outcome) on the payload", async () => {
    let t = 0;
    const now = () => t;
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    await measureStartupStep({ onEvent }, now, "acp.handshake", async () => {
      t = 7000;
      return "handle";
    });

    // The detailed per-step round-trip and provider-duration numbers ride the
    // OTel spans now, so the run-log payload keeps only the high-level fields.
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["durationMs", "outcome", "step"]);
    expect(payload).not.toHaveProperty("roundTrips");
    expect(payload).not.toHaveProperty("providerExecMs");
    expect(payload).not.toHaveProperty("providerGetMs");
    expect(payload).not.toHaveProperty("createRuntimeMs");
    expect(payload).not.toHaveProperty("ensureSessionMs");
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
    // The span name carries the step; no redundant `step` attribute rides it.
    expect(spans[0]!.attributes).not.toHaveProperty("step");
    // The step wall time rides the closed, type-suffixed attribute key.
    expect(spans[0]!.attributes[A.stepWallMs]).toBe(0);
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

  it("carries only the allowlisted attributes on the step span, never the removed round-trip detail", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });
    const { tracer, spans } = makeMockTracer();

    await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok", {
      tracer,
      provider: "daytona",
    });

    // The step span carries only the closed allowlist. The per-execution
    // `sandbox.exec` spans carry the round-trip and provider-duration detail.
    expect(Object.keys(spans[0]!.attributes).sort()).toEqual(
      [A.provider, A.stepWallMs, A.outcome].sort(),
    );
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("roundTrips");
    expect(payload).not.toHaveProperty("providerExecMs");
    expect(payload).not.toHaveProperty("providerGetMs");
  });

  it("normalizes a plugin-backed provider key to plugin and keeps a built-in family as-is", async () => {
    const onEvent = vi.fn(async () => {});

    const custom = makeMockTracer();
    await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok", {
      tracer: custom.tracer,
      provider: "acme-cloud-runner",
    });
    expect(custom.spans[0]!.attributes[A.provider]).toBe("plugin");

    const builtIn = makeMockTracer();
    await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok", {
      tracer: builtIn.tracer,
      provider: "daytona",
    });
    expect(builtIn.spans[0]!.attributes[A.provider]).toBe("daytona");
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
    });

    expect(Object.keys(spans[0]!.attributes).sort()).toEqual(
      [A.provider, A.stepWallMs, A.outcome].sort(),
    );
    // Every key uses the closed prefix, so no free-form command / path / id key
    // can ride the span.
    for (const key of Object.keys(spans[0]!.attributes)) {
      expect(key.startsWith(SANDBOX_STARTUP_SPAN_ATTR_PREFIX)).toBe(true);
    }
    // No forbidden segment (command / arg / env / output / path / raw id) rides
    // the span key set, even after the prefix.
    for (const key of Object.keys(spans[0]!.attributes)) {
      const suffix = key.slice(SANDBOX_STARTUP_SPAN_ATTR_PREFIX.length);
      expect(suffix).not.toMatch(/command|args|env|stdout|stderr|path|url|repo|ref|branch|error|message/);
    }
  });

  it("uses a no-op tracer by default so a call without a tracer changes nothing", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    // No tracer supplied. The helper must still emit the event and return the
    // value without throwing.
    const result = await measureStartupStep({ onEvent }, () => 0, "stage.sync", async () => "ok");

    expect(result).toBe("ok");
    expect(events[0]!.payload).toMatchObject({ step: "stage.sync" });
  });

  it("sets a batch tag on the span from the batch option", async () => {
    const { tracer, spans } = makeMockTracer();
    await measureStartupStep({ onEvent: vi.fn(async () => {}) }, () => 0, "bridge.paperclip", async () => "ok", {
      tracer,
      batch: "bridge",
    });
    expect(spans[0]!.attributes[A.batch]).toBe("bridge");
  });

  it("maps handshake sub-times to fixed span keys and skips a non-finite one", async () => {
    const { tracer, spans } = makeMockTracer();
    await measureStartupStep({ onEvent: vi.fn(async () => {}) }, () => 0, "acp.handshake", async () => "ok", {
      tracer,
      spanWallTimes: () => ({ createRuntime: 12, ensureSession: 6988 }),
    });
    expect(spans[0]!.attributes[A.handshakeCreateRuntimeWallMs]).toBe(12);
    expect(spans[0]!.attributes[A.handshakeEnsureSessionWallMs]).toBe(6988);

    // A retry reports only its own ensure-session sub-time; the absent create-
    // runtime value sets no attribute.
    const retry = makeMockTracer();
    await measureStartupStep({ onEvent: vi.fn(async () => {}) }, () => 0, "acp.handshake", async () => "ok", {
      tracer: retry.tracer,
      spanWallTimes: () => ({ ensureSession: 40 }),
    });
    expect(retry.spans[0]!.attributes[A.handshakeEnsureSessionWallMs]).toBe(40);
    expect(retry.spans[0]!.attributes).not.toHaveProperty(A.handshakeCreateRuntimeWallMs);
  });

  it("sets outcome = ok on a settled step and outcome = failed on a throwing step", async () => {
    const okEvents: AdapterRuntimeEvent[] = [];
    const ok = makeMockTracer();
    await measureStartupStep({ onEvent: vi.fn(async (e: AdapterRuntimeEvent) => { okEvents.push(e); }) },
      () => 0, "stage.sync", async () => "ok", { tracer: ok.tracer });
    expect(ok.spans[0]!.attributes[A.outcome]).toBe("ok");
    expect((okEvents[0]!.payload as Record<string, unknown>).outcome).toBe("ok");

    const failEvents: AdapterRuntimeEvent[] = [];
    const fail = makeMockTracer();
    await expect(
      measureStartupStep({ onEvent: vi.fn(async (e: AdapterRuntimeEvent) => { failEvents.push(e); }) },
        () => 0, "acp.handshake", async () => { throw new Error("boom"); }, { tracer: fail.tracer }),
    ).rejects.toThrow("boom");
    expect(fail.spans[0]!.attributes[A.outcome]).toBe("failed");
    expect((failEvents[0]!.payload as Record<string, unknown>).outcome).toBe("failed");
  });

  it("sets each step-span attribute key with the closed prefix and a type suffix", async () => {
    const { tracer, spans } = makeMockTracer();
    await measureStartupStep({ onEvent: vi.fn(async () => {}) }, () => 0, "stage.sync", async () => "ok", {
      tracer,
      provider: "daytona",
    });

    const keys = Object.keys(spans[0]!.attributes);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith(SANDBOX_STARTUP_SPAN_ATTR_PREFIX)).toBe(true);
    }
    // The step wall time uses its type suffix.
    expect(keys).toContain(A.stepWallMs);
    expect(A.stepWallMs.endsWith(".wall_ms")).toBe(true);
  });
});

describe("setSandboxRootSpanAttributes", () => {
  it("records wall / work / diff and bounds the context, hashing ids and image", () => {
    const span = new MockSpan("sandbox.startup", undefined);
    setSandboxRootSpanAttributes(span, { wallMs: 800, workMs: 1000 }, {
      coldStart: true,
      provider: "acme-custom-runner",
      region: "us-east-1",
      imageId: "registry.internal/team/secret-codename:sha-1234",
      sandboxId: "sbx-secret-internal-id",
      leaseId: "lease-secret-internal-id",
    });

    expect(span.attributes[A.rootWallMs]).toBe(800);
    expect(span.attributes[A.rootWorkMs]).toBe(1000);
    expect(span.attributes[A.rootDiffMs]).toBe(200);
    expect(span.attributes[A.coldStart]).toBe(true);
    // Provider clamps to the bounded family; region stays a known value.
    expect(span.attributes[A.provider]).toBe("plugin");
    expect(span.attributes[A.region]).toBe("us-east-1");
    // The image id and both ids ride only as non-reversible hashes.
    for (const key of [A.imageId, A.sandboxId, A.leaseId]) {
      expect(String(span.attributes[key])).toMatch(/^[0-9a-f]{12}$/);
    }
    for (const value of Object.values(span.attributes).map(String)) {
      expect(value).not.toContain("secret");
      expect(value).not.toContain("codename");
      expect(value).not.toContain("registry.internal");
    }
  });

  it("maps an unknown region to `unknown` and omits every absent context value", () => {
    const span = new MockSpan("sandbox.startup", undefined);
    setSandboxRootSpanAttributes(span, { wallMs: 5, workMs: 5 }, { region: "moon-base-1" });
    expect(span.attributes[A.region]).toBe("unknown");
    expect(span.attributes).not.toHaveProperty(A.coldStart);
    expect(span.attributes).not.toHaveProperty(A.provider);
    expect(span.attributes).not.toHaveProperty(A.imageId);
    expect(span.attributes).not.toHaveProperty(A.sandboxId);
    expect(span.attributes).not.toHaveProperty(A.leaseId);
  });
});

describe("emitSkippedStartupStep", () => {
  it("emits a span and event with outcome = skipped and a zero wall time", async () => {
    const { tracer, spans } = makeMockTracer();
    const events: AdapterRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      events.push(event);
    });

    await emitSkippedStartupStep({ onEvent }, "acp.handshake", { tracer });

    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("acp.handshake");
    expect(spans[0]!.attributes[A.stepWallMs]).toBe(0);
    expect(spans[0]!.attributes[A.outcome]).toBe("skipped");
    expect(spans[0]!.endCount).toBe(1);

    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      step: "acp.handshake",
      durationMs: 0,
      outcome: "skipped",
    });
  });

  it("emits the event with no injected tracer and does not throw", async () => {
    const events: AdapterRuntimeEvent[] = [];
    await emitSkippedStartupStep(
      { onEvent: vi.fn(async (e: AdapterRuntimeEvent) => { events.push(e); }) },
      "acp.handshake",
    );
    expect(events[0]!.payload).toMatchObject({ step: "acp.handshake", outcome: "skipped" });
  });
});

describe("getActiveStepContext", () => {
  it("returns null when no measured step runs", () => {
    expect(getActiveStepContext()).toBeNull();
  });

  it("exposes the active step context to inner code while fn runs, then clears it", async () => {
    const { tracer, spans } = makeMockTracer();
    let seen: ReturnType<typeof getActiveStepContext> = null;

    await measureStartupStep({ onEvent: vi.fn(async () => {}) }, () => 0, "stage.sync", async () => {
      // Inner code reads the active step context through the getter.
      seen = getActiveStepContext();
      return "ok";
    }, {
      tracer,
      // The server builds a child-context token whose active span is the step
      // span. Model it as `{ span }`, the same shape the recording tracer reads.
      contextWithSpan: (span) => ({ span }),
    });

    expect(seen).not.toBeNull();
    // The published span is the one open step span.
    expect(seen!.span).toBe(spans[0]);
    // The parent token points at the step span, so an inner exec span parents
    // to it.
    expect(seen!.parentContext).toEqual({ span: spans[0] });
    // A regular step is on the critical path by default.
    expect(seen!.criticalPath).toBe(true);
    // The context clears once the step body settles.
    expect(getActiveStepContext()).toBeNull();
  });

  it("carries criticalPath = false when the step opts out (parallel steps)", async () => {
    let seen: ReturnType<typeof getActiveStepContext> = null;
    await measureStartupStep({ onEvent: vi.fn(async () => {}) }, () => 0, "bridge.paperclip", async () => {
      seen = getActiveStepContext();
    }, { criticalPath: false });
    expect(seen!.criticalPath).toBe(false);
  });

  it("keeps the ended step store in a timer scheduled inside the step body", async () => {
    // Node snapshots the active store on each async resource at creation time.
    // A timer scheduled inside a measured step body keeps that step store, even
    // after the step span ends. A later run-time exec then reads the ended step
    // and parents its `sandbox.exec` span to a dead startup step. This test locks
    // that leak, so the fix and its guard test stay honest.
    let storeInTimer: ReturnType<typeof getActiveStepContext> = null;
    let fireTimer!: () => void;
    const timerRan = new Promise<void>((resolve) => {
      fireTimer = resolve;
    });

    await measureStartupStep(
      { onEvent: vi.fn(async () => {}) },
      () => 0,
      "bridge.process-session",
      async () => {
        setTimeout(() => {
          storeInTimer = getActiveStepContext();
          fireTimer();
        }, 0);
        return "started";
      },
      { criticalPath: false },
    );

    // The step span already ended, so the main line reads no active step.
    expect(getActiveStepContext()).toBeNull();

    await timerRan;

    // Yet the timer callback still reads the ended step context. This is the
    // store leak the bridge boundary fix removes.
    expect(storeInTimer).not.toBeNull();
    expect(storeInTimer!.criticalPath).toBe(false);
  });

  it("clears the active step for a continuation wrapped in runWithoutActiveStep", async () => {
    // The bridge boundary wraps its long-lived poll timer in `runWithoutActiveStep`.
    // A timer scheduled inside that empty store scope reads no active step, so a
    // later run-time exec opens an unparented span instead of one under the ended
    // startup step.
    let storeInTimer: ReturnType<typeof getActiveStepContext> = null;
    let sawTimer = false;
    let fireTimer!: () => void;
    const timerRan = new Promise<void>((resolve) => {
      fireTimer = resolve;
    });

    await measureStartupStep(
      { onEvent: vi.fn(async () => {}) },
      () => 0,
      "bridge.process-session",
      async () => {
        runWithoutActiveStep(() => {
          setTimeout(() => {
            storeInTimer = getActiveStepContext();
            sawTimer = true;
            fireTimer();
          }, 0);
        });
        return "started";
      },
      { criticalPath: false },
    );

    await timerRan;

    expect(sawTimer).toBe(true);
    expect(storeInTimer).toBeNull();
  });

  it("returns the work result and restores the previous active step", async () => {
    // Outside any measured step the previous store is empty, so the helper both
    // returns the work value and leaves the store empty afterward.
    const value = runWithoutActiveStep(() => "value");
    expect(value).toBe("value");
    expect(getActiveStepContext()).toBeNull();
  });
});

describe("runWithRuntimeParent", () => {
  it("sets the parent context so inner code parents to the given token", () => {
    // The server builds an opaque parent-context token from a run-time span. The
    // helper publishes it, so inner code reads it through the getter and parents
    // a child span to that token. Model the token as a plain object; the helper
    // forwards it opaque.
    const token = { span: "runtime-parent" };
    const seen = runWithRuntimeParent(token, () => getActiveStepContext());

    expect(seen).not.toBeNull();
    // The published parent token is the given token, unchanged.
    expect(seen!.parentContext).toBe(token);
    // The helper stores the no-op span, not a real step span.
    expect(seen!.span).toBe(NOOP_STARTUP_SPAN);
    // A run-time exec is not on the startup critical path.
    expect(seen!.criticalPath).toBe(false);
    // The context clears once the work settles.
    expect(getActiveStepContext()).toBeNull();
  });

  it("empties the store when the token is undefined, like runWithoutActiveStep", () => {
    // A missing token means no run-time parent. The helper then empties the
    // store, so inner code reads no active step and opens an unparented span.
    const seen = runWithRuntimeParent(undefined, () => getActiveStepContext());

    expect(seen).toBeNull();
    expect(getActiveStepContext()).toBeNull();
  });

  it("returns the work result", () => {
    const value = runWithRuntimeParent({ span: "runtime-parent" }, () => "value");
    expect(value).toBe("value");
  });
});

describe("clampSpanLabel", () => {
  it("returns a known command label unchanged and maps an unknown command to `other`", () => {
    expect(clampSpanLabel("command", "sh")).toBe("sh");
    expect(clampSpanLabel("command", "git")).toBe("git");
    // A full command line, a path, or a secret-like argument is not a known
    // basename, so it maps to the bounded fallback and never leaks.
    expect(clampSpanLabel("command", "bash -lc 'rm -rf /secret/path'")).toBe("other");
    expect(clampSpanLabel("command", "/usr/local/bin/node")).toBe("other");
    expect(clampSpanLabel("command", undefined)).toBe("other");
  });

  it("returns a known region unchanged and maps an unknown region to `unknown`", () => {
    expect(clampSpanLabel("region", "us-east-1")).toBe("us-east-1");
    expect(clampSpanLabel("region", "moon-base-1")).toBe("unknown");
    expect(clampSpanLabel("region", undefined)).toBe("unknown");
  });

  it("hashes an id or image label to a non-reversible short digest and never returns the raw value", () => {
    const raw = "lease-super-secret-internal-codename";
    for (const label of ["image_id", "sandbox_id", "lease_id"]) {
      const clamped = clampSpanLabel(label, raw);
      expect(clamped).toBeTruthy();
      expect(clamped).not.toBe(raw);
      expect(clamped).not.toContain("secret");
      expect(clamped).not.toContain("codename");
      // A stable 12-hex-character digest prefix.
      expect(clamped).toMatch(/^[0-9a-f]{12}$/);
    }
    // A missing id yields no attribute (fail open — never a raw value).
    expect(clampSpanLabel("sandbox_id", undefined)).toBeUndefined();
    expect(clampSpanLabel("sandbox_id", "")).toBeUndefined();
  });

  it("drops an unknown label name so the caller sets no attribute for it", () => {
    expect(clampSpanLabel("nonsense", "anything")).toBeUndefined();
    expect(clampSpanLabel("stdout", "secret output")).toBeUndefined();
  });
});

describe("createRuntimeSpanRunner", () => {
  it("opens a named wrapper span and parents the wrapped work to it", async () => {
    const { tracer, spans } = makeMockTracer();
    const runParent = { marker: "run-parent" };
    const traceContext: StartupTraceContext = {
      tracer,
      contextWithSpan: (span) => ({ span }),
    };
    const run = createRuntimeSpanRunner(traceContext, () => runParent);

    let childParent: unknown = "unset";
    const result = await run("sandbox.agentSession.sendInput", async () => {
      childParent = getActiveStepContext()?.parentContext;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("sandbox.agentSession.sendInput");
    expect(spans[0]!.endCount).toBe(1);
    // The wrapped work parents to the wrapper span, not straight to the run
    // parent, so the inner exec spans group under the wrapper span.
    expect((childParent as { span?: unknown }).span).toBe(spans[0]);
  });

  it("marks the wrapper span failed and ends it when the work throws", async () => {
    const { tracer, spans } = makeMockTracer();
    const traceContext: StartupTraceContext = {
      tracer,
      contextWithSpan: (span) => ({ span }),
    };
    const run = createRuntimeSpanRunner(traceContext, () => ({ marker: "run-parent" }));

    await expect(
      run("sandbox.callbackBridge.relayRequest", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status?.code).toBe(2);
    expect(spans[0]!.endCount).toBe(1);
  });

  it("runs the work unwrapped under a no-op trace context", async () => {
    const run = createRuntimeSpanRunner(NOOP_STARTUP_TRACE_CONTEXT, () => ({ marker: "run-parent" }));
    // The no-op `contextWithSpan` yields no child token, so the store empties for
    // the work, exactly like the earlier unparented run-time behavior.
    let childStep: unknown = "unset";
    const result = await run("sandbox.agentSession.pollOutput", async () => {
      childStep = getActiveStepContext();
      return 7;
    });
    expect(result).toBe(7);
    expect(childStep).toBeNull();
  });
});

describe("run phase timing telemetry", () => {
  it("test_phase_telemetry_fields_are_exactly_phase_duration_outcome", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const ctx = { onEvent: async (event: AdapterRuntimeEvent) => void events.push(event) };

    await emitRunPhaseTiming(ctx, "create_runtime", 12, "ok");

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.eventType).toBe(RUN_PHASE_TIMING_EVENT_TYPE);
    // The payload carries exactly the three closed fields and nothing else.
    expect(Object.keys(event.payload ?? {}).sort()).toEqual(["durationMs", "outcome", "phase"]);
    expect(event.payload).toEqual({ phase: "create_runtime", durationMs: 12, outcome: "ok" });
  });

  it("test_phase_telemetry_emits_no_command_path_environment_or_identifier_value", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const ctx = { onEvent: async (event: AdapterRuntimeEvent) => void events.push(event) };

    // Every allowlisted phase emits exactly one closed-shape event.
    for (const phase of RUN_PHASE_NAMES) {
      await emitRunPhaseTiming(ctx, phase, 5, "ok");
    }
    // A phase name outside the closed allowlist emits nothing, so a free-form
    // label (a command, a path, an environment value, or a raw identifier) can
    // never reach the stream.
    await emitRunPhaseTiming(ctx, "/usr/bin/node --flag /secret/path", 5, "ok");
    await emitRunPhaseTiming(ctx, "PAPERCLIP_API_KEY=abc123", 5, "ok");
    await emitRunPhaseTiming(ctx, "run-7f3a-agent-42", 5, "ok");

    expect(events).toHaveLength(RUN_PHASE_NAMES.length);
    for (const event of events) {
      // The phase field is only ever an allowlisted name.
      expect(RUN_PHASE_NAMES).toContain(event.payload?.phase);
      // No field carries a command, a path, an environment value, or an identifier.
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("/usr/bin/node");
      expect(serialized).not.toContain("/secret/path");
      expect(serialized).not.toContain("PAPERCLIP_API_KEY");
      expect(serialized).not.toContain("abc123");
      expect(serialized).not.toContain("run-7f3a-agent-42");
    }
  });

  it("test_telemetry_failure_does_not_fail_the_run", async () => {
    const ctx = {
      onEvent: async () => {
        throw new Error("telemetry sink boom");
      },
    };

    // A throwing telemetry sink never propagates, so the run continues.
    await expect(emitRunPhaseTiming(ctx, "turn", 9, "failed")).resolves.toBeUndefined();
  });
});
