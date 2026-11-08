import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `otel-register.ts` is the `node --import` preload entry. It must settle only
 * after the SDK has started (so the app's imports load into a patched runtime),
 * and it must be a harmless no-op when tracing is not configured.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../instrumentation.js");
  vi.resetModules();
});

describe("otel-register preload", () => {
  it("does not settle before instrumentationReady resolves", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.resetModules();
    vi.doMock("../instrumentation.js", () => ({ instrumentationReady: ready }));

    let settled = false;
    const loading = import("../otel-register.js").then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await loading;
    expect(settled).toBe(true);
  });

  it("is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    await expect(import("../otel-register.js")).resolves.toBeDefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
